/**
 * The 1–5 rating in a customer's reply: the first lone digit 1 to 5 ("4 - Good",
 * "I'd say 4/5"), else the number of stars ("⭐⭐⭐⭐"). Null when there is none.
 */
export function parseRating(text: string | null | undefined): number | null {
    if (!text) return null;
    const digit = /(?:^|\D)([1-5])(?!\d)/.exec(text);
    if (digit) return Number(digit[1]);
    const stars = (text.match(/[⭐★]/gu) ?? []).length;
    return stars >= 1 && stars <= 5 ? stars : null;
}

const NO_REVIEW = new Set(['skip', 'no', 'no thanks', 'none']);

/** The review's words, or '' when the customer wrote none or said to skip. */
export function reviewText(text: string | null | undefined): string {
    const t = (text ?? '').trim();
    return NO_REVIEW.has(t.toLowerCase().replace(/[.!]+$/, '')) ? '' : t;
}
