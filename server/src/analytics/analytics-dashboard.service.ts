import { Injectable } from '@nestjs/common';
import { ChannelPlatform, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  attachProductImages,
  type ProductImageCandidate,
} from './product-image-match.util';
import {
  AnalyticsChannelFilter,
  QueryAnalyticsDto,
  rangeToDays,
} from './dto/query-analytics.dto';
import { dayMonthLabel } from '../common/utils/day-label.util';

// ─── DTOs returned to the client ─────────────────────────────────────────

export interface DashboardStat {
  key: 'totalAddToCart' | 'totalCheckout' | 'totalAbandonedCarts';
  label: string;
  value: number;
  /// Percent change vs the previous comparable window. Positive = up.
  /// Null when the previous window had none to compare with.
  change: number | null;
  changeLabel: string;
}

export interface DashboardTrendPoint {
  /// Day ("21 Oct") for 30d windows, month ("Jan") for longer ones.
  label: string;
  addToCart: number;
  reachedCheckout: number;
  completedOrders: number;
}

export interface DashboardPageRow {
  path: string;
  title: string | null;
  views: number;
}

export interface DashboardProductRow {
  title: string;
  addToCarts: number;
  /** First product image, so the merchant can recognise the row at a glance. */
  image: string | null;
}

export interface DashboardViewedProductRow {
  title: string;
  views: number;
  image: string | null;
}

/** A top-list row before its image is attached. */
type ProductTally<T> = T & { productId?: string };

export interface AnalyticsDashboard {
  stats: DashboardStat[];
  topPages: DashboardPageRow[];
  topViewedProducts: DashboardViewedProductRow[];
  topAddedToCart: DashboardProductRow[];
  trend: DashboardTrendPoint[];
  meta: {
    channel: AnalyticsChannelFilter;
    lastRefreshedAt: string | null;
  };
}

/// Subset of the AnalyticsSnapshot.metrics JSONB blob this service reads.
interface MetricBlob {
  pixelAddToCartSessions?: number;
  pixelCheckoutStartedSessions?: number;
  pixelCheckoutCompletedSessions?: number;
  cartsCreatedFromWebhook?: number;
  checkoutsStartedFromWebhook?: number;
  orders?: number;
  byPage?: Array<{ path: string; title: string | null; views: number }>;
  /** `productId` (Shopify, numeric) only on snapshots written since it was kept. */
  byProduct?: Array<{ productTitle: string; productId?: string; productViews?: number; addToCarts?: number }>;
}

const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

const PLATFORM_BY_FILTER: Partial<Record<AnalyticsChannelFilter, ChannelPlatform>> = {
  shopify: ChannelPlatform.SHOPIFY,
  instagram: ChannelPlatform.INSTAGRAM,
  whatsapp: ChannelPlatform.WHATSAPP,
};

/**
 * Read side of the pixel-first analytics dashboard. Channel-agnostic by
 * design: it only reads `AnalyticsSnapshot` rows, which are keyed per
 * channel per day — supporting a new platform means writing snapshot rows
 * for its channels with the same metric keys; nothing here changes.
 *
 * Metric sources (one source per metric, pixel preferred):
 *   addToCart / reachedCheckout — pixel session counts, falling back to
 *     webhook counts for days before the pixel was activated.
 *   completedOrders — Order-table-derived `orders` (written by the Shopify
 *     analytics refresher), the most reliable count.
 *   abandoned carts — addToCart − pixelCheckoutCompletedSessions, ≥ 0.
 */
@Injectable()
export class AnalyticsDashboardService {
  constructor(private readonly prisma: PrismaService) { }

