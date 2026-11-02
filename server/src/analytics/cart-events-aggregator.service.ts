import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { rememberProductId } from './product-image-match.util';

/// Latest cart / checkout snapshot we've seen for a given session token.
/// Used to dedupe noisy `carts/update` events (Shopify fires one on every
/// quantity change). Per-day, per-token granularity.
interface SessionSnapshot {
  cartToken: string;
  lineItems: Array<{
    product_id?: number | string;
    title?: string;
    quantity?: number;
  }>;
}

interface AggregatedDay {
  channelId: string;
  organizationId: string;
  date: string;
  cartsCreated: Map<string, SessionSnapshot>;
  checkoutsStarted: Map<string, SessionSnapshot>;
  /// Distinct order tokens seen via `orders/create` webhook on this day.
  /// Used for `ordersFromWebhook` count — keeps the checkout→order rate
  /// math consistent with the cart→checkout rate (both sides webhook-
  /// sourced and post-registration).
  ordersPlaced: Set<string>;
}

/**
 * Rolls up cart + checkout webhook events into per-product breakdowns on
 * `AnalyticsSnapshot.metrics.byProduct`. Runs hourly; can also be invoked
 * on-demand from the analytics refresh endpoint.
 *
 * Dedup strategy: cart webhooks fire many times per shopper session
 * (every quantity change, address fill-in, etc.). We collapse by
 * `cart_token` (or `checkout_token`) per day, keeping the LATEST snapshot
 * — that snapshot's `line_items` is the authoritative "what was in this
 * cart at the end of the day" view. Then for each unique cart we count
 * each contained product once (i.e. "carts that contained product X").
 */
@Injectable()
export class CartEventsAggregator {
  private readonly logger = new Logger(CartEventsAggregator.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_HOUR)
  async runHourly(): Promise<void> {
    this.logger.log('[cart-agg] Running hourly cart/checkout aggregation');
    const since = new Date(Date.now() - 60 * 60 * 1000);
    await this.rollup(since);
  }

