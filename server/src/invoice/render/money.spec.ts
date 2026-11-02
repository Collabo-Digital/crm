import { formatAmount, formatMoney } from './money';

describe('amounts on documents', () => {
    it('groups digits the Indian way, to the paisa', () => {
        expect(formatAmount(5647)).toBe('5,647.00');
        expect(formatAmount(123456.785)).toBe('1,23,456.79');
        expect(formatAmount(12345678.9)).toBe('1,23,45,678.90');
    });

    it('prints a true minus sign, and never "−0.00"', () => {
        expect(formatAmount(-142.86)).toBe('−142.86');
        expect(formatAmount(-0.001)).toBe('0.00');
    });

    it('puts ₹ on rupees and the code on other currencies', () => {
        expect(formatMoney(5647, 'INR')).toBe('₹5,647.00');
        expect(formatMoney(-50, 'INR')).toBe('−₹50.00');
        expect(formatMoney(12, 'USD')).toBe('USD 12.00');
    });
});
