import { isDeepStrictEqual } from 'node:util';
import { BadRequestException } from '@nestjs/common';
import { parseDefinition } from '../blocks/definition.schema';
import { MANAGED_BY_KEY, templateSlotsIn } from './managed-automations';
import { ManagedAutomationsService } from './managed-automations.service';

type Row = Record<string, any>;

/** Redis's SET NX and compare-and-delete, in memory. */
function fakeRedis() {
    const held = new Map<string, string>();
    return {
        runScript: jest.fn(async (name: string, _lua: string, _keys: number, [key]: string[], [token]: unknown[]) => {
            if (name === 'lockAcquire') {
                if (held.has(key)) return null;
                held.set(key, String(token));
                return 'OK';
            }
            held.delete(key);
            return 1;
        }),
    };
}

const SLOT_CATEGORY: Record<string, string> = { cart_reminder_1: 'MARKETING', cart_reminder_2: 'MARKETING', cart_reminder_3: 'MARKETING' };
const approved = (...slots: string[]) =>
    slots.map((slot, i) => ({ id: `t${i}`, packSlot: slot, packVersion: 1, status: 'APPROVED', category: SLOT_CATEGORY[slot] ?? 'UTILITY', language: 'en', updatedAt: new Date() }));
const ALL = ['order_confirmed', 'cod_confirm', 'order_shipped', 'out_for_delivery', 'order_delivered', 'order_cancelled', 'refund_processed', 'gst_invoice', 'review_request', 'optin_confirmed', 'cart_reminder_1', 'cart_reminder_2', 'cart_reminder_3'];

function harness(opts: { pack?: Row | null; shopify?: boolean; templates?: Row[]; merchantOn?: string[]; existing?: Row[] } = {}) {
    const pack = opts.pack === null ? null : { id: 'pack1', organizationId: 'o', wabaId: 'waba1', autoActivate: true, settings: {}, ...opts.pack };
    const rows: Row[] = [...(opts.existing ?? [])];
    const published: string[] = [];
    const prisma = {
        channel: {
            findFirst: jest.fn(async () => ({ id: 'ch_wa', externalStoreId: 'waba1' })),
            count: jest.fn(async () => (opts.shopify ? 1 : 0)),
        },
        templatePack: { findUnique: jest.fn(async () => pack) },
        automation: {
            findMany: jest.fn(async ({ where }: Row) => (where.id ? rows.filter((r) => where.id.in.includes(r.id)) : rows.map((r) => ({ ...r })))),
            updateMany: jest.fn(async ({ where, data }: Row) => {
                for (const r of rows) if (where.id.in.includes(r.id)) Object.assign(r, data);
                return { count: where.id.in.length };
            }),
            update: jest.fn(async ({ where, data }: Row) => Object.assign(rows.find((r) => r.id === where.id)!, data)),
        },
        messageTemplate: { findMany: jest.fn(async () => opts.templates ?? []) },
        automationTrigger: {
            findFirst: jest.fn(async ({ where }: Row) => ((opts.merchantOn ?? []).includes(where.triggerType) ? { automation: { name: 'My own flow' } } : null)),
            findMany: jest.fn(async () => (opts.merchantOn ?? []).map((triggerType) => ({ triggerType, automation: { name: 'My own flow' } }))),
        },
        $executeRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
            const sql = strings.join('?');
            if (pack) pack.settings = sql.includes('jsonb_set') ? { cartDiscount: JSON.parse(String(values[1])) } : {};
            return 1;
        }),
    };
    const automations = {
        createSystem: jest.fn(async (_org: string, input: Row) => {
            const row = { id: `a_${input.packKey}`, packKey: input.packKey, status: 'DRAFT', activateWhenReady: input.activateWhenReady, definition: { steps: parseDefinition({ steps: input.steps }) } };
            rows.push(row);
            return { id: row.id };
        }),
        // As AutomationService: a draft changed since it was read is left alone.
        saveSystemDefinition: jest.fn(async (id: string, _org: string, steps: unknown[], current: unknown) => {
            const row = rows.find((r) => r.id === id)!;
            if (!isDeepStrictEqual(row.definition, current)) return null;
            row.definition = { steps: parseDefinition({ steps }) };
            return row.definition;
        }),
        publishSystem: jest.fn(async (id: string, _org: string, draft: unknown) => {
            const row = rows.find((r) => r.id === id)!;
            if (!isDeepStrictEqual(JSON.parse(JSON.stringify(row.definition)), JSON.parse(JSON.stringify(draft)))) return null;
            Object.assign(row, { status: 'ACTIVE', activateWhenReady: false });
            published.push(id);
            return [];
        }),
        packList: jest.fn(async () => rows.filter((r) => r.status !== 'ARCHIVED').map((r) => ({ id: r.id, packKey: r.packKey, status: r.status, name: r.packKey }))),
    };
    const service = new ManagedAutomationsService(prisma as never, automations as never, fakeRedis() as never);
    jest.spyOn((service as unknown as { logger: { log: () => void } }).logger, 'log').mockImplementation(() => undefined);
    const state = (key: string) => rows.find((r) => r.packKey === key);
    return { service, prisma, automations, rows, published, state, pack };
}

