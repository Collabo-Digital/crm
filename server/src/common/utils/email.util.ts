import { Transform } from 'class-transformer';

/**
 * The one form an email address is stored and looked up in. Mailboxes are
 * case-insensitive in practice, so 'Priya@Shop.com' and 'priya@shop.com' must
 * name the same account.
 */
export function normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
}

/** DTO field decorator: normalise an email before it is validated. */
export const NormalizeEmail = () =>
    Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? normalizeEmail(value) : value));
