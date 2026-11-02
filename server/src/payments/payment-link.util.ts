import { createHmac, timingSafeEqual } from 'node:crypto';
import { PaymentLinkStatus, Prisma } from '@prisma/client';
import { formatMoney } from '../commerce/order-vars';

/** Razorpay takes INR in paise, as a whole number; the smallest link is ₹1. */
export const MIN_PAISE = 100;
/** Razorpay allows a link to live at most six months, and at least 15 minutes. */
export const MAX_LINK_HOURS = 24 * 180;

export function toPaise(amount: Prisma.Decimal | string | number): number {
    return new Prisma.Decimal(amount).times(100).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toNumber();
}

export function fromPaise(paise: number): Prisma.Decimal {
    return new Prisma.Decimal(paise).dividedBy(100);
}

/**
 * Razorpay signs a webhook with HMAC-SHA256 of the raw body, keyed by the
 * secret entered when the webhook was set up, hex in X-Razorpay-Signature.
 */
export function razorpaySignatureValid(rawBody: Buffer, signature: string, secret: string): boolean {
    const expected = Buffer.from(createHmac('sha256', secret).update(rawBody).digest('hex'));
    const given = Buffer.from(signature);
    return given.length === expected.length && timingSafeEqual(given, expected);
}

const STATUS: Record<string, PaymentLinkStatus> = {
    created: PaymentLinkStatus.CREATED,
    partially_paid: PaymentLinkStatus.PARTIALLY_PAID,
    paid: PaymentLinkStatus.PAID,
    expired: PaymentLinkStatus.EXPIRED,
    cancelled: PaymentLinkStatus.CANCELLED,
};

export function statusFromRazorpay(status: string): PaymentLinkStatus | null {
    return STATUS[status] ?? null;
}

/**
 * The part of the link after the host, for a template whose URL button is
 * `https://rzp.io/{{1}}` — Meta lets only the end of a button URL vary.
 */
export function linkPath(shortUrl: string): string {
    try {
        return new URL(shortUrl).pathname.replace(/^\//, '');
    } catch {
        return '';
    }
}

/** {{payment.*}} for messages: the link, its path for URL buttons, the amount and expiry. */
export function paymentVars(link: { shortUrl: string; amount: Prisma.Decimal | string; currency: string; expiresAt: Date }): Record<string, string> {
    return {
        'payment.link': link.shortUrl,
        'payment.link_path': linkPath(link.shortUrl),
        'payment.amount': formatMoney(link.amount.toString(), link.currency),
        'payment.expires': link.expiresAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }),
    };
}

/** Razorpay's customer contact: 8 to 14 characters, with the country code. */
export function razorpayContact(e164: string | null | undefined): string | undefined {
    if (!e164) return undefined;
    const digits = e164.replace(/[^\d+]/g, '');
    return digits.length >= 8 && digits.length <= 14 ? digits : undefined;
}
