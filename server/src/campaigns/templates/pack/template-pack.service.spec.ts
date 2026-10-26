import { MetaGraphError } from '../../../channel/meta-graph.types';
import { Priority, RateLimitedError } from '../../../rate-limit/rate-limit.types';
import { SAMPLE_INVOICE_PDF } from './sample-invoice-pdf';
import { TEMPLATE_PACK_VERSION, templatePack } from './template-pack';
import { TemplatePackService, slotState, utilityRestricted } from './template-pack.service';

/**
 * The pack job against an in-memory account: what it creates, in which
 * order and from which variant, what it adopts, when it stops, and what the
 * reconcile does with Meta's verdicts.
 */

const ORG = 'org_1';
const WABA = '1029';
const APP = 'https://app.example.com';
const CORE = templatePack(APP).filter((s) => s.set === 'core');
const PAYMENT = templatePack(APP).filter((s) => s.set === 'payment');
const STORE = templatePack(APP).filter((s) => s.set === 'online_store');

let seq = 0;
type Row = Record<string, any>;

function world(opts: {
    pack?: Row | null;
    channel?: Row | null;
    razorpay?: boolean;
    shopify?: boolean;
    rows?: Row[];
} = {}) {
    const rows: Row[] = [...(opts.rows ?? [])];
    let pack: Row | null = opts.pack === undefined
        ? { id: 'pack_1', organizationId: ORG, channelId: 'ch_wa', wabaId: WABA, autoActivate: true, origin: 'connect', version: 0, status: 'pending', stoppedReason: null, lastRunAt: null, settings: null }
        : opts.pack;
    const channel = opts.channel === undefined ? { id: 'ch_wa', metadata: {} } : opts.channel;
    const row = (patch: Row): Row => ({
        id: `tpl_${++seq}`, organizationId: ORG, wabaId: WABA, externalId: `M${seq}`, language: 'en', status: 'PENDING', category: 'UTILITY',
        requestedCategory: null, statusReason: null, rejectionInfo: null, qualityScore: null, packVersion: 1, packSource: 'collabo',
        libraryTemplateName: null, updatedAt: new Date(Date.now() + seq), ...patch,
    });
    const prisma = {
        templatePack: {
            findUnique: jest.fn(async ({ where }: any) => (pack && where.wabaId === pack.wabaId ? { ...pack } : null)),
            update: jest.fn(async ({ data }: any) => (pack = { ...pack!, ...data })),
        },
        channel: {
            findFirst: jest.fn(async ({ where }: any) => {
                if (where.platform === 'SHOPIFY') return opts.shopify ? { id: 'ch_shop' } : null;
                if (where.platform === 'WHATSAPP') return channel ? { ...channel, externalStoreId: WABA } : null;
                return null;
            }),
        },
        paymentAccount: { findFirst: jest.fn(async () => (opts.razorpay ? { id: 'pa_1' } : null)) },
        messageTemplate: {
            findMany: jest.fn(async () => rows.filter((r) => r.packSlot)),
            findUnique: jest.fn(async ({ where }: any) => rows.find((r) => r.name === where.wabaId_name_language.name && r.language === where.wabaId_name_language.language) ?? null),
            count: jest.fn(async ({ where }: any) => rows.filter((r) => r.packSlot && where.status.in.includes(r.status)).length),
        },
    };
    const created: Array<{ via: 'library' | 'collabo'; name: string; fields: Row; draft?: Row; priority: Priority }> = [];
    const save = (name: string, fields: Row, status: string, category = 'UTILITY') => {
        const r = row({ name, ...fields, status, category });
        rows.push(r);
        return r;
    };
    const templates = {
        withAccountLock: jest.fn(async (_waba: string, fn: () => Promise<unknown>) => fn()),
        pull: jest.fn(async () => ({ synced: 0, removed: 0 })),
        channelFor: jest.fn(async () => ({ id: 'ch_wa', wabaId: WABA, metadata: {} })),
        createFromLibrary: jest.fn(async (_org: string, _ch: Row, t: Row, fields: Row, priority: Priority) => {
            created.push({ via: 'library', name: t.name, fields, priority });
            return save(t.name, fields, 'APPROVED');
        }),
        submit: jest.fn(async (_org: string, _ch: Row, draft: Row, o: Row) => {
            created.push({ via: 'collabo', name: draft.name, fields: o.pack, draft, priority: o.priority });
            return save(draft.name, o.pack, 'PENDING', draft.category);
        }),
        pullName: jest.fn(async (): Promise<Row[]> => []),
        refreshStatus: jest.fn(async (_ch: Row, t: Row) => t),
    };
    const storage = { save: jest.fn(async () => ({ storageKey: `${ORG}/sample.pdf`, size: SAMPLE_INVOICE_PDF.length })) };
    const jobs = { ensure: jest.fn(), reconcile: jest.fn(), reconcileIn: jest.fn(), reconcileLater: jest.fn(), managedSync: jest.fn() };
    const service = new TemplatePackService(prisma as any, templates as any, storage as any, jobs as any, { get: () => APP } as any);
    service.spacingMs = 0;
    jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
    jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
    return { service, prisma, templates, storage, jobs, created, rows, row, pack: () => pack };
}

