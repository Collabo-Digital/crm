import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  QueryDashboardDto,
  rangeToWindow,
  windowStart,
} from './dto/query-dashboard.dto';
import { Prisma } from '@prisma/client';
import { Parser } from 'json2csv';
import {
  SALES_FINANCIAL_STATUSES,
  placedBetween,
  salesOrderWhere,
} from '../common/utils/order-window.util';
import {
  computeBucket,
  emptyBucket,
  round2,
  totalsOf,
  type ProfitBucket,
  type SalesProfitRow,
} from './profit.util';

/** The window every figure on the dashboard is reported over. */
interface Window {
  from: Date;
  /** Exclusive. */
  to: Date;
  unit: 'day' | 'month';
  label: string;
  timezone: string;
  /**
   * The organisation's reporting currency — what every money figure in the
   * response has been converted into, using each order's own stored rate.
   */
  currency: string;
}

export interface SalesProfitPoint extends ProfitBucket {
  /** Axis label — "Jan" for monthly buckets, "3 Sep" for daily ones. */
  bucket: string;
  /** "2026-01" / "2026-01-03". Bucket LABELS collide; this is the real key. */
  bucketKey: string;
  newCustomers: number;
}

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) { }

  async getOverview(orgId: string, query: QueryDashboardDto) {
    const window = await this.resolveWindow(orgId, query);

    const orderWhere: Prisma.OrderWhereInput = {
      organizationId: orgId,
      deletedAt: null,
      ...(query.channelId && { channelId: query.channelId }),
      ...placedBetween(window.from, window.to),
    };

    const baseProductWhere: Prisma.ProductWhereInput = {
      organizationId: orgId,
      deletedAt: null,
      ...(query.channelId && { channelId: query.channelId }),
    };

    // Run all queries in parallel for speed
    const [
      totalSales,
      totalOrders,
      ordersByStatus,
      totalProducts,
      totalInventory,
      topSellingProducts,
      recentOrders,
      totalCustomers,
      lowStockProducts,
    ] = await Promise.all([
      // 1. Total sales over the window. NOTE: the dashboard CARD no longer
      //    reads this — it reads `totals.grossSales` off /monthly-sales, so the
      //    headline figure and the chart beside it are literally the same
      //    number and cannot drift apart again. This one survives for the
      //    JSON/CSV export summary.
      this.prisma.order.aggregate({
        where: salesOrderWhere({
          orgId,
          channelId: query.channelId,
          from: window.from,
          to: window.to,
        }),
        _sum: { totalPrice: true },
      }),

      // 2. Total orders count
      this.prisma.order.count({ where: orderWhere }),

      // 3. Orders grouped by fulfillment status
      this.prisma.order.groupBy({
        by: ['fulfillmentStatus'],
        where: orderWhere,
        _count: true,
      }),

      // 4. Total active products count
      this.prisma.product.count({
        where: { ...baseProductWhere, status: 'ACTIVE' },
      }),

      // 5. Total inventory (sum of all variant stock)
      this.prisma.productVariant.aggregate({
        where: {
          product: baseProductWhere,
        },
        _sum: { inventoryQuantity: true },
      }),

      // 6. Top 5 selling products (by total quantity sold)
      this.getTopSellingProducts(orgId, query, window, 5),

      // 7. Recent 5 orders — deliberately NOT windowed. "Recent" means the last
      //    five, whatever the selected period is; an empty panel on a quiet
      //    week is not useful.
      this.prisma.order.findMany({
        where: {
          organizationId: orgId,
          deletedAt: null,
          ...(query.channelId && { channelId: query.channelId }),
        },
        include: {
          customer: {
            select: { id: true, firstName: true, lastName: true, email: true },
          },
          channel: { select: { id: true, platform: true, name: true } },
          _count: { select: { lineItems: true } },
        },
        orderBy: { externalCreatedAt: 'desc' },
        take: 5,
      }),

      // 8. Customers first seen inside the window. `externalCreatedAt` is null
      //    for CRM-native customers, so the OR is what stops offline signups
      //    from vanishing — same reason the order filters use `placedBetween`.
      this.prisma.customer.count({
        where: {
          organizationId: orgId,
          deletedAt: null,
          ...(query.channelId && { channelId: query.channelId }),
          OR: [
            { externalCreatedAt: { gte: window.from, lt: window.to } },
            {
              externalCreatedAt: null,
              createdAt: { gte: window.from, lt: window.to },
            },
          ],
        },
      }),

      // 9. Top 5 low-stock products (stock > 0 and <= org threshold)
      this.getLowStockProducts(orgId, query.channelId, 5),
    ]);

    // Format fulfillment status breakdown
    const fulfillmentBreakdown: Record<string, number> = {};
    for (const group of ordersByStatus) {
      fulfillmentBreakdown[group.fulfillmentStatus] = group._count;
    }

    return {
      period: this.describe(window),

      // Sales overview
      totalSales: totalSales._sum.totalPrice ?? 0,
      totalOrders,
      totalCustomers,

      // Product overview
      totalProducts,
      totalInventory: totalInventory._sum.inventoryQuantity ?? 0,

      // Order status breakdown
      fulfillmentBreakdown: {
        unfulfilled: fulfillmentBreakdown['UNFULFILLED'] ?? 0,
        fulfilled: fulfillmentBreakdown['FULFILLED'] ?? 0,
        partial: fulfillmentBreakdown['PARTIAL'] ?? 0,
        restocked: fulfillmentBreakdown['RESTOCKED'] ?? 0,
      },

      // Top 5 selling products
      topSellingProducts,

      // Top 5 low-stock products
      lowStockProducts,

      // Recent 5 orders
      recentOrders: recentOrders.map((order) => ({
        id: order.id,
        orderNumber: order.orderNumber,
        name: order.name,
        totalPrice: order.totalPrice,
        currency: order.currency,
        financialStatus: order.financialStatus,
        fulfillmentStatus: order.fulfillmentStatus,
        customer: order.customer,
        channel: order.channel,
        itemCount: order._count.lineItems,
        createdAt: order.externalCreatedAt || order.createdAt,
      })),
    };
  }



  async getReportData(orgId: string, query: QueryDashboardDto) {
    const baseWhere: Prisma.OrderWhereInput = {
      organizationId: orgId,
      deletedAt: null,
      ...(query.channelId && { channelId: query.channelId }),
      ...(query.dateFrom || query.dateTo ? {
        externalCreatedAt: {
          ...(query.dateFrom && { gte: new Date(query.dateFrom) }),
          ...(query.dateTo && { lte: new Date(query.dateTo) }),
        },
      } : {}),
    };

    const orders = await this.prisma.order.findMany({
      where: baseWhere,
      include: {
        customer: { select: { firstName: true, lastName: true, email: true } },
        lineItems: { select: { title: true, quantity: true, price: true } },
        channel: { select: { name: true } },
      },
      orderBy: { externalCreatedAt: 'desc' },
    });

    return orders.map((o) => ({
      orderNumber: o.orderNumber,
      name: o.name,
      date: o.externalCreatedAt?.toISOString() || o.createdAt.toISOString(),
      customer: o.customer ? `${o.customer.firstName || ''} ${o.customer.lastName || ''}`.trim() : 'Guest',
      email: o.customer?.email || '',
      channel: o.channel?.name || '',
      items: o.lineItems.map((li) => `${li.title} x${li.quantity}`).join('; '),
      itemCount: o.lineItems.length,
      subtotal: o.subtotalPrice.toString(),
      tax: o.totalTax.toString(),
      shipping: o.totalShippingPrice.toString(),
      discounts: o.totalDiscounts.toString(),
      total: o.totalPrice.toString(),
      currency: o.currency,
      financialStatus: o.financialStatus,
      fulfillmentStatus: o.fulfillmentStatus,
    }));
  }

  generateCsv(data: any[]): string {
    const fields = [
      'orderNumber', 'name', 'date', 'customer', 'email', 'channel',
      'items', 'itemCount', 'subtotal', 'tax', 'shipping', 'discounts',
      'total', 'currency', 'financialStatus', 'fulfillmentStatus',
    ];
    const parser = new Parser({ fields });
    return parser.parse(data);
  }

  // ─── SALES & GROSS PROFIT (feeds the stat cards AND the bar chart) ───
  //
  // One query behind both. The card used to read an ALL-TIME _sum(totalPrice)
  // from /dashboard while the chart read a hard-coded rolling 12 months from
  // here, so "Total Sales" and "Total Revenue" sat side by side describing
  // different populations — before you even reach the fact that the old
  // `profit` was `totalPrice − shipping − discounts`, which contains no cost of
  // goods, double-counts discounts (totalPrice is already net of them), treats
  // shipping CHARGED as a cost, and books collected tax as profit. For an
  // offline order (shipping and discounts are always 0) it reduced to
  // profit === revenue exactly, which is why the two bars were the same height.
  //
  // Now: gross profit = net sales (post-discount, pre-tax, pre-shipping, net of
  // refunds) − COGS, reported only over the lines whose variant has a known
  // cost, with that coverage published so the figure is never quietly
  // understated by omission.
  async getSalesAndProfit(orgId: string, query: QueryDashboardDto) {
    const window = await this.resolveWindow(orgId, query);
    const previous = this.precedingWindow(window);

    const [rows, customerRows, previousRows, currencyRows, unconvertedOrders] = await Promise.all([
      this.fetchProfitRows(orgId, window, query.channelId),
      this.fetchNewCustomerRows(orgId, window, query.channelId),
      // The trend compares this window against the one immediately before it,
      // matching "vs previous period" everywhere else in the app. The old badge
      // was pinned to 30-vs-30 days regardless of what the chart beside it
      // actually covered.
      this.fetchProfitRows(orgId, previous, query.channelId),
      // What the money above was made of, before conversion. Same window and
      // same filter as the CTE — via the shared `salesOrderWhere` — so this is
      // the same set of orders, just not yet converted. Shown as supporting
      // detail under the converted headline ("of which $10,323.70").
      this.prisma.order.groupBy({
        by: ['currency'],
        where: salesOrderWhere({
          orgId,
          channelId: query.channelId,
          from: window.from,
          to: window.to,
        }),
        _sum: { totalPrice: true },
        _count: { _all: true },
      }),
      // Orders the CTE had to leave out because their rate never resolved.
      // Counted and surfaced rather than dropped silently — a total quietly
      // missing three orders is worse than one that says so.
      this.prisma.order.count({
        where: {
          ...salesOrderWhere({
            orgId,
            channelId: query.channelId,
            from: window.from,
            to: window.to,
          }),
          exchangeRate: null,
        },
      }),
    ]);

    const newCustomersByBucket = new Map(
      customerRows.map((r) => [this.bucketKey(r.bucket, window.unit), Number(r.count)]),
    );

    const data: SalesProfitPoint[] = rows.map((row) => {
      const key = this.bucketKey(row.bucket, window.unit);
      return {
        ...computeBucket(row),
        bucket: this.bucketLabel(row.bucket, window.unit),
        bucketKey: key,
        newCustomers: newCustomersByBucket.get(key) ?? 0,
      };
    });

    const totals = totalsOf(data.length ? data : [emptyBucket()]);
    const previousTotals = totalsOf(
      previousRows.length ? previousRows.map(computeBucket) : [emptyBucket()],
    );

    return {
      period: this.describe(window),
      data,
      totals: {
        ...totals,
        newCustomers: data.reduce((s, d) => s + d.newCustomers, 0),
        // Every money figure above is now in this currency, converted at each
        // order's own stored rate. Stated explicitly so a client never has to
        // assume which currency it is formatting.
        currency: window.currency,
        // The pre-conversion make-up of that figure, biggest first. Supporting
        // detail only — the headline is the converted total.
        salesByCurrency: currencyRows
          .map((r) => ({
            currency: r.currency,
            amount: round2(Number(r._sum.totalPrice ?? 0)),
            orders: r._count._all,
          }))
          .sort((a, b) => b.amount - a.amount),
        // >0 means the totals above exclude this many orders whose rate could
        // not be resolved. The UI says so rather than showing a quiet undercount.
        unconvertedOrders,
      },
      // Null rather than a zero trend when there is no profit to trend.
      profitTrend:
        totals.grossProfit === null
          ? null
          : {
            current: totals.grossProfit,
            previous: previousTotals.grossProfit ?? 0,
            change: this.calcChange(
              totals.grossProfit,
              previousTotals.grossProfit ?? 0,
            ),
          },
    };
  }

  /**
   * The whole aggregate, in one round trip.
   *
   * Raw SQL rather than `orderLineItem.findMany({ include: { variant } })`
   * because the latter ships every sold line to Node to produce at most a few
   * dozen numbers, and because summing money as float64 across tens of
   * thousands of rows accumulates error a profit line should not carry — here
   * it stays NUMERIC until one ROUND per bucket.
   *
   * If this ever gets slow, the daily `AnalyticsSnapshot` rows and their
   * scheduler already exist; adding these sums to that blob and reading buckets
   * from it is the escape hatch, not a bigger query.
   */
  private async fetchProfitRows(
    orgId: string,
    window: Window,
    channelId?: string,
  ): Promise<SalesProfitRow[]> {
    const channelFilter = channelId
      ? Prisma.sql`AND o."channel_id" = ${channelId}`
      : Prisma.empty;

    const tz = window.timezone;
    const unit = window.unit;
    const step = unit === 'day' ? '1 day' : '1 month';

    return this.prisma.$queryRaw<SalesProfitRow[]>`
      WITH scoped AS (
        SELECT
          o."id",
          date_trunc(
            ${unit},
            COALESCE(o."external_created_at", o."created_at")
              AT TIME ZONE 'UTC' AT TIME ZONE ${tz}
          ) AS bucket,
          -- Every money column is converted into the ORG's currency using the
          -- rate stored on the order itself, captured at the order's own date.
          -- Without this the sums added currencies together: an INR workspace
          -- with a USD store reported ₹1,911.50 + $10,323.70 as "₹12,235.20".
          -- "exchange_rate" is 1 for orders already in the org currency, and
          -- orders where it is still NULL are excluded by the WHERE below
          -- rather than defaulted — 1 is a real and very wrong answer.
          o."exchange_rate"                             AS fx,
          o."total_price"          * o."exchange_rate"  AS gross_sales,
          o."total_tax"            * o."exchange_rate"  AS tax,
          o."total_shipping_price" * o."exchange_rate"  AS shipping,
          -- subtotal_price is already post-discount and pre-shipping on both
          -- write paths (Shopify's own subtotal_price; the manual order
          -- builder's subtotal), which is what makes it the one revenue basis
          -- both order sources agree on. When the channel prices tax-inclusive
          -- it also carries tax, so take that back out — less the SHIPPING tax,
          -- which subtotal_price never contained. A null taxes_included means
          -- the channel never told us; treat it as exclusive, matching the
          -- manual-order convention.
          (o."subtotal_price" - CASE
            WHEN o."taxes_included" IS TRUE
            THEN GREATEST(o."total_tax" - COALESCE(o."channel_shipping_tax_amount", 0), 0)
            ELSE 0
          END) * o."exchange_rate" AS net_sales_gross
        FROM "orders" o
        WHERE o."organization_id" = ${orgId}
          AND o."deleted_at"   IS NULL
          AND o."cancelled_at" IS NULL
          -- An order with no resolved rate cannot be added to a converted
          -- total. It is counted separately and surfaced to the user rather
          -- than dropped silently — see unconvertedOrders.
          AND o."exchange_rate" IS NOT NULL
          AND o."financial_status"::text IN (${Prisma.join(SALES_FINANCIAL_STATUSES)})
          AND COALESCE(o."external_created_at", o."created_at") >= ${window.from}::timestamptz AT TIME ZONE 'UTC'
          AND COALESCE(o."external_created_at", o."created_at") <  ${window.to}::timestamptz AT TIME ZONE 'UTC'
          ${channelFilter}
      ),
      -- Lines and refunds are aggregated in SEPARATE CTEs on purpose: joining
      -- both onto scoped in one pass produces their cross product and
      -- silently multiplies each sum by the other's row count.
      sales AS (
        SELECT bucket,
               SUM(gross_sales)     AS gross_sales,
               SUM(tax)             AS tax,
               SUM(shipping)        AS shipping,
               SUM(net_sales_gross) AS net_sales_gross,
               COUNT(*)             AS orders
        FROM scoped GROUP BY bucket
      ),
      lines AS (
        -- Line amounts are denominated in their ORDER's currency, so they take
        -- that order's rate (s.fx) — not one rate for the whole bucket, which
        -- would be wrong the moment a bucket holds two currencies.
        --
        -- pv."cost" is assumed to be in the same currency as the order that
        -- sold it. Nothing on ProductVariant records a currency (there is no
        -- such field on Product, Variant or Channel), so this is the closest
        -- defensible reading: catalogue and order come from the same store.
        SELECT s.bucket,
               SUM((li."price" * li."quantity" - li."total_discount") * s.fx) AS line_net,
               -- A line whose variant is gone (variant_id is SET NULL on
               -- delete) or whose variant has no cost must LOWER COVERAGE, not
               -- contribute cost-free profit. The LEFT JOIN leaves pv."cost"
               -- null and both branches fall to 0, which is the correct
               -- treatment on both sides of the ratio.
               SUM(CASE WHEN pv."cost" IS NOT NULL
                        THEN (li."price" * li."quantity" - li."total_discount") * s.fx
                        ELSE 0 END) AS line_net_with_cost,
               SUM(CASE WHEN pv."cost" IS NOT NULL
                        THEN pv."cost" * li."quantity" * s.fx
                        ELSE 0 END) AS cogs_gross
        FROM scoped s
        JOIN "order_line_items" li ON li."order_id" = s."id"
        LEFT JOIN "product_variants" pv ON pv."id" = li."variant_id"
        GROUP BY s.bucket
      ),
      refunds AS (
        -- Attributed to the ORDER's bucket, not the refund's, so each bucket
        -- stays internally reconcilable with the orders in it. A past bar can
        -- therefore move when a refund lands; that is the intent.
        --
        -- Converted at the ORDER's rate, not the refund date's: a refund gives
        -- back part of a sale already booked at a rate, and re-converting it at
        -- a later rate would leave a residue on a fully refunded order.
        SELECT s.bucket,
               SUM(GREATEST(r."amount" - COALESCE(r."total_tax", 0), 0) * s.fx) AS refunded_net
        FROM scoped s
        JOIN "order_refunds" r ON r."order_id" = s."id"
        GROUP BY s.bucket
      ),
      -- Generated in SQL so the empty buckets land on date_trunc's own
      -- boundaries in the org's timezone, rather than on JS's idea of a month
      -- in whatever timezone the server happens to run.
      buckets AS (
        SELECT generate_series(
          date_trunc(${unit}, ${window.from}::timestamptz AT TIME ZONE ${tz}),
          date_trunc(${unit}, ${window.to}::timestamptz   AT TIME ZONE ${tz}),
          CAST(${step} AS interval)
        ) AS bucket
      )
      SELECT
        b.bucket,
        ROUND(COALESCE(sa.gross_sales, 0), 2)::float8        AS gross_sales,
        ROUND(COALESCE(sa.tax, 0), 2)::float8                AS tax,
        ROUND(COALESCE(sa.shipping, 0), 2)::float8           AS shipping,
        ROUND(COALESCE(sa.net_sales_gross, 0), 2)::float8    AS net_sales_gross,
        ROUND(COALESCE(rf.refunded_net, 0), 2)::float8       AS refunded_net,
        ROUND(COALESCE(l.line_net, 0), 2)::float8            AS line_net,
        ROUND(COALESCE(l.line_net_with_cost, 0), 2)::float8  AS line_net_with_cost,
        ROUND(COALESCE(l.cogs_gross, 0), 2)::float8          AS cogs_gross,
        COALESCE(sa.orders, 0)::int                          AS orders
      FROM buckets b
      LEFT JOIN sales   sa ON sa.bucket = b.bucket
      LEFT JOIN lines   l  ON l.bucket  = b.bucket
      LEFT JOIN refunds rf ON rf.bucket = b.bucket
      ORDER BY b.bucket ASC`;
  }

  /** New customers per bucket, cut on the same boundaries as the sales rows. */
  private async fetchNewCustomerRows(
    orgId: string,
    window: Window,
    channelId?: string,
  ): Promise<Array<{ bucket: Date; count: number }>> {
    const channelFilter = channelId
      ? Prisma.sql`AND c."channel_id" = ${channelId}`
      : Prisma.empty;

    return this.prisma.$queryRaw<Array<{ bucket: Date; count: number }>>`
      SELECT
        date_trunc(
          ${window.unit},
          COALESCE(c."external_created_at", c."created_at")
            AT TIME ZONE 'UTC' AT TIME ZONE ${window.timezone}
        ) AS bucket,
        COUNT(*)::int AS count
      FROM "customers" c
      WHERE c."organization_id" = ${orgId}
        AND c."deleted_at" IS NULL
        AND COALESCE(c."external_created_at", c."created_at") >= ${window.from}::timestamptz AT TIME ZONE 'UTC'
        AND COALESCE(c."external_created_at", c."created_at") <  ${window.to}::timestamptz AT TIME ZONE 'UTC'
        ${channelFilter}
      GROUP BY 1`;
  }

  /**
   * The window every figure on the page shares.
   *
   * `dateFrom`/`dateTo` still win when present — the export endpoints pass them
   * — but the UI drives `range`, so the card and the chart cannot end up
   * describing different periods the way they did when one defaulted to
   * all-time and the other to a hard-coded twelve months.
   */
  private async resolveWindow(
    orgId: string,
    query: QueryDashboardDto,
  ): Promise<Window> {
    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
      select: { timezone: true, currency: true },
    });

    const range = rangeToWindow(query.range);
    const explicit = Boolean(query.dateFrom || query.dateTo);
    const to = query.dateTo ? new Date(query.dateTo) : new Date();
    const from = query.dateFrom
      ? new Date(query.dateFrom)
      : windowStart(to, range);

    return {
      from,
      to,
      unit: explicit ? 'month' : range.unit,
      label: explicit ? 'Selected range' : range.label,
      timezone: org?.timezone || 'UTC',
      currency: (org?.currency || 'USD').toUpperCase(),
    };
  }

  /** The equally long window ending where this one begins. */
  private precedingWindow(window: Window): Window {
    const span = window.to.getTime() - window.from.getTime();
    return {
      ...window,
      from: new Date(window.from.getTime() - span),
      to: window.from,
    };
  }

  private describe(window: Window) {
    return {
      from: window.from.toISOString(),
      to: window.to.toISOString(),
      label: window.label,
      timezone: window.timezone,
    };
  }

  private bucketKey(bucket: Date, unit: 'day' | 'month'): string {
    const iso = new Date(bucket).toISOString();
    return unit === 'day' ? iso.slice(0, 10) : iso.slice(0, 7);
  }

  private bucketLabel(bucket: Date, unit: 'day' | 'month'): string {
    const d = new Date(bucket);
    const month = [
      'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
    ][d.getUTCMonth()];
    return unit === 'day' ? `${d.getUTCDate()} ${month}` : month;
  }

  /**
   * Period-over-period change, matching `OrderService.calcChange` so both
   * endpoints report a delta the same way. Copied rather than shared because
   * that one is private — worth lifting into `common/` if a third caller lands.
   *
   * A `previous` of 0 yields a nominal 100% "up"; callers should hide the badge
   * in that case rather than present growth-from-nothing as a trend.
   */
  private calcChange(current: number, previous: number): { percentage: number; direction: 'up' | 'down' | 'same' } {
    if (previous === 0 && current === 0) return { percentage: 0, direction: 'same' };
    if (previous === 0) return { percentage: 100, direction: 'up' };
    const percentage = Math.round(((current - previous) / previous) * 100);
    return {
      percentage: Math.abs(percentage),
      direction: percentage > 0 ? 'up' : percentage < 0 ? 'down' : 'same',
    };
  }

  // ─── SALES BY PRODUCT TYPE (for donut chart) ───
  async getSalesByCategory(orgId: string, query: QueryDashboardDto) {
    const window = await this.resolveWindow(orgId, query);

    const lineItems = await this.prisma.orderLineItem.findMany({
      where: {
        order: salesOrderWhere({
          orgId,
          channelId: query.channelId,
          from: window.from,
          to: window.to,
        }),
      },
      select: {
        price: true,
        quantity: true,
        totalDiscount: true,
        variant: { select: { product: { select: { productType: true } } } },
      },
    });

    const categoryMap = new Map<string, number>();
    for (const item of lineItems) {
      const category = item.variant?.product?.productType || 'Other';
      const amount = parseFloat(item.price.toString()) * item.quantity - parseFloat(item.totalDiscount.toString());
      categoryMap.set(category, (categoryMap.get(category) || 0) + amount);
    }

    const sorted = Array.from(categoryMap.entries()).sort(([, a], [, b]) => b - a);
    const COLORS = ['#a78bfa', '#fbbf24', '#fb923c', '#818cf8', '#34d399', '#f472b6', '#60a5fa', '#f87171'];

    const data = sorted.slice(0, 6).map(([name, value], i) => ({
      name,
      value: round2(value),
      color: COLORS[i % COLORS.length],
    }));

    const otherTotal = sorted.slice(6).reduce((s, [, v]) => s + v, 0);
    if (otherTotal > 0) {
      data.push({ name: 'Other', value: round2(otherTotal), color: '#9ca3af' });
    }

    return { data, total: round2(data.reduce((s, d) => s + d.value, 0)) };
  }

  private async getTopSellingProducts(
    orgId: string,
    query: QueryDashboardDto,
    window: Window,
    limit: number,
  ) {
    // Group line items by externalProductId to get total quantity sold per
    // product. Scoped through `placedBetween`, so manual/offline orders — whose
    // `externalCreatedAt` is null — are no longer invisible in this panel.
    const topItems = await this.prisma.orderLineItem.groupBy({
      by: ['externalProductId'],
      where: {
        order: {
          organizationId: orgId,
          deletedAt: null,
          ...(query.channelId && { channelId: query.channelId }),
          ...placedBetween(window.from, window.to),
        },
        externalProductId: { not: null },
      },
      _sum: { quantity: true },
      _count: true,
      orderBy: { _sum: { quantity: 'desc' } },
      take: limit,
    });

    // Fetch product details for the top items
    const productIds = topItems
      .map((item) => item.externalProductId)
      .filter(Boolean) as string[];

    const products = await this.prisma.product.findMany({
      where: {
        organizationId: orgId,
        externalId: { in: productIds },
      },
      include: {
        images: { take: 1, orderBy: { position: 'asc' } },
        variants: { select: { price: true, inventoryQuantity: true } },
      },
    });

    const productMap = new Map(products.map((p) => [p.externalId, p]));

    return topItems.map((item) => {
      const product = productMap.get(item.externalProductId!);
      const totalStock = product?.variants.reduce((sum, v) => sum + v.inventoryQuantity, 0) ?? 0;
      const prices = product?.variants.map((v) => parseFloat(String(v.price))) ?? [];

      return {
        externalProductId: item.externalProductId,
        title: product?.title ?? 'Unknown Product',
        image: product?.images[0]?.src ?? null,
        totalQuantitySold: item._sum.quantity ?? 0,
        totalOrders: item._count,
        currentStock: totalStock,
        price: prices.length > 0 ? Math.min(...prices).toFixed(2) : '0.00',
      };
    });
  }

  // Top N products with the lowest (non-zero) stock, flagged by the org's lowStockThreshold.
  // Sort by lowest-stock variant ascending so the most urgent items surface first.
  private async getLowStockProducts(orgId: string, channelId: string | undefined, limit: number) {
    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
      select: { lowStockThreshold: true },
    });
    const threshold = org?.lowStockThreshold ?? 10;

    const products = await this.prisma.product.findMany({
      where: {
        organizationId: orgId,
        deletedAt: null,
        status: 'ACTIVE',
        ...(channelId && { channelId }),
        variants: { some: { inventoryQuantity: { lte: threshold } } },
      },
      include: {
        images: { take: 1, orderBy: { position: 'asc' } },
        variants: { select: { price: true, inventoryQuantity: true } },
      },
    });

    return products
      .map((product) => {
        const stocks = product.variants.map((v) => v.inventoryQuantity);
        const totalStock = stocks.reduce((sum, s) => sum + s, 0);
        const lowestVariantStock = stocks.length > 0 ? Math.min(...stocks) : 0;
        const prices = product.variants.map((v) => parseFloat(String(v.price)));

        return {
          id: product.id,
          title: product.title,
          image: product.images[0]?.src ?? null,
          currentStock: totalStock,
          lowestVariantStock,
          variantCount: product.variants.length,
          price: prices.length > 0 ? Math.min(...prices).toFixed(2) : '0.00',
          threshold,
        };
      })
      .sort((a, b) => a.lowestVariantStock - b.lowestVariantStock)
      .slice(0, limit);
  }
}
