import { Injectable, Logger } from '@nestjs/common';
import { ChannelPlatform, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ShopifyOAuthService } from './shopify-oauth.service';
import { Priority } from '../rate-limit/rate-limit.types';
import {
  ShopifyAuthContext,
  ShopifyGraphqlClient,
  ShopifyGraphqlError,
} from './shopify-graphql.client';
import {
  SHOPIFYQL_QUERY,
  ShopifyqlQueryResponse,
  ShopifyqlQueryVariables,
  ShopifyqlTableData,
} from './shopify-graphql.types';

/**
 * Normalised metric payload written into `AnalyticsSnapshot.metrics`. Kept
 * channel-agnostic so the same shape can be produced by Phase 2 ingestion
 * sources (Web Pixel events, Instagram Insights, etc.).
 */
export interface NormalisedDailyMetrics {
  date: string; // YYYY-MM-DD
  sessions?: number;
  pageviews?: number;
  uniqueVisitors?: number;
  /// Total per-product views across all products on this day.
  productViews?: number;
  /// Total add-to-cart events across all products on this day.
  addToCarts?: number;
  /// Count of sessions where ≥1 item was added to cart.
  sessionsWithCartAdditions?: number;
  /// Count of sessions that reached checkout.
  reachedCheckoutCount?: number;
  addedToCartRate?: number;
  reachedCheckoutRate?: number;
  conversionRate?: number;
  bounceRate?: number;
  /// Average session duration in seconds.
  avgSessionDuration?: number;
  orders?: number;
  revenue?: number;
  currency?: string;
  byReferrer?: ReferrerBreakdown[];
  /// Per-product breakdown for the entire window — attached to the
  /// most-recent day's snapshot only (avoids per-day duplication).
  byProduct?: ProductBreakdown[];
}

export interface ReferrerBreakdown {
  referrerSource: string;
  sessions?: number;
  orders?: number;
  revenue?: number;
}

export interface ProductBreakdown {
  productTitle: string;
  productViews?: number;
  addToCarts?: number;
  checkouts?: number;
  orders?: number;
}

const SNAPSHOT_SOURCE_SHOPIFY_QL = 'shopify_ql';
const SNAPSHOT_SOURCE_FALLBACK = 'shopify_orders_fb';

/** Diagnostic result returned from a refresh call — surfaced via the API
 * so the analytics page can show what happened without log-diving. */
export interface RefreshResult {
  channelId: string;
  source: 'shopify_ql' | 'shopify_orders_fb';
  snapshotsWritten: number;
  /// Human-readable explanation when `source === 'shopify_orders_fb'`.
  /// Null on the happy path.
  error: string | null;
  errorCode: string | null;
}

/**
 * Pulls Shopify analytics via the `shopifyqlQuery` GraphQL field and writes
 * one `AnalyticsSnapshot` row per day per channel. Falls back to deriving
 * proxy metrics from local `Order` rows when ShopifyQL is unavailable —
 * either because the merchant is on Shopify Basic (HTTP 406 on the
 * `sessions` dataset) or because the `read_reports` scope wasn't granted.
 */
@Injectable()
export class ShopifyAnalyticsService {
  private readonly logger = new Logger(ShopifyAnalyticsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly shopifyOAuth: ShopifyOAuthService,
    private readonly graphql: ShopifyGraphqlClient,
  ) {}

