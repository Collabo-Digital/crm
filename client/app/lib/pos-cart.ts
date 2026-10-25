import { parsePhoneNumberFromString } from "libphonenumber-js/min";
import type {
  PosApprovalReason,
  PosCustomer,
  PosDiscount,
  PosProduct,
  PosSaleCustomerInput,
  PosSaleLineInput,
  PosSettings,
} from "~/types/api";

/**
 * The till's cart and the preview of its totals.
 *
 * The preview mirrors the server's rules — prices include GST, a cart
 * discount is spread over the lines, round-off takes the total to the nearest
 * rupee — but the server's numbers are final: the success screen and receipt
 * show what it returns, never these.
 */

export interface PosCartLine {
  /** The variant id, or "custom:<id>" for a custom item. */
  key: string;
  product: PosProduct | null;
  title: string;
  variantTitle: string | null;
  quantity: number;
  /** The catalogue price (or the price typed for a custom item). */
  listPrice: number;
  unitPrice: number;
  discount: PosDiscount | null;
  gstRate: number | null;
}

export type PosCartCustomer =
  | { kind: "existing"; customer: PosCustomer; whatsappOptIn: boolean }
  | {
      kind: "new";
      phone: string;
      name: string;
      gstin?: string;
      billingStateCode?: string;
      whatsappOptIn: boolean;
    };

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export function lineGross(line: Pick<PosCartLine, "unitPrice" | "quantity">): number {
  return round2(line.unitPrice * line.quantity);
}

/** Rupees off, capped at what is being discounted. */
export function discountAmount(discount: PosDiscount | null, base: number): number {
  if (!discount || !(discount.value > 0) || base <= 0) return 0;
  return discount.type === "percent"
    ? round2((base * Math.min(discount.value, 100)) / 100)
    : round2(Math.min(discount.value, base));
}

export function lineDiscount(line: PosCartLine): number {
  return discountAmount(line.discount, lineGross(line));
}

export function lineNet(line: PosCartLine): number {
  return round2(lineGross(line) - lineDiscount(line));
}

export interface PosTotals {
  items: number;
  subtotal: number;
  lineDiscounts: number;
  cartDiscount: number;
  total: number;
  /** Null when a line's GST rate is unknown, so no honest estimate exists. */
  gstEstimate: number | null;
  roundOff: number;
  payable: number;
}

export function cartTotals(lines: PosCartLine[], cartDiscount: PosDiscount | null, roundOff: boolean): PosTotals {
  const subtotal = round2(lines.reduce((s, l) => s + lineGross(l), 0));
  const lineDiscounts = round2(lines.reduce((s, l) => s + lineDiscount(l), 0));
  const afterLines = round2(subtotal - lineDiscounts);
  const cartOff = discountAmount(cartDiscount, afterLines);
  const total = round2(afterLines - cartOff);
  const payable = roundOff ? Math.round(total) : total;

  let gstEstimate: number | null = lines.length ? 0 : null;
  for (const line of lines) {
    if (line.gstRate == null || gstEstimate == null) {
      gstEstimate = null;
      break;
    }
    const net = lineNet(line);
    const share = afterLines > 0 ? (net / afterLines) * cartOff : 0;
    const amount = net - share;
    gstEstimate += amount - (amount * 100) / (100 + line.gstRate);
  }

  return {
    items: lines.reduce((s, l) => s + l.quantity, 0),
    subtotal,
    lineDiscounts,
    cartDiscount: cartOff,
    total,
    gstEstimate: gstEstimate == null ? null : round2(gstEstimate),
    roundOff: round2(payable - total),
    payable,
  };
}

/** True when this line would sell more than the store holds. */
export function oversold(line: PosCartLine): boolean {
  const p = line.product;
  return !!p && p.trackQuantity && p.stockAtStore != null && line.quantity > p.stockAtStore;
}

export interface ApprovalNeed {
  reason: PosApprovalReason;
  /** Rupees the approval covers: the discount, or how far prices were lowered. */
  amount: number;
  /** What the manager is asked to allow, as a sentence. */
  summary: string;
  /** Changes when the discounts or prices change, so an old approval stops counting. */
  signature: string;
}

/**
 * Whether this cart needs a manager's PIN before it is paid: a discount above
 * the limit (any line's, or all discounts against the subtotal), or a
 * catalogue price changed while price changes need approval. The sale carries
 * one approval, so a cart that needs both asks once, for the discount.
 */
export function approvalNeeded(lines: PosCartLine[], cartDiscount: PosDiscount | null, settings: PosSettings): ApprovalNeed | null {
  const totals = cartTotals(lines, cartDiscount, false);
  const signature = JSON.stringify([
    lines.map((l) => [l.key, l.quantity, l.unitPrice, l.discount]),
    cartDiscount,
  ]);

  const limit = settings.discountApprovalPercent;
  if (limit != null && totals.subtotal > 0) {
    const linePercents = lines.map((l) => (lineGross(l) > 0 ? (lineDiscount(l) / lineGross(l)) * 100 : 0));
    const discounts = totals.lineDiscounts + totals.cartDiscount;
    const percent = Math.max((discounts / totals.subtotal) * 100, ...linePercents);
    if (percent > limit + 0.001) {
      return {
        reason: "discount",
        amount: round2(discounts),
        summary: `This sale has a discount of ${formatPercent(percent)}, above the ${formatPercent(limit)} a cashier can give.`,
        signature,
      };
    }
  }

  if (settings.priceOverrideNeedsApproval) {
    const changed = lines.filter((l) => l.product && l.unitPrice !== l.listPrice);
    if (changed.length) {
      const lowered = round2(changed.reduce((s, l) => s + (l.listPrice - l.unitPrice) * l.quantity, 0));
      return {
        reason: "price_override",
        amount: lowered,
        summary:
          changed.length === 1
            ? `The price of ${changed[0].title} was changed.`
            : `The prices of ${changed.length} items were changed.`,
        signature,
      };
    }
  }
  return null;
}

