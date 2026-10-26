import { AutomationStatus } from '@prisma/client';
import { templatePack } from '../../campaigns/templates/pack/template-pack';
import { packStateOf, slotStanding } from './pack-state';

const slot = (key: string) => templatePack('https://app.example.com').find((s) => s.key === key)!;
let n = 0;
const row = (packSlot: string, status: string, category: string, packVersion = 1) => ({
    id: `t${++n}`,
    packSlot,
    packVersion,
    status,
    category,
    language: 'en',
    updatedAt: new Date(2026, 9, 26, 10, n),
});

describe('slotStanding', () => {
    it('is fine with an approved template in the slot’s category, even beside a rejected one', () => {
        expect(slotStanding([row('order_shipped', 'REJECTED', 'UTILITY', 2), row('order_shipped', 'APPROVED', 'UTILITY', 1)], slot('order_shipped'))).toMatchObject({ approved: true, problem: null });
    });

    it('flags a template moved to marketing, rejected or disabled, and a pause', () => {
        expect(slotStanding([row('order_shipped', 'APPROVED', 'MARKETING')], slot('order_shipped'))).toMatchObject({ approved: true, problem: 'marketing' });
        expect(slotStanding([row('order_shipped', 'REJECTED', 'UTILITY')], slot('order_shipped'))).toMatchObject({ approved: false, problem: 'rejected' });
        expect(slotStanding([row('order_shipped', 'DISABLED', 'UTILITY')], slot('order_shipped'))).toMatchObject({ approved: false, problem: 'disabled' });
        expect(slotStanding([row('order_shipped', 'PAUSED', 'UTILITY')], slot('order_shipped'))).toMatchObject({ approved: false, paused: true, problem: null });
        expect(slotStanding([], slot('order_shipped'))).toMatchObject({ approved: false, paused: false, problem: null });
    });
});

describe('packStateOf', () => {
    const ok = { title: 'Order shipped', approved: true, paused: false, problem: null };
    const pending = { title: 'Order shipped', approved: false, paused: false, problem: null };
    const base = { status: AutomationStatus.DRAFT, activateWhenReady: false, slots: [ok], duplicateOf: null };

    it('reads each state', () => {
        expect(packStateOf({ ...base, status: AutomationStatus.ACTIVE })).toEqual({ state: 'live', note: null });
        expect(packStateOf({ ...base, activateWhenReady: true, slots: [pending] })).toEqual({ state: 'waiting', note: 'Goes live by itself when Meta approves its templates.' });
        expect(packStateOf(base)).toEqual({ state: 'ready', note: 'Ready to turn on.' });
        expect(packStateOf({ ...base, slots: [ok, pending] }).state).toBe('off');
        expect(packStateOf({ ...base, duplicateOf: 'My COD flow' })).toEqual({
            state: 'duplicate',
            note: 'Not turned on because your automation “My COD flow” already starts on the same event.',
        });
        expect(packStateOf({ ...base, status: AutomationStatus.ARCHIVED }).state).toBe('off');
    });

    it('asks for attention on a rejected, disabled or recategorised template, live or not', () => {
        const rejected = { ...pending, problem: 'rejected' as const };
        expect(packStateOf({ ...base, slots: [rejected] })).toEqual({ state: 'attention', note: 'Meta rejected its “Order shipped” template.' });
        expect(packStateOf({ ...base, status: AutomationStatus.ACTIVE, slots: [{ ...ok, problem: 'marketing' }] }).state).toBe('attention');
        expect(packStateOf({ ...base, activateWhenReady: true, slots: [{ ...pending, problem: 'disabled' }] }).state).toBe('attention');
    });

    it('says when a live one’s messages wait for Meta to lift a pause', () => {
        expect(packStateOf({ ...base, status: AutomationStatus.ACTIVE, slots: [{ ...pending, paused: true }] })).toEqual({
            state: 'live',
            note: 'Meta paused its “Order shipped” template. Its messages wait until the pause ends.',
        });
    });
});