  /**
   * Refresh analytics for a single channel. Idempotent — re-running for the
   * same `daysBack` window upserts the same `(channelId, date, granularity)`
   * keys. Safe to invoke from a scheduled cron, on-demand sync, or test.
   */
  async refreshForChannel(
    channelId: string,
    daysBack = 35,
  ): Promise<RefreshResult> {
    const channel = await this.prisma.channel.findUnique({
      where: { id: channelId },
    });
    if (!channel || channel.platform !== ChannelPlatform.SHOPIFY) {
      this.logger.debug(
        `Skipping analytics refresh for non-Shopify channel ${channelId}`,
      );
      return {
        channelId,
        source: SNAPSHOT_SOURCE_FALLBACK,
        snapshotsWritten: 0,
        error: 'Channel is not a Shopify channel',
        errorCode: 'NOT_SHOPIFY',
      };
    }

    this.logger.log(
      `[analytics] Starting refresh for channel=${channelId} shop=${channel.externalStoreUrl ?? '(unknown)'} window=${daysBack}d`,
    );

    let auth: ShopifyAuthContext | null = null;
    let lastError: string | null = null;
    let lastErrorCode: string | null = null;

    try {
      const creds = await this.shopifyOAuth.getAccessToken(channelId);
      // Cron work: bulk priority, so a merchant's own sync or an order push
      // is never stuck behind the nightly analytics refresh.
      auth = {
        shopDomain: creds.shopDomain,
        accessToken: creds.token,
        channelId,
        priority: Priority.BULK,
      };
      this.logger.log(
        `[analytics] Resolved access token for shop=${creds.shopDomain}`,
      );
    } catch (err) {
      lastError = `Could not resolve Shopify access token: ${err instanceof Error ? err.message : String(err)}`;
      lastErrorCode = 'TOKEN_RESOLVE_FAILED';
      this.logger.warn(
        `[analytics] Could not resolve Shopify token for channel ${channelId}; using order-derived fallback. ${err}`,
      );
    }

    let dailyMetrics: NormalisedDailyMetrics[] = [];
    let source: 'shopify_ql' | 'shopify_orders_fb' = SNAPSHOT_SOURCE_SHOPIFY_QL;

    if (auth) {
      try {
        dailyMetrics = await this.fetchShopifyQlMetrics(
          auth,
          daysBack,
          channel.organizationId,
          channelId,
        );
        this.logger.log(
          `[analytics] ShopifyQL returned ${dailyMetrics.length} daily rows for channel=${channelId}`,
        );
      } catch (err) {
        if (this.shouldFallback(err)) {
          const reason = this.fallbackReason(err);
          lastError = reason || this.errSummary(err);
          lastErrorCode =
            err instanceof ShopifyGraphqlError ? err.code : 'UNKNOWN';
          this.logger.warn(
            `[analytics] ShopifyQL unavailable for channel=${channelId} (${this.errSummary(err)}). ${reason} Falling back to order-derived metrics.`,
          );
          source = SNAPSHOT_SOURCE_FALLBACK;
        } else {
          this.logger.error(
            `[analytics] ShopifyQL failed for channel=${channelId} with non-recoverable error:`,
            err instanceof Error ? err.stack : String(err),
          );
          throw err;
        }
      }
    } else {
      source = SNAPSHOT_SOURCE_FALLBACK;
    }

    if (source === SNAPSHOT_SOURCE_FALLBACK) {
      dailyMetrics = await this.deriveFallbackMetrics(
        channel.organizationId,
        channelId,
        daysBack,
      );
      this.logger.log(
        `[analytics] Fallback path produced ${dailyMetrics.length} daily rows from local Order table for channel=${channelId}`,
      );
    }

    await this.upsertSnapshots(
      channel.organizationId,
      channelId,
      dailyMetrics,
      source,
    );
    this.logger.log(
      `[analytics] Wrote ${dailyMetrics.length} snapshots for channel=${channelId} (source=${source})`,
    );

    return {
      channelId,
      source,
      snapshotsWritten: dailyMetrics.length,
      error: source === SNAPSHOT_SOURCE_FALLBACK ? lastError : null,
      errorCode: source === SNAPSHOT_SOURCE_FALLBACK ? lastErrorCode : null,
    };
  }

  /** Run `refreshForChannel` against every connected Shopify channel. */
  async refreshAll(daysBack = 35): Promise<RefreshResult[]> {
    const channels = await this.prisma.channel.findMany({
      where: { platform: ChannelPlatform.SHOPIFY },
      select: { id: true },
    });
    const results: RefreshResult[] = [];
    for (const channel of channels) {
      try {
        results.push(await this.refreshForChannel(channel.id, daysBack));
      } catch (err) {
        this.logger.error(
          `Analytics refresh failed for channel ${channel.id}`,
          err instanceof Error ? err.stack : String(err),
        );
        results.push({
          channelId: channel.id,
          source: SNAPSHOT_SOURCE_FALLBACK,
          snapshotsWritten: 0,
          error: err instanceof Error ? err.message : String(err),
          errorCode: 'REFRESH_FAILED',
        });
      }
    }
    return results;
  }

