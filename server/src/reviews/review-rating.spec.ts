import { parseRating, reviewText } from './review-rating';

describe('parseRating', () => {
    it('reads the digit a rating button starts with', () => {
        expect(parseRating('5 - Excellent')).toBe(5);
        expect(parseRating('1 - Very poor')).toBe(1);
    });

    it('reads a digit inside a typed answer', () => {
        expect(parseRating('I would give it 4/5')).toBe(4);
    });

    it('counts stars when there is no digit', () => {
        expect(parseRating('⭐⭐⭐')).toBe(3);
        expect(parseRating('★★★★★ loved it')).toBe(5);
    });

    it('finds none in other numbers or plain words', () => {
        expect(parseRating('10/10')).toBeNull();
        expect(parseRating('order 2024')).toBeNull();
        expect(parseRating('Loved it')).toBeNull();
        expect(parseRating('')).toBeNull();
        expect(parseRating(null)).toBeNull();
    });
});

describe('reviewText', () => {
    it('keeps what the customer wrote', () => {
        expect(reviewText('  Soft fabric, fits well. ')).toBe('Soft fabric, fits well.');
    });

    it('treats skip and no as no review', () => {
        expect(reviewText('Skip')).toBe('');
        expect(reviewText('no thanks!')).toBe('');
        expect(reviewText('   ')).toBe('');
        expect(reviewText(undefined)).toBe('');
    });
});
