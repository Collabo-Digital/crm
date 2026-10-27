import { isCashOnDelivery, isPosOrder } from '../commerce/order-vars';

/**
 * The packing assistant's rules, kept free of the database so they can be
 * tested on their own. The queue's SQL (PackingService) mirrors
 * `isPackableLine`, `ineligibleReason` and `bucketOf`; change them together.
 */

export const OPEN_STATUSES = ['PACKING', 'ON_HOLD'];

export const BUCKETS = ['to_pack', 'packing', 'on_hold', 'packed'] as const;
export type Bucket = (typeof BUCKETS)[number];

export type Payment = 'cod' | 'prepaid' | 'unpaid';

export const HOLD_REASONS = ['items_short', 'damaged', 'customer_request', 'other'] as const;
export const PROBLEM_REASONS = ['missing', 'damaged', 'wrong_item_on_shelf'] as const;
export const CONFIRM_REASONS = ['no_barcode', 'barcode_damaged', 'other'] as const;

export type EventKind =
    | 'SCAN_MATCH'
    | 'SCAN_NOT_IN_ORDER'
    | 'SCAN_OVER'
    | 'SCAN_UNKNOWN'
    | 'HAND_CONFIRM'
    | 'COUNT'
    | 'UNDO'
    | 'PROBLEM'
    | 'PROBLEM_CLEARED'
    | 'HOLD'
    | 'RESUME'
    | 'PACKED'
    | 'CANCELLED';

export const SCAN_RESULTS: Partial<Record<string, 'matched' | 'over' | 'not_in_order' | 'unknown'>> = {
    SCAN_MATCH: 'matched',
    SCAN_OVER: 'over',
    SCAN_NOT_IN_ORDER: 'not_in_order',
    SCAN_UNKNOWN: 'unknown',
};

/** Shipments that never left: a cancelled or failed fulfilment. */
export const NOT_SHIPPED_FULFILMENTS = ['cancelled', 'error', 'failure'];

/** Typing a count is allowed only on lines of at least this many units. */
export const COUNT_MIN_REQUIRED = 5;

export function paymentOf(order: { paymentGateways: string[]; financialStatus: string }): Payment {
    if (isCashOnDelivery(order.paymentGateways)) return 'cod';
    return order.financialStatus === 'PAID' ? 'prepaid' : 'unpaid';
}

/** For a COD order, whether it carries the `cod-confirmed` tag; null for any other order. */
export function codConfirmedOf(payment: Payment, tags: string[]): boolean | null {
    if (payment !== 'cod') return null;
    return tags.some((t) => t.trim().toLowerCase() === 'cod-confirmed');
}

export interface OrderLineQty {
    quantity: number;
    fulfilledQuantity: number;
    requiresShipping: boolean;
    externalId: string;
}

export function remainingOf(line: { quantity: number; fulfilledQuantity: number }): number {
    return Math.max(0, line.quantity - line.fulfilledQuantity);
}

/**
 * A line still to go in a parcel. `requiresShipping` is only known for lines
 * a store synced: Collabo's own offline and draft orders (external id
 * `manual_…`) write false on every line, so it is ignored for them.
 */
export function isPackableLine(line: OrderLineQty): boolean {
    if (remainingOf(line) <= 0) return false;
    return line.requiresShipping || line.externalId.startsWith('manual_');
}

export interface EligibilityOrder {
    cancelledAt: Date | null;
    closedAt: Date | null;
    financialStatus: string;
    fulfillmentStatus: string;
    posSale: boolean;
    sourceName: string | null;
    lineItems: OrderLineQty[];
}