  // ─── ShopifyQL path ──────────────────────────────────────────────────────

  private async fetchShopifyQlMetrics(
    auth: ShopifyAuthContext,
    daysBack: number,
    orgId: string,
    channelId: string,
  ): Promise<NormalisedDailyMetrics[]> {
    // Daily query — only columns the `sessions` dataset actually exposes.
    // `orders` lives in the `sales` / `orders` datasets, NOT `sessions`,
    // so we pull order counts + revenue from our local Order table after
    // the ShopifyQL call returns.
    const dailyQuery =
      `FROM sessions ` +
      `SHOW sessions, pageviews, ` +
      `sessions_with_cart_additions, sessions_that_completed_checkout, ` +
      `added_to_cart_rate, reached_checkout_rate, conversion_rate, ` +
      `bounce_rate, average_session_duration ` +
      `GROUP BY day ` +
      `SINCE -${daysBack}d UNTIL today ` +
      `ORDER BY day ASC`;

    // Referrer breakdown over the same window — drives the "Traffic by
    // Channel" panel. One window-level query, attached to the most-recent
    // day's snapshot.
    const referrerQuery =
      `FROM sessions ` +
      `SHOW sessions ` +
      `GROUP BY referrer_source ` +
      `SINCE -${daysBack}d UNTIL today ` +
      `ORDER BY sessions DESC ` +
      `LIMIT 20`;

    this.logger.log(`[analytics] ShopifyQL daily query: ${dailyQuery}`);
    this.logger.log(`[analytics] ShopifyQL referrer query: ${referrerQuery}`);

    // Daily query is the trunk; referrer query is a leaf that may parse-
    // error independently without tanking the whole refresh.
    const [dailyTable, referrerTable] = await Promise.all([
      this.runShopifyQl(auth, dailyQuery),
      this.tryRunShopifyQl(auth, referrerQuery, 'referrer'),
    ]);

    this.logger.log(
      `[analytics] Daily table: columns=[${dailyTable.columns.map((c) => c.name).join(', ')}], rows=${dailyTable.rows.length}`,
    );
    if (referrerTable) {
      this.logger.log(
        `[analytics] Referrer table: columns=[${referrerTable.columns.map((c) => c.name).join(', ')}], rows=${referrerTable.rows.length}`,
      );
    }

    const referrerByDayMap = referrerTable
      ? this.tableToReferrerBreakdown(referrerTable)
      : [];

    const days = this.tableToDailyMetrics(dailyTable);

    // Merge in orders + revenue from local DB, since the `sessions`
    // dataset doesn't expose those columns. The local Order table is
    // already kept in sync by the standard Shopify sync flow.
    await this.mergeLocalOrderTotals(days, orgId, channelId, daysBack);

    if (days.length > 0 && referrerByDayMap.length > 0) {
      // Attach the window-level referrer breakdown to the most recent
      // day so the UI has a single place to read from.
      days[days.length - 1].byReferrer = referrerByDayMap;
    }
    return days;
  }

