import { ShopifySyncService } from './shopify-sync.service';
import { CRM_DRAFT_ATTRIBUTE } from './draft-rebadge.util';

/**
 * `draft_orders/create|update` for a draft the CRM itself created.
 *
 * A CRM draft lives on the MANUAL channel. The webhook looked it up on the
 * SHOPIFY channel, missed it, and inserted a second DraftOrder — then every
 * later push updated that copy. It must now land on the CRM row, and take only
 * the fields Shopify owns.
 */

const ORG = 'org_1';
const SHOPIFY = 'ch_shopify';
const MANUAL = 'ch_manual';
const SHOPIFY_DRAFT_ID = 9001;

type Row = { id: string; channelId: string; status: string; deletedAt: Date | null };

const crmRow = (over: Partial<Row> = {}): Row => ({
  id: 'draft_crm',
  channelId: MANUAL,
  status: 'OPEN',
  deletedAt: null,
  ...over,
});

const payload = (over: Record<string, unknown> = {}) => ({
  id: SHOPIFY_DRAFT_ID,
  name: '#D12',
  status: 'open',
  currency: 'INR',
  subtotal_price: '999.00',
  total_price: '1100.00',
  total_tax: '101.00',
  invoice_url: 'https://shop.example/invoices/abc',
  updated_at: '2026-09-23T10:00:00Z',
  line_items: [{ id: 1, title: 'Widget', quantity: 1, price: '999.00' }],
  note_attributes: [],
  ...over,
});

function build(opts: { byId?: Row | null; byExternalId?: Row[] }) {
  const prisma = {
    draftOrder: {
      findFirst: jest.fn().mockResolvedValue(opts.byId ?? null),
      findMany: jest.fn().mockResolvedValue(opts.byExternalId ?? []),
      update: jest.fn(({ where }: any) => Promise.resolve({ id: where.id })),
      create: jest.fn((_args: any) => Promise.resolve({ id: 'draft_new' })),
    },
    draftOrderLineItem: {
      deleteMany: jest.fn().mockResolvedValue(undefined),
      create: jest.fn().mockResolvedValue(undefined),
    },
    customer: { findFirst: jest.fn().mockResolvedValue(null) },
    productVariant: { findFirst: jest.fn().mockResolvedValue(null) },
  };
  const service = new ShopifySyncService(
    prisma as any, {} as any, {} as any, {} as any, {} as any, {} as any,
    {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
  );
  jest.spyOn((service as any).logger, 'log').mockImplementation(() => undefined);
  return { service, prisma };
}

describe('ShopifySyncService.upsertDraftOrder — CRM-created drafts', () => {
  it('finds the CRM row by its marker even before the externalId is written back', async () => {
    const { service, prisma } = build({ byId: crmRow() });

    await service.upsertDraftOrder(
      SHOPIFY, ORG,
      payload({ note_attributes: [{ name: CRM_DRAFT_ATTRIBUTE, value: 'draft_crm' }] }),
    );

    expect(prisma.draftOrder.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'draft_crm', organizationId: ORG } }),
    );
    expect(prisma.draftOrder.create).not.toHaveBeenCalled();
    const call = prisma.draftOrder.update.mock.calls[0][0] as any;
    expect(call.where).toEqual({ id: 'draft_crm' });
    expect(call.data.externalId).toBe(String(SHOPIFY_DRAFT_ID));
  });

  it("takes only Shopify's fields — never the CRM's lines, totals or name", async () => {
    const { service, prisma } = build({ byExternalId: [crmRow()] });

    await service.upsertDraftOrder(SHOPIFY, ORG, payload());

    const { data } = prisma.draftOrder.update.mock.calls[0][0] as any;
    expect(data).toMatchObject({
      status: 'OPEN',
      invoiceUrl: 'https://shop.example/invoices/abc',
    });
    for (const crmOwned of ['name', 'totalPrice', 'totalTax', 'subtotalPrice', 'customerId', 'note', 'tags']) {
      expect(data).not.toHaveProperty(crmOwned);
    }
    expect(prisma.draftOrderLineItem.deleteMany).not.toHaveBeenCalled();
    expect(prisma.draftOrderLineItem.create).not.toHaveBeenCalled();
    expect(prisma.draftOrder.create).not.toHaveBeenCalled();
  });

  it('does not reopen a draft the CRM already completed', async () => {
    const { service, prisma } = build({ byExternalId: [crmRow({ status: 'COMPLETED' })] });

    await service.upsertDraftOrder(SHOPIFY, ORG, payload({ status: 'open' }));

    const { data } = prisma.draftOrder.update.mock.calls[0][0] as any;
    expect(data).not.toHaveProperty('status');
  });

  it('prefers the CRM row over an old duplicate on the Shopify channel', async () => {
    const duplicate = crmRow({ id: 'draft_dup', channelId: SHOPIFY });
    const { service, prisma } = build({ byExternalId: [duplicate, crmRow()] });

    await service.upsertDraftOrder(SHOPIFY, ORG, payload());

    expect(prisma.draftOrder.update).toHaveBeenCalledTimes(1);
    expect((prisma.draftOrder.update.mock.calls[0][0] as any).where).toEqual({ id: 'draft_crm' });
  });

  it('ignores the webhook when the CRM draft was deleted', async () => {
    const { service, prisma } = build({ byExternalId: [crmRow({ deletedAt: new Date() })] });

    await service.upsertDraftOrder(SHOPIFY, ORG, payload());

    expect(prisma.draftOrder.update).not.toHaveBeenCalled();
    expect(prisma.draftOrder.create).not.toHaveBeenCalled();
    expect(prisma.draftOrderLineItem.deleteMany).not.toHaveBeenCalled();
  });
});

describe('ShopifySyncService.upsertDraftOrder — drafts made in Shopify admin', () => {
  it('creates the draft and its lines as before', async () => {
    const { service, prisma } = build({});

    await service.upsertDraftOrder(SHOPIFY, ORG, payload());

    const { data } = prisma.draftOrder.create.mock.calls[0][0] as any;
    expect(data).toMatchObject({
      organizationId: ORG,
      channelId: SHOPIFY,
      externalId: String(SHOPIFY_DRAFT_ID),
      totalPrice: '1100.00',
    });
    expect(prisma.draftOrderLineItem.create).toHaveBeenCalledTimes(1);
  });

  it('fully updates its own row, lines included', async () => {
    const { service, prisma } = build({
      byExternalId: [crmRow({ id: 'draft_shop', channelId: SHOPIFY })],
    });

    await service.upsertDraftOrder(SHOPIFY, ORG, payload());

    const { where, data } = prisma.draftOrder.update.mock.calls[0][0] as any;
    expect(where).toEqual({ id: 'draft_shop' });
    expect(data).toMatchObject({ totalPrice: '1100.00', name: '#D12' });
    expect(prisma.draftOrderLineItem.deleteMany).toHaveBeenCalledTimes(1);
  });
});
