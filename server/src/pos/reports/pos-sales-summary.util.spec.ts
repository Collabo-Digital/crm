import {
  NO_STAFF_NAME,
  NO_STORE_NAME,
  calendarDays,
  summarizePosSales,
  toTopProducts,
  type PosOrderRow,
  type PosPaymentRow,
} from './pos-sales-summary.util';

/**
 * The store report's arithmetic, from one row per bill and one per payment —
 * what `PosReportsService` reads out of Postgres.
 */

function bill(over: Partial<PosOrderRow> & { id: string }): PosOrderRow {
  return {
    day: '2026-10-25',
    store_id: 'wh_mg_road',
    staff_id: 'st_asha',
    financial_status: 'PAID',
    fx: 1,
    total: 1000,
    discounts: 0,
    tax: 0,
    round_off: 0,
    items: 1,
    ...over,
  };
}

const pay = (order_id: string, method: string, amount: number): PosPaymentRow => ({
  order_id,
  method,
  amount,
});

function summarize(orders: PosOrderRow[], payments: PosPaymentRow[] = [], days = ['2026-10-25']) {
  return summarizePosSales({
    orders,
    payments,
    days,
    storeNames: new Map([
      ['wh_mg_road', 'MG Road'],
      ['wh_indiranagar', 'Indiranagar'],
    ]),
    staffNames: new Map([
      ['st_asha', 'Asha'],
      ['st_ravi', 'Ravi'],
    ]),
  });
}

