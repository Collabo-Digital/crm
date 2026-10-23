import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import type { RfmGroup } from './segment-rules';

/// Scores older than this are recomputed before a segment that uses them is counted.
const STALE_MS = 12 * 3600_000;

/**
 * The RFM group for a customer's recency (R) and frequency (F) scores, each
 * 1–5 with 5 the most recent or most frequent. Every R/F pair lands in
 * exactly one group.
 */
export function rfmGroup(r: number, f: number): RfmGroup {
    if (r >= 4 && f >= 4) return 'champions';
    if (r >= 3 && f >= 3) return 'loyal';
    if (r >= 4) return 'new';
    if (r === 3) return 'needs_attention';
    if (f >= 3) return 'at_risk';
    return r === 2 ? 'hibernating' : 'lost';
}

/**
 * Recency, frequency and monetary scores for every store customer with an
 * order (dated when it was placed, as the Orders list does), in fifths of the organization's own customers (NTILE(5)), kept in
 * customer_rfm_scores for segments to filter on.
 */
@Injectable()
export class RfmService {
    private readonly logger = new Logger(RfmService.name);

    constructor(private readonly prisma: PrismaService) { }

    async compute(orgId: string, now = new Date()): Promise<number> {
        const rows = await this.prisma.$queryRaw<Array<{ customer_id: string; r: number; f: number; m: number; last_order: Date; orders: number }>>`
            WITH stats AS (
                SELECT o."customer_id", max(coalesce(o."external_created_at", o."created_at")) AS last_order,
                       count(*)::int AS orders, sum(o."total_price") AS spend
                FROM "orders" o
                JOIN "customers" c ON c."id" = o."customer_id" AND c."deleted_at" IS NULL
                WHERE o."organization_id" = ${orgId} AND o."deleted_at" IS NULL AND o."cancelled_at" IS NULL AND o."customer_id" IS NOT NULL
                GROUP BY o."customer_id"
            )
            SELECT "customer_id",
                   ntile(5) OVER (ORDER BY last_order)::int AS r,
                   ntile(5) OVER (ORDER BY orders, last_order)::int AS f,
                   ntile(5) OVER (ORDER BY spend)::int AS m,
                   last_order, orders
            FROM stats
        `;
        await this.prisma.$transaction(async (tx) => {
            await tx.customerRfmScore.deleteMany({ where: { organizationId: orgId } });
            for (let i = 0; i < rows.length; i += 1000) {
                await tx.customerRfmScore.createMany({
                    data: rows.slice(i, i + 1000).map((row) => ({
                        customerId: row.customer_id,
                        organizationId: orgId,
                        recency: row.r,
                        frequency: row.f,
                        monetary: row.m,
                        segment: rfmGroup(row.r, row.f),
                        lastOrderAt: row.last_order,
                        orderCount: row.orders,
                        computedAt: now,
                    })),
                });
            }
        });
        return rows.length;
    }

    /** Recompute when the scores are missing or older than half a day. */
    async ensureFresh(orgId: string): Promise<void> {
        const latest = await this.prisma.customerRfmScore.findFirst({
            where: { organizationId: orgId },
            select: { computedAt: true },
            orderBy: { computedAt: 'desc' },
        });
        if (!latest || Date.now() - latest.computedAt.getTime() > STALE_MS) await this.compute(orgId);
    }

    /** How many customers sit in each group. */
    async summary(orgId: string) {
        await this.ensureFresh(orgId);
        const groups = await this.prisma.customerRfmScore.groupBy({
            by: ['segment'],
            where: { organizationId: orgId },
            _count: { _all: true },
        });
        return Object.fromEntries(groups.map((g) => [g.segment, g._count._all]));
    }

    @Cron('30 4 * * *')
    async nightly() {
        const orgs = await this.prisma.order.findMany({ distinct: ['organizationId'], select: { organizationId: true } });
        for (const { organizationId } of orgs) {
            try {
                await this.compute(organizationId);
            } catch (err) {
                this.logger.warn(`RFM scores for ${organizationId} not computed: ${err instanceof Error ? err.message : err}`);
            }
        }
    }
}
