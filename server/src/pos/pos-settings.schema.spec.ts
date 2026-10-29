import { BadRequestException } from '@nestjs/common';
import { PosSettingsSchema, parsePosSettings, validatePosSettingsPatch } from './pos-settings.schema';

describe('point-of-sale settings', () => {
    it('defaults to round-off on, the customer asked for, bills sent, no PINs and no approvals', () => {
        expect(parsePosSettings(null)).toEqual({
            upiId: null,
            upiPayeeName: null,
            roundOff: true,
            requireStaffPin: false,
            discountApprovalPercent: null,
            priceOverrideNeedsApproval: false,
            receiptWidth: 80,
            receiptFooter: null,
            tileVariantIds: [],
            customerAtCheckout: 'ask',
            customerRequiredAbove: 50000,
            autoSendBill: true,
        });
    });

    it.each([
        [true, 'ask'],
        [false, 'off'],
        ['optional', 'ask'],
        ['required', 'required'],
    ])('reads a stored askCustomer of %p as customer at checkout %p', (askCustomer, expected) => {
        const settings = parsePosSettings({ askCustomer, roundOff: false });
        expect(settings.customerAtCheckout).toBe(expected);
        expect(settings.roundOff).toBe(false);
        expect(settings).not.toHaveProperty('askCustomer');
    });

    it('a customer-at-checkout saved since wins over an old askCustomer left beside it', () => {
        expect(parsePosSettings({ askCustomer: true, customerAtCheckout: 'required' }).customerAtCheckout).toBe('required');
    });

    it('a merged and saved patch no longer carries askCustomer', () => {
        const merged = PosSettingsSchema.parse({ ...parsePosSettings({ askCustomer: false }), ...validatePosSettingsPatch({ autoSendBill: false }) });
        expect(merged).toMatchObject({ customerAtCheckout: 'off', autoSendBill: false });
        expect(merged).not.toHaveProperty('askCustomer');
    });

    it('takes a bill limit, or none', () => {
        expect(validatePosSettingsPatch({ customerRequiredAbove: 200000 }).customerRequiredAbove).toBe(200000);
        expect(validatePosSettingsPatch({ customerRequiredAbove: null }).customerRequiredAbove).toBeNull();
    });

    it('falls back to the defaults for a stored blob that no longer parses', () => {
        expect(parsePosSettings({ receiptWidth: 99 }).receiptWidth).toBe(80);
    });

    it('a patch carries only the keys sent, so merging it keeps the rest', () => {
        const patch = validatePosSettingsPatch({ requireStaffPin: true });
        expect(patch).toEqual({ requireStaffPin: true });
        const merged = PosSettingsSchema.parse({ ...parsePosSettings({ roundOff: false, upiId: 'shop@okhdfc' }), ...patch });
        expect(merged).toMatchObject({ roundOff: false, upiId: 'shop@okhdfc', requireStaffPin: true });
    });

    it('takes a UPI id like name@bank and clears it with an empty string', () => {
        expect(validatePosSettingsPatch({ upiId: 'acme.store@okicici' }).upiId).toBe('acme.store@okicici');
        expect(validatePosSettingsPatch({ upiId: '' }).upiId).toBeNull();
        expect(() => validatePosSettingsPatch({ upiId: 'acme store' })).toThrow('Enter a UPI id like name@bank.');
    });

    it.each([
        [{ receiptFooter: 'x'.repeat(301) }, 'Keep the receipt footer under 300 characters.'],
        [{ tileVariantIds: Array.from({ length: 25 }, (_, i) => `v${i}`) }, 'Pick at most 24 quick tiles.'],
        [{ receiptWidth: 72 }, 'The receipt width must be 58 or 80 mm.'],
        [{ discountApprovalPercent: 120 }, 'The discount limit must be between 0 and 100 percent.'],
        [{ customerAtCheckout: 'sometimes' }, 'Customer at checkout is off, ask or required.'],
        [{ customerRequiredAbove: -1 }, "The bill amount that needs the buyer's details can't be negative."],
        [{ askCustomer: 'required' }, 'There is no point-of-sale setting called “askCustomer”.'],
        [{ theme: 'dark' }, 'There is no point-of-sale setting called “theme”.'],
    ])('refuses %o in a sentence', (patch, message) => {
        expect(() => validatePosSettingsPatch(patch)).toThrow(new BadRequestException(message));
    });

    it('drops repeated quick tiles', () => {
        expect(validatePosSettingsPatch({ tileVariantIds: ['a', 'b', 'a'] }).tileVariantIds).toEqual(['a', 'b']);
    });
});