  async getDashboard(orgId: string, query: QueryAnalyticsDto): Promise<AnalyticsDashboard> {
    const channel = query.channel ?? 'all';
    const days = rangeToDays(query.range);
    const since = this.daysAgo(days);
    const prevSince = this.daysAgo(days * 2);

    const channelIds = await this.resolveChannelIds(orgId, channel);
    // Filter requested but the org has no channels on that platform —
    // return the consistent empty shape instead of erroring.
    if (channelIds !== undefined && channelIds.length === 0) {
      return this.empty(channel);
    }

    // One query covers both the current window and the previous
    // comparison window; split in memory.
    const where: Prisma.AnalyticsSnapshotWhereInput = {
      organizationId: orgId,
      granularity: 'DAILY',
      date: { gte: prevSince },
      ...(channelIds && { channelId: { in: channelIds } }),
    };
    const rows = await this.prisma.analyticsSnapshot.findMany({
      where,
      orderBy: { date: 'asc' },
    });

    const current = rows.filter((r) => r.date >= since);
    const previous = rows.filter((r) => r.date < since);
    const currentMetrics = current.map((r) => (r.metrics ?? {}) as MetricBlob);

    const cur = this.totals(currentMetrics);
    const prev = this.totals(previous.map((r) => (r.metrics ?? {}) as MetricBlob));
    const changeLabel = this.changeLabel(days);

    const lastRefreshedAt =
      current.length > 0
        ? current
          .map((r) => r.updatedAt)
          .reduce((a, b) => (a > b ? a : b))
          .toISOString()
        : null;

    const viewed = this.topViewedProducts(currentMetrics);
    const added = this.topAddedToCart(currentMetrics);
    const candidates = await this.imageCandidates(orgId, [...viewed, ...added]);

    return {
      stats: [
        this.stat('totalAddToCart', 'Total Add to Cart', cur.addToCart, prev.addToCart, changeLabel),
        this.stat('totalCheckout', 'Total Checkout', cur.checkout, prev.checkout, changeLabel),
        this.stat('totalAbandonedCarts', 'Total Abandoned Carts', cur.abandoned, prev.abandoned, changeLabel),
      ],
      topPages: this.topPages(currentMetrics),
      topViewedProducts: attachProductImages(viewed, candidates),
      topAddedToCart: attachProductImages(added, candidates),
      trend: this.buildTrend(current, days),
      meta: { channel, lastRefreshedAt },
    };
  }

  /// undefined = no filter (spans all channels).
  private async resolveChannelIds(
    orgId: string,
    filter: AnalyticsChannelFilter,
  ): Promise<string[] | undefined> {
    if (filter === 'all') return undefined;
    const platform = PLATFORM_BY_FILTER[filter];
    if (!platform) return [];
    const channels = await this.prisma.channel.findMany({
      where: { organizationId: orgId, platform },
      select: { id: true },
    });
    return channels.map((c) => c.id);
  }

  private totals(metrics: MetricBlob[]) {
    const sum = (pick: (m: MetricBlob) => number | undefined) =>
      metrics.reduce((acc, m) => acc + (pick(m) ?? 0), 0);

    const pixelAtc = sum((m) => m.pixelAddToCartSessions);
    const webhookAtc = sum((m) => m.cartsCreatedFromWebhook);
    const pixelCheckout = sum((m) => m.pixelCheckoutStartedSessions);
    const webhookCheckout = sum((m) => m.checkoutsStartedFromWebhook);
    const completed = sum((m) => m.pixelCheckoutCompletedSessions);

    const addToCart = pixelAtc > 0 ? pixelAtc : webhookAtc;
    const checkout = pixelCheckout > 0 ? pixelCheckout : webhookCheckout;
    const abandoned = Math.max(0, addToCart - completed);
    return { addToCart, checkout, abandoned };
  }

  private stat(
    key: DashboardStat['key'],
    label: string,
    value: number,
    prevValue: number,
    changeLabel: string,
  ): DashboardStat {
    // Nothing in the previous window means there is no rate of change: null,
    // not "+100%", and not the flat 0% this used to send, which the cards
    // showed beside a real rise (Total Checkout 4, "0%"). Zero against zero
    // really is no change.
    const change =
      prevValue > 0 ? Math.round(((value - prevValue) / prevValue) * 100) : value > 0 ? null : 0;
    return { key, label, value, change, changeLabel };
  }

  private topPages(metrics: MetricBlob[]): DashboardPageRow[] {
    const totals = new Map<string, { title: string | null; views: number }>();
    for (const m of metrics) {
      for (const p of m.byPage ?? []) {
        const slot = totals.get(p.path) ?? { title: p.title, views: 0 };
        slot.views += p.views ?? 0;
        if (!slot.title && p.title) slot.title = p.title;
        totals.set(p.path, slot);
      }
    }
    return Array.from(totals.entries())
      .map(([path, v]) => ({ path, title: v.title, views: v.views }))
      .sort((a, b) => b.views - a.views)
      .slice(0, 5);
  }

  private topViewedProducts(metrics: MetricBlob[]): ProductTally<{ title: string; views: number }>[] {
    const totals = new Map<string, { views: number; productId?: string }>();
    for (const m of metrics) {
      for (const p of m.byProduct ?? []) {
        if (!p.productViews) continue;
        const t = totals.get(p.productTitle) ?? { views: 0 };
        t.views += p.productViews;
        t.productId ??= p.productId;
        totals.set(p.productTitle, t);
      }
    }
    return Array.from(totals.entries())
      .map(([title, t]) => ({ title, views: t.views, productId: t.productId }))
      .sort((a, b) => b.views - a.views)
      .slice(0, 5);
  }