describe('summarizePosSales', () => {
  it('totals the bills: sales, bills, average bill, discounts, tax and items', () => {
    const { totals } = summarize([
      bill({ id: 'o1', total: 1180, discounts: 50, tax: 180, items: 3 }),
      bill({ id: 'o2', total: 590, discounts: 0, tax: 90, items: 1 }),
    ]);

    expect(totals).toMatchObject({
      sales: 1770,
      orders: 2,
      avgBill: 885,
      discounts: 50,
      tax: 270,
      itemsSold: 4,
    });
  });

  it('splits sales by store, biggest first, with the store names', () => {
    const { byStore } = summarize([
      bill({ id: 'o1', store_id: 'wh_mg_road', total: 500 }),
      bill({ id: 'o2', store_id: 'wh_indiranagar', total: 900 }),
      bill({ id: 'o3', store_id: 'wh_mg_road', total: 300 }),
    ]);

    expect(byStore).toEqual([
      { storeId: 'wh_indiranagar', storeName: 'Indiranagar', sales: 900, orders: 1 },
      { storeId: 'wh_mg_road', storeName: 'MG Road', sales: 800, orders: 2 },
    ]);
  });

  it('keeps bills with no store together rather than dropping them', () => {
    const { byStore } = summarize([bill({ id: 'o1', store_id: null, total: 250 })]);

    expect(byStore).toEqual([{ storeId: null, storeName: NO_STORE_NAME, sales: 250, orders: 1 }]);
  });

  it('splits sales by staff, and puts bills rung up without a PIN under "No staff PIN"', () => {
    const { byStaff } = summarize([
      bill({ id: 'o1', staff_id: 'st_asha', total: 1000 }),
      bill({ id: 'o2', staff_id: 'st_asha', total: 500 }),
      bill({ id: 'o3', staff_id: null, total: 700 }),
      bill({ id: 'o4', staff_id: 'st_ravi', total: 200 }),
    ]);

    expect(byStaff).toEqual([
      { posStaffId: 'st_asha', name: 'Asha', sales: 1500, orders: 2, avgBill: 750 },
      { posStaffId: null, name: NO_STAFF_NAME, sales: 700, orders: 1, avgBill: 700 },
      { posStaffId: 'st_ravi', name: 'Ravi', sales: 200, orders: 1, avgBill: 200 },
    ]);
  });

  it('splits payments by method — cash, UPI, card, other — counting a split bill under each', () => {
    const { byPayment, totals } = summarize(
      [bill({ id: 'o1', total: 1000 }), bill({ id: 'o2', total: 400 }), bill({ id: 'o3', total: 250 })],
      [
        pay('o1', 'CASH', 600),
        pay('o1', 'UPI', 400),
        pay('o2', 'CARD', 400),
        pay('o3', 'UPI', 250),
      ],
    );

    expect(byPayment).toEqual([
      { method: 'CASH', amount: 600, count: 1 },
      { method: 'UPI', amount: 650, count: 2 },
      { method: 'CARD', amount: 400, count: 1 },
      { method: 'OTHER', amount: 0, count: 0 },
    ]);
    expect(totals.paid).toBe(1650);
  });

  it('reports what part-paid and unpaid bills still owe, including the round-off', () => {
    const { totals, partPaid } = summarize(
      [
        // ₹999.60 rounded up to ₹1,000, ₹600 taken: ₹400 to collect.
        bill({ id: 'o1', financial_status: 'PARTIALLY_PAID', total: 999.6, round_off: 0.4 }),
        // Billed on credit, nothing taken yet.
        bill({ id: 'o2', financial_status: 'PENDING', total: 300 }),
        // Paid to the rupee after rounding down: owes nothing.
        bill({ id: 'o3', financial_status: 'PARTIALLY_PAID', total: 500.3, round_off: -0.3 }),
      ],
      [pay('o1', 'CASH', 600), pay('o3', 'UPI', 500)],
    );

    expect(partPaid).toEqual({ orders: 2, balanceDue: 700 });
    expect(totals.balanceDue).toBe(700);
    expect(totals.paid).toBe(1100);
  });

  it('never shows a balance on a bill marked paid', () => {
    const { partPaid } = summarize([bill({ id: 'o1', financial_status: 'PAID', total: 800 })]);

    expect(partPaid).toEqual({ orders: 0, balanceDue: 0 });
  });

  it('charts every day of the period, with zero on days without bills', () => {
    const { byDay } = summarize(
      [
        bill({ id: 'o1', day: '2026-10-24', total: 100 }),
        bill({ id: 'o2', day: '2026-10-26', total: 300 }),
        bill({ id: 'o3', day: '2026-10-26', total: 200 }),
      ],
      [],
      ['2026-10-24', '2026-10-25', '2026-10-26'],
    );

    expect(byDay).toEqual([
      { date: '2026-10-24', sales: 100, orders: 1 },
      { date: '2026-10-25', sales: 0, orders: 0 },
      { date: '2026-10-26', sales: 500, orders: 2 },
    ]);
  });

  it('converts at each bill\'s own rate, and counts the bills it cannot convert instead of adding them', () => {
    const { totals, byPayment, unconvertedOrders } = summarize(
      [
        bill({ id: 'o1', total: 100, fx: 83.5 }),
        bill({ id: 'o2', total: 900, fx: null }),
      ],
      [pay('o1', 'CARD', 100), pay('o2', 'CASH', 900)],
    );

    expect(totals.sales).toBe(8350);
    expect(totals.orders).toBe(1);
    expect(byPayment.find((p) => p.method === 'CARD')?.amount).toBe(8350);
    expect(byPayment.find((p) => p.method === 'CASH')?.amount).toBe(0);
    expect(unconvertedOrders).toBe(1);
  });

  it('returns a whole, zeroed report for a period with no bills', () => {
    const report = summarize([], [], ['2026-10-25', '2026-10-26']);

    expect(report.totals).toEqual({
      sales: 0,
      orders: 0,
      avgBill: 0,
      discounts: 0,
      tax: 0,
      itemsSold: 0,
      paid: 0,
      balanceDue: 0,
    });
    expect(report.byDay).toEqual([
      { date: '2026-10-25', sales: 0, orders: 0 },
      { date: '2026-10-26', sales: 0, orders: 0 },
    ]);
    expect(report.byStore).toEqual([]);
    expect(report.byStaff).toEqual([]);
    expect(report.byPayment.map((p) => p.amount)).toEqual([0, 0, 0, 0]);
    expect(report.partPaid).toEqual({ orders: 0, balanceDue: 0 });
    expect(report.unconvertedOrders).toBe(0);
  });
});

describe('toTopProducts', () => {
  it('names the variant beside the product, except Shopify\'s "Default Title"', () => {
    expect(
      toTopProducts([
        { variant_id: 'v1', title: 'Kurta', variant_title: 'Red / M', quantity: 4, sales: 3996.004 },
        { variant_id: 'v2', title: 'Dupatta', variant_title: 'Default Title', quantity: 2, sales: 900 },
        { variant_id: null, title: 'Alteration', variant_title: null, quantity: 1, sales: 150 },
      ]),
    ).toEqual([
      { variantId: 'v1', title: 'Kurta — Red / M', quantity: 4, sales: 3996 },
      { variantId: 'v2', title: 'Dupatta', quantity: 2, sales: 900 },
      { variantId: null, title: 'Alteration', quantity: 1, sales: 150 },
    ]);
  });
});

describe('calendarDays', () => {
  it('lists every day, both ends included, across a month end', () => {
    expect(calendarDays('2026-09-29', '2026-10-02')).toEqual([
      '2026-09-29',
      '2026-09-30',
      '2026-10-01',
      '2026-10-02',
    ]);
    expect(calendarDays('2026-10-26', '2026-10-26')).toEqual(['2026-10-26']);
  });
});
