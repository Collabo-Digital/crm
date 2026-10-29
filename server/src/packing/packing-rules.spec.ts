import {
    TaskLineState,
    bucketOf,
    clampToRequired,
    codConfirmedOf,
    countRefusal,
    foldAccuracy,
    ineligibleReason,
    isPackableLine,
    lastShippedAt,
    matchingLines,
    paymentOf,
    planFinish,
    planReconcile,
    undoSource,
} from './packing-rules';

/**
 * The packing assistant's rules: which orders are packed, which list they sit
 * in, what a scan matches, and when a count, an undo or a finish is allowed.
 */

const shopLine = (over: Partial<{ quantity: number; fulfilledQuantity: number; requiresShipping: boolean; externalId: string }> = {}) => ({
    quantity: 2,
    fulfilledQuantity: 0,
    requiresShipping: true,
    externalId: '1234',
    ...over,
});

const order = (over: Record<string, unknown> = {}) => ({
    cancelledAt: null,
    closedAt: null,
    financialStatus: 'PAID',
    fulfillmentStatus: 'UNFULFILLED',
    posSale: false,
    sourceName: 'web',
    lineItems: [shopLine()],
    ...over,
});

describe('which orders can be packed', () => {
    it('packs an unfulfilled or partly shipped online order', () => {
        expect(ineligibleReason(order())).toBeNull();
        expect(ineligibleReason(order({ fulfillmentStatus: 'PARTIAL', lineItems: [shopLine({ fulfilledQuantity: 1 })] }))).toBeNull();
    });

    it.each([
        ['cancelled', { cancelledAt: new Date() }, 'cancelled'],
        ['closed', { closedAt: new Date() }, 'closed'],
        ['refunded', { financialStatus: 'REFUNDED' }, 'refunded'],
        ['voided', { financialStatus: 'VOIDED' }, 'voided'],
        ['a Collabo POS sale', { posSale: true }, 'counter sale'],
        ['a Shopify POS sale', { sourceName: 'pos' }, 'counter sale'],
        ['shipped', { fulfillmentStatus: 'FULFILLED' }, 'already shipped'],
        ['restocked', { fulfillmentStatus: 'RESTOCKED' }, 'returned'],
    ])('refuses an order that is %s', (_label, over, words) => {
        expect(ineligibleReason(order(over))).toContain(words);
    });

    it('refuses an order with every line shipped, or nothing that ships', () => {
        expect(ineligibleReason(order({ lineItems: [shopLine({ fulfilledQuantity: 2 })] }))).toContain('Every item');
        expect(ineligibleReason(order({ lineItems: [shopLine({ requiresShipping: false })] }))).toContain('needs shipping');
    });

    it('counts remaining units only, and skips lines a store says need no shipping', () => {
        expect(isPackableLine(shopLine({ quantity: 3, fulfilledQuantity: 3 }))).toBe(false);
        expect(isPackableLine(shopLine({ requiresShipping: false }))).toBe(false);
    });

    it("ignores requiresShipping on Collabo's own offline orders, which write false on every line", () => {
        expect(isPackableLine(shopLine({ requiresShipping: false, externalId: 'manual_9f2c' }))).toBe(true);
    });
});

describe('payment and COD confirmation', () => {
    it('reads COD from the gateway, prepaid when paid, unpaid otherwise', () => {
        expect(paymentOf({ paymentGateways: ['Cash on Delivery (COD)'], financialStatus: 'PENDING' })).toBe('cod');
        expect(paymentOf({ paymentGateways: ['razorpay'], financialStatus: 'PAID' })).toBe('prepaid');
        expect(paymentOf({ paymentGateways: [], financialStatus: 'PENDING' })).toBe('unpaid');
    });

    it('confirms COD by the cod-confirmed tag in any case; null for other orders', () => {
        expect(codConfirmedOf('cod', ['vip', 'COD-Confirmed'])).toBe(true);
        expect(codConfirmedOf('cod', ['cod-check'])).toBe(false);
        expect(codConfirmedOf('prepaid', ['cod-confirmed'])).toBeNull();
    });
});

