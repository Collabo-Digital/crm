const ONES = [
    '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
    'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

/** 1 to 99: "Nineteen", "Forty-Seven". */
function belowHundred(n: number): string {
    return n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? `-${ONES[n % 10]}` : ''}`;
}

/** A whole number in the Indian system: thousand, lakh, crore, and crores of crores. */
function indianWords(n: number): string {
    const crore = Math.floor(n / 1e7);
    const lakh = Math.floor((n % 1e7) / 1e5);
    const thousand = Math.floor((n % 1e5) / 1e3);
    const hundred = Math.floor((n % 1e3) / 100);
    const rest = n % 100;
    return [
        crore ? `${indianWords(crore)} Crore` : '',
        lakh ? `${belowHundred(lakh)} Lakh` : '',
        thousand ? `${belowHundred(thousand)} Thousand` : '',
        hundred ? `${ONES[hundred]} Hundred` : '',
        rest ? belowHundred(rest) : '',
    ]
        .filter(Boolean)
        .join(' ');
}

/**
 * A rupee amount as words: "Rupees Five Thousand Six Hundred Forty-Seven
 * Only", "Rupees One Lakh and Fifty Paise Only", "Fifty Paise Only". Worked
 * in whole paise, so 0.1 + 0.2 still reads as Thirty Paise. Documents carry
 * no negative totals; one would read as its size.
 */
export function amountInWords(amount: number): string {
    const paise = Math.round(Math.abs(amount) * 100);
    const rupees = Math.floor(paise / 100);
    const cents = paise % 100;
    if (rupees === 0 && cents > 0) return `${belowHundred(cents)} Paise Only`;
    return `Rupees ${rupees === 0 ? 'Zero' : indianWords(rupees)}${cents ? ` and ${belowHundred(cents)} Paise` : ''} Only`;
}
