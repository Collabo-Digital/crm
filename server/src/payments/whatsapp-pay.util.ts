/**
 * The WhatsApp Pay "Review and Pay" bill (interactive `order_details`), as
 * Meta's payments docs require it:
 *  - amounts are integers with offset 100 (paise), INR only;
 *  - subtotal = Σ item amount × quantity, and
 *    total = subtotal + tax + shipping − discount, exactly;
 *  - tax is a positive integer, so a tax-inclusive price is shown net of tax
 *    and the order's GST is the tax line;
 *  - items carry retailer_id and the order catalog_id only when every item is
 *    in the number's catalog; otherwise each item names its country of
 *    origin, importer and importer address;
 *  - shipped physical goods name a beneficiary with an Indian address.
 */

export const ORDER_DETAILS_MAX_PAISE = 5_00_000 * 100;

export interface BillLine {
    name: string;
    unitPaise: number;
    quantity: number;
    retailerId: string | null;
}

export interface IndianAddress {
    name: string;
    address_line1: string;
    address_line2?: string;
    city: string;
    state: string;
    postal_code: string;
}

export interface BillInput {
    referenceId: string;
    lines: BillLine[];
    totalPaise: number;
    taxPaise: number;
    shippingPaise: number;
    discountPaise: number;
    catalogId: string | null;
    importer: { name: string; address: IndianAddress } | null;
    beneficiary: IndianAddress;
    configuration: { name: string; provider: string };
    /** Razorpay `receipt`, at most 40 characters. */
    receipt: string;
    expiresAt: Date;
}

const money = (value: number) => ({ value, offset: 100 });

export function buildOrderDetails(input: BillInput): Record<string, unknown> {
    const fromCatalog = !!input.catalogId && input.lines.every((l) => l.retailerId);
    if (!fromCatalog && !input.importer) throw new Error('Items not in the WhatsApp catalog need the importer’s name and address (your GSTIN registration).');

    let lines = input.lines;
    let subtotal = lines.reduce((n, l) => n + l.unitPaise * l.quantity, 0);
    let tax = input.totalPaise - subtotal - input.shippingPaise + input.discountPaise;
    let discount = input.discountPaise;
    if (tax < input.taxPaise && input.taxPaise > 0 && subtotal > 0) {
        // Prices include tax: show each item net, and the order's tax as the tax line.
        const target = input.totalPaise - input.shippingPaise + discount - input.taxPaise;
        lines = lines.map((l) => ({ ...l, unitPaise: Math.round((l.unitPaise * target) / subtotal) }));
        subtotal = lines.reduce((n, l) => n + l.unitPaise * l.quantity, 0);
        tax = input.totalPaise - subtotal - input.shippingPaise + discount;
    }
    if (tax < 0) {
        // Rounding or a discount larger than recorded: the difference is discount, never negative tax.
        discount -= tax;
        tax = 0;
    }

    const importer = input.importer
        ? {
            importer_name: input.importer.name.slice(0, 200),
            importer_address: {
                address_line1: input.importer.address.address_line1,
                ...(input.importer.address.address_line2 ? { address_line2: input.importer.address.address_line2 } : {}),
                city: input.importer.address.city,
                zone_code: input.importer.address.state,
                postal_code: input.importer.address.postal_code,
                country_code: 'IN',
            },
        }
        : null;

    return {
        reference_id: input.referenceId,
        type: 'physical-goods',
        beneficiaries: [{ ...input.beneficiary, country: 'India' }],
        currency: 'INR',
        total_amount: money(input.totalPaise),
        payment_settings: [{
            type: 'payment_gateway',
            payment_gateway: {
                type: input.configuration.provider,
                configuration_name: input.configuration.name,
                ...(input.configuration.provider === 'razorpay' ? { razorpay: { receipt: input.receipt.slice(0, 40), notes: { collabo_reference: input.referenceId } } } : {}),
            },
        }],
        order: {
            status: 'pending',
            ...(fromCatalog ? { catalog_id: input.catalogId } : {}),
            items: lines.map((l) => ({
                ...(fromCatalog ? { retailer_id: l.retailerId } : { country_of_origin: 'India', ...importer }),
                name: l.name.slice(0, 60),
                amount: money(l.unitPaise),
                quantity: l.quantity,
            })),
            subtotal: money(subtotal),
            tax: { ...money(tax), description: 'GST' },
            ...(input.shippingPaise ? { shipping: money(input.shippingPaise) } : {}),
            ...(discount ? { discount: money(discount) } : {}),
            expiration: { timestamp: String(Math.floor(input.expiresAt.getTime() / 1000)), description: 'This payment request expires' },
        },
    };
}

type Obj = Record<string, unknown>;
const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * An Indian delivery address from an order, draft or customer address in
 * Shopify's shape or the CRM's ({address1, city, province, zip}). Null when
 * it is not complete enough for Meta, or not in India.
 */
export function indianAddress(raw: unknown, fallbackName: string | null): IndianAddress | null {
    const a = (raw ?? null) as Obj | null;
    if (!a) return null;
    const country = text(a.country_code) ?? text(a.countryCode) ?? text(a.country);
    if (country && !/^(in|india)$/i.test(country)) return null;
    const postal = (text(a.zip) ?? text(a.postal_code) ?? '').replace(/\s/g, '');
    const line1 = text(a.address1) ?? text(a.address_line1);
    const city = text(a.city);
    const state = text(a.province) ?? text(a.province_code) ?? text(a.state);
    const name = text(a.name) ?? ([text(a.first_name), text(a.last_name)].filter(Boolean).join(' ') || fallbackName);
    if (!line1 || !city || !state || !/^\d{6}$/.test(postal) || !name) return null;
    const line2 = text(a.address2) ?? text(a.address_line2);
    return {
        name: name.slice(0, 200),
        address_line1: line1.slice(0, 100),
        ...(line2 ? { address_line2: line2.slice(0, 100) } : {}),
        city,
        state,
        postal_code: postal,
    };
}

/** Meta spells configuration states "Active", "Needs_Testing" and "Needs Testing". */
export function configurationActive(status: string | null | undefined): boolean {
    return (status ?? '').replace(/[\s_]/g, '').toLowerCase() === 'active';
}