const refusal = (message: string, subcode?: number) => new MetaGraphError(message, 'API_ERROR', 100, subcode, 400, { message, error_user_msg: message });

describe('the ensure job', () => {
    it('does nothing where no pack row exists', async () => {
        const w = world({ pack: null });
        await w.service.ensure(ORG, WABA, 'shopify');
        expect(w.templates.withAccountLock).not.toHaveBeenCalled();
        expect(w.created).toHaveLength(0);
        expect(w.jobs.managedSync).not.toHaveBeenCalled();
    });

    it('creates the core set in order, under the account lock, after syncing first', async () => {
        const w = world();
        await w.service.ensure(ORG, WABA, 'connect');
        expect(w.templates.withAccountLock).toHaveBeenCalledWith(WABA, expect.any(Function), expect.any(Number));
        expect(w.templates.pull).toHaveBeenCalledWith(ORG, expect.objectContaining({ wabaId: WABA }), { adopt: true });
        expect(w.templates.pull.mock.invocationCallOrder[0]).toBeLessThan(w.templates.createFromLibrary.mock.invocationCallOrder[0]);
        expect(w.created.map((c) => c.name)).toEqual(CORE.map((s) => `collabo_${s.key}_v1`));
        expect(w.created.every((c) => c.priority === Priority.NORMAL)).toBe(true);
    });

    it('takes Meta’s library first where it fits, and Collabo’s wording otherwise', async () => {
        const w = world();
        await w.service.ensure(ORG, WABA, 'connect');
        const via = Object.fromEntries(w.created.map((c) => [c.fields.packSlot, c.via]));
        expect(via).toMatchObject({ order_confirmed: 'library', order_delivered: 'library', order_cancelled: 'library', order_shipped: 'collabo', cod_confirm: 'collabo' });
        const cancelled = w.templates.createFromLibrary.mock.calls.find((c) => c[2].name === 'collabo_order_cancelled_v1')!;
        expect(cancelled[2]).toMatchObject({ libraryTemplateName: 'order_canceled_3', buttonInputs: [{ type: 'URL', url: { base_url: `${APP}/t/{{1}}` } }] });
        expect(cancelled[3]).toEqual({ packSlot: 'order_cancelled', packVersion: 1, packSource: 'library', libraryTemplateName: 'order_canceled_3' });
    });

    it('saves Collabo’s templates with the pack fields, no starter and no author', async () => {
        const w = world();
        await w.service.ensure(ORG, WABA, 'connect');
        const [, , draft, o] = w.templates.submit.mock.calls.find((c) => c[2].name === 'collabo_cod_confirm_v1')!;
        expect(draft).toMatchObject({ language: 'en', category: 'UTILITY', parameterFormat: 'NAMED' });
        expect(o).toEqual({ createdById: null, starterKey: null, priority: Priority.NORMAL, pack: { packSlot: 'cod_confirm', packVersion: 1, packSource: 'collabo', libraryTemplateName: null } });
    });

    it('submits the GST invoice with the bundled sample PDF, saved in the organization’s storage', async () => {
        const w = world();
        await w.service.ensure(ORG, WABA, 'connect');
        expect(w.storage.save).toHaveBeenCalledWith(ORG, SAMPLE_INVOICE_PDF, 'application/pdf');
        const invoice = w.created.find((c) => c.fields.packSlot === 'gst_invoice')!;
        expect(invoice.draft!.header).toEqual({ format: 'DOCUMENT', storageKey: `${ORG}/sample.pdf`, mime: 'application/pdf', filename: 'sample-invoice.pdf' });
    });

    it('falls back to Collabo’s wording when Meta refuses a library template', async () => {
        const w = world();
        w.templates.createFromLibrary.mockImplementationOnce(async () => { throw refusal('The template is not available in the library.'); });
        await w.service.ensure(ORG, WABA, 'connect');
        const confirmed = w.created.filter((c) => c.fields.packSlot === 'order_confirmed');
        expect(confirmed.map((c) => [c.via, c.name])).toEqual([['collabo', 'collabo_order_confirmed_v1']]);
    });

    it('adds the payment set with Razorpay and the store set with a connected Shopify store', async () => {
        const w = world({ razorpay: true, shopify: true });
        await w.service.ensure(ORG, WABA, 'razorpay');
        expect(w.created.map((c) => c.fields.packSlot)).toEqual([...CORE, ...PAYMENT, ...STORE].map((s) => s.key));
        expect(w.created.find((c) => c.fields.packSlot === 'cart_reminder_1')!.draft).toMatchObject({ category: 'MARKETING' });
    });

    it('skips slots the account already has, and is ready once every slot has a template, whatever its status', async () => {
        const w = world();
        const rejected = w.row({ name: 'collabo_review_request_v1', packSlot: 'review_request', status: 'REJECTED' });
        const live = CORE.filter((s) => s.key !== 'review_request').map((s) => w.row({ name: `collabo_${s.key}_v1`, packSlot: s.key, status: 'PENDING' }));
        w.rows.push(rejected, ...live);
        // Its one replacement is used already.
        w.pack()!.settings = { replaced: { review_request: TEMPLATE_PACK_VERSION } };
        await w.service.ensure(ORG, WABA, 'backfill');
        expect(w.created).toHaveLength(0);
        expect(w.pack()).toMatchObject({ status: 'ready', version: TEMPLATE_PACK_VERSION });
        expect(w.pack()!.lastRunAt).toBeInstanceOf(Date);
        expect(w.jobs.managedSync).toHaveBeenCalledWith(ORG);
        expect(w.jobs.reconcileLater).toHaveBeenCalledWith(ORG, WABA);
    });

    it('runs at bulk priority for the start-up backfill', async () => {
        const w = world();
        await w.service.ensure(ORG, WABA, 'backfill');
        expect(w.created.every((c) => c.priority === Priority.BULK)).toBe(true);
    });

    it('adopts a name Meta already holds when it is the pack’s own template', async () => {
        const w = world();
        w.templates.createFromLibrary.mockImplementationOnce(async () => { throw refusal('Content in This Language Already Exists', 2388024); });
        w.templates.pullName.mockImplementationOnce(async (): Promise<Row[]> => {
            const adopted = w.row({ name: 'collabo_order_confirmed_v1', packSlot: 'order_confirmed', packSource: 'library', libraryTemplateName: 'order_confirmed', status: 'APPROVED' });
            w.rows.push(adopted);
            return [adopted];
        });
        await w.service.ensure(ORG, WABA, 'connect');
        expect(w.templates.pullName).toHaveBeenCalledWith(ORG, expect.objectContaining({ wabaId: WABA }), 'collabo_order_confirmed_v1', Priority.NORMAL);
        expect(w.created.filter((c) => c.fields.packSlot === 'order_confirmed')).toHaveLength(0);
    });

    it('moves to the next version for a name taken by something else, at Meta or here', async () => {
        const w = world();
        w.rows.push(w.row({ name: 'collabo_cod_confirm_v1', packSlot: null }));
        w.templates.createFromLibrary.mockImplementationOnce(async () => { throw refusal('Content in This Language Already Exists', 2388024); });
        await w.service.ensure(ORG, WABA, 'connect');
        expect(w.created.find((c) => c.fields.packSlot === 'order_confirmed')).toMatchObject({ name: 'collabo_order_confirmed_v2', fields: { packVersion: 2 } });
        expect(w.created.find((c) => c.fields.packSlot === 'cod_confirm')).toMatchObject({ name: 'collabo_cod_confirm_v2', fields: { packVersion: 2 } });
    });

    it('stops at Meta’s rate limit, keeps what it made, and tries again in an hour', async () => {
        const w = world();
        w.templates.submit
            .mockImplementationOnce(async (_o: string, _c: Row, draft: Row, o: Row) => {
                w.created.push({ via: 'collabo', name: draft.name, fields: o.pack, priority: o.priority });
                return w.row({ name: draft.name, ...o.pack });
            })
            .mockImplementationOnce(async () => { throw new RateLimitedError({ platform: 'meta', kind: 'buc', id: WABA }, Date.now() + 60_000, 'BREAKER', 80007); });
        await w.service.ensure(ORG, WABA, 'connect');
        expect(w.created.map((c) => c.fields.packSlot)).toEqual(['order_confirmed', 'cod_confirm']);
        expect(w.jobs.ensure).toHaveBeenCalledWith(ORG, WABA, 'connect', 3600_000);
        expect(w.pack()).toMatchObject({ status: 'running', version: 0 });
    });

    it('treats Meta’s template-creation limit as a rate limit too', async () => {
        const w = world();
        w.templates.createFromLibrary.mockImplementationOnce(async () => { throw refusal('You can only create 100 message templates per hour.'); });
        await w.service.ensure(ORG, WABA, 'connect');
        expect(w.created).toHaveLength(0);
        expect(w.jobs.ensure).toHaveBeenCalledWith(ORG, WABA, 'connect', 3600_000);
    });

    it('stops the pack at Meta’s limit on the number of templates', async () => {
        const w = world();
        w.templates.createFromLibrary.mockImplementationOnce(async () => { throw refusal('The maximum number of message templates has been reached for this account.'); });
        await w.service.ensure(ORG, WABA, 'connect');
        expect(w.pack()).toMatchObject({ status: 'stopped', stoppedReason: expect.stringMatching(/limit on message templates/) });
        expect(w.created).toHaveLength(0);
    });

    it('stops with a plain reason when WhatsApp is disconnected, or Meta restricts utility templates', async () => {
        const off = world({ channel: null });
        await off.service.ensure(ORG, WABA, 'backfill');
        expect(off.pack()).toMatchObject({ status: 'stopped', stoppedReason: expect.stringMatching(/WhatsApp is not connected/) });

        const restricted = world({ channel: { id: 'ch_wa', metadata: { accountRestrictions: [{ restriction_type: 'RESTRICTED_UTILITY_TEMPLATES', expiration: Date.now() / 1000 + 3600 }] } } });
        await restricted.service.ensure(ORG, WABA, 'connect');
        expect(restricted.pack()).toMatchObject({ status: 'stopped', stoppedReason: expect.stringMatching(/restricting utility templates/) });
        expect(restricted.created).toHaveLength(0);
    });

    it('stops the run on a request that got no answer, for the next attempt to adopt what Meta made', async () => {
        const w = world();
        w.templates.createFromLibrary.mockImplementationOnce(async () => { throw new MetaGraphError('timed out', 'TIMEOUT'); });
        await expect(w.service.ensure(ORG, WABA, 'connect')).rejects.toThrow('timed out');
        expect(w.created).toHaveLength(0);
    });

    it('creates one template at a time, a little apart', async () => {
        const w = world();
        w.service.spacingMs = 40;
        const at: number[] = [];
        w.templates.createFromLibrary.mockImplementation(async (_o: string, _c: Row, t: Row, fields: Row) => {
            at.push(Date.now());
            return (w.rows.push(w.row({ name: t.name, ...fields, status: 'APPROVED' })), w.rows[w.rows.length - 1]);
        });
        w.templates.submit.mockImplementation(async (_o: string, _c: Row, draft: Row, o: Row) => {
            at.push(Date.now());
            return (w.rows.push(w.row({ name: draft.name, ...o.pack })), w.rows[w.rows.length - 1]);
        });
        await w.service.ensure(ORG, WABA, 'connect');
        expect(at).toHaveLength(CORE.length);
        for (let i = 1; i < at.length; i++) expect(at[i] - at[i - 1]).toBeGreaterThanOrEqual(35);
    });
});

