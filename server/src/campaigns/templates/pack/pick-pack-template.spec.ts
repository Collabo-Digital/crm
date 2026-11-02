import { PackTemplateRow, latestPackTemplate, pickPackTemplate } from './pick-pack-template';

const row = (id: string, patch: Partial<PackTemplateRow>): PackTemplateRow => ({
    id,
    packSlot: 'order_shipped',
    packVersion: 1,
    status: 'APPROVED',
    category: 'UTILITY',
    language: 'en',
    updatedAt: new Date('2026-10-26T10:00:00Z'),
    ...patch,
});

describe('picking the template a pack slot sends with', () => {
    it('takes an approved template in the slot category over a newer one Meta moved to marketing', () => {
        const rows = [row('marketing', { packVersion: 2, category: 'MARKETING' }), row('utility', { packVersion: 1 })];
        expect(pickPackTemplate(rows, 'order_shipped', 'UTILITY')?.id).toBe('utility');
    });

    it('takes the newest approved version, and falls back to a marketing one when nothing else is approved', () => {
        expect(pickPackTemplate([row('v1', {}), row('v2', { packVersion: 2 })], 'order_shipped', 'UTILITY')?.id).toBe('v2');
        expect(pickPackTemplate([row('m', { category: 'MARKETING' }), row('p', { packVersion: 2, status: 'PENDING' })], 'order_shipped', 'UTILITY')?.id).toBe('m');
    });

    it('returns nothing while no template of the slot and language is approved', () => {
        const rows = [row('pending', { status: 'PENDING' }), row('paused', { status: 'PAUSED' }), row('hi', { language: 'hi' }), row('other', { packSlot: 'order_delivered' })];
        expect(pickPackTemplate(rows, 'order_shipped', 'UTILITY')).toBeNull();
    });

    it('shows the newest template whatever its status while none is approved', () => {
        const rows = [row('old', { status: 'REJECTED' }), row('new', { packVersion: 2, status: 'PENDING' })];
        expect(latestPackTemplate(rows, 'order_shipped')?.id).toBe('new');
        expect(latestPackTemplate(rows, 'order_delivered')).toBeNull();
    });
});