  /**
   * Fill `orders` + `revenue` on each daily snapshot from the local Order
   * table, AND add entries for days that have orders but no Shopify
   * session data. The Shopify `sessions` dataset (ShopifyQL) only returns
   * rows for days with measurable traffic — so an order placed on a
   * traffic-less day would otherwise be invisible in the trend chart.
   *
   * Mutates `days` in place: existing entries get their `orders`/`revenue`
   * filled; new orders-only days are appended; the array is sorted by date
   * ascending at the end so consumers can treat it as a time series.
   */
  private async mergeLocalOrderTotals(
    days: NormalisedDailyMetrics[],
    orgId: string,
    channelId: string,
    daysBack: number,
  ): Promise<void> {
    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    since.setUTCDate(since.getUTCDate() - daysBack);

    const orders = await this.prisma.order.findMany({
      where: {
        organizationId: orgId,
        channelId,
        deletedAt: null,
        externalCreatedAt: { gte: since },
      },
      select: {
        externalCreatedAt: true,
        createdAt: true,
        totalPrice: true,
        currency: true,
        financialStatus: true,
      },
    });

    const map = new Map<
      string,
      { orders: number; revenue: number; currency: string }
    >();
    for (const order of orders) {
      const date = (order.externalCreatedAt ?? order.createdAt)
        .toISOString()
        .slice(0, 10);
      const slot =
        map.get(date) ?? { orders: 0, revenue: 0, currency: order.currency || 'USD' };
      slot.orders += 1;
      if (
        order.financialStatus === 'PAID' ||
        order.financialStatus === 'PARTIALLY_PAID' ||
        order.financialStatus === 'PARTIALLY_REFUNDED'
      ) {
        slot.revenue += Number(order.totalPrice);
      }
      map.set(date, slot);
    }

    // Fill orders/revenue on the days Shopify already gave us.
    const shopifyDates = new Set(days.map((d) => d.date));
    for (const day of days) {
      const slot = map.get(day.date);
      day.orders = slot?.orders ?? 0;
      day.revenue = slot?.revenue ?? 0;
      if (slot) day.currency = slot.currency;
    }

    // Append days that have local orders but no Shopify session data —
    // otherwise revenue on those days is invisible in the trend chart.
    for (const [date, slot] of map) {
      if (!shopifyDates.has(date)) {
        days.push({
          date,
          orders: slot.orders,
          revenue: slot.revenue,
          currency: slot.currency,
        });
      }
    }

    // Sort ascending by date so downstream consumers can treat the array
    // as a clean time series.
    days.sort((a, b) => a.date.localeCompare(b.date));
  }

  /**
   * Run a non-critical ShopifyQL query (referrer / per-product) with
   * graceful failure. AUTH_FAILED and 406 still propagate — those are
   * account-level issues that should send the whole refresh to fallback —
   * but a parse error on one leaf query just blanks its slice of the
   * analytics page rather than killing the request.
   */
  private async tryRunShopifyQl(
    auth: ShopifyAuthContext,
    shopifyql: string,
    label: string,
  ): Promise<ShopifyqlTableData | null> {
    try {
      return await this.runShopifyQl(auth, shopifyql);
    } catch (err) {
      if (err instanceof ShopifyGraphqlError) {
        if (
          err.code === 'AUTH_FAILED' ||
          (err.code === 'HTTP_ERROR' && err.httpStatus === 406)
        ) {
          throw err;
        }
        this.logger.warn(
          `[analytics] ${label} query failed (${err.code}); proceeding without ${label} data. ${err.message}`,
        );
        return null;
      }
      throw err;
    }
  }

  private async runShopifyQl(
    auth: ShopifyAuthContext,
    shopifyql: string,
  ): Promise<ShopifyqlTableData> {
    const res = await this.graphql.request<
      ShopifyqlQueryResponse,
      ShopifyqlQueryVariables
    >(auth, SHOPIFYQL_QUERY, { shopifyql });

    const payload = res.shopifyqlQuery;
    if (payload.parseErrors && payload.parseErrors.length > 0) {
      this.logger.error(
        `[analytics] ShopifyQL rejected the query: ${payload.parseErrors.join(' | ')} (query was: ${shopifyql})`,
      );
      throw new ShopifyGraphqlError(
        `ShopifyQL parse error: ${payload.parseErrors.join('; ')}`,
        'GRAPHQL_ERROR',
        payload.parseErrors,
      );
    }
    if (!payload.tableData) {
      this.logger.warn(
        `[analytics] ShopifyQL returned no tableData and no parseErrors for query: ${shopifyql}`,
      );
      throw new ShopifyGraphqlError(
        'ShopifyQL returned no tableData and no parseErrors',
        'EMPTY_RESPONSE',
        payload,
      );
    }
    return payload.tableData;
  }