describe('queue buckets', () => {
    const at = (iso: string) => new Date(iso);

    it('an open task decides the bucket', () => {
        expect(bucketOf({ openStatus: 'PACKING', lastPackedAt: null, lastShippedAt: null })).toBe('packing');
        expect(bucketOf({ openStatus: 'ON_HOLD', lastPackedAt: at('2026-10-02'), lastShippedAt: null })).toBe('on_hold');
    });

    it('packed until something ships after the packing', () => {
        expect(bucketOf({ openStatus: null, lastPackedAt: at('2026-10-02'), lastShippedAt: null })).toBe('packed');
        expect(bucketOf({ openStatus: null, lastPackedAt: at('2026-10-02'), lastShippedAt: at('2026-10-01') })).toBe('packed');
        expect(bucketOf({ openStatus: null, lastPackedAt: at('2026-10-02'), lastShippedAt: at('2026-10-03') })).toBe('to_pack');
        expect(bucketOf({ openStatus: null, lastPackedAt: null, lastShippedAt: null })).toBe('to_pack');
    });

    it('a cancelled or failed shipment never counts as shipped', () => {
        const created = at('2026-10-05');
        expect(lastShippedAt([
            { status: 'cancelled', shippedAt: at('2026-10-09'), createdAt: created },
            { status: 'failure', shippedAt: null, createdAt: at('2026-10-08') },
            { status: 'success', shippedAt: null, createdAt: created },
        ])).toEqual(created);
    });
});

describe('what a scan matches', () => {
    const lines = [
        { id: 'a', variantId: 'v1', sku: 'TEE-BLU', barcode: '890123' },
        { id: 'b', variantId: 'v2', sku: 'MUG', barcode: null },
        { id: 'c', variantId: 'v3', sku: 'TEE-BLU', barcode: '777' },
        { id: 'custom', variantId: null, sku: 'GIFT', barcode: 'GIFT' },
    ];

    it('exact barcode first, before any SKU', () => {
        expect(matchingLines(lines, ' 890123 ').map((l) => l.id)).toEqual(['a']);
    });

    it('then exact SKU, every such line in line order', () => {
        expect(matchingLines(lines, 'TEE-BLU').map((l) => l.id)).toEqual(['a', 'c']);
    });

    it('then SKU ignoring case', () => {
        expect(matchingLines(lines, 'mug').map((l) => l.id)).toEqual(['b']);
    });

    it('never matches a custom line, which is confirmed by hand only', () => {
        expect(matchingLines(lines, 'GIFT')).toEqual([]);
    });

    it('matches nothing for an unknown or empty code', () => {
        expect(matchingLines(lines, 'nope')).toEqual([]);
        expect(matchingLines(lines, '   ')).toEqual([]);
    });
});

const qty = (over: Partial<TaskLineState> = {}): TaskLineState => ({
    id: 'line',
    orderLineItemId: 'oli',
    variantId: 'v',
    title: 'Socks',
    variantTitle: null,
    sku: 'SOCK',
    barcode: null,
    qtyRequired: 6,
    qtyPicked: 0,
    qtyHandConfirmed: 0,
    qtyCounted: 0,
    problemReason: null,
    problemQty: 0,
    ...over,
});

describe('typing a count', () => {
    it('only on lines of 5 or more', () => {
        expect(countRefusal(qty({ qtyRequired: 4, qtyPicked: 1 }), 3)).toMatchObject({ conflict: true });
    });

    it('only after one unit was scanned (hand-confirmed units do not count)', () => {
        expect(countRefusal(qty(), 3)).toMatchObject({ conflict: true });
        expect(countRefusal(qty({ qtyPicked: 1, qtyHandConfirmed: 1 }), 3)).toMatchObject({ conflict: true });
        expect(countRefusal(qty({ qtyPicked: 1 }), 3)).toBeNull();
    });

    it('never below what was scanned and hand-confirmed, never above what is needed', () => {
        const line = qty({ qtyPicked: 4, qtyHandConfirmed: 1, qtyCounted: 1 });
        expect(countRefusal(line, 2)).toMatchObject({ conflict: false });
        expect(countRefusal(line, 2)?.message).toContain('at least 3');
        expect(countRefusal(line, 3)).toBeNull();
        expect(countRefusal(line, 7)).toMatchObject({ conflict: false });
    });
});

describe('undo', () => {
    it('takes back counted, then hand-confirmed, then scanned', () => {
        expect(undoSource(qty({ qtyPicked: 4, qtyHandConfirmed: 1, qtyCounted: 2 }))).toBe('counted');
        expect(undoSource(qty({ qtyPicked: 2, qtyHandConfirmed: 1 }))).toBe('hand_confirmed');
        expect(undoSource(qty({ qtyPicked: 2 }))).toBe('scanned');
        expect(undoSource(qty())).toBeNull();
    });
});

