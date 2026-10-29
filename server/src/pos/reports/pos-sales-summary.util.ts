import { round2 } from '../../dashboard/profit.util';

/** One POS bill, as read by `PosReportsService` — money in the order's own currency. */
export interface PosOrderRow {
  id: string;
  /** `YYYY-MM-DD`, the day the bill was placed in the org's reporting timezone. */
  day: string;
  store_id: string | null;
  staff_id: string | null;
  financial_status: string;
  /**
   * The order's stored rate into the org currency. NULL when it never resolved
   * or targets a currency the org no longer reports in: the bill is then left
   * out of every figure and counted in `unconvertedOrders`, as on the dashboard.
   */
  fx: number | null;
  total: number;
  discounts: number;
  tax: number;
  /** `metadata.pos.roundOff`; what the customer pays is `total + round_off`. */
  round_off: number;
  items: number;
}

export interface PosPaymentRow {
  order_id: string;
  method: string;
  amount: number;
}

export interface PosProductRow {
  variant_id: string | null;
  title: string;
  variant_title: string | null;
  quantity: number;
  sales: number;
}

/** Fixed order, so the cash / UPI / card split reads the same every time. */
export const POS_PAYMENT_METHODS = ['CASH', 'UPI', 'CARD', 'OTHER'] as const;

/** Bills that can still owe money. A PAID bill owes nothing, whatever its payment rows say. */
const OWING_STATUSES = new Set(['PENDING', 'PARTIALLY_PAID']);

export const NO_STAFF_NAME = 'No staff PIN';
export const NO_STORE_NAME = 'No store';

interface Tally {
  sales: number;
  orders: number;
}

/**
 * Every figure on the store report except top products, from one row per bill
 * and one row per payment taken on those bills.
 *
 * Payments are counted against the bills in the period, not by the day they
 * were taken, so `paid + balanceDue` reconciles with what the period's bills
 * came to.
 */
export function summarizePosSales(input: {
  orders: PosOrderRow[];
  payments: PosPaymentRow[];
  /** Every day of the period, oldest first; days with no bills chart as zero. */
  days: string[];
  storeNames: Map<string, string>;
  staffNames: Map<string, string>;
}) {
  const converted = input.orders.filter((o) => o.fx !== null);
  const fxByOrder = new Map(converted.map((o) => [o.id, o.fx as number]));

  const paidByOrder = new Map<string, number>();
  const byMethod = new Map<string, { amount: number; count: number }>(
    POS_PAYMENT_METHODS.map((m) => [m, { amount: 0, count: 0 }]),
  );
  for (const p of input.payments) {
    const fx = fxByOrder.get(p.order_id);
    if (fx === undefined) continue;
    const amount = p.amount * fx;
    paidByOrder.set(p.order_id, (paidByOrder.get(p.order_id) ?? 0) + amount);
    const method = byMethod.get(p.method)!;
    method.amount += amount;
    method.count += 1;
  }

  const totals = { sales: 0, orders: 0, discounts: 0, tax: 0, itemsSold: 0, paid: 0, balanceDue: 0 };
  const partPaid = { orders: 0, balanceDue: 0 };
  const byDay = new Map<string, Tally>(input.days.map((d) => [d, { sales: 0, orders: 0 }]));
  const byStore = new Map<string | null, Tally>();
  const byStaff = new Map<string | null, Tally>();
  const add = (map: Map<string | null, Tally>, key: string | null, sales: number) => {
    const t = map.get(key) ?? { sales: 0, orders: 0 };
    t.sales += sales;
    t.orders += 1;
    map.set(key, t);
  };

  for (const o of converted) {
    const fx = o.fx as number;
    const sales = o.total * fx;
    const paid = paidByOrder.get(o.id) ?? 0;

    totals.sales += sales;
    totals.orders += 1;
    totals.discounts += o.discounts * fx;
    totals.tax += o.tax * fx;
    totals.itemsSold += o.items;
    totals.paid += paid;

    // Rounded per bill: a bill paid to the paisa must not leave a
    // floating-point crumb that counts it as part-paid.
    const balance = OWING_STATUSES.has(o.financial_status)
      ? Math.max(round2((o.total + o.round_off) * fx - paid), 0)
      : 0;
    if (balance > 0) {
      partPaid.orders += 1;
      partPaid.balanceDue += balance;
    }

    const day = byDay.get(o.day)!;
    day.sales += sales;
    day.orders += 1;
    add(byStore, o.store_id, sales);
    add(byStaff, o.staff_id, sales);
  }

  const bySales = (a: Tally, b: Tally) => b.sales - a.sales || b.orders - a.orders;

  return {
    totals: {
      sales: round2(totals.sales),
      orders: totals.orders,
      avgBill: avgBill(totals),
      discounts: round2(totals.discounts),
      tax: round2(totals.tax),
      itemsSold: totals.itemsSold,
      paid: round2(totals.paid),
      balanceDue: round2(partPaid.balanceDue),
    },
    byDay: [...byDay.entries()].map(([date, t]) => ({
      date,
      sales: round2(t.sales),
      orders: t.orders,
    })),
    byStore: [...byStore.entries()]
      .sort(([, a], [, b]) => bySales(a, b))
      .map(([storeId, t]) => ({
        storeId,
        storeName: storeId ? (input.storeNames.get(storeId) ?? NO_STORE_NAME) : NO_STORE_NAME,
        sales: round2(t.sales),
        orders: t.orders,
      })),
    byStaff: [...byStaff.entries()]
      .sort(([, a], [, b]) => bySales(a, b))
      .map(([posStaffId, t]) => ({
        posStaffId,
        name: posStaffId ? (input.staffNames.get(posStaffId) ?? NO_STAFF_NAME) : NO_STAFF_NAME,
        sales: round2(t.sales),
        orders: t.orders,
        avgBill: avgBill(t),
      })),
    byPayment: [...byMethod.entries()].map(([method, m]) => ({
      method,
      amount: round2(m.amount),
      count: m.count,
    })),
    partPaid: { orders: partPaid.orders, balanceDue: round2(partPaid.balanceDue) },
    unconvertedOrders: input.orders.length - converted.length,
  };
}

/** "Kurta" or "Kurta — Red / M"; Shopify names a variant-less product's only variant "Default Title". */
export function toTopProducts(rows: PosProductRow[]) {
  return rows.map((r) => ({
    variantId: r.variant_id,
    title:
      r.variant_title && r.variant_title !== 'Default Title'
        ? `${r.title} — ${r.variant_title}`
        : r.title,
    quantity: r.quantity,
    sales: round2(r.sales),
  }));
}

/** Each `YYYY-MM-DD` from `from` to `to`, both included. */
export function calendarDays(from: string, to: string): string[] {
  const days: string[] = [];
  const [y, m, d] = from.split('-').map(Number);
  for (let i = 0; ; i++) {
    const day = new Date(Date.UTC(y, m - 1, d + i)).toISOString().slice(0, 10);
    if (day > to) return days;
    days.push(day);
  }
}

function avgBill(t: Tally): number {
  return t.orders ? round2(t.sales / t.orders) : 0;
}
