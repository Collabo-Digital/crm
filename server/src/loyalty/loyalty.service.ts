import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { LoyaltyMetric, Prisma, VipLevel } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

interface LoyaltyConfig {
    loyaltyMetric: LoyaltyMetric;
    loyaltyBronzeMin: Prisma.Decimal;
    loyaltySilverMin: Prisma.Decimal;
    loyaltyGoldMin: Prisma.Decimal;
    loyaltyPlatinumMin: Prisma.Decimal;
}

/**
 * Owns `Customer.ordersCount`, `Customer.totalSpent` and `Customer.vipLevel`.
 *
 * Those two counters are DERIVED — recomputed from the customer's Order rows,
 * never incremented in place. Nothing else may write them.
 *
 * They used to be maintained by three writers that disagreed: offline sales
 * incremented, cancellations decremented, and Shopify customer sync OVERWROTE
 * both wholesale from Shopify's `orders_count` / `total_spent`. Since Shopify's
 * figures only describe Shopify orders, that last writer wiped every in-store
 * purchase for any customer who shopped on both channels (or was adopted by
 * email match during sync). Deriving makes the order table the single source of
 * truth, so the three can no longer fight — and it is self-healing: any later
 * recompute repairs a counter that drifted for any reason.
 *
 * Call `recomputeForCustomer` after anything that creates, cancels or deletes
 * an order. `recomputeAll` does the same for an entire organization and doubles
 * as the repair button for historical drift.
 *
 * Counted: orders that are neither soft-deleted nor cancelled, on any channel.
 * (Refunds are not deducted — nothing in the system adjusts for them today, and
 * changing that would alter tier outcomes.)
 *
 * Staleness note: a Shopify `customers/*` webhook can land before the matching
 * `orders/*` one, leaving a customer briefly counted low. Shopify fires
 * `customers/update` when an order is placed, and a full sync processes orders
 * before customers, so this converges on its own.
 */
@Injectable()
export class LoyaltyService {
    private readonly logger = new Logger(LoyaltyService.name);
    // Rejects concurrent `recomputeAll` calls for the same org (409 Conflict).
    private readonly recomputingOrgs = new Set<string>();

    constructor(private readonly prisma: PrismaService) {}

    /**
     * Recompute one customer's `ordersCount` / `totalSpent` from their orders.
     *
     * A single statement, so it is inherently race-free: concurrent callers all
     * compute the same answer from the same rows rather than applying deltas
     * that can be lost or double-applied. The `IS DISTINCT FROM` guard skips
     * the write (and the `updatedAt` bump) when nothing actually changed.
     */
    private async deriveCounters(customerId: string, orgId: string): Promise<void> {
        await this.prisma.$executeRaw`
            UPDATE "customers" c
            SET "orders_count" = s.cnt,
                "total_spent"  = s.total,
                "updated_at"   = CURRENT_TIMESTAMP
            FROM (
                -- total_spent is money in the ORG's currency, so each order is
                -- converted at the rate stored on it. Summing total_price raw
                -- added currencies together: a customer with USD orders showed
                -- "₹6,418.36" for what was $6,418.36.
                --
                -- The COUNT deliberately covers every order while the SUM skips
                -- any whose rate never resolved: a count is currency-free and
                -- always correct, whereas adding an unconverted amount would
                -- book dollars as rupees. The two can therefore disagree, which
                -- is the honest outcome — and is rare, since both order-creation
                -- paths now set a rate.
                SELECT COUNT(*)::int AS cnt,
                       COALESCE(SUM("total_price" * "exchange_rate"), 0) AS total
                FROM "orders"
                WHERE "customer_id" = ${customerId}
                  AND "organization_id" = ${orgId}
                  AND "deleted_at" IS NULL
                  AND "cancelled_at" IS NULL
            ) s
            WHERE c."id" = ${customerId}
              AND c."organization_id" = ${orgId}
              AND (c."orders_count" IS DISTINCT FROM s.cnt
                   OR c."total_spent" IS DISTINCT FROM s.total)
        `;
    }

    /** Same derivation across a whole organization, in one statement. */
    private async deriveCountersForOrg(orgId: string): Promise<number> {
        return this.prisma.$executeRaw`
            UPDATE "customers" c
            SET "orders_count" = s.cnt,
                "total_spent"  = s.total,
                "updated_at"   = CURRENT_TIMESTAMP
            FROM (
                -- Same conversion as deriveCounters above: money in the org's
                -- currency, at each order's own stored rate.
                SELECT cu."id" AS customer_id,
                       COUNT(o."id")::int AS cnt,
                       COALESCE(SUM(o."total_price" * o."exchange_rate"), 0) AS total
                FROM "customers" cu
                LEFT JOIN "orders" o
                       ON o."customer_id" = cu."id"
                      AND o."deleted_at" IS NULL
                      AND o."cancelled_at" IS NULL
                WHERE cu."organization_id" = ${orgId}
                  AND cu."deleted_at" IS NULL
                GROUP BY cu."id"
            ) s
            WHERE c."id" = s.customer_id
              AND (c."orders_count" IS DISTINCT FROM s.cnt
                   OR c."total_spent" IS DISTINCT FROM s.total)
        `;
    }

