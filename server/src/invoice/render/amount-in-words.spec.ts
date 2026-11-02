import { amountInWords } from './amount-in-words';

describe('amount in words', () => {
    it.each([
        [0, 'Rupees Zero Only'],
        [1, 'Rupees One Only'],
        [19, 'Rupees Nineteen Only'],
        [20, 'Rupees Twenty Only'],
        [47, 'Rupees Forty-Seven Only'],
        [100, 'Rupees One Hundred Only'],
        [101, 'Rupees One Hundred One Only'],
        [1000, 'Rupees One Thousand Only'],
        [5647, 'Rupees Five Thousand Six Hundred Forty-Seven Only'],
        [99999, 'Rupees Ninety-Nine Thousand Nine Hundred Ninety-Nine Only'],
        [100000, 'Rupees One Lakh Only'],
        [522987, 'Rupees Five Lakh Twenty-Two Thousand Nine Hundred Eighty-Seven Only'],
        [10000000, 'Rupees One Crore Only'],
        [10000001, 'Rupees One Crore One Only'],
        [1000000000, 'Rupees One Hundred Crore Only'],
    ])('%d', (amount, words) => {
        expect(amountInWords(amount)).toBe(words);
    });

    it('adds paise when there are any', () => {
        expect(amountInWords(5647.5)).toBe('Rupees Five Thousand Six Hundred Forty-Seven and Fifty Paise Only');
        expect(amountInWords(100000.05)).toBe('Rupees One Lakh and Five Paise Only');
        expect(amountInWords(1.99)).toBe('Rupees One and Ninety-Nine Paise Only');
    });

    it('an amount of paise only says so without a rupee figure', () => {
        expect(amountInWords(0.5)).toBe('Fifty Paise Only');
        expect(amountInWords(0.01)).toBe('One Paise Only');
    });

    it('the largest amount a document can carry', () => {
        expect(amountInWords(999999999.99)).toBe(
            'Rupees Ninety-Nine Crore Ninety-Nine Lakh Ninety-Nine Thousand Nine Hundred Ninety-Nine and Ninety-Nine Paise Only',
        );
    });

    it('a negative amount, which no document carries, reads as its size rather than failing', () => {
        expect(amountInWords(-1500)).toBe('Rupees One Thousand Five Hundred Only');
    });

    it('counts in whole paise, so binary fractions do not lose one', () => {
        expect(amountInWords(0.1 + 0.2)).toBe('Thirty Paise Only');
        expect(amountInWords(1.005 * 1000)).toBe('Rupees One Thousand Five Only');
        expect(amountInWords(4534.1)).toBe('Rupees Four Thousand Five Hundred Thirty-Four and Ten Paise Only');
    });
});