/** Why this order can't be packed, as a sentence for the packer; null when it can. */
export function ineligibleReason(order: EligibilityOrder): string | null {
    if (order.cancelledAt) return 'This order was cancelled, so there is nothing to pack.';
    if (order.closedAt) return 'This order is closed. Reopen it to pack it.';
    if (order.financialStatus === 'REFUNDED') return 'This order was refunded, so there is nothing to pack.';
    if (order.financialStatus === 'VOIDED') return "This order's payment was voided, so there is nothing to pack.";
    if (isPosOrder(order)) return 'This was a counter sale, so it is not packed.';
    if (order.fulfillmentStatus === 'FULFILLED') return 'This order has already shipped.';
    if (order.fulfillmentStatus !== 'UNFULFILLED' && order.fulfillmentStatus !== 'PARTIAL') {
        return 'This order was returned, so there is nothing to pack.';
    }
    if (!order.lineItems.some(isPackableLine)) {
        return order.lineItems.some((li) => remainingOf(li) > 0)
            ? 'Nothing on this order needs shipping, so there is nothing to pack.'
            : 'Every item on this order has shipped, so there is nothing left to pack.';
    }
    return null;
}

/** The latest time something on the order shipped, ignoring cancelled or failed shipments. */
export function lastShippedAt(
    fulfillments: Array<{ status: string; shippedAt: Date | null; createdAt: Date }>,
): Date | null {
    let latest: Date | null = null;
    for (const f of fulfillments) {
        if (NOT_SHIPPED_FULFILMENTS.includes(f.status)) continue;
        const at = f.shippedAt ?? f.createdAt;
        if (!latest || at > latest) latest = at;
    }
    return latest;
}

/** Packed and not shipped since: the packed part is still waiting for the courier. */
export function packedNotShipped(packedAt: Date | null, shippedAt: Date | null): boolean {
    return !!packedAt && (!shippedAt || packedAt > shippedAt);
}

export function bucketOf(state: {
    openStatus: string | null;
    lastPackedAt: Date | null;
    lastShippedAt: Date | null;
}): Bucket {
    if (state.openStatus === 'PACKING') return 'packing';
    if (state.openStatus === 'ON_HOLD') return 'on_hold';
    if (packedNotShipped(state.lastPackedAt, state.lastShippedAt)) return 'packed';
    return 'to_pack';
}

export interface ScanLine {
    id: string;
    variantId: string | null;
    sku: string | null;
    barcode: string | null;
}

/**
 * The task's lines a scanned code names, in line order: exact barcode, else
 * exact SKU, else SKU ignoring case. Lines without a variant are confirmed by
 * hand only and never match.
 */
export function matchingLines<T extends ScanLine>(lines: T[], raw: string): T[] {
    const code = raw.trim();
    if (!code) return [];
    const scannable = lines.filter((l) => l.variantId);
    const byBarcode = scannable.filter((l) => l.barcode?.trim() === code);
    if (byBarcode.length > 0) return byBarcode;
    const bySku = scannable.filter((l) => l.sku?.trim() === code);
    if (bySku.length > 0) return bySku;
    const lower = code.toLowerCase();
    return scannable.filter((l) => l.sku?.trim().toLowerCase() === lower);
}

export interface LineQty {
    qtyRequired: number;
    qtyPicked: number;
    qtyHandConfirmed: number;
    qtyCounted: number;
}

export function scannedOf(line: LineQty): number {
    return line.qtyPicked - line.qtyHandConfirmed - line.qtyCounted;
}

/** Why typing `packed` as this line's total is refused; null when it is allowed. */
export function countRefusal(line: LineQty, packed: number): { conflict: boolean; message: string } | null {
    if (line.qtyRequired < COUNT_MIN_REQUIRED) {
        return { conflict: true, message: `Typing a count is only for lines of ${COUNT_MIN_REQUIRED} or more. Scan each item instead.` };
    }
    if (scannedOf(line) < 1) {
        return { conflict: true, message: 'Scan one of these first, then you can type the count.' };
    }
    const floor = line.qtyPicked - line.qtyCounted;
    if (packed < floor) {
        return { conflict: false, message: `${floor} are already scanned or confirmed. Enter at least ${floor}, or undo some first.` };
    }
    if (packed > line.qtyRequired) {
        return { conflict: false, message: `This order needs only ${line.qtyRequired} of these.` };
    }
    return null;
}