    /**
     * Pure: decides a customer's tier from org thresholds + the chosen metric.
     * Uses Prisma.Decimal comparison (>=) since thresholds & totalSpent are Decimal.
     */
    computeTier(org: LoyaltyConfig, ordersCount: number, totalSpent: Prisma.Decimal | string | number): VipLevel {
        const value =
            org.loyaltyMetric === LoyaltyMetric.ORDERS
                ? new Prisma.Decimal(ordersCount)
                : new Prisma.Decimal(totalSpent as any);

        if (value.gte(org.loyaltyPlatinumMin)) return VipLevel.PLATINUM;
        if (value.gte(org.loyaltyGoldMin)) return VipLevel.GOLD;
        if (value.gte(org.loyaltySilverMin)) return VipLevel.SILVER;
        if (value.gte(org.loyaltyBronzeMin)) return VipLevel.BRONZE;
        return VipLevel.NONE;
    }

    /**
     * Recompute a single customer's vipLevel. Writes only if the tier changed,
     * and records one CustomerActivityLog row tagged `vip_auto_recompute`.
     */
    async recomputeForCustomer(customerId: string, orgId: string): Promise<VipLevel | null> {
        // Counters first — the tier below is decided from them.
        await this.deriveCounters(customerId, orgId);

        const [org, customer] = await Promise.all([
            this.prisma.organization.findUnique({
                where: { id: orgId },
                select: {
                    loyaltyMetric: true,
                    loyaltyBronzeMin: true,
                    loyaltySilverMin: true,
                    loyaltyGoldMin: true,
                    loyaltyPlatinumMin: true,
                },
            }),
            this.prisma.customer.findFirst({
                where: { id: customerId, organizationId: orgId, deletedAt: null },
                select: { id: true, vipLevel: true, ordersCount: true, totalSpent: true },
            }),
        ]);
        if (!org || !customer) return null;

        const nextTier = this.computeTier(org, customer.ordersCount, customer.totalSpent);
        if (nextTier === customer.vipLevel) return customer.vipLevel;

        await this.prisma.$transaction([
            this.prisma.customer.update({
                where: { id: customer.id },
                data: { vipLevel: nextTier },
            }),
            this.prisma.customerActivityLog.create({
                data: {
                    customerId: customer.id,
                    action: 'vip_auto_recompute',
                    description: `VIP auto-updated from ${customer.vipLevel} to ${nextTier}`,
                    oldValue: customer.vipLevel,
                    newValue: nextTier,
                },
            }),
        ]);
        return nextTier;
    }

    /**
     * Batch recompute every customer in an org.
     *
     * Uses 5 `updateMany` calls (one per tier range) so the cost stays at 5
     * SQL statements regardless of customer count. Skips per-customer activity
     * log rows — a bulk recompute against 50k customers shouldn't flood the log
     * table.
     */
    async recomputeAll(orgId: string): Promise<{ updated: number; total: number }> {
        if (this.recomputingOrgs.has(orgId)) {
            throw new ConflictException('A loyalty recompute is already running for this organization.');
        }
        this.recomputingOrgs.add(orgId);

        try {
            const org = await this.prisma.organization.findUnique({
                where: { id: orgId },
                select: {
                    loyaltyMetric: true,
                    loyaltyBronzeMin: true,
                    loyaltySilverMin: true,
                    loyaltyGoldMin: true,
                    loyaltyPlatinumMin: true,
                },
            });
            if (!org) return { updated: 0, total: 0 };

            // Repair every counter in the org before tiering, so this endpoint
            // also fixes historical drift (e.g. customers whose in-store
            // purchases were previously clobbered by a Shopify sync).
            await this.deriveCountersForOrg(orgId);

            const total = await this.prisma.customer.count({
                where: { organizationId: orgId, deletedAt: null },
            });

            const metricField = org.loyaltyMetric === LoyaltyMetric.ORDERS ? 'ordersCount' : 'totalSpent';

            // Each tier gets a half-open range [min, nextMin). PLATINUM has no upper bound.
            // NONE covers anything below BRONZE's min.
            const ranges: Array<{ tier: VipLevel; gte: Prisma.Decimal | null; lt: Prisma.Decimal | null }> = [
                { tier: VipLevel.NONE, gte: null, lt: org.loyaltyBronzeMin },
                { tier: VipLevel.BRONZE, gte: org.loyaltyBronzeMin, lt: org.loyaltySilverMin },
                { tier: VipLevel.SILVER, gte: org.loyaltySilverMin, lt: org.loyaltyGoldMin },
                { tier: VipLevel.GOLD, gte: org.loyaltyGoldMin, lt: org.loyaltyPlatinumMin },
                { tier: VipLevel.PLATINUM, gte: org.loyaltyPlatinumMin, lt: null },
            ];

            let updated = 0;
            for (const range of ranges) {
                const metricWhere: { gte?: Prisma.Decimal; lt?: Prisma.Decimal } = {};
                if (range.gte !== null) metricWhere.gte = range.gte;
                if (range.lt !== null) metricWhere.lt = range.lt;

                const result = await this.prisma.customer.updateMany({
                    where: {
                        organizationId: orgId,
                        deletedAt: null,
                        vipLevel: { not: range.tier },
                        [metricField]: metricWhere,
                    } as Prisma.CustomerWhereInput,
                    data: { vipLevel: range.tier },
                });
                updated += result.count;
            }

            this.logger.log(
                `Loyalty recompute complete for org ${orgId}: ${updated}/${total} customers updated (metric=${org.loyaltyMetric}).`,
            );
            return { updated, total };
        } finally {
            this.recomputingOrgs.delete(orgId);
        }
    }
}