  private tableToDailyMetrics(
    table: ShopifyqlTableData,
  ): NormalisedDailyMetrics[] {
    const columnIndex = this.indexColumns(table.columns);
    return table.rows.map((row) => {
      const date = this.coerceDate(row[columnIndex['day']]);
      return {
        date,
        sessions: this.coerceNumber(row[columnIndex['sessions']]),
        pageviews: this.coerceNumber(row[columnIndex['pageviews']]),
        // Direct counts from Shopify (no longer derived from rates).
        sessionsWithCartAdditions: this.coerceNumber(
          row[columnIndex['sessions_with_cart_additions']],
        ),
        reachedCheckoutCount: this.coerceNumber(
          row[columnIndex['sessions_that_completed_checkout']],
        ),
        addedToCartRate: this.coerceNumber(
          row[columnIndex['added_to_cart_rate']],
        ),
        reachedCheckoutRate: this.coerceNumber(
          row[columnIndex['reached_checkout_rate']],
        ),
        conversionRate: this.coerceNumber(row[columnIndex['conversion_rate']]),
        bounceRate: this.coerceNumber(row[columnIndex['bounce_rate']]),
        avgSessionDuration: this.coerceNumber(
          row[columnIndex['average_session_duration']],
        ),
        // `orders` and `revenue` are filled in by `mergeLocalOrderTotals`
        // after this method returns — the `sessions` dataset doesn't
        // expose those columns.
      };
    });
  }

  // NOTE: per-product visit / add-to-cart breakdown ISN'T available from
  // the `sessions` dataset (no `product_title` dimension, no `product_views`
  // / `add_to_carts` columns). Shopify exposes those only via a Web Pixel
  // app extension (Phase 2). Until that ships, `byProduct` stays empty and
  // the UI renders the "Available via Web Pixel" empty state.

  private tableToReferrerBreakdown(
    table: ShopifyqlTableData,
  ): ReferrerBreakdown[] {
    const columnIndex = this.indexColumns(table.columns);
    return table.rows
      .map((row) => ({
        referrerSource: String(row[columnIndex['referrer_source']] ?? 'Unknown'),
        sessions: this.coerceNumber(row[columnIndex['sessions']]),
      }))
      .filter((r) => r.referrerSource && r.referrerSource !== 'null');
  }

  // ─── Fallback path (order-derived) ───────────────────────────────────────

  /**
   * Derive a coarse approximation of the funnel metrics from the local
   * `Order` table. Sessions / pageviews / add-to-cart-rate are unknowable
   * without a tracking pixel, so we leave them undefined — the UI shows an
   * empty state for those panels and renders the order-derived numbers for
   * the panels that can be computed.
   */
  private async deriveFallbackMetrics(
    organizationId: string,
    channelId: string,
    daysBack: number,
  ): Promise<NormalisedDailyMetrics[]> {
    const since = this.daysAgo(daysBack);
    const orders = await this.prisma.order.findMany({
      where: {
        organizationId,
        channelId,
        deletedAt: null,
        externalCreatedAt: { gte: since },
      },
      select: {
        externalCreatedAt: true,
        createdAt: true,
        totalPrice: true,
        currency: true,
        financialStatus: true,
      },
    });

    const dayMap = new Map<
      string,
      { orders: number; revenue: number; currency: string }
    >();
    for (const order of orders) {
      const date = this.toIsoDate(order.externalCreatedAt ?? order.createdAt);
      const slot =
        dayMap.get(date) ??
        { orders: 0, revenue: 0, currency: order.currency || 'USD' };
      slot.orders += 1;
      if (
        order.financialStatus === 'PAID' ||
        order.financialStatus === 'PARTIALLY_PAID' ||
        order.financialStatus === 'PARTIALLY_REFUNDED'
      ) {
        slot.revenue += Number(order.totalPrice);
      }
      dayMap.set(date, slot);
    }

    const days: NormalisedDailyMetrics[] = [];
    for (let i = daysBack - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = this.toIsoDate(d);
      const slot = dayMap.get(key);
      days.push({
        date: key,
        orders: slot?.orders ?? 0,
        revenue: slot?.revenue ?? 0,
        currency: slot?.currency ?? 'USD',
      });
    }
    return days;
  }

