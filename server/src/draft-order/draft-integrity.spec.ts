import { BadRequestException, ConflictException } from '@nestjs/common';
import { DraftOrderStatus } from '@prisma/client';
import { GstCalculatorService } from '../gst/gst-calculator.service';
import { DraftOrderService } from './draft-order.service';

/**
 * What a draft may hold and when it may still change.
 *
 * - A product deleted after it was picked could still be drafted, or kept
 *   through an edit, and the draft then completed into a sale of it.
 * - Edits and deletes checked the draft was open, then wrote by id alone, so a
 *   completion landing in between was overwritten or deleted.
 * - The draft's discount total was always 0, whatever its lines said.
 */

const ORG = 'org_1';
const USER = 'u_1';

const shirt = (deletedAt: Date | null = null) => ({
  id: 'v_1',
  title: 'M',
  sku: 'SHIRT-M',
  price: 1000,
  gstRate: null,
  taxable: true,
  product: { id: 'p_1', title: 'Linen shirt', gstRate: 5, deletedAt },
});
const cap = {
  id: 'v_2',
  title: 'Default Title',
  sku: 'CAP',
  price: 300,
  gstRate: null,
  taxable: true,
  product: { id: 'p_2', title: 'Cap', gstRate: 5, deletedAt: null },
};

function build(opts: { variants?: unknown[]; status?: DraftOrderStatus; writes?: number } = {}) {
  const writes = { count: opts.writes ?? 1 };
  const tx = {
    channel: { findFirst: jest.fn().mockResolvedValue({ id: 'ch_manual' }) },
    productVariant: { findMany: jest.fn().mockResolvedValue(opts.variants ?? [shirt(), cap]) },
    organization: {
      findUnique: jest.fn().mockResolvedValue({ gstEnabled: false, currency: 'INR' }),
      findUniqueOrThrow: jest.fn().mockResolvedValue({ gstEnabled: false, currency: 'INR' }),
    },
    draftOrder: {
      create: jest.fn(({ data }: { data: object }) => Promise.resolve({ id: 'd_1', ...data })),
      updateMany: jest.fn().mockResolvedValue(writes),
    },
    draftOrderLineItem: {
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      createMany: jest.fn().mockResolvedValue({ count: 2 }),
    },
  };
  const prisma = {
    $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
    draftOrder: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'd_1',
        status: opts.status ?? DraftOrderStatus.OPEN,
        externalId: 'gid_1',
      }),
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        channelId: 'ch_manual',
        customerId: null,
        shippingAddress: null,
        billingAddress: null,
        metadata: {},
        customer: null,
      }),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue(writes),
    },
  };
  const mirror = { enqueueCreate: jest.fn(), enqueueUpdate: jest.fn(), enqueueDelete: jest.fn() };
  const service = new DraftOrderService(
    prisma as never,
    new GstCalculatorService(),
    { resolveLineGstRates: jest.fn() } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    mirror as never,
    { getOrderSettings: jest.fn().mockResolvedValue({ autoSyncToShopify: true }) } as never,
  );
  jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
  return { service, prisma, tx, mirror };
}

const lineItems = [
  { productVariantId: 'v_1', quantity: 2, discount: 150 },
  { productVariantId: 'v_2', quantity: 1, discount: 25.5 },
];
const stillOpen = {
  id: 'd_1',
  organizationId: ORG,
  deletedAt: null,
  status: DraftOrderStatus.OPEN,
};

describe('A product deleted after it was picked', () => {
  it('cannot be drafted, and the refusal names it', async () => {
    const { service, tx } = build({ variants: [shirt(new Date()), cap] });

    const attempt = service.create(ORG, USER, { lineItems } as never);

    await expect(attempt).rejects.toBeInstanceOf(BadRequestException);
    await expect(attempt).rejects.toThrow('"Linen shirt — M" has been deleted from your products.');
    expect(tx.draftOrder.create).not.toHaveBeenCalled();
  });

  it('cannot be kept through an edit, and the draft keeps its lines', async () => {
    const { service, tx } = build({ variants: [shirt(new Date()), cap] });

    await expect(service.update('d_1', ORG, USER, { lineItems } as never)).rejects.toThrow(
      '"Linen shirt — M" has been deleted from your products.',
    );
    expect(tx.draftOrderLineItem.deleteMany).not.toHaveBeenCalled();
    expect(tx.draftOrder.updateMany).not.toHaveBeenCalled();
  });
});

describe('The discount total of a draft', () => {
  it('is the sum of its line discounts when created', async () => {
    const { service, tx } = build();

    await service.create(ORG, USER, { lineItems } as never);

    expect(tx.draftOrder.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ totalDiscounts: 175.5 }) }),
    );
  });

  it('is the sum of its line discounts after an edit', async () => {
    const { service, tx } = build();

    await service.update('d_1', ORG, USER, { lineItems } as never);

    expect(tx.draftOrder.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ totalDiscounts: 175.5 }) }),
    );
  });
});

describe('An edit that lands after the draft stopped being open', () => {
  it('writes new lines only while the draft is still open', async () => {
    const { service, tx } = build();

    await service.update('d_1', ORG, USER, { lineItems } as never);

    expect(tx.draftOrder.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: stillOpen }),
    );
  });

  it('is refused with a 409 when the draft was completed meanwhile, and mirrors nothing', async () => {
    const { service, mirror } = build({ writes: 0 });

    await expect(service.update('d_1', ORG, USER, { lineItems } as never)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(mirror.enqueueUpdate).not.toHaveBeenCalled();
  });

  it('writes a note only while the draft is still open', async () => {
    const { service, prisma } = build();
    jest.spyOn(service, 'findOne').mockResolvedValue({} as never);

    await service.update('d_1', ORG, USER, { note: 'Gift wrap' } as never);

    expect(prisma.draftOrder.updateMany).toHaveBeenCalledWith({
      where: stillOpen,
      data: { note: 'Gift wrap' },
    });
    expect(prisma.draftOrder.update).not.toHaveBeenCalled();
  });

  it('refuses a note with a 409 when the draft was completed meanwhile', async () => {
    const { service, mirror } = build({ writes: 0 });

    await expect(
      service.update('d_1', ORG, USER, { note: 'Gift wrap' } as never),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(mirror.enqueueUpdate).not.toHaveBeenCalled();
  });
});

describe('Deleting a draft that was completed meanwhile', () => {
  it('deletes only a draft that is still not completed', async () => {
    const { service, prisma } = build({ status: DraftOrderStatus.INVOICE_SENT });

    await service.softDelete('d_1', ORG);

    expect(prisma.draftOrder.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'd_1',
        organizationId: ORG,
        deletedAt: null,
        status: { not: DraftOrderStatus.COMPLETED },
      },
      data: { deletedAt: expect.any(Date) },
    });
    expect(prisma.draftOrder.update).not.toHaveBeenCalled();
  });

  it('is refused with a 409, and Shopify’s copy is left alone', async () => {
    const { service, mirror } = build({ writes: 0 });

    await expect(service.softDelete('d_1', ORG)).rejects.toBeInstanceOf(ConflictException);
    expect(mirror.enqueueDelete).not.toHaveBeenCalled();
  });
});