function formatPercent(n: number): string {
  return `${Number.isInteger(n) ? n : n.toFixed(1)}%`;
}

export function saleLines(lines: PosCartLine[]): PosSaleLineInput[] {
  return lines.map((l) => {
    const discount = l.discount && l.discount.value > 0 ? l.discount : undefined;
    if (!l.product) {
      return {
        custom: { title: l.title, unitPrice: l.unitPrice, gstRate: l.gstRate ?? undefined },
        quantity: l.quantity,
        discount,
      };
    }
    return {
      variantId: l.product.variantId,
      quantity: l.quantity,
      unitPrice: l.unitPrice !== l.listPrice ? l.unitPrice : undefined,
      discount,
    };
  });
}

export function saleCustomer(customer: PosCartCustomer | null): PosSaleCustomerInput | undefined {
  if (!customer) return undefined;
  if (customer.kind === "existing") {
    return { customerId: customer.customer.id, whatsappOptIn: customer.whatsappOptIn };
  }
  return {
    phone: customer.phone,
    name: customer.name.trim() || undefined,
    gstin: customer.gstin?.trim() || undefined,
    billingStateCode: customer.billingStateCode || undefined,
    whatsappOptIn: customer.whatsappOptIn,
  };
}

/**
 * Notes a customer might hand over for `due`: the exact amount, then the next
 * round ₹50, ₹100, ₹500 and ₹2,000 above it.
 */
export function quickCashAmounts(due: number): number[] {
  if (due <= 0) return [];
  const amounts = [round2(due)];
  for (const step of [50, 100, 500, 2000]) {
    const next = Math.ceil(due / step) * step;
    if (next > due && !amounts.includes(next)) amounts.push(next);
  }
  return amounts;
}

/**
 * A UPI intent link (NPCI's upi://pay). A VPA holds only letters, digits and
 * ".-_@", so `pa` goes in as typed — some UPI apps refuse an encoded "@".
 */
export function upiPayUri({ upiId, payeeName, amount, note }: { upiId: string; payeeName: string; amount: number; note: string }): string {
  return [
    `upi://pay?pa=${upiId.trim()}`,
    `pn=${encodeURIComponent(payeeName.trim())}`,
    `am=${amount.toFixed(2)}`,
    "cu=INR",
    `tn=${encodeURIComponent(note)}`,
  ].join("&");
}

/** A short reference for the UPI note and the customer's payment history. */
export function billRef(clientSaleId: string): string {
  return clientSaleId.replace(/-/g, "").slice(0, 8).toUpperCase();
}

/**
 * crypto.randomUUID exists only on HTTPS and localhost; a till opened on a LAN
 * address over plain HTTP still needs an id, and getRandomValues works there.
 */
export function newClientSaleId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** GST state codes for a customer's billing state (place of supply). */
export const GST_STATES: Array<{ code: string; name: string }> = [
  { code: "01", name: "Jammu & Kashmir" },
  { code: "02", name: "Himachal Pradesh" },
  { code: "03", name: "Punjab" },
  { code: "04", name: "Chandigarh" },
  { code: "05", name: "Uttarakhand" },
  { code: "06", name: "Haryana" },
  { code: "07", name: "Delhi" },
  { code: "08", name: "Rajasthan" },
  { code: "09", name: "Uttar Pradesh" },
  { code: "10", name: "Bihar" },
  { code: "11", name: "Sikkim" },
  { code: "12", name: "Arunachal Pradesh" },
  { code: "13", name: "Nagaland" },
  { code: "14", name: "Manipur" },
  { code: "15", name: "Mizoram" },
  { code: "16", name: "Tripura" },
  { code: "17", name: "Meghalaya" },
  { code: "18", name: "Assam" },
  { code: "19", name: "West Bengal" },
  { code: "20", name: "Jharkhand" },
  { code: "21", name: "Odisha" },
  { code: "22", name: "Chhattisgarh" },
  { code: "23", name: "Madhya Pradesh" },
  { code: "24", name: "Gujarat" },
  { code: "26", name: "Dadra & Nagar Haveli and Daman & Diu" },
  { code: "27", name: "Maharashtra" },
  { code: "29", name: "Karnataka" },
  { code: "30", name: "Goa" },
  { code: "31", name: "Lakshadweep" },
  { code: "32", name: "Kerala" },
  { code: "33", name: "Tamil Nadu" },
  { code: "34", name: "Puducherry" },
  { code: "35", name: "Andaman & Nicobar Islands" },
  { code: "36", name: "Telangana" },
  { code: "37", name: "Andhra Pradesh" },
  { code: "38", name: "Ladakh" },
];

/** "+919847012345" as "+91 98470 12345". */
export function formatPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  return parsePhoneNumberFromString(phone, "IN")?.formatInternational() ?? phone;
}

export const GSTIN_PATTERN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