describe('ManagedAutomationsService.sync', () => {
    it('does nothing for an account without a pack', async () => {
        const h = harness({ pack: null, templates: approved(...ALL) });
        await h.service.sync('o');
        expect(h.automations.createSystem).not.toHaveBeenCalled();
    });

    it('makes the core automations, and cart recovery only with an online store, waiting to go live when on by default', async () => {
        const core = harness();
        await core.service.sync('o');
        expect(core.rows.map((r) => r.packKey)).toEqual([
            'order_confirmed', 'cod_confirmation', 'order_shipped', 'out_for_delivery', 'order_delivered', 'order_cancelled', 'refund_processed', 'gst_invoice', 'review_request', 'optin_confirmed',
        ]);
        expect(core.rows.filter((r) => !r.activateWhenReady).map((r) => r.packKey)).toEqual(['review_request']);
        expect(core.automations.createSystem).toHaveBeenCalledWith('o', expect.objectContaining({ packKey: 'order_shipped', channelId: 'ch_wa', name: 'Order shipped' }));

        const online = harness({ shopify: true });
        await online.service.sync('o');
        expect(online.state('cart_recovery')).toMatchObject({ status: 'DRAFT', activateWhenReady: true });

        const backfilled = harness({ pack: { autoActivate: false } });
        await backfilled.service.sync('o');
        expect(backfilled.rows.every((r) => !r.activateWhenReady)).toBe(true);
    });

    it('puts each live once every template it sends is approved, and only those', async () => {
        const h = harness({ templates: approved('order_confirmed', 'order_shipped', 'cod_confirm') });
        await h.service.sync('o');
        expect(h.published.sort()).toEqual(['a_cod_confirmation', 'a_order_confirmed', 'a_order_shipped']);
        expect(h.state('out_for_delivery')).toMatchObject({ status: 'DRAFT', activateWhenReady: true });

        // Later approvals: the next sync puts the rest live; the review request stays off.
        (h.prisma.messageTemplate.findMany as jest.Mock).mockResolvedValue(approved(...ALL));
        await h.service.sync('o');
        expect(h.rows.filter((r) => r.status !== 'ACTIVE').map((r) => r.packKey)).toEqual(['review_request']);
        expect(h.automations.createSystem).toHaveBeenCalledTimes(10);
    });

    it('holds one back when an automation of the merchant’s starts on the same event, so nobody gets two messages', async () => {
        const h = harness({ templates: approved(...ALL), merchantOn: ['crm.website.signup'] });
        await h.service.sync('o');
        expect(h.state('optin_confirmed')).toMatchObject({ status: 'DRAFT', activateWhenReady: false });
        expect(h.state('order_shipped')).toMatchObject({ status: 'ACTIVE' });
        const listed = await h.service.withPackState('o', [{ id: 'a_optin_confirmed', status: 'DRAFT' as never, packKey: 'optin_confirmed' }]);
        expect(listed[0]).toMatchObject({ packState: 'duplicate', packNote: 'Not turned on because your automation “My own flow” already starts on the same event.' });
    });

    it('never touches one the merchant edited, archived or put live themselves', async () => {
        const shipped = MANAGED_BY_KEY.get('order_shipped')!.steps({ cartDiscount: null });
        const edited = shipped.map((s) => (s.id === 'pk_send' ? { ...s, config: { kind: 'template', templateId: 'tpl_mine' } } : s));
        const h = harness({
            templates: approved(...ALL),
            existing: [
                { id: 'a_edit', packKey: 'order_shipped', status: 'DRAFT', activateWhenReady: true, definition: { steps: parseDefinition({ steps: edited }) } },
                { id: 'a_gone', packKey: 'order_delivered', status: 'ARCHIVED', activateWhenReady: true, definition: { steps: [] } },
            ],
        });
        await h.service.sync('o');
        expect(h.published).not.toContain('a_edit');
        expect(h.published).not.toContain('a_gone');
        expect(h.automations.saveSystemDefinition).not.toHaveBeenCalled();
        expect(h.automations.createSystem).not.toHaveBeenCalledWith('o', expect.objectContaining({ packKey: 'order_delivered' }));
        // Reported as it is: it will not go live by itself.
        const [listed] = await h.service.withPackState('o', [{ id: 'a_edit', status: 'DRAFT' as never, packKey: 'order_shipped' }]);
        expect(listed.packState).toBe('ready');
    });
});

