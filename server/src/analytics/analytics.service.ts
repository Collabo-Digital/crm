import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ShopifyAnalyticsService } from '../channel/shopify-analytics.service';
import type {
  NormalisedDailyMetrics,
  ProductBreakdown,
  ReferrerBreakdown,
} from '../channel/shopify-analytics.service';
import {
  QueryAnalyticsDto,
  rangeToDays,
} from './dto/query-analytics.dto';
import { dayMonthLabel } from '../common/utils/day-label.util';

// ─── DTOs returned to the client ─────────────────────────────────────────

export interface AnalyticsStat {
  key:
    | 'totalRevenue'
    | 'conversionRate'
    | 'avgOrderValue'
    | 'returningCustomers'
    | 'bounceRate'
    | 'avgSessionDuration'
    | 'cartToCheckoutRate'
    | 'checkoutToOrderRate'
    | 'cartAbandonmentRate';
  label: string;
  /// Pre-formatted display value ("$96,715", "3.24%"). The client renders it
  /// as-is, so locale + currency formatting happens here.
  value: string;
  /// Percent change vs the previous comparable window. Positive = up.
  change: number;
  changeLabel: string;
}

export interface AnalyticsTrendPoint {
  month: string; // "Jan", "Feb", …
  revenue: number;
  sessions: number;
  orders: number;
}

export interface AnalyticsChannelRow {
  channel: string;
  sessions: number;
  orders: number;
  revenue: number;
}

/**
 * 4-step conversion funnel + standalone pageview count. The funnel itself
 * is monotonically decreasing (each step is a session-count strictly ≤ the
 * previous). `pageviews` is a parallel metric — total pages viewed across
 * all sessions — surfaced separately so the chart math stays clean.
 */
export interface AnalyticsFunnel {
  sessions: number;
  pageviews: number;
  /// Count of sessions that added at least one item to cart
  /// (Shopify column: `sessions_with_cart_additions`).
  addToCarts: number;
  /// Count of sessions that reached the checkout page
  /// (Shopify column: `sessions_that_completed_checkout`).
  reachedCheckout: number;
  /// Order count for the window — pulled from the local Order table
  /// because Shopify's `sessions` dataset doesn't expose an `orders`
  /// column.
  orders: number;
}

export interface AnalyticsProductRow {
  title: string;
  productViews: number;
  addToCarts: number;
  checkouts: number;
  orders: number;
}

export interface AnalyticsOverview {
  stats: AnalyticsStat[];
  trend: AnalyticsTrendPoint[];
  channels: AnalyticsChannelRow[];
  funnel: AnalyticsFunnel;
  topViewedProducts: AnalyticsProductRow[];
  topAddedToCart: AnalyticsProductRow[];
  /// "shopify_ql" or "shopify_orders_fb" — surfaced so the UI can show a
  /// helpful empty state when sessions/pageviews are unavailable.
  source: string;
  currency: string;
  /// ISO timestamp of the most-recent snapshot's `updatedAt`. Surfaced so
  /// the UI can show "Last refreshed at HH:MM" and the merchant can confirm
  /// the data isn't a stale cache. Null when no snapshots exist yet.
  lastRefreshedAt: string | null;
}

const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

interface SnapshotMetricBlob extends Partial<NormalisedDailyMetrics> {}

/**
 * Reads cached `AnalyticsSnapshot` rows and shapes them into the payload
 * consumed by the client analytics page. Writing snapshots is
 * `ShopifyAnalyticsService`'s job — this service is read-only.
 */
