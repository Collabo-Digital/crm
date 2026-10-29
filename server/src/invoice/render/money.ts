const grouping = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "5,647.00", "1,23,456.78", "−142.86": Indian digit grouping, two decimals, a true minus sign. */
export function formatAmount(value: number): string {
    const text = grouping.format(Math.abs(value));
    return value <= -0.005 ? `−${text}` : text;
}

/** "₹5,647.00" for rupees, "USD 12.00" for anything else. */
export function formatMoney(value: number, currency: string): string {
    const sign = currency === 'INR' ? '₹' : `${currency} `;
    const text = `${sign}${grouping.format(Math.abs(value))}`;
    return value <= -0.005 ? `−${text}` : text;
}