/** Which packed unit an undo takes back: counted first, then hand-confirmed, then scanned. */
export function undoSource(line: LineQty): 'counted' | 'hand_confirmed' | 'scanned' | null {
    if (line.qtyPicked <= 0) return null;
    if (line.qtyCounted > 0) return 'counted';
    if (line.qtyHandConfirmed > 0) return 'hand_confirmed';
    return 'scanned';
}

export interface ProblemQty {
    problemReason: string | null;
    problemQty: number;
}

/** A problem never covers more units than are still unpacked; none left clears it. */
export function fitProblem(line: ProblemQty, required: number, picked: number): ProblemQty {
    const problemQty = Math.max(0, Math.min(line.problemQty, required - picked));
    return { problemQty, problemReason: problemQty > 0 ? line.problemReason : null };
}

/**
 * The line after the order now needs only `required`: packed units above it
 * are given back counted first, then hand-confirmed, then scanned.
 */
export function clampToRequired<T extends LineQty & ProblemQty>(line: T, required: number) {
    let excess = Math.max(0, line.qtyPicked - required);
    const fromCounted = Math.min(line.qtyCounted, excess);
    excess -= fromCounted;
    const fromHand = Math.min(line.qtyHandConfirmed, excess);
    const qtyPicked = Math.min(line.qtyPicked, required);
    return {
        qtyRequired: required,
        qtyPicked,
        qtyCounted: line.qtyCounted - fromCounted,
        qtyHandConfirmed: line.qtyHandConfirmed - fromHand,
        ...fitProblem(line, required, qtyPicked),
    };
}

export interface WantedLine {
    orderLineItemId: string;
    variantId: string | null;
    title: string;
    variantTitle: string | null;
    sku: string | null;
    barcode: string | null;
    remaining: number;
}

export interface TaskLineState extends LineQty, ProblemQty {
    id: string;
    orderLineItemId: string;
    variantId: string | null;
    title: string;
    variantTitle: string | null;
    sku: string | null;
    barcode: string | null;
}

/**
 * Brings a task's lines in line with the order's lines still to ship: lines
 * gone from the order (a Shopify edit deletes them) are dropped, new ones
 * added, and each line's required quantity and snapshots follow the order.
 */
export function planReconcile(current: TaskLineState[], wanted: WantedLine[]) {
    const wantedById = new Map(wanted.map((w) => [w.orderLineItemId, w]));
    const have = new Set(current.map((l) => l.orderLineItemId));

    const remove = current.filter((l) => !wantedById.has(l.orderLineItemId)).map((l) => l.id);
    const add = wanted.filter((w) => !have.has(w.orderLineItemId));
    const update: Array<{ id: string; data: Partial<Omit<TaskLineState, 'id' | 'orderLineItemId'>> }> = [];
    for (const line of current) {
        const w = wantedById.get(line.orderLineItemId);
        if (!w) continue;
        const data: Partial<Omit<TaskLineState, 'id' | 'orderLineItemId'>> = {};
        for (const key of ['variantId', 'title', 'variantTitle', 'sku', 'barcode'] as const) {
            if (line[key] !== w[key]) Object.assign(data, { [key]: w[key] });
        }
        if (line.qtyRequired !== w.remaining) Object.assign(data, clampToRequired(line, w.remaining));
        if (Object.keys(data).length > 0) update.push({ id: line.id, data });
    }
    return { remove, add, update };
}

export function isEmptyPlan(plan: ReturnType<typeof planReconcile>): boolean {
    return plan.remove.length === 0 && plan.add.length === 0 && plan.update.length === 0;
}

