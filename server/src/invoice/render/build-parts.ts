import { zonedParts } from '../../common/utils/zoned-date.util';
import { getStateName } from '../../gst/constants/indian-states';
import type { BusinessId, InvoiceSettings } from '../../organization-settings/schemas/invoice-settings.schema';
import type { StoreProfileSettings } from '../../organization-settings/schemas/store-profile-settings.schema';
import { maskPhone } from '../../pos/pos-bill-link';
import type { DocField, DocumentKind, DocumentTheme } from './document-model';
import { formatMoney } from './money';
import type { RenderSnapshot } from './render-snapshot';

/**
 * What the invoice builder and the bill builder word the same way: dates,
 * states, the seller's IDs and contacts, the footer, the buyer's contact,
 * till payments and the UPI link. Pure, like the builders.
 */

export type DocumentBrand = RenderSnapshot['brand'];

/** Rule 5(1)(f), word for word. */
export const COMPOSITION_LINE = 'Composition taxable person, not eligible to collect tax on supplies';

/** Rule 46(s), word for word. */
export const E_INVOICE_DECLARATION =
    'I/We hereby declare that though our aggregate turnover in any preceding financial year from 2017-18 onwards is more than the aggregate turnover notified under sub-rule (4) of rule 48, we are not required to prepare an invoice in terms of the provisions of the said sub-rule.';

export const round2 = (n: number) => Math.round(n * 100) / 100;
export const sum = (values: number[]) => round2(values.reduce((s, v) => s + v, 0));

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "27 Oct 2026" in the organization's time zone. Spelt out here because ICU writes September "Sept". */
export function docDate(date: Date, timeZone: string): string {
    const { year, month, day } = zonedParts(date, timeZone);
    return `${day} ${MONTHS[month - 1]} ${year}`;
}

/** "25 Oct 2026, 18:42". */
export function docDateTime(date: Date, timeZone: string): string {
    const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone }).format(date);
    return `${docDate(date, timeZone)}, ${time}`;
}

/** "Kerala (32)". */
export function stateLabel(code: string | null | undefined, name?: string | null): string | null {
    if (!code) return null;
    return `${name?.trim() || getStateName(code) || code} (${code})`;
}

const ALIASES: Record<string, readonly string[]> = {
    address1: ['address1', 'address_1'],
    address2: ['address2', 'address_2'],
    city: ['city'],
    province: ['province', 'province_code', 'state'],
    zip: ['zip', 'postal_code', 'pincode'],
    country: ['country', 'country_code'],
    company: ['company'],
};

/** A text field of a loosely typed address blob, trimmed, or ''. */
export function addressField(address: unknown, key: string): string {
    const a = (address && typeof address === 'object' ? address : {}) as Record<string, unknown>;
    const value = a[key];
    return typeof value === 'string' ? value.trim() : '';
}

/** Display lines of a loosely typed address blob (Shopify snake_case or CRM camelCase). */
export function addressLines(address: unknown): string[] {
    const pick = (field: string) => {
        for (const key of ALIASES[field] ?? [field]) {
            const value = addressField(address, key);
            if (value) return value;
        }
        return '';
    };
    const street = [pick('address1'), pick('address2')].filter(Boolean).join(', ');
    const region = [[pick('city'), pick('zip')].filter(Boolean).join(' '), pick('province')].filter(Boolean).join(', ');
    return [pick('company'), street, region, pick('country')].filter(Boolean);
}

/** "12 MG Road, Kochi, Kerala 682016" from an address blob in the app's canonical keys. */
export function addressLine(address: unknown): string | null {
    const part = (key: string) => addressField(address, key);
    const text = [part('address1'), part('address2'), part('city'), [part('province'), part('zip')].filter(Boolean).join(' ')]
        .filter(Boolean)
        .join(', ');
    return text || null;
}

/** The brand line beside the legal name: null when blank or the same name, ignoring case. */
export function tradeNameBeside(tradeName: string, legalName: string): string | null {
    const name = tradeName.trim();
    return name && name.toLowerCase() !== legalName.trim().toLowerCase() ? name : null;
}

const ID_LABELS: Record<Exclude<BusinessId['type'], 'CUSTOM'>, string> = {
    CIN: 'CIN',
    FSSAI: 'FSSAI Lic. No.',
    UDYAM: 'Udyam Reg. No.',
    IEC: 'IEC',
    LUT: 'LUT',
    DL: 'D.L. No.',
};

/**
 * PAN (characters 3 to 12 of the GSTIN) when the settings show it, then the
 * brand's IDs meant for this paper: `onA4` for documents, `onReceipt` for the
 * till's receipt.
 */
export function businessIds(design: InvoiceSettings, gstin: string | null, paper: 'onA4' | 'onReceipt'): DocField[] {
    const pan = design.showPan && gstin?.length === 15 ? [{ label: 'PAN', value: gstin.slice(2, 12) }] : [];
    const ids = design.businessIds
        .filter((id) => id[paper])
        .map((id) => ({ label: id.type === 'CUSTOM' ? id.label : ID_LABELS[id.type], value: id.value }));
    return [...pan, ...ids];
}

