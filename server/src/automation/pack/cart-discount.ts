/** The merchant's cart-recovery discount, kept in TemplatePack.settings.cartDiscount. */
export interface CartDiscount {
    code: string;
    text: string;
    validDays: number;
}

/** TemplatePack.settings.cartDiscount, when it is a usable one. */
export function readCartDiscount(settings: unknown): CartDiscount | null {
    const d = (settings as { cartDiscount?: Partial<CartDiscount> } | null)?.cartDiscount;
    if (!d || typeof d.code !== 'string' || !d.code || typeof d.text !== 'string' || !d.text) return null;
    const validDays = Number(d.validDays);
    return Number.isInteger(validDays) && validDays >= 1 ? { code: d.code, text: d.text, validDays } : null;
}