describe('never the same wording twice', () => {
    it('a slot with no library variant whose wording Meta rejected gets nothing more', async () => {
        const w = world();
        w.rows.push(w.row({ name: 'collabo_cod_confirm_v1', packSlot: 'cod_confirm', status: 'REJECTED' }));
        await w.service.ensure(ORG, WABA, 'manual');
        expect(w.created.filter((c) => c.fields.packSlot === 'cod_confirm')).toHaveLength(0);
    });

    it('a rejected slot with an unused library variant is replaced from it once, at the next version', async () => {
        const w = world();
        w.rows.push(w.row({ name: 'collabo_order_shipped_v1', packSlot: 'order_shipped', status: 'REJECTED' }));
        await w.service.ensure(ORG, WABA, 'manual');
        const shipped = w.created.filter((c) => c.fields.packSlot === 'order_shipped');
        expect(shipped.map((c) => [c.via, c.name])).toEqual([['library', 'collabo_order_shipped_v2']]);
        expect(w.pack()!.settings).toEqual({ replaced: { order_shipped: TEMPLATE_PACK_VERSION } });

        // The replacement is rejected too: nothing more, from either job.
        w.rows.find((r) => r.name === 'collabo_order_shipped_v2')!.status = 'REJECTED';
        w.created.length = 0;
        await w.service.ensure(ORG, WABA, 'manual');
        await w.service.reconcile(ORG, WABA);
        expect(w.created.filter((c) => c.fields.packSlot === 'order_shipped')).toHaveLength(0);
    });
});

