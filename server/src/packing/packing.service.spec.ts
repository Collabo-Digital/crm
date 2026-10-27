import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PackingService } from './packing.service';

/**
 * PackingService against a stand-in database. What matters here is how each
 * action talks to it: a scan adds a unit only through a conditional UPDATE
 * (so two packers can never over-pack), a retried request changes nothing,
 * and status changes write their event and order timeline entry.
 * The same paths ran against real Postgres while this was built.
 */

const ORG = 'org_1';
const USER = 'u_riya';
const TASK = 'task_1';
const ORDER = 'order_1';

interface Line {
    id: string;
    orderLineItemId: string;
    variantId: string | null;
    sku: string | null;
    barcode: string | null;
    qtyRequired: number;
    qtyPicked: number;
    qtyHandConfirmed: number;
    qtyCounted: number;
    problemReason: string | null;
    problemQty: number;
}

const line = (over: Partial<Line>): Line => ({
    id: 'l1',
    orderLineItemId: 'oli1',
    variantId: 'v1',
    sku: 'TEE',
    barcode: '890123',
    qtyRequired: 2,
    qtyPicked: 0,
    qtyHandConfirmed: 0,
    qtyCounted: 0,
    problemReason: null,
    problemQty: 0,
    ...over,
});

/** The `data` of each call to a create or update mock, in call order. */
const dataOf = (fn: { mock: { calls: unknown[][] } }) =>
    fn.mock.calls.map((c) => (c[0] as { data: Record<string, unknown> }).data);

const uniqueViolation = () => new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' });