@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly shopifyAnalytics: ShopifyAnalyticsService,
  ) {}

  async getOverview(
    orgId: string,
    query: QueryAnalyticsDto,
  ): Promise<AnalyticsOverview> {
    const days = rangeToDays(query.range);
    const since = this.daysAgo(days);

    const where: Prisma.AnalyticsSnapshotWhereInput = {
      organizationId: orgId,
      granularity: 'DAILY',
      date: { gte: since },
      ...(query.channelId && { channelId: query.channelId }),
    };

    let snapshots = await this.prisma.analyticsSnapshot.findMany({
      where,
      orderBy: { date: 'asc' },
    });

    // First-load fallback: if no snapshots exist for this org yet, trigger a
    // synchronous refresh against the org's Shopify channel so the page has
    // *something* to render. Subsequent loads are fed by the scheduler.
    if (snapshots.length === 0) {
      const fresh = await this.coldStartRefresh(orgId, query.channelId, days);
      if (fresh) {
        snapshots = await this.prisma.analyticsSnapshot.findMany({
          where,
          orderBy: { date: 'asc' },
        });
      }
    }

    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
      select: { currency: true },
    });
    const currency = org?.currency ?? 'USD';

    const enrichedSnapshots = snapshots.map((s) => ({
      date: s.date,
      source: s.source,
      metrics: (s.metrics ?? {}) as SnapshotMetricBlob,
    }));

    const trend = this.buildTrend(enrichedSnapshots, days);
    const channels = this.buildChannelBreakdown(enrichedSnapshots);
    const funnel = this.buildFunnel(enrichedSnapshots);
    const { topViewedProducts, topAddedToCart } =
      this.buildTopProducts(enrichedSnapshots);
    const stats = await this.buildStats(
      orgId,
      query.channelId,
      enrichedSnapshots,
      days,
      currency,
    );

    const source = this.dominantSource(snapshots);
    // Show the freshest snapshot's write time so the merchant can verify
    // the data isn't cached / stale.
    const lastRefreshedAt =
      snapshots.length > 0
        ? snapshots
            .map((s) => s.updatedAt)
            .reduce((a, b) => (a > b ? a : b))
            .toISOString()
        : null;

    return {
      stats,
      trend,
      channels,
      funnel,
      topViewedProducts,
      topAddedToCart,
      source,
      currency,
      lastRefreshedAt,
    };
  }

  // ─── Trend (revenue + sessions + orders by month) ──────────────────────

  private buildTrend(
    snapshots: Array<{
      date: Date;
      metrics: SnapshotMetricBlob;
    }>,
    days: number,
  ): AnalyticsTrendPoint[] {
    // Determine the time bucket: short windows (30d) bucket by day,
    // longer windows bucket by month. The chart adapts via the label.
    const bucketByMonth = days > 60;

    // Pre-populate every bucket across the requested window with zero so
    // the chart shows a continuous time series even when traffic is
    // sparse (otherwise low-volume stores would see one or two scattered
    // bars instead of a year's worth of slots).
    const buckets = new Map<
      string,
      { revenue: number; sessions: number; orders: number; label: string }
    >();
    const now = new Date();
    if (bucketByMonth) {
      // Walk back month-by-month from current month, ~days/30 buckets.
      const monthsBack = Math.ceil(days / 30);
      for (let i = monthsBack - 1; i >= 0; i--) {
        const d = new Date(
          Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1),
        );
        const key = `${d.getUTCFullYear()}-${MONTH_NAMES[d.getUTCMonth()]}`;
        buckets.set(key, {
          revenue: 0,
          sessions: 0,
          orders: 0,
          label: MONTH_NAMES[d.getUTCMonth()],
        });
      }
    } else {
      // Walk back day-by-day.
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date();
        d.setUTCHours(0, 0, 0, 0);
        d.setUTCDate(d.getUTCDate() - i);
        const key = this.toIsoDate(d);
        buckets.set(key, {
          revenue: 0,
          sessions: 0,
          orders: 0,
          label: dayMonthLabel(d),
        });
      }
    }

    // Overlay actual snapshot data on top of the zero scaffold.
    for (const snap of snapshots) {
      const key = bucketByMonth
        ? `${snap.date.getUTCFullYear()}-${MONTH_NAMES[snap.date.getUTCMonth()]}`
        : this.toIsoDate(snap.date);
      const slot = buckets.get(key);
      if (!slot) continue; // snapshot outside the visible window — skip
      slot.revenue += snap.metrics.revenue ?? 0;
      slot.sessions += snap.metrics.sessions ?? 0;
      slot.orders += snap.metrics.orders ?? 0;
    }

    return Array.from(buckets.values()).map((slot) => ({
      month: slot.label,
      revenue: this.round(slot.revenue),
      sessions: Math.round(slot.sessions),
      orders: Math.round(slot.orders),
    }));
  }

  // ─── Channel (referrer) breakdown ──────────────────────────────────────

  private buildChannelBreakdown(
    snapshots: Array<{ metrics: SnapshotMetricBlob }>,
  ): AnalyticsChannelRow[] {
    const totals = new Map<
      string,
      { sessions: number; orders: number; revenue: number }
    >();
    for (const snap of snapshots) {
      const referrers: ReferrerBreakdown[] = snap.metrics.byReferrer ?? [];
      for (const ref of referrers) {
        const key = this.normalizeReferrer(ref.referrerSource);
        const slot =
          totals.get(key) ?? { sessions: 0, orders: 0, revenue: 0 };
        slot.sessions += ref.sessions ?? 0;
        slot.orders += ref.orders ?? 0;
        slot.revenue += ref.revenue ?? 0;
        totals.set(key, slot);
      }
    }
    return Array.from(totals.entries())
      .map(([channel, t]) => ({
        channel,
        sessions: Math.round(t.sessions),
        orders: Math.round(t.orders),
        revenue: this.round(t.revenue),
      }))
      .sort((a, b) => b.sessions - a.sessions);
  }

  // ─── Funnel (sessions → cart → checkout → orders + pageviews) ─────────

  private buildFunnel(
    snapshots: Array<{ metrics: SnapshotMetricBlob }>,
  ): AnalyticsFunnel {
    const sum = (key: keyof SnapshotMetricBlob) =>
      snapshots.reduce(
        (acc, snap) => acc + ((snap.metrics[key] as number | undefined) ?? 0),
        0,
      );
    // Webhook-derived alternates. The cart aggregator writes these into
    // each snapshot blob; we fall back to them when ShopifyQL's count
    // columns are absent (Basic plan, missing scope, or just no data
    // backfilled yet). Two sources rarely overlap — ShopifyQL is hourly
    // aggregate, webhooks are real-time — so prefer ShopifyQL when
    // non-zero.
    const sumWebhook = (key: string) =>
      snapshots.reduce(
        (acc, snap) =>
          acc + (((snap.metrics as Record<string, unknown>)[key] as number | undefined) ?? 0),
        0,
      );

    const shopifyAddToCarts = sum('sessionsWithCartAdditions');
    const webhookAddToCarts = sumWebhook('cartsCreatedFromWebhook');
    const shopifyReachedCheckout = sum('reachedCheckoutCount');
    const webhookReachedCheckout = sumWebhook('checkoutsStartedFromWebhook');

    return {
      sessions: Math.round(sum('sessions')),
      pageviews: Math.round(sum('pageviews')),
      addToCarts: Math.round(
        shopifyAddToCarts > 0 ? shopifyAddToCarts : webhookAddToCarts,
      ),
      reachedCheckout: Math.round(
        shopifyReachedCheckout > 0 ? shopifyReachedCheckout : webhookReachedCheckout,
      ),
      orders: Math.round(sum('orders')),
    };
  }

  // ─── Top products (per-product view / add-to-cart counts) ─────────────
  //
  // Per-product breakdown is populated by `CartEventsAggregator` from
  // Shopify cart + checkout webhooks. We sum across all snapshots in the
  // window so the tables reflect the full requested range.
  //
  // Note: `productViews` stays at 0 — Shopify doesn't fire a server-side
  // "viewed" webhook, so we can only count add-to-cart and checkout
  // activity from this pipeline. The "Top Viewed Products" panel in the
  // UI renders an explanatory empty state.
  private buildTopProducts(
    snapshots: Array<{ date: Date; metrics: SnapshotMetricBlob }>,
  ): {
    topViewedProducts: AnalyticsProductRow[];
    topAddedToCart: AnalyticsProductRow[];
  } {
    const totals = new Map<
      string,
      { productViews: number; addToCarts: number; checkouts: number; orders: number }
    >();
    for (const snap of snapshots) {
      const products = (snap.metrics as { byProduct?: ProductBreakdown[] })
        .byProduct;
      if (!products) continue;
      for (const row of products) {
        const slot =
          totals.get(row.productTitle) ?? {
            productViews: 0,
            addToCarts: 0,
            checkouts: 0,
            orders: 0,
          };
        slot.productViews += row.productViews ?? 0;
        slot.addToCarts += row.addToCarts ?? 0;
        slot.checkouts += row.checkouts ?? 0;
        slot.orders += row.orders ?? 0;
        totals.set(row.productTitle, slot);
      }
    }
    const normalised: AnalyticsProductRow[] = Array.from(totals.entries()).map(
      ([title, v]) => ({
        title,
        productViews: Math.round(v.productViews),
        addToCarts: Math.round(v.addToCarts),
        checkouts: Math.round(v.checkouts),
        orders: Math.round(v.orders),
      }),
    );
    const topViewedProducts = [...normalised]
      .filter((p) => p.productViews > 0)
      .sort((a, b) => b.productViews - a.productViews)
      .slice(0, 10);
    const topAddedToCart = [...normalised]
      .filter((p) => p.addToCarts > 0)
      .sort((a, b) => b.addToCarts - a.addToCarts)
      .slice(0, 10);
    return { topViewedProducts, topAddedToCart };
  }

  // Map Shopify's referrer_source enum to the labels the UI shows.
  private normalizeReferrer(source: string): string {
    const map: Record<string, string> = {
      organic: 'Organic',
      direct: 'Direct',
      email: 'Email',
      social: 'Social',
      paid: 'Paid Search',
      referral: 'Referral',
      unknown: 'Direct',
    };
    return map[source.toLowerCase()] ?? source;
  }

  // ─── Stat cards ────────────────────────────────────────────────────────

  private async buildStats(
    orgId: string,
    channelId: string | undefined,
    snapshots: Array<{ date: Date; metrics: SnapshotMetricBlob }>,
    days: number,
    currency: string,
  ): Promise<AnalyticsStat[]> {
    // Compute the headline numbers for the current window.
    const current = this.aggregateStats(snapshots);
    const currentSince = this.daysAgo(days);
    const currentReturning = await this.computeReturningRate(
      orgId,
      channelId,
      currentSince,
      new Date(),
    );

    // Compute the same numbers for the previous equivalent window so we can
    // show real period-over-period change percentages instead of "+0%".
    const previousUntil = currentSince;
    const previousSince = this.daysAgo(days * 2);
    const previousSnapshots = await this.prisma.analyticsSnapshot.findMany({
      where: {
        organizationId: orgId,
        granularity: 'DAILY',
        date: { gte: previousSince, lt: previousUntil },
        ...(channelId && { channelId }),
      },
    });
    const previousEnriched = previousSnapshots.map((s) => ({
      date: s.date,
      metrics: (s.metrics ?? {}) as SnapshotMetricBlob,
    }));
    const previous = this.aggregateStats(previousEnriched);
    const previousReturning = await this.computeReturningRate(
      orgId,
      channelId,
      previousSince,
      previousUntil,
    );

    const changeLabel = this.changeLabel(days);

    return [
      {
        key: 'totalRevenue',
        label: 'Total Revenue',
        value: this.formatCurrency(current.totalRevenue, currency),
        change: this.pctChange(current.totalRevenue, previous.totalRevenue),
        changeLabel,
      },
      {
        key: 'conversionRate',
        label: 'Conversion Rate',
        value: `${current.conversionRate.toFixed(2)}%`,
        change: this.pctChange(current.conversionRate, previous.conversionRate),
        changeLabel,
      },
      {
        key: 'avgOrderValue',
        label: 'Avg. Order Value',
        value: this.formatCurrency(current.avgOrderValue, currency),
        change: this.pctChange(current.avgOrderValue, previous.avgOrderValue),
        changeLabel,
      },
      {
        key: 'returningCustomers',
        label: 'Returning Customers',
        value: `${currentReturning.toFixed(1)}%`,
        change: this.pctChange(currentReturning, previousReturning),
        changeLabel,
      },
      {
        key: 'bounceRate',
        label: 'Bounce Rate',
        value: `${current.bounceRate.toFixed(1)}%`,
        change: this.pctChange(current.bounceRate, previous.bounceRate),
        changeLabel,
      },
      {
        key: 'avgSessionDuration',
        label: 'Avg. Session Duration',
        value: this.formatDuration(current.avgSessionDuration),
        change: this.pctChange(
          current.avgSessionDuration,
          previous.avgSessionDuration,
        ),
        changeLabel,
      },
      {
        key: 'cartToCheckoutRate',
        label: 'Cart → Checkout Rate',
        value: `${current.cartToCheckoutRate.toFixed(1)}%`,
        change: this.pctChange(
          current.cartToCheckoutRate,
          previous.cartToCheckoutRate,
        ),
        changeLabel,
      },
      {
        key: 'checkoutToOrderRate',
        label: 'Checkout → Order Rate',
        value: `${current.checkoutToOrderRate.toFixed(1)}%`,
        change: this.pctChange(
          current.checkoutToOrderRate,
          previous.checkoutToOrderRate,
        ),
        changeLabel,
      },
      {
        key: 'cartAbandonmentRate',
        label: 'Cart Abandonment',
        value: `${current.cartAbandonmentRate.toFixed(1)}%`,
        change: this.pctChange(
          current.cartAbandonmentRate,
          previous.cartAbandonmentRate,
        ),
        changeLabel,
      },
    ];
  }

  /**
   * Roll up a snapshot list into the metrics needed by the stat cards.
   * Pure function over snapshots — no DB access — so we can call it twice
   * (current + previous window) without doubling the query count.
   */
  private aggregateStats(
    snapshots: Array<{ metrics: SnapshotMetricBlob }>,
  ): {
    totalRevenue: number;
    totalOrders: number;
    conversionRate: number;
    avgOrderValue: number;
    bounceRate: number;
    avgSessionDuration: number;
    addToCarts: number;
    reachedCheckout: number;
    cartToCheckoutRate: number;
    checkoutToOrderRate: number;
    cartAbandonmentRate: number;
  } {
    const totalRevenue = snapshots.reduce(
      (s, snap) => s + (snap.metrics.revenue ?? 0),
      0,
    );
    const totalOrders = snapshots.reduce(
      (s, snap) => s + (snap.metrics.orders ?? 0),
      0,
    );

    // Prefer the ShopifyQL `conversion_rate` column when present; otherwise
    // approximate as orders/sessions.
    const ratedSnapshots = snapshots.filter(
      (s) => typeof s.metrics.conversionRate === 'number',
    );
    let conversionRate = 0;
    if (ratedSnapshots.length > 0) {
      conversionRate =
        ratedSnapshots.reduce(
          (sum, s) => sum + (s.metrics.conversionRate ?? 0),
          0,
        ) / ratedSnapshots.length;
    } else {
      const totalSessions = snapshots.reduce(
        (s, snap) => s + (snap.metrics.sessions ?? 0),
        0,
      );
      conversionRate =
        totalSessions > 0 ? (totalOrders / totalSessions) * 100 : 0;
    }

    const avgOrderValue = totalOrders > 0 ? totalRevenue / totalOrders : 0;

    const bounceSnapshots = snapshots.filter(
      (s) => typeof s.metrics.bounceRate === 'number',
    );
    const bounceRate =
      bounceSnapshots.length > 0
        ? bounceSnapshots.reduce(
            (sum, s) => sum + (s.metrics.bounceRate ?? 0),
            0,
          ) / bounceSnapshots.length
        : 0;

    const durationSnapshots = snapshots.filter(
      (s) => typeof s.metrics.avgSessionDuration === 'number',
    );
    const avgSessionDuration =
      durationSnapshots.length > 0
        ? durationSnapshots.reduce(
            (sum, s) => sum + (s.metrics.avgSessionDuration ?? 0),
            0,
          ) / durationSnapshots.length
        : 0;

    // Cart / checkout / order counts come from two possible sources:
    //   • ShopifyQL  — aggregates ALL sessions for the day, but only
    //     after a ~1h lag, and only when the merchant is on a plan that
    //     exposes the sessions dataset.
    //   • Webhooks   — real-time, but only counts events that fired
    //     AFTER we subscribed (i.e. post-registration shoppers).
    //
    // Critically, BOTH SIDES of a ratio must come from the SAME source.
    // Earlier we mixed `totalOrders` (local DB, full history) with
    // `webhookReachedCheckout` (post-registration only), which produced
    // nonsense values like 500% when the merchant had pre-existing
    // orders in the DB. We now pick one source per `aggregateStats`
    // call and use it consistently.
    const shopifyAddToCarts = snapshots.reduce(
      (s, snap) => s + (snap.metrics.sessionsWithCartAdditions ?? 0),
      0,
    );
    const webhookAddToCarts = snapshots.reduce(
      (s, snap) =>
        s +
        (((snap.metrics as Record<string, unknown>).cartsCreatedFromWebhook as
          | number
          | undefined) ?? 0),
      0,
    );
    const shopifyReachedCheckout = snapshots.reduce(
      (s, snap) => s + (snap.metrics.reachedCheckoutCount ?? 0),
      0,
    );
    const webhookReachedCheckout = snapshots.reduce(
      (s, snap) =>
        s +
        (((snap.metrics as Record<string, unknown>)
          .checkoutsStartedFromWebhook as number | undefined) ?? 0),
      0,
    );
    const webhookOrders = snapshots.reduce(
      (s, snap) =>
        s +
        (((snap.metrics as Record<string, unknown>).ordersFromWebhook as
          | number
          | undefined) ?? 0),
      0,
    );

    // Pick the source. ShopifyQL takes priority when it has data for
    // BOTH cart and checkout (so the ratio is well-defined); otherwise
    // we fall back entirely to webhook counts.
    const useShopifyQl = shopifyAddToCarts > 0 && shopifyReachedCheckout > 0;
    const addToCarts = useShopifyQl ? shopifyAddToCarts : webhookAddToCarts;
    const reachedCheckout = useShopifyQl
      ? shopifyReachedCheckout
      : webhookReachedCheckout;
    // In ShopifyQL mode the order count is the local DB count (covers
    // all sessions, same coverage as ShopifyQL itself). In webhook mode
    // we use the webhook-recorded order count to keep the ratio's
    // numerator and denominator in the same time window.
    const ordersForRate = useShopifyQl ? totalOrders : webhookOrders;

    // Clamp to [0, 100] — webhook delivery is at-least-once so we can
    // occasionally see a denominator that's slightly behind the
    // numerator; capping prevents a "500%" stat card on the UI while we
    // wait for the next event to arrive.
    const clamp = (v: number) => Math.max(0, Math.min(100, v));

    const cartToCheckoutRate =
      addToCarts > 0 ? clamp((reachedCheckout / addToCarts) * 100) : 0;
    const checkoutToOrderRate =
      reachedCheckout > 0 ? clamp((ordersForRate / reachedCheckout) * 100) : 0;
    const cartAbandonmentRate =
      addToCarts > 0
        ? clamp(((addToCarts - reachedCheckout) / addToCarts) * 100)
        : 0;

    return {
      totalRevenue,
      totalOrders,
      conversionRate,
      avgOrderValue,
      bounceRate,
      avgSessionDuration,
      addToCarts,
      reachedCheckout,
      cartToCheckoutRate,
      checkoutToOrderRate,
      cartAbandonmentRate,
    };
  }

  /**
   * Period-over-period percentage change. Returns 0 when the previous
   * window has no comparable data (i.e. the merchant has just connected
   * Shopify) — we'd rather under-claim a flat trend than flash a
   * misleading "+100%" on every stat card during cold-start.
   */
  private pctChange(current: number, previous: number): number {
    if (!Number.isFinite(current) || !Number.isFinite(previous)) return 0;
    if (previous === 0) return 0;
    return Math.round(((current - previous) / previous) * 100);
  }

  /// Format seconds as "M:SS" (e.g. "1:42"). Falls back to "0s" when no data.
  private formatDuration(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds <= 0) return '0s';
    if (seconds < 60) return `${Math.round(seconds)}s`;
    const minutes = Math.floor(seconds / 60);
    const remainder = Math.round(seconds % 60);
    return `${minutes}m ${remainder.toString().padStart(2, '0')}s`;
  }

  private async computeReturningRate(
    orgId: string,
    channelId: string | undefined,
    since: Date,
    until: Date,
  ): Promise<number> {
    const where: Prisma.CustomerWhereInput = {
      organizationId: orgId,
      deletedAt: null,
      createdAt: { gte: since, lt: until },
      ...(channelId && { channelId }),
    };
    const [total, returning] = await Promise.all([
      this.prisma.customer.count({ where }),
      this.prisma.customer.count({
        where: { ...where, ordersCount: { gt: 1 } },
      }),
    ]);
    return total > 0 ? (returning / total) * 100 : 0;
  }

  // ─── Cold start ────────────────────────────────────────────────────────

  /// Triggered on first analytics request when no snapshots exist yet.
  /// Returns true if a refresh ran successfully.
  private async coldStartRefresh(
    orgId: string,
    channelId: string | undefined,
    days: number,
  ): Promise<boolean> {
    const target = await this.prisma.channel.findFirst({
      where: {
        organizationId: orgId,
        platform: 'SHOPIFY',
        ...(channelId && { id: channelId }),
      },
      select: { id: true },
    });
    if (!target) return false;
    try {
      await this.shopifyAnalytics.refreshForChannel(target.id, days);
      return true;
    } catch (err) {
      this.logger.warn(
        `Cold-start analytics refresh failed for org ${orgId}: ${err instanceof Error ? err.message : err}`,
      );
      return false;
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

  private daysAgo(n: number): Date {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() - n);
    return d;
  }

  private toIsoDate(d: Date): string {
    return d.toISOString().slice(0, 10);
  }

  private round(n: number): number {
    return Math.round(n * 100) / 100;
  }

  private changeLabel(days: number): string {
    if (days <= 7) return 'vs last 7 days';
    if (days <= 30) return 'vs last 30 days';
    if (days <= 182) return 'vs last 6 months';
    return 'vs last year';
  }

  private formatCurrency(value: number, currency: string): string {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      maximumFractionDigits: 0,
    }).format(value);
  }

  private dominantSource(
    snapshots: Array<{ source: string }>,
  ): string {
    if (snapshots.length === 0) return 'none';
    const counts: Record<string, number> = {};
    for (const s of snapshots) counts[s.source] = (counts[s.source] ?? 0) + 1;
    return Object.entries(counts).sort(([, a], [, b]) => b - a)[0][0];
  }
}
