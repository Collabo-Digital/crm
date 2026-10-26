import { Prisma } from '@prisma/client';
import { TemplatePackBackfill } from './template-pack.backfill';
import { claimPackRow, queuePackEnsure } from './template-pack.queue';

/** Fake BullMQ queue: jobs by id with a state; finished ones are kept, as BullMQ keeps them. */
function queueOf(states: Record<string, string> = {}) {
    const removed: string[] = [];
    const queue = {
        getJob: jest.fn(async (id: string) => (states[id] ? { getState: async () => states[id], remove: async () => void removed.push(id) } : undefined)),
        add: jest.fn(async () => ({})),
    };
    return { queue, removed };
}

const job = { organizationId: 'org_1', wabaId: '1029', reason: 'connect' as const };

describe('queueing an ensure', () => {
    it('uses the organization’s job id, never a bare number or a colon, at normal priority', async () => {
        const { queue } = queueOf();
        await queuePackEnsure(queue as any, job);
        expect(queue.add).toHaveBeenCalledWith('ensure', job, expect.objectContaining({ jobId: 'pack-ensure-org_1', priority: 5, attempts: 5 }));
    });

    it('replaces a finished job, which BullMQ would otherwise keep and ignore the add for', async () => {
        const { queue, removed } = queueOf({ 'pack-ensure-org_1': 'completed' });
        expect(await queuePackEnsure(queue as any, job)).toBe('added');
        expect(removed).toEqual(['pack-ensure-org_1']);
    });

    it('leaves a waiting one alone, and queues one follow-up behind a running one', async () => {
        const waiting = queueOf({ 'pack-ensure-org_1': 'waiting' });
        expect(await queuePackEnsure(waiting.queue as any, job)).toBe('waiting');
        expect(waiting.queue.add).not.toHaveBeenCalled();

        const running = queueOf({ 'pack-ensure-org_1': 'active' });
        expect(await queuePackEnsure(running.queue as any, job)).toBe('added');
        expect(running.queue.add).toHaveBeenCalledWith('ensure', job, expect.objectContaining({ jobId: 'pack-ensure-org_1-next' }));
    });

    it('runs the backfill at bulk priority, and can be delayed', async () => {
        const { queue } = queueOf();
        await queuePackEnsure(queue as any, { ...job, reason: 'backfill' }, { delayMs: 3600_000 });
        expect(queue.add).toHaveBeenCalledWith('ensure', expect.anything(), expect.objectContaining({ priority: 10, delay: 3600_000 }));
    });
});

describe('claiming the pack row', () => {
    const prismaWith = (existing: Record<string, unknown> | null) => ({
        templatePack: { findUnique: jest.fn(async () => existing), create: jest.fn(async () => ({})), update: jest.fn(async () => ({})) },
    });
    const row = { organizationId: 'org_1', channelId: 'ch_2', wabaId: '1029', autoActivate: true, origin: 'connect' as const };

    it('makes a new row with the caller’s intent', async () => {
        const prisma = prismaWith(null);
        await claimPackRow(prisma as any, row);
        expect(prisma.templatePack.create).toHaveBeenCalledWith({ data: row });
    });

    it('keeps an existing row’s intent, following a new channel row', async () => {
        const prisma = prismaWith({ id: 'p', organizationId: 'org_1', channelId: 'ch_1', autoActivate: false, origin: 'backfill' });
        await claimPackRow(prisma as any, row);
        expect(prisma.templatePack.update).toHaveBeenCalledWith({ where: { id: 'p' }, data: { channelId: 'ch_2' } });
    });

    it('starts again for an organization that takes over an account another one had', async () => {
        const prisma = prismaWith({ id: 'p', organizationId: 'org_old', channelId: 'ch_1' });
        await claimPackRow(prisma as any, row);
        expect(prisma.templatePack.update).toHaveBeenCalledWith({
            where: { id: 'p' },
            data: { ...row, version: 0, status: 'pending', stoppedReason: null, lastRunAt: null, settings: Prisma.DbNull },
        });
    });

    it('lets a row made a moment ago by another start stand', async () => {
        const prisma = prismaWith(null);
        prisma.templatePack.create.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' }));
        await expect(claimPackRow(prisma as any, row)).resolves.toBeUndefined();
    });
});