/** "+91 80 4000 0000 · care@brand.in · brand.in", the website without its scheme; null when hidden or blank. */
export function sellerContactLine(design: InvoiceSettings, brand: DocumentBrand): string | null {
    if (!design.showSupportContact) return null;
    const website = brand.website.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    return [brand.supportPhone.trim(), brand.supportEmail.trim(), website].filter(Boolean).join(' · ') || null;
}

/** "Registered office: … · CIN …" when there is an office, then "Questions about this order? WhatsApp … · email". */
export function footerLines(design: InvoiceSettings, brand: DocumentBrand): string[] {
    const lines: string[] = [];
    const office = design.registeredOffice.trim();
    if (office) {
        const cin = design.businessIds.find((id) => id.type === 'CIN' && id.onA4)?.value;
        lines.push([`Registered office: ${office}`, cin && `CIN ${cin}`].filter(Boolean).join(' · '));
    }
    const whatsapp = brand.whatsappPhone.trim();
    const reach = [whatsapp && `WhatsApp ${whatsapp}`, brand.supportEmail.trim()].filter(Boolean);
    if (design.showSupportContact && reach.length) lines.push(`Questions about this order? ${reach.join(' · ')}`);
    return lines;
}

/** The footer note for a document with no signatory block. */
export function computerGeneratedNote(kind: DocumentKind): string {
    return `This is a computer-generated ${kind === 'BILL' || kind === 'BILL_OF_SUPPLY' ? 'bill' : 'invoice'} and does not need a signature.`;
}

/** "a•••@gmail.com". */
export function maskEmail(email: string): string {
    const at = email.lastIndexOf('@');
    return at > 0 ? `${email[0]}•••${email.slice(at)}` : '•••';
}

/** The buyer's phone and email as `customerContact` shows them, or null. */
export function buyerContactLine(mode: InvoiceSettings['customerContact'], phone: string | null, email: string | null): string | null {
    if (mode === 'hide') return null;
    const p = phone?.trim() || null;
    const e = email?.trim() || null;
    const parts = mode === 'mask' ? [maskPhone(p), e && maskEmail(e)] : [p, e];
    return parts.filter(Boolean).join(' · ') || null;
}

/** Classic for a GST-registered buyer when the settings say so; the chosen theme otherwise. */
export function themeOf(design: InvoiceSettings, buyerGstin: string | null): DocumentTheme {
    return design.classicForB2b && buyerGstin ? 'classic' : design.theme;
}

/** The terms, one per line. */
export function termsOf(design: InvoiceSettings): string[] {
    return design.terms
        .split(/\r?\n/)
        .map((t) => t.trim())
        .filter(Boolean);
}

/** The return policy, then its link. */
export function returnsOf(design: InvoiceSettings): string | null {
    return [design.returnPolicy.trim(), design.returnPolicyUrl.trim()].filter(Boolean).join(' ') || null;
}

/** The `upi://pay` link a UPI QR carries, built as the till builds its own (client pos-cart.ts). */
export function upiPayUri(upiId: string, payee: string, amount: number, note: string): string {
    return [`upi://pay?pa=${upiId.trim()}`, `pn=${encodeURIComponent(payee.trim())}`, `am=${amount.toFixed(2)}`, 'cu=INR', `tn=${encodeURIComponent(note)}`].join('&');
}

const TILL_METHODS: Record<string, string> = { CASH: 'Cash', UPI: 'UPI', CARD: 'Card', OTHER: 'Other' };

/** "Cash", "UPI", "Card": a payment method of the till or of an order made in Collabo. */
export const tillMethodLabel = (method: string) => TILL_METHODS[method] ?? method;

/** The methods of a sale's payments, once each: "Cash + UPI". */
export function methodsOf(payments: Array<{ method: string }>): string | null {
    return [...new Set(payments.map((p) => tillMethodLabel(p.method)))].join(' + ') || null;
}

/** "UPI · Ref 629312345678 · 25 Oct 2026, 18:42 · ₹1,500.00". */
export function tillPaymentLine(
    payment: { method: string; amount: number; reference: string | null; at: Date },
    timeZone: string,
    currency: string,
): string {
    return [
        tillMethodLabel(payment.method),
        payment.reference?.trim() && `Ref ${payment.reference.trim()}`,
        docDateTime(payment.at, timeZone),
        formatMoney(payment.amount, currency),
    ]
        .filter(Boolean)
        .join(' · ');
}

/** The latest of some instants, or null. */
export function latest(dates: Array<Date | null | undefined>): Date | null {
    return dates.reduce<Date | null>((a, d) => (d && (!a || d > a) ? d : a), null);
}

/** The brand as a document issued now snapshots it (design 4.2). */
export function currentBrand(
    org: { name: string; website: string | null },
    profile: StoreProfileSettings,
    upiId: string | null,
): DocumentBrand {
    return {
        tradeName: profile.storeName.trim() || org.name,
        logoStorageKey: profile.logoStorageKey || null,
        supportPhone: profile.supportPhone,
        whatsappPhone: profile.whatsappPhone,
        supportEmail: profile.supportEmail,
        website: profile.website.trim() || org.website || '',
        upiId,
    };
}

/** How a document issued before snapshots renders: an ordinary tax invoice in the current settings. */
export function currentSnapshot(design: InvoiceSettings, brand: DocumentBrand): RenderSnapshot {
    return { v: 1, documentType: 'TAX_INVOICE', composition: false, eInvoiceDeclaration: false, design, brand };
}