describe('the reconcile job', () => {
    const full = (w: ReturnType<typeof world>, patch: Record<string, Row> = {}) =>
        w.rows.push(...CORE.map((s) => w.row({ name: `collabo_${s.key}_v1`, packSlot: s.key, status: 'APPROVED', ...(patch[s.key] ?? {}) })));

    it('re-reads every pack template still with Meta, and always lets the automations follow', async () => {
        const w = world();
        full(w, { cod_confirm: { status: 'PENDING' }, order_shipped: { status: 'PAUSED' } });
        await w.service.reconcile(ORG, WABA);
        expect(w.templates.refreshStatus.mock.calls.map((c) => c[1].packSlot).sort()).toEqual(['cod_confirm', 'order_shipped']);
        expect(w.created).toHaveLength(0);
        expect(w.jobs.managedSync).toHaveBeenCalledWith(ORG);
    });

    it('replaces a rejected template from an unused library variant, once', async () => {
        const w = world();
        full(w, { order_shipped: { status: 'REJECTED', rejectionInfo: { reason: 'Too promotional' } } });
        await w.service.reconcile(ORG, WABA);
        expect(w.created.map((c) => [c.via, c.name])).toEqual([['library', 'collabo_order_shipped_v2']]);
        w.rows.find((r) => r.name === 'collabo_order_shipped_v2')!.status = 'REJECTED';
        await w.service.reconcile(ORG, WABA);
        expect(w.created).toHaveLength(1);
    });

    it('replaces a utility template Meta approved as marketing when a library variant is left, and keeps it otherwise', async () => {
        const w = world();
        full(w, { order_shipped: { category: 'MARKETING', requestedCategory: 'UTILITY' }, out_for_delivery: { category: 'MARKETING', requestedCategory: 'UTILITY' } });
        await w.service.reconcile(ORG, WABA);
        expect(w.created.map((c) => c.name)).toEqual(['collabo_order_shipped_v2']);
    });

    it('leaves a paused template alone, and a disabled one is handled as rejected', async () => {
        const w = world();
        full(w, { order_shipped: { status: 'DISABLED' }, order_delivered: { status: 'PAUSED' } });
        await w.service.reconcile(ORG, WABA);
        expect(w.created.map((c) => c.name)).toEqual(['collabo_order_shipped_v2']);
    });

    it('stops the pack when Meta reports its template limit', async () => {
        const w = world();
        full(w, { optin_confirmed: { status: 'LIMIT_EXCEEDED' } });
        await w.service.reconcile(ORG, WABA);
        expect(w.pack()).toMatchObject({ status: 'stopped', stoppedReason: expect.stringMatching(/limit on message templates/) });
        expect(w.jobs.managedSync).toHaveBeenCalledWith(ORG);
    });
});