  private topAddedToCart(metrics: MetricBlob[]): ProductTally<{ title: string; addToCarts: number }>[] {
    const totals = new Map<string, { addToCarts: number; productId?: string }>();
    for (const m of metrics) {
      for (const p of m.byProduct ?? []) {
        if (!p.addToCarts) continue;
        const t = totals.get(p.productTitle) ?? { addToCarts: 0 };
        t.addToCarts += p.addToCarts;
        t.productId ??= p.productId;
        totals.set(p.productTitle, t);
      }
    }
    return Array.from(totals.entries())
      .map(([title, t]) => ({ title, addToCarts: t.addToCarts, productId: t.productId }))
      .sort((a, b) => b.addToCarts - a.addToCarts)
      .slice(0, 5);
  }

  /**
   * The products behind the top lists, with their first image — one query for
   * both lists. By Shopify id where the snapshot kept one, by title otherwise
   * (see `attachProductImages` for how ambiguous titles are handled).
   */
  private async imageCandidates(
    orgId: string,
    rows: Array<{ title: string; productId?: string }>,
  ): Promise<ProductImageCandidate[]> {
    if (rows.length === 0) return [];
    const ids = [...new Set(rows.map((r) => r.productId).filter((id): id is string => !!id))];
    const titles = [...new Set(rows.map((r) => r.title))];
    const products = await this.prisma.product.findMany({
      where: {
        organizationId: orgId,
        deletedAt: null,
        OR: [
          ...(ids.length ? [{ externalId: { in: ids } }] : []),
          { title: { in: titles } },
        ],
      },
      select: {
        externalId: true,
        title: true,
        images: { take: 1, orderBy: { position: 'asc' }, select: { src: true } },
      },
    });
    return products.map((p) => ({
      externalId: p.externalId,
      title: p.title,
      image: p.images[0]?.src ?? null,
    }));
  }

  private buildTrend(
    rows: Array<{ date: Date; metrics: unknown }>,
    days: number,
  ): DashboardTrendPoint[] {
    const byMonth = days > 60;
    const buckets = new Map<string, DashboardTrendPoint>();
    const now = new Date();

    // Pre-populate every bucket with zeros so the chart renders a
    // continuous series even when traffic is sparse.
    if (byMonth) {
      const monthsBack = Math.ceil(days / 30);
      for (let i = monthsBack - 1; i >= 0; i--) {
        const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
        buckets.set(`${d.getUTCFullYear()}-${d.getUTCMonth()}`, {
          label: MONTH_NAMES[d.getUTCMonth()],
          addToCart: 0,
          reachedCheckout: 0,
          completedOrders: 0,
        });
      }
    } else {
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date();
        d.setUTCHours(0, 0, 0, 0);
        d.setUTCDate(d.getUTCDate() - i);
        const key = d.toISOString().slice(0, 10);
        buckets.set(key, {
          label: dayMonthLabel(d),
          addToCart: 0,
          reachedCheckout: 0,
          completedOrders: 0,
        });
      }
    }

    for (const row of rows) {
      const m = (row.metrics ?? {}) as MetricBlob;
      const key = byMonth
        ? `${row.date.getUTCFullYear()}-${row.date.getUTCMonth()}`
        : row.date.toISOString().slice(0, 10);
      const slot = buckets.get(key);
      if (!slot) continue;
      const atc = m.pixelAddToCartSessions ?? m.cartsCreatedFromWebhook ?? 0;
      const chk = m.pixelCheckoutStartedSessions ?? m.checkoutsStartedFromWebhook ?? 0;
      slot.addToCart += atc;
      slot.reachedCheckout += chk;
      slot.completedOrders += m.orders ?? 0;
    }
    return Array.from(buckets.values());
  }

  private empty(channel: AnalyticsChannelFilter): AnalyticsDashboard {
    return {
      stats: [
        { key: 'totalAddToCart', label: 'Total Add to Cart', value: 0, change: 0, changeLabel: '' },
        { key: 'totalCheckout', label: 'Total Checkout', value: 0, change: 0, changeLabel: '' },
        { key: 'totalAbandonedCarts', label: 'Total Abandoned Carts', value: 0, change: 0, changeLabel: '' },
      ],
      topPages: [],
      topViewedProducts: [],
      topAddedToCart: [],
      trend: [],
      meta: { channel, lastRefreshedAt: null },
    };
  }

  private daysAgo(n: number): Date {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() - n);
    return d;
  }

  private changeLabel(days: number): string {
    if (days <= 7) return 'vs last 7 days';
    if (days <= 30) return 'vs last 30 days';
    if (days <= 182) return 'vs last 6 months';
    return 'vs last year';
  }
}