describe('the start-up backfill', () => {
    function build(opts: { enabled?: boolean; accounts?: Array<Record<string, unknown>>; jobs?: Record<string, string> } = {}) {
        const prisma = {
            $queryRaw: jest.fn(async () => opts.accounts ?? []),
            templatePack: { findUnique: jest.fn(async () => null), create: jest.fn(async () => ({})), update: jest.fn(async () => ({})) },
        };
        const { queue } = queueOf(opts.jobs);
        const config = { get: jest.fn(() => opts.enabled ?? true) };
        return { backfill: new TemplatePackBackfill(prisma as any, config as any, queue as any), prisma, queue, config };
    }
    const account = (patch: Record<string, unknown> = {}) => ({ channelId: 'ch_1', organizationId: 'org_1', wabaId: '1029', status: 'CONNECTED', packOrg: null, version: null, ...patch });

    it('does nothing at start-up when TEMPLATE_PACK_AUTO_ENABLE is false', async () => {
        const { backfill, prisma, queue, config } = build({ enabled: false, accounts: [account()] });
        backfill.onApplicationBootstrap();
        await new Promise((r) => setImmediate(r));
        expect(config.get).toHaveBeenCalledWith('templatePack.autoEnable');
        expect(prisma.$queryRaw).not.toHaveBeenCalled();
        expect(queue.add).not.toHaveBeenCalled();
    });

    it('queues at start-up when it is on, without waiting for it', async () => {
        const { backfill, queue } = build({ accounts: [account()] });
        expect(backfill.onApplicationBootstrap()).toBeUndefined();
        await new Promise((r) => setImmediate(r));
        expect(queue.add).toHaveBeenCalledTimes(1);
    });

    it('gives an account connected before the pack a row whose automations wait for the merchant', async () => {
        const { backfill, prisma, queue } = build({ accounts: [account()] });
        expect(await backfill.enqueueAll()).toBe(1);
        expect(prisma.templatePack.create).toHaveBeenCalledWith({ data: { organizationId: 'org_1', channelId: 'ch_1', wabaId: '1029', autoActivate: false, origin: 'backfill' } });
        expect(queue.add).toHaveBeenCalledWith(
            'ensure',
            { organizationId: 'org_1', wabaId: '1029', reason: 'backfill' },
            expect.objectContaining({ jobId: 'pack-ensure-org_1', priority: 10 }),
        );
    });

    it('gives an account in error a row too, so it never goes live by itself when it reconnects, and ensures only connected ones', async () => {
        const { backfill, prisma, queue } = build({ accounts: [account(), account({ channelId: 'ch_2', organizationId: 'org_2', wabaId: '2029', status: 'ERROR' })] });
        expect(await backfill.enqueueAll()).toBe(1);
        expect(prisma.templatePack.create).toHaveBeenCalledWith({ data: { organizationId: 'org_2', channelId: 'ch_2', wabaId: '2029', autoActivate: false, origin: 'backfill' } });
        expect(prisma.templatePack.create).toHaveBeenCalledTimes(2);
        expect(queue.add).toHaveBeenCalledTimes(1);
        expect(queue.add).toHaveBeenCalledWith('ensure', expect.objectContaining({ organizationId: 'org_1' }), expect.anything());
    });

    it('ensures a pack of an older version again, leaving its row as it is', async () => {
        const { backfill, prisma, queue } = build({ accounts: [account({ packOrg: 'org_1', version: 0 })] });
        expect(await backfill.enqueueAll()).toBe(1);
        expect(prisma.templatePack.create).not.toHaveBeenCalled();
        expect(prisma.templatePack.update).not.toHaveBeenCalled();
        expect(queue.add).toHaveBeenCalledTimes(1);
    });

    it('selects WhatsApp accounts not disconnected, of live organizations, without a row or (connected) without the current pack', async () => {
        const { backfill, prisma } = build();
        await backfill.enqueueAll();
        const call = prisma.$queryRaw.mock.calls[0] as unknown as [TemplateStringsArray, ...unknown[]];
        const sql = call[0].join('?');
        expect(sql).toMatch(/c."platform" = 'WHATSAPP' AND c."status" <> 'DISCONNECTED'/);
        expect(sql).toMatch(/o."deleted_at" IS NULL/);
        expect(sql).toMatch(/p."id" IS NULL OR p."organization_id" <> c."organization_id" OR \(c."status" = 'CONNECTED' AND p."version" < \?\)/);
        expect(call[1]).toBe(1);
    });

    it('leaves an account whose ensure is queued or running alone, so several servers starting queue it once', async () => {
        const { backfill, queue } = build({ accounts: [account()], jobs: { 'pack-ensure-org_1': 'active' } });
        expect(await backfill.enqueueAll()).toBe(0);
        expect(queue.add).not.toHaveBeenCalled();
    });
});
