import { BadRequestException } from '@nestjs/common';
import { OrderFinancialStatus } from '@prisma/client';
import {
    discountNeedsApproval,
    mainPaymentMethod,
    payableFor,
    paymentStatus,
    settlePayments,
    spreadDiscounts,
} from './pos-pricing';

/**
 * The bill arithmetic the server is the authority on: the billing screen's
 * figures are only a preview, so these decide what the customer pays.
 */

describe('spreadDiscounts', () => {
    it('turns a line percentage into an amount off that line', () => {
        expect(spreadDiscounts([{ gross: 1000, discount: { type: 'percent', value: 10 } }, { gross: 500 }])).toEqual([100, 0]);
    });

    it('takes a line amount as it is', () => {
        expect(spreadDiscounts([{ gross: 1000, discount: { type: 'amount', value: 49.5 } }])).toEqual([49.5]);
    });

    it('spreads a cart discount over the lines by their value, the remainder on the last', () => {
        // ₹100 over 300 + 200 + 100: 50 + 33.33 + the remaining 16.67.
        const out = spreadDiscounts([{ gross: 300 }, { gross: 200 }, { gross: 100 }], { type: 'amount', value: 100 });
        expect(out).toEqual([50, 33.33, 16.67]);
        expect(out.reduce((s, d) => s + d, 0)).toBeCloseTo(100, 2);
    });

    it('spreads a cart percentage on what is left after the line discounts', () => {
        // Line 1: 1000 − 100 = 900 left; line 2: 100. 10% of 1000 = 100, split 90 / 10.
        const out = spreadDiscounts(
            [{ gross: 1000, discount: { type: 'amount', value: 100 } }, { gross: 100 }],
            { type: 'percent', value: 10 },
        );
        expect(out).toEqual([190, 10]);
    });

    it('never gives a line more discount than it is worth, even at 100% off', () => {
        const lines = [{ gross: 0.29 }, { gross: 0.29 }, { gross: 0.01 }];
        const out = spreadDiscounts(lines, { type: 'percent', value: 100 });
        out.forEach((d, i) => expect(d).toBeLessThanOrEqual(lines[i].gross));
        expect(out.reduce((s, d) => s + d, 0)).toBeCloseTo(0.59, 2);
    });

    it('skips a line already free when spreading', () => {
        const out = spreadDiscounts(
            [{ gross: 100 }, { gross: 50, discount: { type: 'percent', value: 100 } }],
            { type: 'amount', value: 10 },
        );
        expect(out).toEqual([10, 50]);
    });

    it('refuses a cart discount bigger than the bill', () => {
        expect(() => spreadDiscounts([{ gross: 100 }], { type: 'amount', value: 100.5 })).toThrow("The discount can't be more than the bill.");
    });

    it('refuses a line discount bigger than the line', () => {
        expect(() => spreadDiscounts([{ gross: 100, discount: { type: 'amount', value: 150 } }])).toThrow(BadRequestException);
    });
});

describe('discountNeedsApproval', () => {
    it('never asks when the store has no limit', () => {
        expect(discountNeedsApproval(null, 900, 1000)).toBe(false);
    });

    it('asks only above the limit, not at it', () => {
        expect(discountNeedsApproval(10, 100, 1000)).toBe(false);
        expect(discountNeedsApproval(10, 100.01, 1000)).toBe(true);
    });

    it('a 0% limit makes any discount need a manager', () => {
        expect(discountNeedsApproval(0, 1, 1000)).toBe(true);
        expect(discountNeedsApproval(0, 0, 1000)).toBe(false);
    });
});

describe('payableFor', () => {
    it('rounds to the nearest rupee and says by how much', () => {
        expect(payableFor(1049.6, true)).toEqual({ payable: 1050, roundOff: 0.4 });
        expect(payableFor(1049.4, true)).toEqual({ payable: 1049, roundOff: -0.4 });
        expect(payableFor(1049.5, true)).toEqual({ payable: 1050, roundOff: 0.5 });
    });

    it('leaves the total alone with round-off off', () => {
        expect(payableFor(1049.6, false)).toEqual({ payable: 1049.6, roundOff: 0 });
    });
});

describe('paymentStatus', () => {
    it.each([
        [1050, 1050, OrderFinancialStatus.PAID],
        [500, 1050, OrderFinancialStatus.PARTIALLY_PAID],
        [0, 1050, OrderFinancialStatus.PENDING],
        // A bill discounted to nothing is paid.
        [0, 0, OrderFinancialStatus.PAID],
    ])('%s paid of %s is %s', (paid, payable, status) => {
        expect(paymentStatus(paid, payable)).toBe(status);
    });
});

describe('settlePayments', () => {
    it('gives change from cash handed over beyond the amount', () => {
        expect(settlePayments([{ method: 'CASH', amount: 1050, tendered: 2000 }], 1050)).toEqual({ paid: 1050, change: 950 });
    });

    it('adds up a split payment', () => {
        expect(settlePayments([{ method: 'UPI', amount: 600 }, { method: 'CARD', amount: 450 }], 1050)).toEqual({ paid: 1050, change: 0 });
    });

    it('allows paying less, or nothing, now', () => {
        expect(settlePayments([{ method: 'CASH', amount: 200 }], 1050).paid).toBe(200);
        expect(settlePayments([], 1050).paid).toBe(0);
    });

    it('refuses payments over what is due', () => {
        expect(() => settlePayments([{ method: 'CARD', amount: 1100 }], 1050)).toThrow(/more than the ₹1,050.00 due/);
    });

    it('refuses cash handed over that is less than the cash amount', () => {
        expect(() => settlePayments([{ method: 'CASH', amount: 500, tendered: 400 }], 1050)).toThrow('The cash handed over is less than the amount paid in cash.');
    });
});

describe('mainPaymentMethod', () => {
    it('is the method most of the bill was paid by', () => {
        expect(mainPaymentMethod([{ method: 'UPI', amount: 300 }, { method: 'CARD', amount: 700 }])).toBe('CARD');
    });

    it('is null when nothing was paid yet', () => {
        expect(mainPaymentMethod([])).toBeNull();
    });
});