  // ─── Persistence ─────────────────────────────────────────────────────────

  private async upsertSnapshots(
    organizationId: string,
    channelId: string,
    days: NormalisedDailyMetrics[],
    source: string,
  ): Promise<void> {
    for (const day of days) {
      const date = new Date(`${day.date}T00:00:00.000Z`);
      const metrics = this.stripUndefined(day);
      await this.prisma.analyticsSnapshot.upsert({
        where: {
          channelId_date_granularity: {
            channelId,
            date,
            granularity: 'DAILY',
          },
        },
        create: {
          organizationId,
          channelId,
          date,
          granularity: 'DAILY',
          source,
          metrics: metrics as Prisma.InputJsonValue,
        },
        update: {
          source,
          metrics: metrics as Prisma.InputJsonValue,
        },
      });
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private shouldFallback(err: unknown): boolean {
    if (!(err instanceof ShopifyGraphqlError)) return false;
    // 406 = ShopifyQL Analytics API blocked on this plan (Basic / Starter).
    // AUTH_FAILED can also surface when `read_reports` wasn't granted — fall
    // back rather than failing the whole sync, but log clearly so the
    // operator can prompt the merchant to reconnect.
    if (err.code === 'HTTP_ERROR' && err.httpStatus === 406) return true;
    if (err.code === 'AUTH_FAILED') return true;
    // GraphQL field-not-accessible — happens when the token's scopes don't
    // include `read_reports`. Shopify returns 200 with a GRAPHQL_ERROR in
    // the envelope rather than 401/403.
    if (
      err.code === 'GRAPHQL_ERROR' &&
      typeof err.message === 'string' &&
      /access denied|read_reports|access scope/i.test(err.message)
    ) {
      return true;
    }
    return false;
  }

  private fallbackReason(err: unknown): string {
    if (!(err instanceof ShopifyGraphqlError)) return '';
    if (err.code === 'HTTP_ERROR' && err.httpStatus === 406) {
      return 'Likely cause: store is on Shopify Basic/Starter — the sessions dataset requires Advanced or Plus.';
    }
    if (err.code === 'AUTH_FAILED') {
      return "Likely cause: the access token doesn't have the `read_reports` scope. Disconnect and reconnect the Shopify channel so the merchant re-grants permissions.";
    }
    if (err.code === 'GRAPHQL_ERROR') {
      return `Likely cause: missing scope or invalid query. Raw message: ${err.message}`;
    }
    return '';
  }

  private errSummary(err: unknown): string {
    if (err instanceof ShopifyGraphqlError) {
      return `${err.code}${err.httpStatus ? ` ${err.httpStatus}` : ''}: ${err.message}`;
    }
    return err instanceof Error ? err.message : String(err);
  }

  private indexColumns(
    columns: ShopifyqlTableData['columns'],
  ): Record<string, number> {
    const idx: Record<string, number> = {};
    columns.forEach((col, i) => {
      idx[col.name] = i;
    });
    return idx;
  }

  private coerceNumber(
    value: string | number | boolean | null | undefined,
  ): number | undefined {
    if (value === null || value === undefined || typeof value === 'boolean') {
      return undefined;
    }
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : undefined;
  }

  private coerceDate(
    value: string | number | boolean | null | undefined,
  ): string {
    if (!value) return this.toIsoDate(new Date());
    const d = new Date(String(value));
    return Number.isNaN(d.getTime()) ? String(value).slice(0, 10) : this.toIsoDate(d);
  }

  private toIsoDate(d: Date): string {
    return d.toISOString().slice(0, 10);
  }

  private daysAgo(n: number): Date {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() - n);
    return d;
  }

  private stripUndefined<T extends object>(obj: T): Partial<T> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (value !== undefined) result[key] = value;
    }
    return result as Partial<T>;
  }
}
