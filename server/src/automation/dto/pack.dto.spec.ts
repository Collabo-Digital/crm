import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { SetCartDiscountDto, TurnOnPackDto } from './pack.dto';

/** The app's own pipe (main.ts), so these are the bodies the routes really accept. */
const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true, transformOptions: { enableImplicitConversion: true } });
const check = (metatype: unknown, body: unknown) => pipe.transform(body, { type: 'body', metatype: metatype as never, data: '' });

describe('PUT /automations/pack/cart-discount body', () => {
    it('takes the discount, wrapped, or null to remove it', async () => {
        await expect(check(SetCartDiscountDto, { cartDiscount: null })).resolves.toEqual({ cartDiscount: null });
        await expect(check(SetCartDiscountDto, { cartDiscount: { code: 'save10', text: '10%', validDays: 7 } })).resolves.toMatchObject({ cartDiscount: { code: 'save10', text: '10%', validDays: 7 } });
        await expect(check(SetCartDiscountDto, { cartDiscount: { code: 'SAVE10', text: '₹200', validDays: '30' } })).resolves.toMatchObject({ cartDiscount: { validDays: 30 } });
    });

    it('refuses a missing, partial or malformed discount, and the old flat shape', async () => {
        for (const body of [
            {},
            { cartDiscount: { code: 'SAVE10' } },
            { cartDiscount: { code: 'x!', text: '10%', validDays: 7 } },
            { cartDiscount: { code: 'SAVE10', text: '10%', validDays: 31 } },
            { cartDiscount: { code: 'SAVE10', text: '10%', validDays: 7, extra: 1 } },
            { code: 'SAVE10', text: '10%', validDays: 7 },
        ]) {
            await expect(check(SetCartDiscountDto, body)).rejects.toThrow(BadRequestException);
        }
    });
});

describe('POST /automations/pack/turn-on body', () => {
    it('takes no keys or a list of them', async () => {
        await expect(check(TurnOnPackDto, {})).resolves.toEqual({});
        await expect(check(TurnOnPackDto, { keys: ['review_request'] })).resolves.toEqual({ keys: ['review_request'] });
        await expect(check(TurnOnPackDto, { keys: 'review_request' })).rejects.toThrow(BadRequestException);
    });
});