/** Whether the task can be marked packed, and if so whether items are left for later. */
export function planFinish(
    lines: LineQty[],
    mode: 'all' | 'partial',
    payment: Payment,
): { partial: boolean } | { error: string } {
    const required = lines.reduce((n, l) => n + l.qtyRequired, 0);
    const packed = lines.reduce((n, l) => n + l.qtyPicked, 0);
    if (required === 0) return { error: 'There is nothing on this order to pack.' };
    if (packed >= required) return { partial: false };
    if (mode === 'all') {
        const left = required - packed;
        return { error: `${left} ${left === 1 ? 'item is' : 'items are'} still to pack. Pack ${left === 1 ? 'it' : 'them'}, or hold the order.` };
    }
    if (payment === 'cod') {
        return { error: "Cash on delivery orders aren't split: two parcels would mean collecting cash twice. Hold the order instead." };
    }
    if (payment !== 'prepaid') return { error: 'Only paid orders can be sent in parts. Hold the order instead.' };
    if (packed === 0) return { error: 'Pack at least one item first, or hold the order.' };
    return { partial: true };
}

export interface AccuracyRow {
    userId: string;
    name: string;
    ordersPacked: number;
    unitsScanned: number;
    unitsHandConfirmed: number;
    unitsCounted: number;
    wrongScans: number;
    overScans: number;
    problems: number;
}

export type AccuracyTotals = Omit<AccuracyRow, 'userId' | 'name'>;

/** Folds per-person, per-kind event sums into one row per packer, busiest first. */
export function foldAccuracy(
    groups: Array<{ actorId: string; kind: string; count: number; units: number }>,
    names: Map<string, string>,
): { rows: AccuracyRow[]; totals: AccuracyTotals } {
    const empty = (): AccuracyTotals => ({
        ordersPacked: 0,
        unitsScanned: 0,
        unitsHandConfirmed: 0,
        unitsCounted: 0,
        wrongScans: 0,
        overScans: 0,
        problems: 0,
    });
    const byActor = new Map<string, AccuracyTotals>();
    const totals = empty();
    for (const g of groups) {
        const row = byActor.get(g.actorId) ?? empty();
        byActor.set(g.actorId, row);
        for (const target of [row, totals]) {
            if (g.kind === 'PACKED') target.ordersPacked += g.count;
            else if (g.kind === 'SCAN_MATCH') target.unitsScanned += g.units;
            else if (g.kind === 'HAND_CONFIRM') target.unitsHandConfirmed += g.units;
            else if (g.kind === 'COUNT') target.unitsCounted += g.units;
            else if (g.kind === 'SCAN_NOT_IN_ORDER') target.wrongScans += g.count;
            else if (g.kind === 'SCAN_OVER') target.overScans += g.count;
            else if (g.kind === 'PROBLEM') target.problems += g.count;
        }
    }
    const rows = [...byActor.entries()]
        .map(([userId, t]) => ({ userId, name: names.get(userId) ?? 'Former member', ...t }))
        .sort((a, b) => b.ordersPacked - a.ordersPacked || a.name.localeCompare(b.name));
    return { rows, totals };
}

export function displayName(user: { firstName: string | null; lastName: string | null } | null | undefined): string | null {
    const name = [user?.firstName, user?.lastName].filter((p) => p && p.trim()).join(' ').trim();
    return name || null;
}

function addressField(address: unknown, keys: string[]): string | null {
    if (!address || typeof address !== 'object') return null;
    for (const key of keys) {
        const value = (address as Record<string, unknown>)[key];
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return null;
}

export function customerNameOf(
    customer: { firstName: string | null; lastName: string | null } | null,
    shippingAddress: unknown,
): string | null {
    return (
        displayName(customer) ??
        addressField(shippingAddress, ['name']) ??
        displayName({
            firstName: addressField(shippingAddress, ['first_name', 'firstName']),
            lastName: addressField(shippingAddress, ['last_name', 'lastName']),
        })
    );
}

export function cityOf(shippingAddress: unknown): string | null {
    return addressField(shippingAddress, ['city']);
}

/** Shopify names a product's only variant "Default Title"; that is no variant name. */
export function variantTitleOf(title: string | null | undefined): string | null {
    return title && title !== 'Default Title' ? title : null;
}