  /// Replay the last 24h of cart + checkout events into the day-level
  /// snapshots. Idempotent — re-running for the same window overwrites
  /// the same `byProduct` entries. The Refresh button names its own
  /// workspace; only the hourly cron runs across every workspace.
  async rollupRecentDay(organizationId: string): Promise<void> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await this.rollup(since, organizationId);
  }

  async rollup(since: Date, organizationId?: string): Promise<void> {
    const events = await this.prisma.rawAnalyticsEvent.findMany({
      where: {
        ...(organizationId && { organizationId }),
        occurredAt: { gte: since },
        eventName: {
          in: [
            'carts_create',
            'carts_update',
            'checkouts_create',
            'checkouts_update',
            'orders_create',
          ],
        },
      },
      orderBy: { occurredAt: 'asc' },
      select: {
        organizationId: true,
        channelId: true,
        occurredAt: true,
        eventName: true,
        sessionId: true,
        payload: true,
      },
    });

    if (events.length === 0) {
      this.logger.log('[cart-agg] No cart/checkout events in window');
      return;
    }

    // Group by (channel, date), then deduplicate by session token within
    // each bucket. Iteration order is `occurredAt ASC` so later writes
    // overwrite earlier ones — we end up with the LATEST snapshot per
    // (token, day).
    const buckets = new Map<string, AggregatedDay>();
    for (const evt of events) {
      if (!evt.sessionId) continue;
      const date = evt.occurredAt.toISOString().slice(0, 10);
      const key = `${evt.channelId}:${date}`;
      const slot =
        buckets.get(key) ?? {
          channelId: evt.channelId,
          organizationId: evt.organizationId,
          date,
          cartsCreated: new Map(),
          checkoutsStarted: new Map(),
          ordersPlaced: new Set(),
        };

      // Order webhooks don't have line items at the cart level we care
      // about — for ordersPlaced we just need a distinct count.
      if (evt.eventName === 'orders_create') {
        slot.ordersPlaced.add(evt.sessionId);
        buckets.set(key, slot);
        continue;
      }

      const lineItems = this.extractLineItems(
        evt.payload as Record<string, unknown>,
      );
      if (lineItems.length === 0) {
        buckets.set(key, slot);
        continue;
      }
      const snapshot: SessionSnapshot = {
        cartToken: evt.sessionId,
        lineItems,
      };
      if (evt.eventName.startsWith('carts')) {
        slot.cartsCreated.set(evt.sessionId, snapshot);
      } else {
        slot.checkoutsStarted.set(evt.sessionId, snapshot);
      }
      buckets.set(key, slot);
    }

    for (const bucket of buckets.values()) {
      await this.upsertSnapshot(bucket);
    }
    this.logger.log(
      `[cart-agg] Rolled up ${events.length} events into ${buckets.size} snapshot row(s)`,
    );
  }

  private extractLineItems(
    payload: Record<string, unknown>,
  ): Array<{ product_id?: number | string; title?: string; quantity?: number }> {
    const raw = (payload as { line_items?: unknown }).line_items;
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((li): li is Record<string, unknown> => !!li && typeof li === 'object')
      .map((li) => ({
        product_id: li.product_id as number | string | undefined,
        title:
          (li.title as string | undefined) ??
          (li.product_title as string | undefined) ??
          (li.name as string | undefined),
        quantity: typeof li.quantity === 'number' ? li.quantity : 1,
      }))
      .filter((li) => !!li.title);
  }

  private async upsertSnapshot(bucket: AggregatedDay): Promise<void> {
    // Count carts per product title (one cart counts once per product
    // regardless of quantity — "carts that contained product X today").
    const cartCountByTitle = new Map<string, number>();
    for (const snap of bucket.cartsCreated.values()) {
      const seenInThisCart = new Set<string>();
      for (const li of snap.lineItems) {
        if (!li.title || seenInThisCart.has(li.title)) continue;
        seenInThisCart.add(li.title);
        cartCountByTitle.set(li.title, (cartCountByTitle.get(li.title) ?? 0) + 1);
      }
    }

    // Same for checkouts.
    const checkoutCountByTitle = new Map<string, number>();
    for (const snap of bucket.checkoutsStarted.values()) {
      const seen = new Set<string>();
      for (const li of snap.lineItems) {
        if (!li.title || seen.has(li.title)) continue;
        seen.add(li.title);
        checkoutCountByTitle.set(
          li.title,
          (checkoutCountByTitle.get(li.title) ?? 0) + 1,
        );
      }
    }

    // Shopify product id per title, kept so the Analytics page can show its image.
    const productIdByTitle = new Map<string, string>();
    for (const snap of [...bucket.cartsCreated.values(), ...bucket.checkoutsStarted.values()]) {
      for (const li of snap.lineItems) {
        if (li.title) rememberProductId(productIdByTitle, li.title, li.product_id);
      }
    }

    const date = new Date(`${bucket.date}T00:00:00.000Z`);
    const existing = await this.prisma.analyticsSnapshot.findUnique({
      where: {
        channelId_date_granularity: {
          channelId: bucket.channelId,
          date,
          granularity: 'DAILY',
        },
      },
    });
    const existingMetrics =
      (existing?.metrics as Record<string, unknown> | null) ?? {};

    // Merge into the existing byProduct array (which may have been
    // populated by another source). We OVERWRITE the addToCarts +
    // checkouts numbers for products we have webhook data for, because
    // this aggregator is the authoritative source for those numbers.
    const mergedByProduct = this.mergeProductBreakdown(
      (existingMetrics.byProduct as
        | Array<{
            productTitle: string;
            productId?: string;
            productViews?: number;
            addToCarts?: number;
            checkouts?: number;
            orders?: number;
          }>
        | undefined) ?? [],
      cartCountByTitle,
      checkoutCountByTitle,
      productIdByTitle,
    );

    const nextMetrics = {
      ...existingMetrics,
      byProduct: mergedByProduct,
      // Top-line counts for the funnel widget. These complement (not
      // replace) the ShopifyQL `sessions_with_cart_additions` /
      // `sessions_that_completed_checkout` columns — when both are
      // available the ShopifyQL ones win because they cover all
      // sessions, not just ones we have webhooks for.
      cartsCreatedFromWebhook: bucket.cartsCreated.size,
      checkoutsStartedFromWebhook: bucket.checkoutsStarted.size,
      // Distinct order count from `orders/create` webhooks today. Used
      // as the numerator for `checkoutToOrderRate` when we're in
      // webhook-source mode (consistent with the checkout denominator).
      ordersFromWebhook: bucket.ordersPlaced.size,
    };

    await this.prisma.analyticsSnapshot.upsert({
      where: {
        channelId_date_granularity: {
          channelId: bucket.channelId,
          date,
          granularity: 'DAILY',
        },
      },
      create: {
        organizationId: bucket.organizationId,
        channelId: bucket.channelId,
        date,
        granularity: 'DAILY',
        source: 'shopify_webhook',
        metrics: nextMetrics as Prisma.InputJsonValue,
      },
      update: {
        // Don't clobber the source if it was set by another writer.
        source: existing?.source ?? 'shopify_webhook',
        metrics: nextMetrics as Prisma.InputJsonValue,
      },
    });
  }

  private mergeProductBreakdown(
    existing: Array<{
      productTitle: string;
      productId?: string;
      productViews?: number;
      addToCarts?: number;
      checkouts?: number;
      orders?: number;
    }>,
    cartCountByTitle: Map<string, number>,
    checkoutCountByTitle: Map<string, number>,
    productIdByTitle: Map<string, string>,
  ): Array<{
    productTitle: string;
    productId?: string;
    productViews: number;
    addToCarts: number;
    checkouts: number;
    orders: number;
  }> {
    const merged = new Map<
      string,
      { productId?: string; productViews: number; addToCarts: number; checkouts: number; orders: number }
    >();
    for (const row of existing) {
      merged.set(row.productTitle, {
        productId: row.productId,
        productViews: row.productViews ?? 0,
        addToCarts: row.addToCarts ?? 0,
        checkouts: row.checkouts ?? 0,
        orders: row.orders ?? 0,
      });
    }
    for (const [title, n] of cartCountByTitle) {
      const slot =
        merged.get(title) ?? {
          productViews: 0,
          addToCarts: 0,
          checkouts: 0,
          orders: 0,
        };
      // Webhook count is authoritative — overwrite, don't accumulate
      // (we rebuilt today's count from scratch).
      slot.addToCarts = n;
      merged.set(title, slot);
    }
    for (const [title, n] of checkoutCountByTitle) {
      const slot =
        merged.get(title) ?? {
          productViews: 0,
          addToCarts: 0,
          checkouts: 0,
          orders: 0,
        };
      slot.checkouts = n;
      merged.set(title, slot);
    }
    for (const [title, id] of productIdByTitle) {
      const slot = merged.get(title);
      if (slot && !slot.productId) slot.productId = id;
    }
    return Array.from(merged.entries()).map(([productTitle, v]) => ({
      productTitle,
      ...(v.productId && { productId: v.productId }),
      productViews: v.productViews,
      addToCarts: v.addToCarts,
      checkouts: v.checkouts,
      orders: v.orders,
    }));
  }
}
