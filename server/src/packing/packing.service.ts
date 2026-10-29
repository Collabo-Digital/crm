import {
    BadRequestException,
    ConflictException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
    resolveReportingTimeZone,
    zonedDayEndExclusive,
    zonedDayStart,
    zonedDayStartDaysAgo,
} from '../common/utils/zoned-date.util';
import {
    Bucket,
    BUCKETS,
    EventKind,
    OPEN_STATUSES,
    SCAN_RESULTS,
    TaskLineState,
    WantedLine,
    cityOf,
    codConfirmedOf,
    countRefusal,
    customerNameOf,
    displayName,
    fitProblem,
    foldAccuracy,
    ineligibleReason,
    isEmptyPlan,
    isPackableLine,
    lastShippedAt,
    matchingLines,
    packedNotShipped,
    paymentOf,
    planFinish,
    planReconcile,
    remainingOf,
    undoSource,
    variantTitleOf,
} from './packing-rules';

type Tx = Prisma.TransactionClient;

const isUniqueViolation = (err: unknown) =>
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

const HOLD_LABELS: Record<string, string> = {
    items_short: 'items short',
    damaged: 'damaged items',
    customer_request: "customer's request",
    other: 'other reason',
};

const orderSelect = {
    id: true,
    name: true,
    cancelledAt: true,
    closedAt: true,
    financialStatus: true,
    fulfillmentStatus: true,
    posSale: true,
    sourceName: true,
    paymentGateways: true,
    tags: true,
    shippingAddress: true,
    dispatchWarehouseId: true,
    customer: { select: { firstName: true, lastName: true } },
    lineItems: {
        select: {
            id: true,
            variantId: true,
            externalId: true,
            title: true,
            variantTitle: true,
            sku: true,
            quantity: true,
            fulfilledQuantity: true,
            requiresShipping: true,
            variant: {
                select: {
                    sku: true,
                    barcode: true,
                    image: { select: { src: true } },
                    product: { select: { images: { select: { src: true }, orderBy: { position: 'asc' }, take: 1 } } },
                },
            },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    },
} satisfies Prisma.OrderSelect;

type PackOrder = Prisma.OrderGetPayload<{ select: typeof orderSelect }>;

const taskInclude = {
    lines: true,
    warehouse: { select: { id: true, name: true } },
} satisfies Prisma.PickTaskInclude;

type TaskWithLines = Prisma.PickTaskGetPayload<{ include: typeof taskInclude }>;

/** One event the action records, beside the line it changed. */
interface EventDraft {
    kind: EventKind;
    lineId?: string | null;
    code?: string | null;
    qty?: number;
    reason?: string | null;
}

interface QueueSqlRow {
    id: string;
    name: string;
    placed_at: Date;
    first_name: string | null;
    last_name: string | null;
    shipping_address: unknown;
    payment_gateways: string[];
    financial_status: string;
    tags: string[];
    warehouse_id: string | null;
    warehouse_name: string | null;
    units: number;
    lines: number;
    bucket: Bucket;
    task_id: string | null;
    task_updated_at: Date | null;
}

/**
 * The order packing assistant: a queue of orders to pack, and a packing task
 * per order that checks the right items and quantities go into the parcel.
 *
 * Packing never creates a shipment, never moves stock and never calls
 * Shopify: shipping stays with the fulfil dialog and courier apps.
 *
 * Locking: every change to a task's lines first takes the task row FOR SHARE
 * (so two packers on one order scan side by side), and every change of status
 * or of which lines exist takes it FOR UPDATE, so a hold or finish never
 * interleaves with a scan.
 */
@Injectable()
export class PackingService {
    constructor(private readonly prisma: PrismaService) { }

    // ─── Queue ─────────────────────────────────────────────────────────────

    async queue(
        orgId: string,
        q: { bucket: Bucket; warehouseId?: string; search?: string; page: number; limit: number },
    ) {
        const cte = this.queueSql(orgId, q);
        const order =
            q.bucket === 'to_pack'
                ? Prisma.sql`ORDER BY "placed_at" ASC, "id" ASC`
                : Prisma.sql`ORDER BY "task_updated_at" DESC NULLS LAST, "id" ASC`;
        const [rows, countRows] = await Promise.all([
            this.prisma.$queryRaw<QueueSqlRow[]>`
                ${cte}
                SELECT * FROM "r" WHERE "bucket" = ${q.bucket}
                ${order}
                LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`,
            this.prisma.$queryRaw<Array<{ bucket: Bucket; n: number }>>`
                ${cte}
                SELECT "bucket", COUNT(*)::int AS "n" FROM "r" GROUP BY "bucket"`,
        ]);

        const counts = Object.fromEntries(BUCKETS.map((b) => [b, 0])) as Record<Bucket, number>;
        for (const c of countRows) counts[c.bucket] = c.n;

        const taskIds = rows.map((r) => r.task_id).filter((id): id is string => !!id);
        const tasks = taskIds.length
            ? await this.prisma.pickTask.findMany({
                where: { id: { in: taskIds } },
                select: {
                    id: true,
                    status: true,
                    holdReason: true,
                    holdNote: true,
                    assigneeId: true,
                    packedBy: true,
                    lines: { select: { qtyPicked: true, qtyRequired: true } },
                },
            })
            : [];
        const lastActors = taskIds.length
            ? await this.prisma.$queryRaw<Array<{ pick_task_id: string; actor_id: string }>>`
                SELECT DISTINCT ON ("pick_task_id") "pick_task_id", "actor_id"
                FROM "pick_task_events"
                WHERE "pick_task_id" IN (${Prisma.join(taskIds)})
                ORDER BY "pick_task_id", "created_at" DESC`
            : [];
        const taskById = new Map(tasks.map((t) => [t.id, t]));
        const lastActorByTask = new Map(lastActors.map((a) => [a.pick_task_id, a.actor_id]));
        const names = await this.userNames(
            tasks.map((t) => lastActorByTask.get(t.id) ?? t.packedBy ?? t.assigneeId),
        );

        return {
            data: rows.map((r) => {
                const payment = paymentOf({ paymentGateways: r.payment_gateways, financialStatus: r.financial_status });
                const task = r.task_id ? taskById.get(r.task_id) : undefined;
                const lastPacker = task ? (lastActorByTask.get(task.id) ?? task.packedBy ?? task.assigneeId) : null;
                return {
                    orderId: r.id,
                    orderName: r.name,
                    createdAt: r.placed_at,
                    customerName: customerNameOf({ firstName: r.first_name, lastName: r.last_name }, r.shipping_address),
                    city: cityOf(r.shipping_address),
                    units: r.units,
                    lines: r.lines,
                    payment,
                    codConfirmed: codConfirmedOf(payment, r.tags),
                    warehouse: r.warehouse_id ? { id: r.warehouse_id, name: r.warehouse_name } : null,
                    task: task
                        ? {
                            id: task.id,
                            status: task.status,
                            packedUnits: task.lines.reduce((n, l) => n + l.qtyPicked, 0),
                            requiredUnits: task.lines.reduce((n, l) => n + l.qtyRequired, 0),
                            holdReason: task.holdReason,
                            holdNote: task.holdNote,
                            updatedAt: r.task_updated_at,
                            lastPackerName: lastPacker ? (names.get(lastPacker) ?? null) : null,
                        }
                        : null,
                };
            }),
            meta: { total: counts[q.bucket], page: q.page, limit: q.limit },
            counts,
        };
    }

    /**
     * The orders that can be packed, each with its bucket. Mirrors
     * `ineligibleReason`, `isPackableLine` and `bucketOf` in packing-rules.
     */
    private queueSql(orgId: string, f: { warehouseId?: string; search?: string }): Prisma.Sql {
        const filters: Prisma.Sql[] = [];
        if (f.warehouseId === 'none') filters.push(Prisma.sql`o."dispatch_warehouse_id" IS NULL`);
        else if (f.warehouseId) filters.push(Prisma.sql`o."dispatch_warehouse_id" = ${f.warehouseId}`);
        const term = f.search?.trim();
        if (term) {
            const like = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
            const digits = term.replace(/\D/g, '');
            const byPhone = digits.length >= 3 && !/\p{L}/u.test(term);
            // The last ten digits find a number saved with or without its country code.
            const phoneLike = `%${digits.length > 10 ? digits.slice(-10) : digits}%`;
            filters.push(Prisma.sql`(
                o."name" ILIKE ${like}
                OR concat_ws(' ', c."first_name", c."last_name") ILIKE ${like}
                OR o."shipping_address"->>'name' ILIKE ${like}
                OR concat_ws(' ', coalesce(o."shipping_address"->>'first_name', o."shipping_address"->>'firstName'),
                                  coalesce(o."shipping_address"->>'last_name', o."shipping_address"->>'lastName')) ILIKE ${like}
                ${byPhone
                    ? Prisma.sql`OR regexp_replace(coalesce(c."phone", ''), '\\D', '', 'g') LIKE ${phoneLike}
                        OR regexp_replace(coalesce(o."shipping_address"->>'phone', ''), '\\D', '', 'g') LIKE ${phoneLike}`
                    : Prisma.empty}
            )`);
        }
        const extra = filters.length ? Prisma.sql`AND ${Prisma.join(filters, ' AND ')}` : Prisma.empty;

        return Prisma.sql`
            WITH "q" AS (
                SELECT o."id", o."name", COALESCE(o."external_created_at", o."created_at") AS "placed_at",
                       c."first_name", c."last_name", o."shipping_address", o."payment_gateways",
                       o."financial_status"::text AS "financial_status", o."tags",
                       w."id" AS "warehouse_id", w."name" AS "warehouse_name",
                       rem."units", rem."lines",
                       ot."id" AS "open_id", ot."status" AS "open_status", ot."updated_at" AS "open_updated_at",
                       pt."id" AS "packed_id", pt."packed_at", pt."updated_at" AS "packed_updated_at",
                       sh."at" AS "shipped_at"
                FROM "orders" o
                LEFT JOIN "customers" c ON c."id" = o."customer_id"
                LEFT JOIN "warehouses" w ON w."id" = o."dispatch_warehouse_id"
                CROSS JOIN LATERAL (
                    SELECT COUNT(*)::int AS "lines",
                           COALESCE(SUM(li."quantity" - li."fulfilled_quantity"), 0)::int AS "units"
                    FROM "order_line_items" li
                    WHERE li."order_id" = o."id"
                      AND li."quantity" > li."fulfilled_quantity"
                      AND (li."requires_shipping" OR li."external_id" LIKE 'manual\\_%')
                ) rem
                LEFT JOIN LATERAL (
                    SELECT t."id", t."status",
                           GREATEST(t."updated_at", (SELECT MAX(e."created_at") FROM "pick_task_events" e WHERE e."pick_task_id" = t."id")) AS "updated_at"
                    FROM "pick_tasks" t
                    WHERE t."order_id" = o."id" AND t."status" IN ('PACKING', 'ON_HOLD')
                    LIMIT 1
                ) ot ON TRUE
                LEFT JOIN LATERAL (
                    SELECT t."id", t."packed_at",
                           GREATEST(t."updated_at", (SELECT MAX(e."created_at") FROM "pick_task_events" e WHERE e."pick_task_id" = t."id")) AS "updated_at"
                    FROM "pick_tasks" t
                    WHERE t."order_id" = o."id" AND t."status" = 'PACKED'
                    ORDER BY t."packed_at" DESC NULLS LAST
                    LIMIT 1
                ) pt ON TRUE
                LEFT JOIN LATERAL (
                    SELECT MAX(COALESCE(f."shipped_at", f."created_at")) AS "at"
                    FROM "order_fulfillments" f
                    WHERE f."order_id" = o."id" AND f."status" NOT IN ('cancelled', 'error', 'failure')
                ) sh ON TRUE
                WHERE ${this.eligibleSql(orgId)}
                  AND rem."lines" > 0
                  ${extra}
            ),
            "b" AS (
                SELECT "q".*,
                       CASE
                           WHEN "open_status" = 'PACKING' THEN 'packing'
                           WHEN "open_status" = 'ON_HOLD' THEN 'on_hold'
                           WHEN "packed_at" IS NOT NULL AND ("shipped_at" IS NULL OR "packed_at" > "shipped_at") THEN 'packed'
                           ELSE 'to_pack'
                       END AS "bucket"
                FROM "q"
            ),
            "r" AS (
                SELECT "b".*,
                       CASE WHEN "bucket" IN ('packing', 'on_hold') THEN "open_id"
                            WHEN "bucket" = 'packed' THEN "packed_id" END AS "task_id",
                       CASE WHEN "bucket" IN ('packing', 'on_hold') THEN "open_updated_at"
                            WHEN "bucket" = 'packed' THEN "packed_updated_at" END AS "task_updated_at"
                FROM "b"
            )`;
    }

    /** Orders that may be packed at all; the line test is applied by the caller. */
    private eligibleSql(orgId: string): Prisma.Sql {
        return Prisma.sql`
            o."organization_id" = ${orgId}
            AND o."deleted_at" IS NULL
            AND o."cancelled_at" IS NULL
            AND o."closed_at" IS NULL
            AND o."financial_status" NOT IN ('REFUNDED', 'VOIDED')
            AND o."fulfillment_status" IN ('UNFULFILLED', 'PARTIAL')
            AND o."pos_sale" = FALSE
            AND o."source_name" IS DISTINCT FROM 'pos'`;
    }

    /** A packing slip's barcode (the order id), or an exact order name. */
    async lookup(orgId: string, raw: string | undefined) {
        const code = (raw ?? '').trim();
        if (!code) throw new BadRequestException('Scan a packing slip or type an order number.');
        const byId = await this.prisma.order.findFirst({
            where: { id: code, organizationId: orgId, deletedAt: null },
            select: { id: true },
        });
        if (byId) return { orderId: byId.id };

        const names = code.startsWith('#') ? [code] : [code, `#${code}`];
        const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
            SELECT o."id" FROM "orders" o
            WHERE ${this.eligibleSql(orgId)}
              AND o."name" IN (${Prisma.join(names)})
              AND EXISTS (
                  SELECT 1 FROM "order_line_items" li
                  WHERE li."order_id" = o."id"
                    AND li."quantity" > li."fulfilled_quantity"
                    AND (li."requires_shipping" OR li."external_id" LIKE 'manual\\_%')
              )
            LIMIT 2`;
        if (rows.length === 1) return { orderId: rows[0].id };
        if (rows.length > 1) {
            throw new NotFoundException(`More than one order to pack is called ${code}. Scan its packing slip instead.`);
        }
        throw new NotFoundException(`No order to pack matches ${code}. Check the slip, or search the list.`);
    }

    // ─── Tasks ─────────────────────────────────────────────────────────────

    /**
     * The order's PACKING or ON_HOLD task, else a new PACKING task from what
     * is left to ship. An order packed and not shipped since gets its PACKED
     * task back rather than a second task asking to pack it all again.
     */
    async start(orgId: string, userId: string, orderId: string) {
        const order = await this.loadOrder(orgId, orderId);
        if (!order) throw new NotFoundException('Order not found.');
        const refusal = ineligibleReason(order);
        if (refusal) throw new ConflictException(refusal);

        const open = await this.prisma.pickTask.findFirst({
            where: { organizationId: orgId, orderId, status: { in: OPEN_STATUSES } },
            select: { id: true },
        });
        if (open) {
            await this.reconcile(orgId, open.id, order);
            return this.view(orgId, open.id, order);
        }

        const packed = await this.packedWaitingToShip(orgId, orderId);
        if (packed) return this.view(orgId, packed, order);

        let taskId: string;
        try {
            const name = await this.actorName(userId);
            taskId = await this.prisma.$transaction(async (tx) => {
                const task = await tx.pickTask.create({
                    data: {
                        organizationId: orgId,
                        orderId,
                        warehouseId: order.dispatchWarehouseId,
                        status: 'PACKING',
                        assigneeId: userId,
                        startedAt: new Date(),
                        lines: {
                            create: this.wantedLines(order).map((w) => ({
                                orderLineItemId: w.orderLineItemId,
                                variantId: w.variantId,
                                title: w.title,
                                variantTitle: w.variantTitle,
                                sku: w.sku,
                                barcode: w.barcode,
                                qtyRequired: w.remaining,
                            })),
                        },
                    },
                    select: { id: true },
                });
                await this.timeline(tx, orderId, userId, task.id, 'packing_started', `Packing started by ${name}`);
                return task.id;
            });
        } catch (err) {
            // Another packer opened the order at the same moment; theirs stands.
            if (!isUniqueViolation(err)) throw err;
            const winner = await this.prisma.pickTask.findFirst({
                where: { organizationId: orgId, orderId, status: { in: OPEN_STATUSES } },
                select: { id: true },
            });
            if (!winner) throw err;
            taskId = winner.id;
        }
        return this.view(orgId, taskId, order);
    }

    async getTask(orgId: string, taskId: string) {
        const task = await this.findTask(orgId, taskId);
        const order = await this.loadOrder(orgId, task.orderId);
        if (!order) throw new NotFoundException('This order was deleted.');
        if (OPEN_STATUSES.includes(task.status) && !ineligibleReason(order)) {
            await this.reconcile(orgId, taskId, order);
        }
        return this.view(orgId, taskId, order);
    }

    /**
     * One scan. Only this task's lines are matched (barcodes and SKUs are not
     * unique in an organization). Every outcome is recorded; a retry with the
     * same clientScanId returns the first outcome and changes nothing.
     */
    async scan(orgId: string, userId: string, taskId: string, body: { code: string; clientScanId: string }) {
        await this.findTask(orgId, taskId);
        const code = body.code.trim();
        const prior = await this.priorEvent(taskId, body.clientScanId);
        if (prior) return this.scanReply(orgId, taskId, prior);

        let event: { kind: string; code: string | null; pickTaskLineId: string | null };
        try {
            event = await this.prisma.$transaction(async (tx) => {
                this.requirePacking(await this.lockTask(tx, orgId, taskId, 'share'));
                const lines = this.inLineOrder(
                    await tx.pickTaskLine.findMany({ where: { pickTaskId: taskId } }),
                    await this.linePositions(tx, taskId),
                );
                const candidates = matchingLines(lines, code);
                let kind: EventKind;
                let lineId: string | null = null;
                if (candidates.length > 0) {
                    kind = 'SCAN_OVER';
                    lineId = candidates[0].id;
                    for (const line of candidates) {
                        // The predicate is the guard: two packers scanning the
                        // last unit at once can't both add it.
                        const added = await tx.$executeRaw`
                            UPDATE "pick_task_lines"
                            SET "qty_picked" = "qty_picked" + 1,
                                "problem_qty" = GREATEST(0, LEAST("problem_qty", "qty_required" - "qty_picked" - 1)),
                                "problem_reason" = CASE WHEN LEAST("problem_qty", "qty_required" - "qty_picked" - 1) > 0 THEN "problem_reason" END
                            WHERE "id" = ${line.id} AND "pick_task_id" = ${taskId} AND "qty_picked" < "qty_required"`;
                        if (added === 1) {
                            kind = 'SCAN_MATCH';
                            lineId = line.id;
                            break;
                        }
                    }
                } else {
                    kind = (await this.findOrgVariant(tx, orgId, code)) ? 'SCAN_NOT_IN_ORDER' : 'SCAN_UNKNOWN';
                }
                return tx.pickTaskEvent.create({
                    data: {
                        organizationId: orgId,
                        pickTaskId: taskId,
                        pickTaskLineId: lineId,
                        actorId: userId,
                        kind,
                        code,
                        qty: kind === 'SCAN_MATCH' ? 1 : 0,
                        clientScanId: body.clientScanId,
                    },
                    select: { kind: true, code: true, pickTaskLineId: true },
                });
            });
        } catch (err) {
            // A retry raced its original: the original's outcome stands.
            if (!isUniqueViolation(err)) throw err;
            const first = await this.priorEvent(taskId, body.clientScanId);
            if (!first) throw err;
            return this.scanReply(orgId, taskId, first);
        }
        return this.scanReply(orgId, taskId, event);
    }

    /** Packs `qty` units of a line by hand (no barcode, or a damaged one). */
    confirm(
        orgId: string,
        userId: string,
        taskId: string,
        lineId: string,
        body: { qty: number; clientScanId: string; reason?: string },
    ) {
        return this.lineAction(orgId, userId, taskId, body.clientScanId, async (tx) => {
            const line = await this.lockLine(tx, taskId, lineId);
            const left = line.qtyRequired - line.qtyPicked;
            if (left <= 0) throw new ConflictException('Every item on this line is already packed.');
            if (body.qty > left) throw new BadRequestException(`Only ${left} left to pack on this line.`);
            const qtyPicked = line.qtyPicked + body.qty;
            await tx.pickTaskLine.update({
                where: { id: line.id },
                data: {
                    qtyPicked,
                    qtyHandConfirmed: line.qtyHandConfirmed + body.qty,
                    ...fitProblem(line, line.qtyRequired, qtyPicked),
                },
            });
            return { kind: 'HAND_CONFIRM', lineId: line.id, qty: body.qty, reason: body.reason ?? null };
        });
    }

    /**
     * Sets a line's packed total by typing it: only on lines of 5 or more once
     * one unit was scanned. Units above the scanned and hand-confirmed ones
     * are recorded as counted.
     */
    count(orgId: string, userId: string, taskId: string, lineId: string, body: { packed: number; clientScanId: string }) {
        return this.lineAction(orgId, userId, taskId, body.clientScanId, async (tx) => {
            const line = await this.lockLine(tx, taskId, lineId);
            const refusal = countRefusal(line, body.packed);
            if (refusal) {
                throw refusal.conflict ? new ConflictException(refusal.message) : new BadRequestException(refusal.message);
            }
            if (body.packed === line.qtyPicked) return null;
            const qtyCounted = body.packed - (line.qtyPicked - line.qtyCounted);
            await tx.pickTaskLine.update({
                where: { id: line.id },
                data: { qtyPicked: body.packed, qtyCounted, ...fitProblem(line, line.qtyRequired, body.packed) },
            });
            return { kind: 'COUNT', lineId: line.id, qty: qtyCounted - line.qtyCounted };
        });
    }

    /** Takes back one packed unit: counted first, then hand-confirmed, then scanned. */
    undo(orgId: string, userId: string, taskId: string, lineId: string, body: { clientScanId: string }) {
        return this.lineAction(orgId, userId, taskId, body.clientScanId, async (tx) => {
            const line = await this.lockLine(tx, taskId, lineId);
            const source = undoSource(line);
            if (!source) throw new ConflictException('Nothing on this line is packed yet.');
            await tx.pickTaskLine.update({
                where: { id: line.id },
                data: {
                    qtyPicked: line.qtyPicked - 1,
                    ...(source === 'counted' ? { qtyCounted: line.qtyCounted - 1 } : {}),
                    ...(source === 'hand_confirmed' ? { qtyHandConfirmed: line.qtyHandConfirmed - 1 } : {}),
                },
            });
            return { kind: 'UNDO', lineId: line.id, qty: 1, reason: source };
        });
    }

    setProblem(orgId: string, userId: string, taskId: string, lineId: string, body: { reason: string; qty: number }) {
        return this.lineAction(orgId, userId, taskId, null, async (tx) => {
            const line = await this.lockLine(tx, taskId, lineId);
            const unpacked = line.qtyRequired - line.qtyPicked;
            if (unpacked <= 0) throw new ConflictException('Every item on this line is packed, so there is nothing to report.');
            if (body.qty > unpacked) throw new BadRequestException(`Only ${unpacked} on this line ${unpacked === 1 ? 'is' : 'are'} still unpacked.`);
            await tx.pickTaskLine.update({
                where: { id: line.id },
                data: { problemReason: body.reason, problemQty: body.qty },
            });
            return { kind: 'PROBLEM', lineId: line.id, qty: body.qty, reason: body.reason };
        });
    }

    clearProblem(orgId: string, userId: string, taskId: string, lineId: string) {
        return this.lineAction(orgId, userId, taskId, null, async (tx) => {
            const line = await this.lockLine(tx, taskId, lineId);
            if (!line.problemReason && line.problemQty === 0) return null;
            await tx.pickTaskLine.update({ where: { id: line.id }, data: { problemReason: null, problemQty: 0 } });
            return { kind: 'PROBLEM_CLEARED', lineId: line.id };
        });
    }

    /** Puts the order on hold with a reason. Holding a held order updates its reason. */
    async hold(orgId: string, userId: string, taskId: string, body: { reason: string; note?: string }) {
        const task = await this.findTask(orgId, taskId);
        const name = await this.actorName(userId);
        await this.prisma.$transaction(async (tx) => {
            const status = await this.lockTask(tx, orgId, taskId, 'update');
            if (status !== 'PACKING' && status !== 'ON_HOLD') throw new ConflictException(this.statusRefusal(status));
            const note = body.note?.trim() || null;
            await tx.pickTask.update({
                where: { id: taskId },
                data: { status: 'ON_HOLD', holdReason: body.reason, holdNote: note, heldAt: new Date(), heldBy: userId },
            });
            await this.recordEvent(tx, orgId, taskId, userId, null, { kind: 'HOLD', reason: body.reason });
            if (status === 'PACKING') {
                const label = HOLD_LABELS[body.reason] ?? body.reason;
                await this.timeline(tx, task.orderId, userId, taskId, 'packing_held',
                    `Packing put on hold by ${name}: ${label}${note ? ` (${note})` : ''}`);
            }
        });
        return this.view(orgId, taskId);
    }

    async resume(orgId: string, userId: string, taskId: string) {
        const task = await this.findTask(orgId, taskId);
        const name = await this.actorName(userId);
        await this.prisma.$transaction(async (tx) => {
            const status = await this.lockTask(tx, orgId, taskId, 'update');
            if (status === 'PACKING') return;
            if (status !== 'ON_HOLD') throw new ConflictException(this.statusRefusal(status));
            await tx.pickTask.update({
                where: { id: taskId },
                data: { status: 'PACKING', holdReason: null, holdNote: null, heldAt: null, heldBy: null },
            });
            await this.recordEvent(tx, orgId, taskId, userId, null, { kind: 'RESUME' });
            await this.timeline(tx, task.orderId, userId, taskId, 'packing_resumed', `Packing resumed by ${name}`);
        });
        return this.view(orgId, taskId);
    }

    /**
     * Marks the order Packed, ready to ship. `all` needs every line full;
     * `partial` sends what is packed now and is offered for prepaid orders
     * only. Shipping itself stays with the fulfil dialog and courier apps.
     */
    async finish(orgId: string, userId: string, taskId: string, body: { mode: 'all' | 'partial' }) {
        const task = await this.findTask(orgId, taskId);
        if (task.status === 'PACKED') return this.view(orgId, taskId);
        const order = await this.loadOrder(orgId, task.orderId);
        if (!order) throw new NotFoundException('This order was deleted.');
        const refusal = ineligibleReason(order);
        if (refusal) throw new ConflictException(refusal);
        if (task.status === 'PACKING') await this.reconcile(orgId, taskId, order);

        const name = await this.actorName(userId);
        await this.prisma.$transaction(async (tx) => {
            this.requirePacking(await this.lockTask(tx, orgId, taskId, 'update'));
            const lines = await tx.pickTaskLine.findMany({ where: { pickTaskId: taskId } });
            const plan = planFinish(lines, body.mode, paymentOf(order));
            if ('error' in plan) throw new ConflictException(plan.error);
            const packed = lines.reduce((n, l) => n + l.qtyPicked, 0);
            const required = lines.reduce((n, l) => n + l.qtyRequired, 0);
            await tx.pickTask.update({
                where: { id: taskId },
                data: { status: 'PACKED', packedAt: new Date(), packedBy: userId, partial: plan.partial },
            });
            await this.recordEvent(tx, orgId, taskId, userId, null, {
                kind: 'PACKED',
                qty: packed,
                reason: plan.partial ? 'partial' : null,
            });
            await this.timeline(tx, task.orderId, userId, taskId, 'packed', plan.partial
                ? `Packed by ${name} (${packed} of ${required} items, the rest later)`
                : `Packed by ${name} (${packed} ${packed === 1 ? 'item' : 'items'})`);
        });
        return this.view(orgId, taskId, order);
    }

    /** "Start over": cancels a PACKING or ON_HOLD task. Opening the order again starts afresh. */
    async cancel(orgId: string, userId: string, taskId: string) {
        const task = await this.findTask(orgId, taskId);
        const name = await this.actorName(userId);
        await this.prisma.$transaction(async (tx) => {
            const status = await this.lockTask(tx, orgId, taskId, 'update');
            if (status === 'CANCELLED') return;
            if (status !== 'PACKING' && status !== 'ON_HOLD') throw new ConflictException(this.statusRefusal(status));
            await tx.pickTask.update({ where: { id: taskId }, data: { status: 'CANCELLED' } });
            await this.recordEvent(tx, orgId, taskId, userId, null, { kind: 'CANCELLED' });
            await this.timeline(tx, task.orderId, userId, taskId, 'packing_cancelled', `Packing cancelled by ${name}`);
        });
        return this.view(orgId, taskId);
    }

    // ─── Accuracy ──────────────────────────────────────────────────────────

    /**
     * Per packer: orders packed, units scanned / confirmed by hand / counted,
     * wrong and over scans, problems. From the events that happened in the
     * range (bare dates are days in the organization's reporting zone;
     * default the last 30 days).
     */
    async accuracy(orgId: string, q: { from?: string; to?: string; warehouseId?: string }) {
        const org = await this.prisma.organization.findUnique({ where: { id: orgId }, select: { timezone: true } });
        const timeZone = resolveReportingTimeZone(org ?? {});
        const to = q.to ? zonedDayEndExclusive(q.to, timeZone) : new Date();
        const from = q.from ? zonedDayStart(q.from, timeZone) : zonedDayStartDaysAgo(new Date(), 29, timeZone);
        if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
            throw new BadRequestException('Use dates like 2026-10-28.');
        }

        const warehouse =
            q.warehouseId === 'none' ? { pickTask: { warehouseId: null } }
                : q.warehouseId ? { pickTask: { warehouseId: q.warehouseId } }
                    : {};
        const groups = await this.prisma.pickTaskEvent.groupBy({
            by: ['actorId', 'kind'],
            where: { organizationId: orgId, createdAt: { gte: from, lt: to }, ...warehouse },
            _count: { _all: true },
            _sum: { qty: true },
        });
        const names = await this.userNames(groups.map((g) => g.actorId));
        return {
            ...foldAccuracy(
                groups.map((g) => ({ actorId: g.actorId, kind: g.kind, count: g._count._all, units: g._sum.qty ?? 0 })),
                names,
            ),
            from,
            to,
        };
    }

    // ─── Order detail ──────────────────────────────────────────────────────

    /** The order page's packing line: the open task, else a packed one not shipped since. */
    async orderPacking(orgId: string, orderId: string) {
        const open = await this.prisma.pickTask.findFirst({
            where: { organizationId: orgId, orderId, status: { in: OPEN_STATUSES } },
            select: { id: true },
        });
        const taskId = open?.id ?? (await this.packedWaitingToShip(orgId, orderId));
        if (!taskId) return null;
        const task = await this.prisma.pickTask.findUniqueOrThrow({
            where: { id: taskId },
            select: {
                id: true,
                status: true,
                holdReason: true,
                packedAt: true,
                packedBy: true,
                lines: { select: { qtyPicked: true, qtyRequired: true } },
            },
        });
        return {
            taskId: task.id,
            status: task.status,
            packedUnits: task.lines.reduce((n, l) => n + l.qtyPicked, 0),
            requiredUnits: task.lines.reduce((n, l) => n + l.qtyRequired, 0),
            holdReason: task.holdReason,
            packedAt: task.packedAt,
            packedByName: task.packedBy ? await this.actorName(task.packedBy) : null,
        };
    }

    // ─── Helpers ───────────────────────────────────────────────────────────

    private loadOrder(orgId: string, orderId: string): Promise<PackOrder | null> {
        return this.prisma.order.findFirst({
            where: { id: orderId, organizationId: orgId, deletedAt: null },
            select: orderSelect,
        });
    }

    /** The order's lines still to go in a parcel, as task lines want them. */
    private wantedLines(order: PackOrder): WantedLine[] {
        return order.lineItems.filter(isPackableLine).map((li) => ({
            orderLineItemId: li.id,
            variantId: li.variantId,
            title: li.title,
            variantTitle: variantTitleOf(li.variantTitle),
            sku: li.variant?.sku ?? li.sku ?? null,
            barcode: li.variant?.barcode ?? null,
            remaining: remainingOf(li),
        }));
    }

    private async findTask(orgId: string, taskId: string) {
        const task = await this.prisma.pickTask.findFirst({
            where: { id: taskId, organizationId: orgId },
            select: { id: true, orderId: true, status: true },
        });
        if (!task) throw new NotFoundException('This packing task was not found.');
        return task;
    }

    /** The latest PACKED task, when nothing has shipped since it was packed. */
    private async packedWaitingToShip(orgId: string, orderId: string): Promise<string | null> {
        const packed = await this.prisma.pickTask.findFirst({
            where: { organizationId: orgId, orderId, status: 'PACKED' },
            orderBy: { packedAt: 'desc' },
            select: { id: true, packedAt: true },
        });
        if (!packed) return null;
        const fulfillments = await this.prisma.orderFulfillment.findMany({
            where: { orderId },
            select: { status: true, shippedAt: true, createdAt: true },
        });
        return packedNotShipped(packed.packedAt, lastShippedAt(fulfillments)) ? packed.id : null;
    }

    /**
     * Mirrors the order's lines still to ship onto an open task. Reads first
     * and only locks when something differs, so opening an unchanged task
     * writes nothing.
     */
    private async reconcile(orgId: string, taskId: string, order: PackOrder) {
        const wanted = this.wantedLines(order);
        const current = await this.prisma.pickTaskLine.findMany({ where: { pickTaskId: taskId } });
        if (isEmptyPlan(planReconcile(current, wanted))) return;

        await this.prisma.$transaction(async (tx) => {
            const status = await this.lockTask(tx, orgId, taskId, 'update');
            if (!OPEN_STATUSES.includes(status)) return;
            const plan = planReconcile(await tx.pickTaskLine.findMany({ where: { pickTaskId: taskId } }), wanted);
            if (plan.remove.length > 0) {
                await tx.pickTaskLine.deleteMany({ where: { id: { in: plan.remove }, pickTaskId: taskId } });
            }
            if (plan.add.length > 0) {
                await tx.pickTaskLine.createMany({
                    data: plan.add.map((w) => ({
                        pickTaskId: taskId,
                        orderLineItemId: w.orderLineItemId,
                        variantId: w.variantId,
                        title: w.title,
                        variantTitle: w.variantTitle,
                        sku: w.sku,
                        barcode: w.barcode,
                        qtyRequired: w.remaining,
                    })),
                    skipDuplicates: true,
                });
            }
            for (const u of plan.update) {
                await tx.pickTaskLine.update({ where: { id: u.id }, data: u.data });
            }
        });
    }

    /** The task as the pack screen shows it. */
    private async view(orgId: string, taskId: string, knownOrder?: PackOrder) {
        const task: TaskWithLines | null = await this.prisma.pickTask.findFirst({
            where: { id: taskId, organizationId: orgId },
            include: taskInclude,
        });
        if (!task) throw new NotFoundException('This packing task was not found.');
        const order = knownOrder ?? (await this.loadOrder(orgId, task.orderId));
        if (!order) throw new NotFoundException('This order was deleted.');
        const lastEvent = await this.prisma.pickTaskEvent.aggregate({
            where: { pickTaskId: taskId },
            _max: { createdAt: true },
        });

        const payment = paymentOf(order);
        const orderLines = new Map(order.lineItems.map((li) => [li.id, li]));
        const positions = new Map(order.lineItems.map((li, i) => [li.id, i]));
        const lastAt = lastEvent._max.createdAt;
        return {
            id: task.id,
            orderId: order.id,
            orderName: order.name,
            status: task.status,
            customerName: customerNameOf(order.customer, order.shippingAddress),
            city: cityOf(order.shippingAddress),
            payment,
            codConfirmed: codConfirmedOf(payment, order.tags),
            partialAllowed: payment === 'prepaid',
            partial: task.partial,
            holdReason: task.holdReason,
            holdNote: task.holdNote,
            heldAt: task.heldAt,
            warehouse: task.warehouse,
            updatedAt: lastAt && lastAt > task.updatedAt ? lastAt : task.updatedAt,
            packedAt: task.packedAt,
            lines: this.inLineOrder(task.lines, positions).map((l) => {
                const li = orderLines.get(l.orderLineItemId);
                return {
                    id: l.id,
                    orderLineItemId: l.orderLineItemId,
                    title: l.title,
                    variantTitle: l.variantTitle,
                    sku: l.sku,
                    barcode: l.barcode,
                    imageUrl: li?.variant?.image?.src ?? li?.variant?.product?.images?.[0]?.src ?? null,
                    required: l.qtyRequired,
                    packed: l.qtyPicked,
                    handConfirmed: l.qtyHandConfirmed,
                    counted: l.qtyCounted,
                    problem: l.problemReason && l.problemQty > 0 ? { reason: l.problemReason, qty: l.problemQty } : null,
                    scannable: !!l.variantId && !!(l.barcode || l.sku),
                };
            }),
        };
    }

    /** Task lines in the order's own line order; lines gone from the order last. */
    private inLineOrder<T extends { id: string; orderLineItemId: string }>(lines: T[], positions: Map<string, number>): T[] {
        const at = (l: T) => positions.get(l.orderLineItemId) ?? Number.MAX_SAFE_INTEGER;
        return [...lines].sort((a, b) => at(a) - at(b) || a.id.localeCompare(b.id));
    }

    private async linePositions(tx: Tx, taskId: string): Promise<Map<string, number>> {
        const rows = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT li."id" FROM "order_line_items" li
            JOIN "pick_tasks" t ON t."order_id" = li."order_id"
            WHERE t."id" = ${taskId}
            ORDER BY li."created_at" ASC, li."id" ASC`;
        return new Map(rows.map((r, i) => [r.id, i]));
    }

    private async lockTask(tx: Tx, orgId: string, taskId: string, mode: 'share' | 'update'): Promise<string> {
        const rows =
            mode === 'share'
                ? await tx.$queryRaw<Array<{ status: string }>>`
                    SELECT "status" FROM "pick_tasks" WHERE "id" = ${taskId} AND "organization_id" = ${orgId} FOR SHARE`
                : await tx.$queryRaw<Array<{ status: string }>>`
                    SELECT "status" FROM "pick_tasks" WHERE "id" = ${taskId} AND "organization_id" = ${orgId} FOR UPDATE`;
        if (rows.length === 0) throw new NotFoundException('This packing task was not found.');
        return rows[0].status;
    }

    private async lockLine(tx: Tx, taskId: string, lineId: string): Promise<TaskLineState> {
        await tx.$queryRaw`SELECT 1 FROM "pick_task_lines" WHERE "id" = ${lineId} AND "pick_task_id" = ${taskId} FOR UPDATE`;
        const line = await tx.pickTaskLine.findFirst({ where: { id: lineId, pickTaskId: taskId } });
        if (!line) throw new NotFoundException('This item is no longer on the order. Reopen the order to refresh it.');
        return line;
    }

    private requirePacking(status: string) {
        if (status !== 'PACKING') throw new ConflictException(this.statusRefusal(status));
    }

    private statusRefusal(status: string): string {
        if (status === 'ON_HOLD') return 'This order is on hold. Resume it to keep packing.';
        if (status === 'PACKED') return 'This order is already packed.';
        if (status === 'CANCELLED') return 'This packing was cancelled. Open the order again to start over.';
        return 'This packing task can no longer be changed.';
    }

    /**
     * Runs one change to a PACKING task's line and records its event. With a
     * clientScanId, a retry finds the first request's event and changes nothing.
     */
    private async lineAction(
        orgId: string,
        userId: string,
        taskId: string,
        clientScanId: string | null,
        act: (tx: Tx) => Promise<EventDraft | null>,
    ) {
        await this.findTask(orgId, taskId);
        if (clientScanId && (await this.priorEvent(taskId, clientScanId))) return this.view(orgId, taskId);
        try {
            await this.prisma.$transaction(async (tx) => {
                this.requirePacking(await this.lockTask(tx, orgId, taskId, 'share'));
                const draft = await act(tx);
                if (draft) await this.recordEvent(tx, orgId, taskId, userId, clientScanId, draft);
            });
        } catch (err) {
            if (!(clientScanId && isUniqueViolation(err))) throw err;
        }
        return this.view(orgId, taskId);
    }

    private priorEvent(taskId: string, clientScanId: string) {
        return this.prisma.pickTaskEvent.findUnique({
            where: { pickTaskId_clientScanId: { pickTaskId: taskId, clientScanId } },
            select: { kind: true, code: true, pickTaskLineId: true },
        });
    }

    private recordEvent(tx: Tx, orgId: string, taskId: string, userId: string, clientScanId: string | null, e: EventDraft) {
        return tx.pickTaskEvent.create({
            data: {
                organizationId: orgId,
                pickTaskId: taskId,
                pickTaskLineId: e.lineId ?? null,
                actorId: userId,
                kind: e.kind,
                code: e.code ?? null,
                qty: e.qty ?? 0,
                reason: e.reason ?? null,
                clientScanId,
            },
        });
    }

    private async scanReply(
        orgId: string,
        taskId: string,
        event: { kind: string; code: string | null; pickTaskLineId: string | null },
    ) {
        const result = SCAN_RESULTS[event.kind];
        if (!result) throw new ConflictException('This clientScanId was already used for another action.');
        const product =
            result === 'not_in_order' && event.code ? await this.findOrgVariant(this.prisma, orgId, event.code) : null;
        return {
            result,
            ...(event.pickTaskLineId ? { lineId: event.pickTaskLineId } : {}),
            ...(product ? { product: { title: product.product.title, variantTitle: variantTitleOf(product.title) } } : {}),
            task: await this.view(orgId, taskId),
        };
    }

    /** Another product of the organization with this code, so the packer sees what they picked by mistake. */
    private async findOrgVariant(db: Tx | PrismaService, orgId: string, code: string) {
        const find = (where: Prisma.ProductVariantWhereInput) =>
            db.productVariant.findFirst({
                where: { product: { organizationId: orgId, deletedAt: null }, ...where },
                select: { title: true, product: { select: { title: true } } },
                orderBy: { createdAt: 'asc' },
            });
        return (
            (await find({ barcode: code })) ??
            (await find({ sku: code })) ??
            (await find({ sku: { equals: code, mode: 'insensitive' } }))
        );
    }

    private timeline(tx: Tx, orderId: string, userId: string, taskId: string, action: string, message: string) {
        return tx.orderTimelineEvent.create({
            data: { orderId, actorId: userId, action, message, metadata: { taskId } as Prisma.InputJsonValue },
        });
    }

    private async userNames(ids: Array<string | null | undefined>): Promise<Map<string, string>> {
        const unique = [...new Set(ids.filter((id): id is string => !!id))];
        if (unique.length === 0) return new Map();
        const users = await this.prisma.user.findMany({
            where: { id: { in: unique } },
            select: { id: true, firstName: true, lastName: true, email: true },
        });
        return new Map(users.map((u) => [u.id, displayName(u) ?? u.email]));
    }

    private async actorName(userId: string): Promise<string> {
        return (await this.userNames([userId])).get(userId) ?? 'a former member';
    }
}