describe('ManagedAutomationsService.turnOn', () => {
    it('asks for the chosen ones to go live, by default every one that is on by default', async () => {
        const h = harness({ pack: { autoActivate: false }, templates: approved(...ALL) });
        await h.service.sync('o');
        expect(h.published).toEqual([]);
        const { automations } = await h.service.turnOn('o', ['review_request']);
        expect(h.published).toEqual(['a_review_request']);
        expect(automations.find((a) => a.packKey === 'review_request')).toMatchObject({ packState: 'live' });
        expect(automations.find((a) => a.packKey === 'order_shipped')).toMatchObject({ packState: 'ready', packNote: 'Ready to turn on.' });

        await h.service.turnOn('o');
        expect(h.rows.filter((r) => r.status !== 'ACTIVE').map((r) => r.packKey)).toEqual([]);
    });

    it('waits for Meta when templates are not approved yet, and refuses an unknown key', async () => {
        const h = harness({ pack: { autoActivate: false }, templates: [] });
        const { automations } = await h.service.turnOn('o', ['order_shipped']);
        expect(automations.find((a) => a.packKey === 'order_shipped')).toMatchObject({ packState: 'waiting' });
        expect(automations.find((a) => a.packKey === 'order_delivered')).toMatchObject({ packState: 'off' });
        await expect(h.service.turnOn('o', ['teleport'])).rejects.toThrow(BadRequestException);
    });
});

describe('ManagedAutomationsService.setCartDiscount', () => {
    const cartSlots = (h: ReturnType<typeof harness>) => templateSlotsIn(parseDefinition(h.state('cart_recovery')!.definition));

    it('saves it and rebuilds the live cart recovery with a third reminder, then takes it away again', async () => {
        const h = harness({ shopify: true, templates: approved(...ALL) });
        await h.service.sync('o');
        expect(cartSlots(h)).toEqual(['cart_reminder_1', 'cart_reminder_2']);

        const saved = await h.service.setCartDiscount('o', { code: 'save10', text: ' 10% ', validDays: 7 });
        expect(saved).toEqual({ cartDiscount: { code: 'SAVE10', text: '10%', validDays: 7 } });
        expect(h.pack!.settings).toEqual({ cartDiscount: { code: 'SAVE10', text: '10%', validDays: 7 } });
        expect(cartSlots(h)).toEqual(['cart_reminder_1', 'cart_reminder_2', 'cart_reminder_3']);
        expect(h.published.filter((id) => id === 'a_cart_recovery')).toHaveLength(2);

        expect(await h.service.setCartDiscount('o', null)).toEqual({ cartDiscount: null });
        expect(cartSlots(h)).toEqual(['cart_reminder_1', 'cart_reminder_2']);
        expect(h.published.filter((id) => id === 'a_cart_recovery')).toHaveLength(3);
    });

    it('rebuilds only when the discount changes: a merchant’s edit equal to the other build is theirs', async () => {
        const h = harness({ shopify: true, templates: approved(...ALL), pack: { settings: { cartDiscount: { code: 'SAVE10', text: '10%', validDays: 7 } } } });
        await h.service.sync('o');
        expect(cartSlots(h)).toEqual(['cart_reminder_1', 'cart_reminder_2', 'cart_reminder_3']);
        // The merchant drops reminder 3 by hand: the next syncs leave it so.
        const cart = MANAGED_BY_KEY.get('cart_recovery')!;
        h.state('cart_recovery')!.definition = { steps: parseDefinition({ steps: cart.steps({ cartDiscount: null }) }) };
        await h.service.sync('o');
        expect(cartSlots(h)).toEqual(['cart_reminder_1', 'cart_reminder_2']);
        expect(h.automations.saveSystemDefinition).not.toHaveBeenCalled();
    });

    it('needs what the code takes off, and a pack to keep it on', async () => {
        const h = harness();
        await expect(h.service.setCartDiscount('o', { code: 'SAVE10', text: '  ', validDays: 3 })).rejects.toThrow('Say what the code takes off');
        await expect(harness({ pack: null }).service.setCartDiscount('o', { code: 'SAVE10', text: '10%', validDays: 3 })).rejects.toThrow('Set up the recommended WhatsApp templates first.');
    });
});

describe('ManagedAutomationsService.withPackState', () => {
    it('reports Collabo’s automations and leaves the merchant’s alone', async () => {
        const h = harness({ templates: [{ ...approved('order_shipped')[0], status: 'REJECTED' }] });
        await h.service.sync('o');
        const listed = await h.service.withPackState('o', [
            { id: 'mine', status: 'ACTIVE' as never, packKey: null },
            { id: 'a_order_shipped', status: 'DRAFT' as never, packKey: 'order_shipped' },
            { id: 'a_order_delivered', status: 'DRAFT' as never, packKey: 'order_delivered' },
        ]);
        expect(listed.map((r) => [r.id, r.packState, r.packNote])).toEqual([
            ['mine', null, null],
            ['a_order_shipped', 'attention', 'Meta rejected its “Order shipped” template.'],
            ['a_order_delivered', 'waiting', 'Goes live by itself when Meta approves its templates.'],
        ]);
    });
});
