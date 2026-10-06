import { Prisma, OrderFinancialStatus } from '@prisma/client';

/**
 * Order/date scoping shared by every figure the dashboard reports.
 *
 * This exists because the dashboard's sales figure and its profit figure were
 * each built from their own hand-rolled `where`, and the two disagreed on four
 * separate axes — window, NULL handling, cancellation and status set. A metric
 * that cannot be reconciled with the metric beside it is worse than no metric,
 * so the filters now come from one place.
 */

/**
 * Orders that count as a sale.
 *
 * PARTIALLY_REFUNDED is IN because the unrefunded remainder is still revenue —
 * the refund is netted out separately rather than by dropping the whole order.
 * REFUNDED and VOIDED are out entirely.
 */
export const SALES_FINANCIAL_STATUSES: OrderFinancialStatus[] = [
  OrderFinancialStatus.PAID,
  OrderFinancialStatus.PARTIALLY_PAID,
  OrderFinancialStatus.PARTIALLY_REFUNDED,
];

/**
 * "When the sale happened."
 *
 * `externalCreatedAt` is NULL for CRM-native orders (see order.service.ts's
 * note on the same field), so a bare `externalCreatedAt: { gte }` silently
 * drops every manual/offline sale — while an order-level `_sum` over the same
 * period happily includes them. That asymmetry is what made Total Sales and
 * the profit chart irreconcilable, and it is subtle enough that the old code
 * carried an `externalCreatedAt || createdAt` fallback which could never fire.
 *
 * `to` is EXCLUSIVE so two adjacent buckets can't both claim a boundary row.
 * Either bound may be omitted (an export with only a `dateTo`); the dashboard
 * always passes `from`.
 */
export function placedBetween(from?: Date, to?: Date): Prisma.OrderWhereInput {
  // No bounds is no window, not an OR that happens to match every row.
  if (!from && !to) return {};
  const range: Prisma.DateTimeFilter = { ...(from && { gte: from }), ...(to && { lt: to }) };
  return {
    OR: [
      { externalCreatedAt: range },
      { externalCreatedAt: null, createdAt: range },
    ],
  };
}

/**
 * Raw-SQL twin of `placedBetween`'s ordering key. Kept beside it so the two
 * can never drift into filtering on different columns.
 */
export const PLACED_AT = Prisma.sql`COALESCE(o."external_created_at", o."created_at")`;

export interface SalesScope {
  orgId: string;
  channelId?: string;
  from: Date;
  /** Exclusive. */
  to?: Date;
}

/**
 * Full scope for any revenue figure.
 *
 * `cancelledAt: null` is deliberate and is a behaviour change: a cancelled but
 * still-PAID order had its units restocked, so it is neither revenue nor COGS —
 * yet nothing in the dashboard filtered it before.
 */
export function salesOrderWhere(scope: SalesScope): Prisma.OrderWhereInput {
  return {
    organizationId: scope.orgId,
    deletedAt: null,
    cancelledAt: null,
    financialStatus: { in: SALES_FINANCIAL_STATUSES },
    ...(scope.channelId && { channelId: scope.channelId }),
    ...placedBetween(scope.from, scope.to),
  };
}
