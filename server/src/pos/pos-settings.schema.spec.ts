import { BadRequestException } from '@nestjs/common';
import { PosSettingsSchema, parsePosSettings, validatePosSettingsPatch } from './pos-settings.schema';

describe('point-of-sale settings', () => {
    it('defaults to round-off on, walk-ins allowed, no PINs and no approvals', () => {
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
            askCustomer: 'optional',
        });
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
        [{ askCustomer: 'sometimes' }, 'Check the askCustomer setting.'],
        [{ theme: 'dark' }, 'There is no point-of-sale setting called “theme”.'],
    ])('refuses %o in a sentence', (patch, message) => {
        expect(() => validatePosSettingsPatch(patch)).toThrow(new BadRequestException(message));
    });

    it('drops repeated quick tiles', () => {
        expect(validatePosSettingsPatch({ tileVariantIds: ['a', 'b', 'a'] }).tileVariantIds).toEqual(['a', 'b']);
    });
});
