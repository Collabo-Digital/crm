/**
 * The {{order.*}} and {{checkout.*}} values a store automation can use.
 * Pure: the commerce events service gathers the rows.
 */

export type StoreEventKind = 'created' | 'paid' | 'fulfilled' | 'delivered' | 'cancelled';

/** Shopify names cash on delivery in `payment_gateway_names`, e.g. "Cash on Delivery (COD)". */
export function isCashOnDelivery(gateways: string[]): boolean {
    return gateways.some((g) => /cash on delivery|\bcod\b/i.test(g));
}

export function formatMoney(amount: number | string | null | undefined, currency: string | null | undefined): string {
    const n = typeof amount === 'string' ? Number(amount) : amount ?? NaN;
    if (!Number.isFinite(n)) return '';
    try {
        return new Intl.NumberFormat('en-IN', { style: 'currency', currency: currency || 'INR', maximumFractionDigits: 2 }).format(n as number);
    } catch {
        return `${currency ?? ''} ${(n as number).toFixed(2)}`.trim();
    }
}

/** "Linen shirt × 2, Belt" — capped so a big order still fits a template value. */
export function itemsSummary(items: Array<{ title: string; quantity: number }>, max = 200): string {
    const text = items.map((i) => (i.quantity > 1 ? `${i.title} × ${i.quantity}` : i.title)).join(', ');
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export interface OrderForVars {
    name: string | null;
    totalPrice: number | string;
    currency: string;
    financialStatus: string;
    fulfillmentStatus: string;
    paymentGateways: string[];
    lineItems: Array<{ title: string; quantity: number }>;
    fulfillments: Array<{ trackingNumber: string | null; trackingUrl: string | null; trackingCompany: string | null }>;
}

export function orderVars(order: OrderForVars): Record<string, string> {
    const ship = order.fulfillments.find((f) => f.trackingUrl || f.trackingNumber) ?? null;
    return {
        'order.name': order.name ?? '',
        'order.total': formatMoney(order.totalPrice, order.currency),
        'order.items': itemsSummary(order.lineItems),
        'order.payment': isCashOnDelivery(order.paymentGateways) ? 'Cash on delivery' : order.financialStatus === 'PAID' ? 'Paid' : 'Pending',
        'order.status': order.fulfillmentStatus === 'FULFILLED' ? 'Shipped' : order.fulfillmentStatus === 'PARTIAL' ? 'Partly shipped' : 'Processing',
        'order.tracking_url': ship?.trackingUrl ?? '',
        'order.tracking_number': ship?.trackingNumber ?? '',
        'order.carrier': ship?.trackingCompany ?? '',
    };
}

/** A link after the store's address ("1234/checkouts/b19/recover?key=…"), for a template button whose URL ends in {{1}}. */
function pathOf(url: string | null): string {
    if (!url) return '';
    try {
        const u = new URL(url);
        return `${u.pathname}${u.search}`.replace(/^\//, '');
    } catch {
        return '';
    }
}

/** {{invoice.*}}: the GST invoice issued for an order. */
export function invoiceVars(invoice: { invoiceNumber: string; invoiceDate: Date; grandTotal: number | string; currency: string }): Record<string, string> {
    return {
        'invoice.number': invoice.invoiceNumber,
        'invoice.date': invoice.invoiceDate.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }),
        'invoice.total': formatMoney(invoice.grandTotal, invoice.currency),
    };
}

export function checkoutVars(c: {
    recoveryUrl: string | null;
    total: number | string | null;
    currency: string | null;
    items: Array<{ title: string; quantity: number }>;
}): Record<string, string> {
    return {
        'checkout.url': c.recoveryUrl ?? '',
        'checkout.url_path': pathOf(c.recoveryUrl),
        'checkout.total': formatMoney(c.total, c.currency),
        'checkout.items': itemsSummary(c.items),
    };
}
