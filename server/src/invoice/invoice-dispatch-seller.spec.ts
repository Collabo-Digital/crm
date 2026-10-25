import { GstCalculatorService } from '../gst/gst-calculator.service';
import { InvoiceService } from './invoice.service';

/**
 * A place of business supplies under its own GST registration. An order whose
 * goods left a location linked to a GSTIN is invoiced under that GSTIN — before
 * this, the seller was picked by place of supply alone, so a Kochi store's
 * walk-in sale in a Karnataka-default workspace was invoiced from Karnataka and
 * then refused by the dispatch check ("registered under a different GSTIN").
 */

const ORG = 'org_1';
const KA = { id: 'g_ka', gstin: '29AABCT1332L1ZN', legalName: 'Acme', address: null, stateCode: '29', stateName: 'Karnataka', isDefault: true, isActive: true };
const KL = { id: 'g_kl', gstin: '32AABCT1332L1ZJ', legalName: 'Acme', address: null, stateCode: '32', stateName: 'Kerala', isDefault: false, isActive: true };

function build(opts: { locationGstinId: string | null; placeOfSupplyCode: string }) {
  const order = {
    id: 'order_1',
    organizationId: ORG,
    externalCreatedAt: new Date('2026-10-05T10:00:00.000Z'),
    createdAt: new Date('2026-10-05T10:00:00.000Z'),
    currency: 'INR',
    totalTax: '50.00',
    taxesIncluded: false,
    sourceName: null,
    totalShippingPrice: '0.00',
    billingAddress: null,
    dispatchWarehouseId: 'wh_kochi',
    placeOfSupplyCode: opts.placeOfSupplyCode,
    customer: null,
    channel: { platform: 'MANUAL' },
    lineItems: [
      { id: 'li_1', title: 'Shirt', variantTitle: null, price: '1000.00', quantity: 1, totalDiscount: '0.00', taxable: true, variant: null },
    ],
  };
  const registrations = [KA, KL];
  const tx = {
    order: {
      findFirst: jest.fn(({ where }: any) => Promise.resolve(where.id ? order : null)),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    invoice: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(({ data }: any) => Promise.resolve({ ...data, lineItems: [] })),
    },
    organization: { findUnique: jest.fn().mockResolvedValue({ gstEnabled: true, timezone: 'Asia/Kolkata' }) },
    organizationSettings: { findUnique: jest.fn().mockResolvedValue({ taxSettings: {} }) },
    organizationGstin: {
      findFirst: jest.fn(({ where }: any) =>
        Promise.resolve(
          registrations.find(
            (g) =>
              (where.id === undefined || g.id === where.id) &&
              (where.stateCode === undefined || g.stateCode === where.stateCode) &&
              (where.isDefault === undefined || g.isDefault === where.isDefault),
          ) ?? null,
        ),
      ),
    },
    warehouse: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'wh_kochi',
        name: 'Kochi store',
        address: { stateCode: '32' },
        gstinId: opts.locationGstinId,
        gstin: opts.locationGstinId === 'g_kl' ? { stateCode: '32' } : null,
      }),
    },
    gstFiling: { findFirst: jest.fn().mockResolvedValue(null) },
  };
  const service = new InvoiceService(
    {} as any,
    {} as any,
    new GstCalculatorService(),
    { resolveLineGstRates: jest.fn().mockResolvedValue([5]) } as any,
    { getNextInvoiceNumber: jest.fn().mockResolvedValue('INV-26-27/000001') } as any,
    { invoiceIssued: jest.fn() } as any,
  );
  jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
  const issue = async (dto: { sellerGstinId?: string } = {}) => {
    await service.createForOrderTx(tx as any, ORG, 'order_1', dto);
    return tx.invoice.create.mock.calls.at(-1)![0].data;
  };
  return { issue };
}

describe('InvoiceService.createForOrderTx — seller from the dispatch location', () => {
  beforeEach(() => jest.useFakeTimers({ now: new Date('2026-10-08T09:00:00.000Z') }));
  afterEach(() => jest.useRealTimers());

  it('invoices under the location’s own GSTIN, whatever the place of supply would pick', async () => {
    // Supplied into Karnataka, where the default registration is — but the
    // goods left the Kochi store, registered in Kerala.
    const data = await build({ locationGstinId: 'g_kl', placeOfSupplyCode: '29' }).issue();

    expect(data.sellerGstinId).toBe('g_kl');
    expect(data.sellerStateCode).toBe('32');
    expect(data.gstType).toBe('IGST');
  });

  it('a walk-in sale at the store is intra-state under the store’s GSTIN', async () => {
    const data = await build({ locationGstinId: 'g_kl', placeOfSupplyCode: '32' }).issue();

    expect(data.sellerGstinId).toBe('g_kl');
    expect(data.gstType).toBe('CGST_SGST');
  });

  it('falls back to today’s rule when the location has no GSTIN', async () => {
    const data = await build({ locationGstinId: null, placeOfSupplyCode: '29' }).issue();

    expect(data.sellerGstinId).toBe('g_ka');
  });

  it('keeps a seller GSTIN chosen explicitly', async () => {
    const data = await build({ locationGstinId: null, placeOfSupplyCode: '29' }).issue({ sellerGstinId: 'g_kl' });

    expect(data.sellerGstinId).toBe('g_kl');
  });
});
