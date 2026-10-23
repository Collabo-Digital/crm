/**
 * Shopify `checkouts/create` and `checkouts/update` webhook bodies (the REST
 * checkout shape). Pure: the webhook handler stores what this returns.
 */

export interface ParsedCheckout {
    externalId: string;
    token: string | null;
    /** Shopify's link that reopens the checkout with its cart. */
    recoveryUrl: string | null;
    phone: string | null;
    email: string | null;
    firstName: string | null;
    customerExternalId: string | null;
    completedAt: Date | null;
    currency: string | null;
    total: number | null;
    items: Array<{ variantId: string | null; productId: string | null; title: string; quantity: number; price: number | null }>;
}

type Obj = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null);
const num = (v: unknown) => {
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
    return Number.isFinite(n) ? n : null;
};
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null);

export function parseCheckout(raw: unknown): ParsedCheckout | null {
    const c = obj(raw);
    const id = str(c?.id);
    if (!c || !id) return null;
    const customer = obj(c.customer);
    const shipping = obj(c.shipping_address);
    const billing = obj(c.billing_address);
    const completed = str(c.completed_at);
    return {
        externalId: id,
        token: str(c.token),
        recoveryUrl: str(c.abandoned_checkout_url),
        // The number the buyer typed at checkout comes first; the profile's last.
        phone: str(c.phone) ?? str(c.sms_marketing_phone) ?? str(shipping?.phone) ?? str(billing?.phone) ?? str(customer?.phone),
        email: str(c.email) ?? str(customer?.email),
        firstName: str(customer?.first_name) ?? str(shipping?.first_name) ?? str(billing?.first_name),
        customerExternalId: str(customer?.id),
        completedAt: completed ? new Date(completed) : null,
        currency: str(c.presentment_currency) ?? str(c.currency),
        total: num(c.total_price),
        items: (Array.isArray(c.line_items) ? c.line_items : []).map((li) => {
            const l = obj(li) ?? {};
            return {
                variantId: str(l.variant_id),
                productId: str(l.product_id),
                title: str(l.title) ?? 'Item',
                quantity: num(l.quantity) ?? 1,
                price: num(l.price),
            };
        }),
    };
}