function build(opts: { status?: string; lines?: Line[]; updated?: number[]; variant?: unknown; prior?: unknown[]; order?: Record<string, unknown> } = {}) {
    const state = { status: opts.status ?? 'PACKING' };
    const lines = opts.lines ?? [line({})];
    const updated = [...(opts.updated ?? [])];
    const prior = [...(opts.prior ?? [])];

    const sqlOf = (strings: TemplateStringsArray) => strings.join('?');
    const tx = {
        $queryRaw: jest.fn((strings: TemplateStringsArray) => {
            const sql = sqlOf(strings);
            if (sql.includes('FROM "pick_tasks"')) return Promise.resolve([{ status: state.status }]);
            if (sql.includes('FROM "order_line_items"')) return Promise.resolve(lines.map((l) => ({ id: l.orderLineItemId })));
            return Promise.resolve([]);
        }),
        $executeRaw: jest.fn(() => Promise.resolve(updated.shift() ?? 0)),
        pickTaskLine: {
            findMany: jest.fn(() => Promise.resolve(lines)),
            findFirst: jest.fn(({ where }: { where: { id: string } }) => Promise.resolve(lines.find((l) => l.id === where.id) ?? null)),
            update: jest.fn(() => Promise.resolve({})),
        },
        pickTask: { update: jest.fn(() => Promise.resolve({})) },
        pickTaskEvent: {
            create: jest.fn(({ data }: { data: { kind: string; code?: string; pickTaskLineId?: string | null } }) =>
                Promise.resolve({ kind: data.kind, code: data.code ?? null, pickTaskLineId: data.pickTaskLineId ?? null })),
        },
        orderTimelineEvent: { create: jest.fn(() => Promise.resolve({})) },
        productVariant: { findFirst: jest.fn(() => Promise.resolve(opts.variant ?? null)) },
    };
    const prisma = {
        ...tx,
        $transaction: jest.fn((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
        pickTask: {
            ...tx.pickTask,
            findFirst: jest.fn((): Promise<{ id: string; orderId: string; status: string } | null> =>
                Promise.resolve({ id: TASK, orderId: ORDER, status: state.status })),
        },
        pickTaskEvent: {
            ...tx.pickTaskEvent,
            findUnique: jest.fn(() => Promise.resolve(prior.shift() ?? null)),
        },
        order: {
            findFirst: jest.fn(() => Promise.resolve({
                id: ORDER,
                name: '#1001',
                cancelledAt: null,
                closedAt: null,
                financialStatus: 'PAID',
                fulfillmentStatus: 'UNFULFILLED',
                posSale: false,
                sourceName: 'web',
                paymentGateways: [],
                tags: [],
                dispatchWarehouseId: null,
                lineItems: [{ id: 'oli1', quantity: 3, fulfilledQuantity: 0, requiresShipping: true, externalId: '1' }],
                ...opts.order,
            })),
        },
        user: {
            findMany: jest.fn(() => Promise.resolve([{ id: USER, firstName: 'Riya', lastName: 'Sharma', email: 'riya@x.in' }])),
        },
    };
    const service = new PackingService(prisma as never);
    // The pack screen's read is covered by the database run; here only the writes matter.
    const view = jest.spyOn(service as any, 'view').mockResolvedValue({ id: TASK });
    jest.spyOn(service as any, 'reconcile').mockResolvedValue(undefined);
    return { service, prisma, tx, state, view, sqlOf };
}

describe('PackingService.scan', () => {
    it('adds one unit through an UPDATE guarded by qty_picked < qty_required', async () => {
        const { service, tx, sqlOf } = build({ updated: [1] });

        const out = await service.scan(ORG, USER, TASK, { code: '890123', clientScanId: 's1' });

        expect(out).toMatchObject({ result: 'matched', lineId: 'l1' });
        const [strings, ...values] = tx.$executeRaw.mock.calls[0] as unknown as [TemplateStringsArray, ...unknown[]];
        expect(sqlOf(strings)).toContain('"qty_picked" = "qty_picked" + 1');
        expect(sqlOf(strings)).toContain('AND "qty_picked" < "qty_required"');
        expect(values).toContain('l1');
        expect(values).toContain(TASK);
        expect(dataOf(tx.pickTaskEvent.create)).toMatchObject([
            { kind: 'SCAN_MATCH', pickTaskLineId: 'l1', qty: 1, code: '890123', clientScanId: 's1', actorId: USER },
        ]);
    });

    it('takes the task FOR SHARE first, so a hold or finish waits for the scan', async () => {
        const { service, tx, sqlOf } = build({ updated: [1] });
        await service.scan(ORG, USER, TASK, { code: '890123', clientScanId: 's1' });
        const first = tx.$queryRaw.mock.calls[0] as unknown as [TemplateStringsArray];
        expect(sqlOf(first[0])).toContain('FOR SHARE');
    });

    it('moves to the next matching line when another packer filled the first', async () => {
        const { service, tx } = build({
            lines: [line({ id: 'l1', orderLineItemId: 'oli1' }), line({ id: 'l2', orderLineItemId: 'oli2' })],
            updated: [0, 1],
        });

        const out = await service.scan(ORG, USER, TASK, { code: 'TEE', clientScanId: 's1' });

        expect(out).toMatchObject({ result: 'matched', lineId: 'l2' });
        expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
    });

    it('is over, changing nothing, when every matching line is full', async () => {
        const { service, tx } = build({ updated: [0] });

        const out = await service.scan(ORG, USER, TASK, { code: '890123', clientScanId: 's1' });

        expect(out).toMatchObject({ result: 'over', lineId: 'l1' });
        expect(dataOf(tx.pickTaskEvent.create)).toMatchObject([{ kind: 'SCAN_OVER', qty: 0 }]);
    });

    it('names the product picked by mistake when the code is another product of the organization', async () => {
        const { service, tx } = build({ variant: { title: 'Default Title', product: { title: 'Green Cap' } } });

        const out = await service.scan(ORG, USER, TASK, { code: '8900000000017', clientScanId: 's1' });

        expect(out).toMatchObject({ result: 'not_in_order', product: { title: 'Green Cap', variantTitle: null } });
        expect(out).not.toHaveProperty('lineId');
        expect(tx.$executeRaw).not.toHaveBeenCalled();
        expect(dataOf(tx.pickTaskEvent.create)).toMatchObject([{ kind: 'SCAN_NOT_IN_ORDER' }]);
    });

    it('is unknown when the code matches nothing at all, and still records it', async () => {
        const { service, tx } = build();

        const out = await service.scan(ORG, USER, TASK, { code: 'zzz', clientScanId: 's1' });

        expect(out).toMatchObject({ result: 'unknown' });
        expect(out).not.toHaveProperty('product');
        expect(dataOf(tx.pickTaskEvent.create)).toMatchObject([{ kind: 'SCAN_UNKNOWN' }]);
    });

    it('returns the first outcome for a retried clientScanId and changes nothing', async () => {
        const { service, prisma, tx } = build({ prior: [{ kind: 'SCAN_MATCH', code: '890123', pickTaskLineId: 'l1' }] });

        const out = await service.scan(ORG, USER, TASK, { code: '890123', clientScanId: 's1' });

        expect(out).toMatchObject({ result: 'matched', lineId: 'l1' });
        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(tx.$executeRaw).not.toHaveBeenCalled();
    });

    it('a retry racing its original gets the original outcome (its own write rolls back)', async () => {
        const { service, prisma } = build({ prior: [null, { kind: 'SCAN_OVER', code: '890123', pickTaskLineId: 'l1' }] });
        prisma.$transaction.mockRejectedValueOnce(uniqueViolation());

        const out = await service.scan(ORG, USER, TASK, { code: '890123', clientScanId: 's1' });

        expect(out).toMatchObject({ result: 'over', lineId: 'l1' });
    });

    it.each([
        ['ON_HOLD', 'on hold'],
        ['PACKED', 'already packed'],
        ['CANCELLED', 'cancelled'],
    ])('refuses with 409 while the task is %s', async (status, words) => {
        const { service, tx } = build({ status });

        await expect(service.scan(ORG, USER, TASK, { code: '890123', clientScanId: 's1' })).rejects.toThrow(ConflictException);
        await expect(service.scan(ORG, USER, TASK, { code: '890123', clientScanId: 's2' })).rejects.toThrow(words);
        expect(tx.$executeRaw).not.toHaveBeenCalled();
        expect(tx.pickTaskEvent.create).not.toHaveBeenCalled();
    });
});

describe('PackingService line actions', () => {
    it('a count records the typed units above scanned and hand-confirmed as counted', async () => {
        const { service, tx } = build({ lines: [line({ qtyRequired: 6, qtyPicked: 2, qtyHandConfirmed: 1 })] });

        await service.count(ORG, USER, TASK, 'l1', { packed: 5, clientScanId: 'c1' });

        expect(tx.pickTaskLine.update.mock.calls[0]).toMatchObject([{ where: { id: 'l1' }, data: { qtyPicked: 5, qtyCounted: 3 } }]);
        expect(dataOf(tx.pickTaskEvent.create)).toMatchObject([{ kind: 'COUNT', qty: 3, clientScanId: 'c1' }]);
    });

    it('an undo takes a counted unit before a scanned one', async () => {
        const { service, tx } = build({ lines: [line({ qtyRequired: 6, qtyPicked: 4, qtyCounted: 2 })] });

        await service.undo(ORG, USER, TASK, 'l1', { clientScanId: 'u1' });

        expect(tx.pickTaskLine.update).toHaveBeenCalledWith({ where: { id: 'l1' }, data: { qtyPicked: 3, qtyCounted: 1 } });
        expect(dataOf(tx.pickTaskEvent.create)).toMatchObject([{ kind: 'UNDO', reason: 'counted' }]);
    });

    it('a retried line action changes nothing', async () => {
        const { service, prisma, tx } = build({ prior: [{ kind: 'HAND_CONFIRM', code: null, pickTaskLineId: 'l1' }] });

        await service.confirm(ORG, USER, TASK, 'l1', { qty: 1, clientScanId: 'h1' });

        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(tx.pickTaskLine.update).not.toHaveBeenCalled();
    });

    it('refuses to undo an empty line', async () => {
        const { service } = build();
        await expect(service.undo(ORG, USER, TASK, 'l1', { clientScanId: 'u1' })).rejects.toThrow('Nothing on this line is packed yet.');
    });
});

describe('PackingService hold and resume', () => {
    it('hold sets ON_HOLD with the reason, and writes an event and the order timeline', async () => {
        const { service, tx, sqlOf } = build();

        await service.hold(ORG, USER, TASK, { reason: 'items_short', note: ' Short 2 ' });

        expect(sqlOf((tx.$queryRaw.mock.calls[0] as unknown as [TemplateStringsArray])[0])).toContain('FOR UPDATE');
        expect(dataOf(tx.pickTask.update)).toMatchObject([{ status: 'ON_HOLD', holdReason: 'items_short', holdNote: 'Short 2', heldBy: USER }]);
        expect(dataOf(tx.pickTaskEvent.create)).toMatchObject([{ kind: 'HOLD', reason: 'items_short' }]);
        expect(dataOf(tx.orderTimelineEvent.create)).toMatchObject([
            { orderId: ORDER, action: 'packing_held', message: 'Packing put on hold by Riya Sharma: items short (Short 2)' },
        ]);
    });

    it('cannot hold a packed order', async () => {
        const { service } = build({ status: 'PACKED' });
        await expect(service.hold(ORG, USER, TASK, { reason: 'other' })).rejects.toThrow('already packed');
    });

    it('resume sets PACKING and clears the hold', async () => {
        const { service, tx } = build({ status: 'ON_HOLD' });

        await service.resume(ORG, USER, TASK);

        expect(tx.pickTask.update).toHaveBeenCalledWith({
            where: { id: TASK },
            data: { status: 'PACKING', holdReason: null, holdNote: null, heldAt: null, heldBy: null },
        });
        expect(dataOf(tx.orderTimelineEvent.create)).toMatchObject([{ action: 'packing_resumed', message: 'Packing resumed by Riya Sharma' }]);
    });

    it('resuming a task already packing changes nothing', async () => {
        const { service, tx } = build({ status: 'PACKING' });
        await service.resume(ORG, USER, TASK);
        expect(tx.pickTask.update).not.toHaveBeenCalled();
        expect(tx.orderTimelineEvent.create).not.toHaveBeenCalled();
    });
});

describe('PackingService.finish', () => {
    const short = [line({ qtyRequired: 2, qtyPicked: 2 }), line({ id: 'l2', orderLineItemId: 'oli2', qtyRequired: 1, qtyPicked: 0 })];

    it('sends the packed part of a prepaid order now and the rest later', async () => {
        const { service, tx } = build({ lines: short });

        await service.finish(ORG, USER, TASK, { mode: 'partial' });

        expect(dataOf(tx.pickTask.update)).toMatchObject([{ status: 'PACKED', packedBy: USER, partial: true }]);
        expect(dataOf(tx.pickTask.update)[0].packedAt).toBeInstanceOf(Date);
        expect(dataOf(tx.orderTimelineEvent.create)).toMatchObject([
            { action: 'packed', message: 'Packed by Riya Sharma (2 of 3 items, the rest later)' },
        ]);
    });

    it('never splits a COD order', async () => {
        const { service, tx } = build({ lines: short, order: { financialStatus: 'PENDING', paymentGateways: ['Cash on Delivery (COD)'] } });

        await expect(service.finish(ORG, USER, TASK, { mode: 'partial' })).rejects.toThrow('Cash on delivery');
        expect(tx.pickTask.update).not.toHaveBeenCalled();
    });

    it('needs every line full to mark it all packed', async () => {
        const { service } = build({ lines: short });
        await expect(service.finish(ORG, USER, TASK, { mode: 'all' })).rejects.toThrow('1 item is still to pack');
    });

    it('refuses an order cancelled while it was being packed', async () => {
        const { service } = build({ lines: short, order: { cancelledAt: new Date() } });
        await expect(service.finish(ORG, USER, TASK, { mode: 'all' })).rejects.toThrow('cancelled');
    });
});

describe('PackingService.start', () => {
    it('refuses an order that is not packed, with the reason', async () => {
        const { service } = build({ order: { posSale: true } });
        await expect(service.start(ORG, USER, ORDER)).rejects.toThrow(new ConflictException('This was a counter sale, so it is not packed.'));
    });

    it('when two packers start at once, the second gets the first one\'s task', async () => {
        const { service, prisma, view } = build();
        prisma.pickTask.findFirst
            .mockResolvedValueOnce(null) // no open task yet
            .mockResolvedValueOnce(null) // nothing packed
            .mockResolvedValueOnce({ id: 'task_winner', orderId: ORDER, status: 'PACKING' });
        prisma.$transaction.mockRejectedValueOnce(uniqueViolation());

        await service.start(ORG, USER, ORDER);

        expect(view.mock.calls[0].slice(0, 2)).toEqual([ORG, 'task_winner']);
    });
});