describe('what the templates page shows', () => {
    it('a state per slot of the sets that apply, the pack, and the counts', async () => {
        const w = world({ razorpay: true });
        w.rows.push(
            w.row({ name: 'collabo_order_confirmed_v1', packSlot: 'order_confirmed', status: 'APPROVED', packSource: 'library', libraryTemplateName: 'order_confirmed' }),
            w.row({ name: 'collabo_cod_confirm_v1', packSlot: 'cod_confirm', status: 'PENDING' }),
            w.row({ name: 'collabo_order_shipped_v1', packSlot: 'order_shipped', status: 'REJECTED', rejectionInfo: { reason: 'INVALID_FORMAT', recommendation: 'Fix it' } }),
            w.row({ name: 'collabo_out_for_delivery_v1', packSlot: 'out_for_delivery', status: 'APPROVED', category: 'MARKETING', requestedCategory: 'UTILITY' }),
            w.row({ name: 'collabo_order_delivered_v1', packSlot: 'order_delivered', status: 'PAUSED' }),
        );
        const view = await w.service.view(ORG);
        expect(view.pack).toMatchObject({ status: 'pending', origin: 'connect', autoActivate: true, version: 0, cartDiscount: null });
        expect(view.sets).toEqual(['core', 'payment']);
        expect(view.slots.map((s) => s.slot)).toEqual([...CORE, ...PAYMENT].map((s) => s.key));
        const by = Object.fromEntries(view.slots.map((s) => [s.slot, s]));
        expect(by.order_confirmed).toMatchObject({ state: 'approved', template: { source: 'library', status: 'APPROVED', packVersion: 1 } });
        expect(by.cod_confirm.state).toBe('pending');
        expect(by.order_shipped).toMatchObject({ state: 'attention', template: { rejectionInfo: { reason: 'INVALID_FORMAT', recommendation: 'Fix it' } } });
        expect(by.out_for_delivery).toMatchObject({ state: 'attention', template: { category: 'MARKETING', requestedCategory: 'UTILITY' } });
        expect(by.order_delivered.state).toBe('paused');
        expect(by.payment_link).toMatchObject({ state: 'not_created', template: null, set: 'payment', title: 'Payment link' });
        expect(view.counts).toEqual({ total: CORE.length + PAYMENT.length, approved: 1, pending: 1, attention: 2 });
    });

    it('no pack row: the slots, and nothing to report about a pack', async () => {
        const view = await world({ pack: null }).service.view(ORG);
        expect(view.pack).toBeNull();
        expect(view.slots.every((s) => s.state === 'not_created')).toBe(true);
    });

    it('setting it up by hand makes a pack whose automations wait for the merchant, and queues it', async () => {
        const w = world({ pack: null });
        (w.prisma.templatePack as any).create = jest.fn(async () => ({}));
        await w.service.start(ORG);
        expect((w.prisma.templatePack as any).create).toHaveBeenCalledWith({ data: { organizationId: ORG, channelId: 'ch_wa', wabaId: WABA, autoActivate: false, origin: 'manual' } });
        expect(w.jobs.ensure).toHaveBeenCalledWith(ORG, WABA, 'manual');
    });
});

describe('pack helpers', () => {
    it('reads a utility restriction only while it lasts', () => {
        const now = Date.now();
        expect(utilityRestricted({ accountRestrictions: [{ restriction_type: 'RATE_LIMITED_UTILITY_TEMPLATE_MESSAGING' }] }, now)).toBe(true);
        expect(utilityRestricted({ accountRestrictions: [{ restriction_type: 'RESTRICTED_UTILITY_TEMPLATES', expiration: now / 1000 - 60 }] }, now)).toBe(false);
        expect(utilityRestricted({ accountRestrictions: [{ restriction_type: 'RESTRICTED_BIZ_INITIATED_MESSAGING' }] }, now)).toBe(false);
        expect(utilityRestricted(null, now)).toBe(false);
    });

    it('shows the approved template a slot sends with over a newer one in review', () => {
        const w = world();
        const sending = w.row({ name: 'collabo_order_shipped_v1', packSlot: 'order_shipped', status: 'APPROVED' });
        const review = w.row({ name: 'collabo_order_shipped_v2', packSlot: 'order_shipped', packVersion: 2, status: 'PENDING' });
        expect(slotState([sending, review] as any, { key: 'order_shipped', category: 'UTILITY' })).toEqual({ state: 'approved', template: sending });
    });
});