describe('reconciling a task with its order', () => {
    const wanted = (id: string, remaining: number, over: Record<string, unknown> = {}) => ({
        orderLineItemId: id,
        variantId: 'v',
        title: 'Socks',
        variantTitle: null,
        sku: 'SOCK',
        barcode: null,
        remaining,
        ...over,
    });

    it('drops a line gone from the order and adds a new one', () => {
        const plan = planReconcile([qty({ id: 'l1', orderLineItemId: 'gone' })], [wanted('new', 2)]);
        expect(plan.remove).toEqual(['l1']);
        expect(plan.add.map((a) => a.orderLineItemId)).toEqual(['new']);
        expect(plan.update).toEqual([]);
    });

    it('changes nothing when the order is unchanged', () => {
        const plan = planReconcile([qty({ orderLineItemId: 'oli' })], [wanted('oli', 6)]);
        expect(plan).toEqual({ remove: [], add: [], update: [] });
    });

    it('follows the remaining quantity and clamps what was packed, giving back counted units first', () => {
        const line = qty({ orderLineItemId: 'oli', qtyPicked: 5, qtyHandConfirmed: 1, qtyCounted: 2 });
        const plan = planReconcile([line], [wanted('oli', 2)]);
        expect(plan.update).toMatchObject([{ id: 'line', data: { qtyRequired: 2, qtyPicked: 2, qtyCounted: 0, qtyHandConfirmed: 0 } }]);
        expect(plan.update).toHaveLength(1);
    });

    it('refreshes the snapshots a scan matches on', () => {
        const plan = planReconcile([qty({ orderLineItemId: 'oli' })], [wanted('oli', 6, { barcode: '890123' })]);
        expect(plan.update).toEqual([{ id: 'line', data: { barcode: '890123' } }]);
    });

    it('a problem never covers more than is still unpacked', () => {
        const line = qty({ qtyPicked: 1, problemReason: 'missing', problemQty: 3 });
        expect(clampToRequired(line, 3)).toMatchObject({ qtyPicked: 1, problemQty: 2, problemReason: 'missing' });
        expect(clampToRequired(line, 1)).toMatchObject({ problemQty: 0, problemReason: null });
    });
});

describe('finishing', () => {
    const refusal = (plan: ReturnType<typeof planFinish>) => ('error' in plan ? plan.error : null);
    const full = [{ qtyRequired: 2, qtyPicked: 2, qtyHandConfirmed: 0, qtyCounted: 0 }];
    const short = [
        { qtyRequired: 2, qtyPicked: 2, qtyHandConfirmed: 0, qtyCounted: 0 },
        { qtyRequired: 1, qtyPicked: 0, qtyHandConfirmed: 0, qtyCounted: 0 },
    ];

    it('all needs every line full', () => {
        expect(planFinish(full, 'all', 'cod')).toEqual({ partial: false });
        expect(refusal(planFinish(short, 'all', 'prepaid'))).toContain('1 item is still to pack');
    });

    it('partial only for prepaid orders', () => {
        expect(planFinish(short, 'partial', 'prepaid')).toEqual({ partial: true });
        expect(refusal(planFinish(short, 'partial', 'cod'))).toContain('Cash on delivery');
        expect(refusal(planFinish(short, 'partial', 'unpaid'))).toContain('Only paid orders');
    });

    it('partial needs at least one packed unit', () => {
        const none = short.map((l) => ({ ...l, qtyPicked: 0 }));
        expect(refusal(planFinish(none, 'partial', 'prepaid'))).toContain('at least one');
    });

    it('a partial finish with everything packed is a full one', () => {
        expect(planFinish(full, 'partial', 'cod')).toEqual({ partial: false });
    });
});

describe('accuracy', () => {
    it('folds event sums into one row per packer, busiest first, with totals', () => {
        const names = new Map([['u1', 'Riya'], ['u2', 'Arjun']]);
        const { rows, totals } = foldAccuracy([
            { actorId: 'u2', kind: 'PACKED', count: 1, units: 3 },
            { actorId: 'u1', kind: 'PACKED', count: 4, units: 12 },
            { actorId: 'u1', kind: 'SCAN_MATCH', count: 10, units: 10 },
            { actorId: 'u1', kind: 'HAND_CONFIRM', count: 1, units: 2 },
            { actorId: 'u1', kind: 'COUNT', count: 1, units: 5 },
            { actorId: 'u2', kind: 'SCAN_NOT_IN_ORDER', count: 2, units: 0 },
            { actorId: 'u2', kind: 'SCAN_OVER', count: 3, units: 0 },
            { actorId: 'u2', kind: 'PROBLEM', count: 1, units: 2 },
            { actorId: 'u2', kind: 'SCAN_UNKNOWN', count: 7, units: 0 },
            { actorId: 'gone', kind: 'UNDO', count: 1, units: 1 },
        ], names);
        expect(rows.map((r) => r.name)).toEqual(['Riya', 'Arjun', 'Former member']);
        expect(rows[0]).toEqual({
            userId: 'u1', name: 'Riya', ordersPacked: 4, unitsScanned: 10, unitsHandConfirmed: 2, unitsCounted: 5,
            wrongScans: 0, overScans: 0, problems: 0,
        });
        expect(totals).toEqual({
            ordersPacked: 5, unitsScanned: 10, unitsHandConfirmed: 2, unitsCounted: 5, wrongScans: 2, overScans: 3, problems: 1,
        });
    });
});
