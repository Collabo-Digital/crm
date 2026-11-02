import { BadRequestException, ConflictException } from '@nestjs/common';
import { DraftOrderStatus } from '@prisma/client';
import { GstCalculatorService } from '../gst/gst-calculator.service';
import { DraftOrderService } from './draft-order.service';

/**
 * Completing a draft with no Shopify copy makes the sale here.
 *
 * The draft used to be claimed, sold and linked in three separate commits. A
 * crash after the claim left a COMPLETED draft with no order that could not be
 * completed again, and the lines were read before the claim, so an edit saved
 * in between was sold at the old lines' prices. The claim and the link now
 * run inside the sale's own transaction, and only for the version that was read.
 */

const ORG = 'org_1';
const USER = 'u_1';
const READ_AT = new Date('2026-10-01T10:00:00.123Z');

function build(opts: { status?: DraftOrderStatus; claims?: number; saleError?: Error } = {}) {
  const draft = {
    id: 'd_1',
    status: opts.status ?? DraftOrderStatus.OPEN,
    externalId: null,
    updatedAt: READ_AT,
    customerId: null,
    customer: null,
    customerEmail: null,
    note: null,
    metadata: {},
    shippingAddress: null,
    billingAddress: null,
    lineItems: [{ variantId: 'v_1', quantity: 2, price: 500, totalDiscount: 50 }],
  };
  const prisma = {
    draftOrder: {
      findFirst: jest.fn().mockResolvedValue(draft),
      // Writes outside the sale's transaction are what this fix removes.
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const tx = { draftOrder: { updateMany: jest.fn().mockResolvedValue({ count: opts.claims ?? 1 }) } };
  const orderService = {
    // Runs the hook as createOfflineOrder does: inside the transaction, once
    // the order row exists. A throw from it is a rolled-back sale.
    createOfflineOrder: jest.fn(
      async (
        _org: string,
        _user: string,
        _dto: unknown,
        options?: { inTransaction?: (t: unknown, o: { id: string; customerId: null }) => Promise<void> },
      ) => {
        if (opts.saleError) throw opts.saleError;
        await options?.inTransaction?.(tx, { id: 'ord_1', customerId: null });
        return { order: { id: 'ord_1' }, invoice: null, invoiceError: null };
      },
    ),
  };
  const service = new DraftOrderService(
    prisma as never,
    new GstCalculatorService(),
    {} as never,
    orderService as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, prisma, tx, orderService };
}

const complete = (service: DraftOrderService) =>
  service.complete('d_1', ORG, USER, { paymentMethod: 'CASH' });

describe('DraftOrderService.complete without Shopify', () => {
  it('claims and links the draft inside the sale’s transaction, for the version it read', async () => {
    const { service, prisma, tx } = build();

    const out = await complete(service);

    expect(tx.draftOrder.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'd_1',
        organizationId: ORG,
        deletedAt: null,
        status: { in: [DraftOrderStatus.OPEN, DraftOrderStatus.INVOICE_SENT] },
        updatedAt: READ_AT,
      },
      data: {
        status: DraftOrderStatus.COMPLETED,
        completedAt: expect.any(Date),
        completedOrderId: 'ord_1',
      },
    });
    expect(prisma.draftOrder.updateMany).not.toHaveBeenCalled();
    expect(prisma.draftOrder.update).not.toHaveBeenCalled();
    expect(out).toEqual({ draftId: 'd_1', order: { id: 'ord_1' }, invoice: null, invoiceError: null });
  });

  it('sells the lines it read', async () => {
    const { service, orderService } = build();

    await complete(service);

    expect(orderService.createOfflineOrder.mock.calls[0][2]).toMatchObject({
      lineItems: [{ productVariantId: 'v_1', quantity: 2, unitPriceOverride: 500, discount: 50 }],
      paymentMethod: 'CASH',
    });
  });

  it('refuses, and so undoes the sale, when the draft was edited, deleted or completed since it was read', async () => {
    const { service, prisma } = build({ claims: 0 });

    await expect(complete(service)).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.draftOrder.updateMany).not.toHaveBeenCalled();
    expect(prisma.draftOrder.update).not.toHaveBeenCalled();
  });

  it('leaves nothing to undo when the sale fails, so the draft can be completed again', async () => {
    const { service, prisma, tx } = build({ saleError: new BadRequestException('Insufficient stock') });

    await expect(complete(service)).rejects.toThrow('Insufficient stock');
    expect(tx.draftOrder.updateMany).not.toHaveBeenCalled();
    expect(prisma.draftOrder.updateMany).not.toHaveBeenCalled();
  });

  it('refuses a draft already completed without making a sale', async () => {
    const { service, orderService } = build({ status: DraftOrderStatus.COMPLETED });

    await expect(complete(service)).rejects.toThrow('Draft is already completed. See the linked order.');
    expect(orderService.createOfflineOrder).not.toHaveBeenCalled();
  });
});
