import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  ChannelPlatform,
  ChannelStatus,
  GstType,
  InvoiceStatus,
  OrderFinancialStatus,
  OrderFulfillmentStatus,
  Prisma,
  StockBucket,
} from '@prisma/client';
import { resolvePlaceOfSupply } from '../gst/place-of-supply.util';
import { singleDistinct } from '../channel/single-distinct.util';
import {
  sellerStateForSupply,
  type SellerRegistrations,
} from '../gst/seller-registration.util';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { QueryOrdersDto } from './dto/query-orders.dto';
import { CreateOfflineOrderDto } from './dto/create-offline-order.dto';
import { UpdateOrderDto } from './dto/update-order.dto';
import { CancelOrderDto } from './dto/cancel-order.dto';
import { CapturePaymentDto } from './dto/capture-payment.dto';
import { CreateFulfillmentDto } from './dto/create-fulfillment.dto';
import { UpdateTrackingDto } from './dto/update-tracking.dto';
import { QueryDashboardDto } from '../dashboard/dto/query-dashboard.dto';
import { Parser } from 'json2csv';
import { GstCalculatorService } from '../gst/gst-calculator.service';
import { TaxResolverService } from '../gst/tax-resolver.service';
import { InvoiceService } from '../invoice/invoice.service';
import { ShopifyPushEnqueuer } from '../channel/shopify-push.enqueuer';
import { ShopifyPushService, isStalePendingSync } from '../channel/shopify-push.service';

/// Recorded on `metadata.shopifySync.error` when a push could not even be
/// queued. Distinct wording from a worker failure so the audit can tell the
/// two apart; `attempts` is not incremented because nothing ran.
const QUEUE_UNAVAILABLE_ERROR =
  'Could not queue the Shopify push (queue unavailable). Use "Sync to Shopify" to retry.';
import { ShopifyGraphqlClient } from '../channel/shopify-graphql.client';
import { ShopifyOAuthService } from '../channel/shopify-oauth.service';
import { OrganizationSettingsService } from '../organization-settings/organization-settings.service';
import { LoyaltyService } from '../loyalty/loyalty.service';
import { InventoryLedgerService } from '../inventory/inventory-ledger.service';
import { FxRateService } from '../common/fx/fx-rate.service';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { SHOPIFY_PUSH_QUEUE } from '../channel/shopify-push.queue';
import { displayVariantTitle } from '../product/variant-title.util';
import {
  retryOnNumberingConflict,
  uniqueViolationTargets,
} from '../common/utils/serialization-retry.util';
import { mergeJsonMetadata } from '../common/utils/jsonb-merge.util';
import {
  FulfillmentCancelResponse,
  FulfillmentCancelVariables,
  FulfillmentCreateResponse,
  FulfillmentCreateVariables,
  FulfillmentTrackingInfoUpdateResponse,
  FulfillmentTrackingInfoUpdateVariables,
  MailingAddressInput,
  OrderCancelResponse,
  OrderCancelVariables,
  OrderCapturableTransactionsResponse,
  OrderCapturableTransactionsVariables,
  OrderCaptureResponse,
  OrderCaptureVariables,
  OrderCloseOrOpenVariables,
  OrderCloseResponse,
  OrderFulfillmentOrdersResponse,
  OrderMarkAsPaidResponse,
  OrderMarkAsPaidVariables,
  OrderOpenResponse,
  OrderUpdateInput,
  OrderUpdateResponse,
  OrderUpdateVariables,
  FULFILLMENT_CANCEL_MUTATION,
  FULFILLMENT_ORDER_HOLD_MUTATION,
  FULFILLMENT_ORDER_RELEASE_HOLD_MUTATION,
  FULFILLMENT_ORDER_OPEN_MUTATION,
  FulfillmentOrderHoldResponse,
  FulfillmentOrderHoldVariables,
  FulfillmentOrderReleaseHoldResponse,
  FulfillmentOrderReleaseHoldVariables,
  FulfillmentOrderOpenResponse,
  FulfillmentOrderOpenVariables,
  FULFILLMENT_ORDER_REPORT_PROGRESS_MUTATION,
  FulfillmentOrderReportProgressResponse,
  FULFILLMENT_EVENT_CREATE_MUTATION,
  FulfillmentEventCreateResponse,
  FulfillmentEventCreateVariables,
  ORDER_FULFILLMENTS_WITH_LINES_QUERY,
  OrderFulfillmentsWithLinesResponse,
  FULFILLMENT_CREATE_MUTATION,
  FULFILLMENT_TRACKING_INFO_UPDATE_MUTATION,
  ORDER_CANCEL_MUTATION,
  ORDER_CAPTURABLE_TRANSACTIONS_QUERY,
  ORDER_CAPTURE_MUTATION,
  ORDER_CLOSE_MUTATION,
  ORDER_FULFILLMENT_ORDERS_QUERY,
  ORDER_ALL_FULFILLMENT_ORDERS_QUERY,
  ORDER_MARK_AS_PAID_MUTATION,
  ORDER_OPEN_MUTATION,
  ORDER_UPDATE_MUTATION,
} from '../channel/shopify-graphql.types';
import { mapFulfilmentLines } from '../channel/fulfillment-line-map.util';

/**
 * Fulfilment-order states Shopify will not accept a fulfilment against.
 *
 * A DENY-list on purpose. An allow-list would silently drop any status Shopify
 * adds later, breaking fulfilment with no error; with a deny-list an unknown
 * status is still attempted and Shopify tells us if it can't be done.
 */
const UNFULFILLABLE_FO_STATUSES: ReadonlySet<string> = new Set([
  'CLOSED',
  'CANCELLED',
  'INCOMPLETE',
]);

export const isUnfulfillableFo = (status: string): boolean =>
  UNFULFILLABLE_FO_STATUSES.has(status);

/**
 * The fulfilment orders a fulfilment may actually be created against, OPEN first.
 *
 * Exported and pure so the selection can be asserted directly — this is the
 * exact logic that let a CLOSED fulfilment order reach `fulfillmentCreate`.
 */
export function selectFulfillableFos<T extends { status: string }>(fos: T[]): T[] {
  return fos
    .filter((fo) => !isUnfulfillableFo(fo.status))
    .sort((a, b) => Number(b.status === 'OPEN') - Number(a.status === 'OPEN'));
}

/** Matches `fulfillmentOrders(first: 25)` in both FO queries — neither paginates. */
const FULFILLMENT_ORDER_PAGE_SIZE = 25;

/**
 * Ceiling on one batch package-slip print job. Lower than the label route's
 * 200 because a slip carries an address block and its line items, not a
 * barcode — and 100 slips is already 25 A4 sheets in one print dialog.
 */
const MAX_SLIP_ORDERS = 100;

/** The window a comparison reports on, plus the one immediately before it. */
interface ComparisonPeriods {
  currentStart: Date;
  currentEnd: Date;
  previousStart: Date;
  previousEnd: Date;
  /**
   * False for an unbounded ("All Time") window: there is no earlier period to
   * compare against, so every metric's trend is null rather than a fabricated
   * "100% up" against an empty window.
   */
  hasPrevious: boolean;
}

@Injectable()
export class OrderService {
  private readonly logger = new Logger(OrderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly calculator: GstCalculatorService,
    private readonly taxResolver: TaxResolverService,
    private readonly invoiceService: InvoiceService,
    private readonly shopifyPushEnqueuer: ShopifyPushEnqueuer,
    private readonly shopifyPushService: ShopifyPushService,
    private readonly graphql: ShopifyGraphqlClient,
    private readonly shopifyOAuth: ShopifyOAuthService,
    private readonly settings: OrganizationSettingsService,
    private readonly loyalty: LoyaltyService,
    private readonly ledger: InventoryLedgerService,
    // A counter sale is priced in the org's currency, but a catalogue price is
    // denominated in ITS channel's currency — see `catalogueUnitPrice`.
    private readonly fx: FxRateService,
    @InjectQueue(SHOPIFY_PUSH_QUEUE)
    private readonly shopifyPushQueue: Queue,
  ) { }

  async findAll(orgId: string, query: QueryOrdersDto, vendorScope?: string) {
    const where: Prisma.OrderWhereInput = {
      organizationId: orgId,
      deletedAt: null,
    };

    // Filter by financial status
    if (query.financialStatus) {
      where.financialStatus = query.financialStatus;
    }

    // Filter by fulfillment status
    if (query.fulfillmentStatus) {
      where.fulfillmentStatus = query.fulfillmentStatus;
    }

    // Filter by channel
    if (query.channelId) {
      where.channelId = query.channelId;
    }

    // Filter to orders containing a line item from a specific product
    // (drives "Recent sales" on the product detail page).
    if (query.productId) {
      where.lineItems = {
        some: { variant: { productId: query.productId } },
      };
    }

    // Filter to orders for a specific customer (drives the customer detail
    // page's order history if/when that lands).
    if (query.customerId) {
      where.customerId = query.customerId;
    }

    // VENDOR role: only orders that contain at least one of this vendor's items.
    if (vendorScope) {
      where.lineItems = { some: { vendor: vendorScope } };
    }

    // Search by order number, customer name, or email
    if (query.search) {
      const searchTerm = query.search.trim();
      const orderNum = parseInt(searchTerm, 10);

      where.OR = [
        // Search by order number (if numeric)
        ...(isNaN(orderNum) ? [] : [{ orderNumber: orderNum }]),
        // Search by order name (#1001)
        { name: { contains: searchTerm, mode: 'insensitive' as const } },
        // Search by customer name
        {
          customer: {
            OR: [
              { firstName: { contains: searchTerm, mode: 'insensitive' as const } },
              { lastName: { contains: searchTerm, mode: 'insensitive' as const } },
              { email: { contains: searchTerm, mode: 'insensitive' as const } },
            ],
          },
        },
      ];
    }

    // Date range filter
    if (query.dateFrom || query.dateTo) {
      where.externalCreatedAt = {};
      if (query.dateFrom) where.externalCreatedAt.gte = new Date(query.dateFrom);
      if (query.dateTo) where.externalCreatedAt.lte = new Date(query.dateTo);
    }

    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    // Determine sort field
    const sortBy = query.sortBy ?? 'externalCreatedAt';
    const sortOrder = query.sortOrder ?? 'desc';

    const [data, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        include: {
          customer: {
            select: { id: true, firstName: true, lastName: true, email: true },
          },
          channel: {
            select: { id: true, name: true, platform: true },
          },
          _count: {
            // For vendors, count only their own line items.
            select: { lineItems: vendorScope ? { where: { vendor: vendorScope } } : true },
          },
          // For vendors, pull their own line items' prices so we can show a
          // vendor-scoped subtotal in the list (their items only).
          ...(vendorScope
            ? { lineItems: { where: { vendor: vendorScope }, select: { price: true, quantity: true } } }
            : {}),
        },
        orderBy: { [sortBy]: sortOrder },
        skip,
        take: limit,
      }),
      this.prisma.order.count({ where }),
    ]);

    const meta = {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };

    // VENDOR role: a deliberately narrow projection. The customer is limited to
    // their display name — the vendor needs to tell rows apart, and
    // `findOneForVendor` already shows them the name on the detail page, so
    // withholding it here only produced a misleading "Guest" on every row. Email
    // and customer id stay out. The amount is the vendor's own subtotal (their
    // items only), matching the vendor order detail page's `vendorSubtotal`.
    if (vendorScope) {
      return {
        data: data.map((order) => ({
          id: order.id,
          orderNumber: order.orderNumber,
          name: order.name,
          fulfillmentStatus: order.fulfillmentStatus,
          customer: order.customer
            ? { firstName: order.customer.firstName, lastName: order.customer.lastName }
            : null,
          totalPrice: order.lineItems.reduce(
            (sum, li) => sum + Number(li.price) * li.quantity,
            0,
          ),
          createdAt: order.externalCreatedAt || order.createdAt,
          itemCount: order._count.lineItems, // already filtered to the vendor's items
        })),
        meta,
      };
    }

    return {
      data: data.map((order) => ({
        id: order.id,
        orderNumber: order.orderNumber,
        name: order.name,
        financialStatus: order.financialStatus,
        fulfillmentStatus: order.fulfillmentStatus,
        currency: order.currency,
        totalPrice: order.totalPrice,
        subtotalPrice: order.subtotalPrice,
        totalTax: order.totalTax,
        totalDiscounts: order.totalDiscounts,
        totalShippingPrice: order.totalShippingPrice,
        tags: order.tags,
        note: order.note,
        cancelReason: order.cancelReason,
        cancelledAt: order.cancelledAt,
        createdAt: order.externalCreatedAt || order.createdAt,
        customer: order.customer,
        channel: order.channel,
        itemCount: order._count.lineItems,
      })),
      meta,
    };
  }

  async findOne(id: string, orgId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id, organizationId: orgId, deletedAt: null },
      include: {
        customer: {
          select: { id: true, firstName: true, lastName: true, email: true, phone: true, defaultAddress: true },
        },
        channel: {
          select: { id: true, name: true, platform: true },
        },
        // Named so the detail rail can show where the goods left from.
        dispatchWarehouse: {
          select: { id: true, name: true, code: true },
        },
        lineItems: {
          include: {
            variant: {
              select: {
                id: true,
                title: true,
                sku: true,
                price: true,
                // Order line items never snapshot weight, so the detail page's
                // shipping-weight total has to come off the live variant.
                weight: true,
                weightUnit: true,
                image: { select: { src: true } },
                product: {
                  select: {
                    images: { select: { src: true }, orderBy: { position: 'asc' }, take: 1 },
                  },
                },
              },
            },
          },
        },
        fulfillments: true,
        refunds: true,
        // Capped: the feed is rendered in full, and a long-lived order that has
        // been re-synced, held, released and re-tracked can accumulate hundreds
        // of rows. Newest 100 is far more than the UI meaningfully shows.
        timeline: { orderBy: { createdAt: 'desc' }, take: 100 },
        // The order's live GST invoice (at most one — enforced by the partial
        // unique index invoices_order_id_active_key). Lets the client show the
        // invoice card / gate the Generate button without scanning the
        // paginated invoice list.
        invoices: {
          where: { status: { not: InvoiceStatus.CANCELLED } },
          select: {
            id: true,
            invoiceNumber: true,
            invoiceDate: true,
            status: true,
            grandTotal: true,
          },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });

    if (!order) throw new NotFoundException('Order not found');
    // Flatten a per-line product image + its fulfilment tracking for the UI.
    const lineTracking = this.buildLineTrackingMap(order.fulfillments);
    return {
      ...order,
      lineItems: order.lineItems.map((li) => ({
        ...li,
        imageUrl: li.variant?.image?.src ?? li.variant?.product?.images?.[0]?.src ?? null,
        trackingNumber: lineTracking.get(li.id)?.trackingNumber ?? null,
        trackingUrl: lineTracking.get(li.id)?.trackingUrl ?? null,
        trackingCompany: lineTracking.get(li.id)?.trackingCompany ?? null,
      })),
    };
  }

  async getComparison(orgId: string, query: QueryDashboardDto) {
    const periods = this.comparisonPeriods(query);
    const { currentStart, currentEnd, previousStart, previousEnd } = periods;

    const channelFilter = query.channelId ? { channelId: query.channelId } : {};

    const [
      currentOrders,
      previousOrders,
      currentPendingOrders,
      previousPendingOrders,
      currentSalesConverted,
      previousSalesConverted,
      currentSalesByCurrency,
      currentProductsSold,
      previousProductsSold,
      orgRow,
    ] = await Promise.all([
      // Total new orders (current period)
      this.prisma.order.count({
        where: {
          organizationId: orgId, deletedAt: null, ...channelFilter,
          externalCreatedAt: { gte: currentStart, lte: currentEnd },
        },
      }),
      // Total new orders (previous period)
      this.prisma.order.count({
        where: {
          organizationId: orgId, deletedAt: null, ...channelFilter,
          externalCreatedAt: { gte: previousStart, lte: previousEnd },
        },
      }),

      // Pending orders (current period)
      this.prisma.order.count({
        where: {
          organizationId: orgId, deletedAt: null, ...channelFilter,
          fulfillmentStatus: 'UNFULFILLED',
          externalCreatedAt: { gte: currentStart, lte: currentEnd },
        },
      }),
      // Pending orders (previous period)
      this.prisma.order.count({
        where: {
          organizationId: orgId, deletedAt: null, ...channelFilter,
          fulfillmentStatus: 'UNFULFILLED',
          externalCreatedAt: { gte: previousStart, lte: previousEnd },
        },
      }),

      // Total sales revenue, converted into the org currency at each order's
      // own stored rate (current period, then the one before it).
      this.convertedSales(orgId, query.channelId, currentStart, currentEnd),
      this.convertedSales(orgId, query.channelId, previousStart, previousEnd),

      // The same current-period sales, split by the currency each order was
      // actually placed in. Supporting detail under the converted headline —
      // the `_sum.totalPrice` aggregates above are pre-conversion and are
      // superseded by the converted figures computed below.
      this.prisma.order.groupBy({
        by: ['currency'],
        where: {
          organizationId: orgId, deletedAt: null, ...channelFilter,
          financialStatus: { in: ['PAID', 'PARTIALLY_PAID'] },
          externalCreatedAt: { gte: currentStart, lte: currentEnd },
        },
        _sum: { totalPrice: true },
        _count: { _all: true },
      }),

      // Total products sold / volume (current period)
      this.prisma.orderLineItem.aggregate({
        where: {
          order: {
            organizationId: orgId, deletedAt: null, ...channelFilter,
            externalCreatedAt: { gte: currentStart, lte: currentEnd },
          },
        },
        _sum: { quantity: true },
      }),
      // Total products sold / volume (previous period)
      this.prisma.orderLineItem.aggregate({
        where: {
          order: {
            organizationId: orgId, deletedAt: null, ...channelFilter,
            externalCreatedAt: { gte: previousStart, lte: previousEnd },
          },
        },
        _sum: { quantity: true },
      }),
      // What the converted figures above are denominated in.
      this.prisma.organization.findUnique({
        where: { id: orgId },
        select: { currency: true },
      }),
    ]);

    return this.buildComparison(periods, {
      orders: { current: currentOrders, previous: previousOrders },
      pending: { current: currentPendingOrders, previous: previousPendingOrders },
      sales: {
        current: currentSalesConverted.total,
        previous: previousSalesConverted.total,
        currency: (orgRow?.currency ?? 'USD').toUpperCase(),
        unconverted: currentSalesConverted.unconverted,
        byCurrency: currentSalesByCurrency
          .map((r) => ({
            currency: r.currency,
            amount: Number(r._sum.totalPrice ?? 0),
            orders: r._count._all,
          }))
          .sort((a, b) => b.amount - a.amount),
      },
      sold: {
        current: currentProductsSold._sum.quantity ?? 0,
        previous: previousProductsSold._sum.quantity ?? 0,
      },
    });
  }

  /**
   * The same four metrics as {@link getComparison}, but measured over a single
   * vendor's line items rather than whole orders — an order can carry several
   * vendors, and summing `Order.totalPrice` would hand this vendor the others'
   * revenue.
   *
   * Two metrics cannot be expressed in Prisma and drop to raw SQL:
   *   - pending compares two columns (`fulfilled_quantity < quantity`), which is
   *     the only reliable partial-shipment test (see the note on
   *     `OrderLineItem.fulfilledQuantity` — `fulfillmentStatus` alone cannot
   *     express "2 of 5 shipped");
   *   - sales sums a product of two columns (`price * quantity`).
   *
   * Kept as its own method rather than a flag threaded through the org-wide one:
   * half its queries would have had to change engine, and this way the owner
   * path — which already works — is not touched at all.
   */
  async getVendorComparison(
    orgId: string,
    query: QueryDashboardDto,
    vendorScope: string,
  ) {
    const periods = this.comparisonPeriods(query);
    const { currentStart, currentEnd, previousStart, previousEnd } = periods;

    const channelFilter = query.channelId ? { channelId: query.channelId } : {};
    // Raw-SQL twin of `channelFilter`, for the two queries below that cannot go
    // through Prisma.
    const channelSql = query.channelId
      ? Prisma.sql`AND o."channel_id" = ${query.channelId}`
      : Prisma.empty;

    // Orders carrying at least one of this vendor's items — the same membership
    // rule `findAll` applies via `where.lineItems.some.vendor`.
    const ordersIn = (from: Date, to: Date): Prisma.OrderWhereInput => ({
      organizationId: orgId,
      deletedAt: null,
      ...channelFilter,
      externalCreatedAt: { gte: from, lte: to },
      lineItems: { some: { vendor: vendorScope } },
    });

    // Orders where THIS vendor still owes units. An order whose other vendors
    // are behind is not this vendor's pending work. COUNT(DISTINCT) because one
    // vendor may hold several lines on the same order.
    const pendingIn = (from: Date, to: Date) =>
      this.prisma.$queryRaw<Array<{ count: number }>>`
        SELECT COUNT(DISTINCT o."id")::int AS count
        FROM "orders" o
        JOIN "order_line_items" li ON li."order_id" = o."id"
        WHERE o."organization_id" = ${orgId}
          AND o."deleted_at" IS NULL
          AND o."external_created_at" >= ${from}
          AND o."external_created_at" <= ${to}
          AND li."vendor" = ${vendorScope}
          AND li."fulfilled_quantity" < li."quantity"
          ${channelSql}
      `;

    // Their line revenue: price × quantity, the same figure `vendorSubtotal` and
    // the vendor order rows already show, so the tile ties out against the list
    // beneath it. Paid-only, matching the org-wide tile's financialStatus rule.
    const salesIn = (from: Date, to: Date) =>
      this.prisma.$queryRaw<Array<{ value: number | null }>>`
        SELECT COALESCE(SUM(li."price" * li."quantity"), 0)::float AS value
        FROM "order_line_items" li
        JOIN "orders" o ON o."id" = li."order_id"
        WHERE o."organization_id" = ${orgId}
          AND o."deleted_at" IS NULL
          AND o."financial_status"::text IN ('PAID', 'PARTIALLY_PAID')
          AND o."external_created_at" >= ${from}
          AND o."external_created_at" <= ${to}
          AND li."vendor" = ${vendorScope}
          ${channelSql}
      `;

    const soldIn = (from: Date, to: Date) =>
      this.prisma.orderLineItem.aggregate({
        where: {
          vendor: vendorScope,
          order: {
            organizationId: orgId,
            deletedAt: null,
            ...channelFilter,
            externalCreatedAt: { gte: from, lte: to },
          },
        },
        _sum: { quantity: true },
      });

    const [
      currentOrders,
      previousOrders,
      currentPending,
      previousPending,
      currentSales,
      previousSales,
      currentSold,
      previousSold,
    ] = await Promise.all([
      this.prisma.order.count({ where: ordersIn(currentStart, currentEnd) }),
      this.prisma.order.count({ where: ordersIn(previousStart, previousEnd) }),
      pendingIn(currentStart, currentEnd),
      pendingIn(previousStart, previousEnd),
      salesIn(currentStart, currentEnd),
      salesIn(previousStart, previousEnd),
      soldIn(currentStart, currentEnd),
      soldIn(previousStart, previousEnd),
    ]);

    return this.buildComparison(periods, {
      orders: { current: currentOrders, previous: previousOrders },
      pending: {
        current: currentPending[0]?.count ?? 0,
        previous: previousPending[0]?.count ?? 0,
      },
      sales: {
        current: currentSales[0]?.value ?? 0,
        previous: previousSales[0]?.value ?? 0,
      },
      sold: {
        current: currentSold._sum.quantity ?? 0,
        previous: previousSold._sum.quantity ?? 0,
      },
    });
  }

  /**
   * Sales for a window, converted into the organisation's currency at each
   * order's own stored rate.
   *
   * Raw SQL because Prisma's `aggregate` can only sum a column, and this has to
   * sum a product (`total_price * exchange_rate`). Summing `total_price` alone
   * — which is what this replaced — added currencies together: an INR
   * workspace with a USD store reported "₹4,456.94" for a figure that was part
   * rupees and part dollars.
   *
   * Orders whose rate never resolved are EXCLUDED from the total and counted
   * separately, so a caller can say the figure is incomplete rather than
   * quietly under-reporting. Defaulting them to 1 would book $2,545 as ₹2,545.
   *
   * The date predicate deliberately matches the aggregates it sits beside
   * (`external_created_at`, inclusive both ends) so the converted figure covers
   * exactly the same orders as the counts next to it.
   */
  private async convertedSales(
    orgId: string,
    channelId: string | undefined,
    from: Date,
    to: Date,
  ): Promise<{ total: number; unconverted: number }> {
    const channelFilter = channelId
      ? Prisma.sql`AND o."channel_id" = ${channelId}`
      : Prisma.empty;

    const rows = await this.prisma.$queryRaw<
      { total: string | null; unconverted: bigint }[]
    >`
      SELECT
        COALESCE(SUM(o."total_price" * o."exchange_rate"), 0) AS total,
        COUNT(*) FILTER (WHERE o."exchange_rate" IS NULL)     AS unconverted
      FROM "orders" o
      WHERE o."organization_id" = ${orgId}
        AND o."deleted_at" IS NULL
        AND o."financial_status"::text IN ('PAID', 'PARTIALLY_PAID')
        AND o."external_created_at" >= ${from}
        AND o."external_created_at" <= ${to}
        ${channelFilter}
    `;

    const row = rows[0];
    return {
      total: Number(row?.total ?? 0),
      unconverted: Number(row?.unconverted ?? 0),
    };
  }

  /**
   * The window to report on, plus the same-length window immediately before it.
   * Shared by the org-wide and vendor comparisons so both quote the same dates.
   */
  private comparisonPeriods(query: QueryDashboardDto): ComparisonPeriods {
    const now = new Date();
    const currentEnd = query.dateTo ? new Date(query.dateTo) : now;

    // No `dateFrom` means the caller asked for ALL TIME — the Orders page's
    // own "All Time" option sends nothing. This used to default to the 1st of
    // the current month, so "All Time" silently reported month-to-date: on the
    // live data 3 orders and ₹4,456.94 instead of 9 and ₹12,235.20, and
    // "Pending Orders 0" directly above a table listing four unfulfilled ones.
    //
    // Unbounded is expressed as the epoch rather than by dropping the
    // predicate, so every query below keeps one code path and one shape.
    if (!query.dateFrom) {
      const epoch = new Date(0);
      return {
        currentStart: epoch,
        currentEnd,
        // Never read — `hasPrevious: false` suppresses the comparison — but a
        // valid range keeps the queries that receive them well-formed.
        previousStart: epoch,
        previousEnd: epoch,
        hasPrevious: false,
      };
    }

    const currentStart = new Date(query.dateFrom);

    // Previous period = same duration, shifted back
    const duration = currentEnd.getTime() - currentStart.getTime();
    return {
      currentStart,
      currentEnd,
      previousStart: new Date(currentStart.getTime() - duration),
      previousEnd: new Date(currentStart.getTime() - 1), // 1ms before current starts
      hasPrevious: true,
    };
  }

  /**
   * Assembles the comparison response. Separate so the vendor-scoped variant
   * returns a byte-identical shape — one set of tiles renders for every role.
   */
  private buildComparison(
    periods: ComparisonPeriods,
    metrics: {
      orders: { current: number; previous: number };
      pending: { current: number; previous: number };
      // Decimal on the org-wide path (Prisma `_sum`), plain number on the
      // vendor path (raw SQL). Both serialize fine — the client applies
      // `Number()` before formatting either way.
      sales: {
        /** Converted into the org currency at each order's own stored rate. */
        current: Prisma.Decimal | number;
        previous: Prisma.Decimal | number;
        /** What `current` and `previous` are denominated in. */
        currency?: string;
        /**
         * Orders excluded from `current` because their rate never resolved.
         * >0 means the figure is incomplete and the UI must say so.
         */
        unconverted?: number;
        /**
         * Pre-conversion make-up of `current`, as supporting detail. Optional:
         * the vendor-scoped variant (raw SQL) does not compute it.
         */
        byCurrency?: { currency: string; amount: number; orders: number }[];
      };
      sold: { current: number; previous: number };
    },
  ) {
    const { orders, pending, sales, sold } = metrics;

    // An unbounded window has nothing before it. `calcChange` would report
    // "100% up" against an empty previous period — a green trend badge on
    // every tile, asserting growth that was never measured.
    const change = (current: number, previous: number) =>
      periods.hasPrevious ? this.calcChange(current, previous) : null;

    return {
      period: {
        current: {
          from: periods.currentStart.toISOString(),
          to: periods.currentEnd.toISOString(),
        },
        previous: periods.hasPrevious
          ? {
            from: periods.previousStart.toISOString(),
            to: periods.previousEnd.toISOString(),
          }
          : null,
      },

      totalNewOrders: {
        current: orders.current,
        previous: orders.previous,
        change: change(orders.current, orders.previous),
      },

      pendingOrders: {
        current: pending.current,
        previous: pending.previous,
        change: change(pending.current, pending.previous),
      },

      totalSales: {
        current: sales.current,
        previous: sales.previous,
        change: change(Number(sales.current), Number(sales.previous)),
        currency: sales.currency,
        unconverted: sales.unconverted,
        byCurrency: sales.byCurrency,
      },

      totalProductsSold: {
        current: sold.current,
        previous: sold.previous,
        change: change(sold.current, sold.previous),
      },
    };
  }

  /**
   * Print payload for the batch package-slip route — many orders at once.
   *
   * `findAll` cannot serve this: its list projection carries neither
   * `lineItems` nor `shippingAddress`, which are the two things a slip is
   * mostly made of. `findOne` has them but is one order per round trip, and a
   * 100-parcel print run would be 100 requests.
   *
   * The shape is deliberately the same subset of `findOne`'s output that the
   * per-order slip already renders — including BOTH `createdAt` and
   * `externalCreatedAt`, since the slip prefers the external one — so a single
   * `<PackageSlip>` component renders identically from either source.
   *
   * Ordered by `orderNumber` so a printed stack comes out in a predictable
   * sequence regardless of the order the ids arrived in.
   */
  async getSlipData(orgId: string, orderIds: string[]) {
    if (orderIds.length === 0) return [];

    const orders = await this.prisma.order.findMany({
      where: {
        // Cap in the service, like `InventoryService.getLabelData`. 100 slips
        // is already 25 A4 sheets; past that the browser's print dialog is the
        // real bottleneck, not the query.
        id: { in: orderIds.slice(0, MAX_SLIP_ORDERS) },
        organizationId: orgId,
        deletedAt: null,
      },
      select: {
        id: true,
        name: true,
        note: true,
        createdAt: true,
        externalCreatedAt: true,
        shippingAddress: true,
        customer: {
          select: { firstName: true, lastName: true, email: true, phone: true },
        },
        lineItems: {
          select: {
            id: true,
            title: true,
            variantTitle: true,
            sku: true,
            quantity: true,
          },
        },
      },
      orderBy: { orderNumber: 'asc' },
    });

    return orders;
  }

  async getExportData(orgId: string, query: QueryOrdersDto) {
    const where: Prisma.OrderWhereInput = {
      organizationId: orgId,
      deletedAt: null,
      ...(query.financialStatus && { financialStatus: query.financialStatus }),
      ...(query.fulfillmentStatus && { fulfillmentStatus: query.fulfillmentStatus }),
      ...(query.channelId && { channelId: query.channelId }),
      ...((query.dateFrom || query.dateTo) && {
        externalCreatedAt: {
          ...(query.dateFrom && { gte: new Date(query.dateFrom) }),
          ...(query.dateTo && { lte: new Date(query.dateTo) }),
        },
      }),
    };

    const orders = await this.prisma.order.findMany({
      where,
      include: {
        customer: { select: { firstName: true, lastName: true, email: true } },
        lineItems: { select: { title: true, quantity: true, price: true } },
        channel: { select: { name: true } },
      },
      orderBy: { externalCreatedAt: 'desc' },
      // Bounded: the export builds the whole CSV/JSON in memory, so an
      // unlimited query on a large tenant could OOM the process for everyone.
      take: 10_000,
    });

    return orders.map((o) => ({
      orderNumber: o.orderNumber,
      name: o.name,
      date: (o.externalCreatedAt || o.createdAt).toISOString(),
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

  private calcChange(current: number, previous: number): { percentage: number; direction: 'up' | 'down' | 'same' } {
    if (previous === 0 && current === 0) return { percentage: 0, direction: 'same' };
    if (previous === 0) return { percentage: 100, direction: 'up' };
    const percentage = Math.round(((current - previous) / previous) * 100);
    return {
      percentage: Math.abs(percentage),
      direction: percentage > 0 ? 'up' : percentage < 0 ? 'down' : 'same',
    };
  }

  /**
   * Catalogue prices restated in the currency the counter sale is priced in.
   *
   * A variant's `price` is a bare decimal denominated in ITS OWN channel's
   * currency — the same rule `ShopifyPushService.priceConverter` applies in the
   * other direction. A counter sale is always priced in the org's currency, so
   * taking that number unchanged does not mislabel it, it re-denominates it: a
   * $749.95 snowboard synced from a USD Shopify store was rung up as ₹749.95
   * and the customer was charged about a ninety-fourth of the price.
   *
   * Today's rate, not the order's stored one: this is a live price being set
   * now, not an accounting fact being recorded about the past. (The order's own
   * `exchangeRate` stays 1 — the sale really is booked in the org currency.)
   *
   * Throws rather than guessing when a rate is needed and cannot be reached.
   * Charging a wrong price at the till is worse than refusing the line, and the
   * cashier can always type the price to proceed.
   */
  private async catalogueUnitPrices(
    orgId: string,
    orderCurrency: string,
    variants: Array<{
      price: Prisma.Decimal | number;
      product: { title: string; channel: { currency: string | null } | null };
    }>,
  ): Promise<number[]> {
    // One lookup per distinct source currency, not per line.
    const rates = new Map<string, number>([[orderCurrency, 1]]);
    const needed = new Set(
      variants
        .map((v) => (v.product.channel?.currency ?? orderCurrency).toUpperCase())
        .filter((c) => c && c !== orderCurrency),
    );

    for (const source of needed) {
      const rate = await this.fx.getRate(source, orderCurrency, new Date());
      if (rate == null) {
        throw new BadRequestException(
          `Cannot price this sale: no ${source}→${orderCurrency} exchange rate is available, ` +
            `and charging a ${source} catalogue price as ${orderCurrency} would be wrong. ` +
            `Enter the unit price manually to continue.`,
        );
      }
      rates.set(source, rate);
    }

    return variants.map((v) => {
      const source = (v.product.channel?.currency ?? orderCurrency).toUpperCase();
      const rate = rates.get(source) ?? 1;
      return this.calculator.round2(this.calculator.toNumber(v.price) * rate);
    });
  }

  // ─── OFFLINE / IN-STORE ORDER CREATION ───
  // Creates a manual order from a merchant's physical counter sale:
  // resolves/creates customer, validates and decrements stock, snapshots
  // line items, computes GST, and (when configured) generates the invoice
  // — all in a single Serializable transaction so a partial failure rolls
  // back cleanly.
  async createOfflineOrder(
    orgId: string,
    userId: string,
    dto: CreateOfflineOrderDto,
  ) {
    const variantIds = dto.lineItems.map((li) => li.productVariantId);
    if (new Set(variantIds).size !== variantIds.length) {
      throw new BadRequestException(
        'Duplicate variant IDs are not allowed; merge them into a single line item.',
      );
    }

    const runSale = () => this.prisma.$transaction(
      async (tx) => {
        // Variants whose stock this sale actually moved. Declared per attempt,
        // not outside `runSale`, because a numbering collision re-runs the
        // whole transaction and a shared array would accumulate duplicates.
        const soldVariantIds: string[] = [];

        // 1. Resolve or lazy-create the org's MANUAL channel.
        const channel = await tx.channel.upsert({
          where: {
            organizationId_platform: {
              organizationId: orgId,
              platform: ChannelPlatform.MANUAL,
            },
          },
          create: {
            organizationId: orgId,
            platform: ChannelPlatform.MANUAL,
            name: 'In-Store / Manual',
            status: ChannelStatus.CONNECTED,
            isEnabled: true,
          },
          update: {},
        });

        // 2. Resolve customer (existing by id/email/phone, else create).
        const customer = await this.resolveCustomer(tx, orgId, channel.id, dto);

        // 3. Fetch variants — used for line-item snapshots, tax math, AND
        //    inventory gating (Phase 2: trackQuantity / continueSellingWhenOutOfStock).
        const variants = await tx.productVariant.findMany({
          where: {
            id: { in: variantIds },
            product: { organizationId: orgId },
          },
          // The channel comes along because a catalogue price is denominated in
          // ITS channel's currency, and this order is priced in the org's —
          // see `catalogueUnitPrice`.
          include: { product: { include: { channel: { select: { currency: true } } } } },
        });

        const variantById = new Map(variants.map((v) => [v.id, v]));
        const missing = variantIds.filter((id) => !variantById.has(id));
        if (missing.length > 0) {
          throw new NotFoundException(
            `Product variants not found: ${missing.join(', ')}`,
          );
        }

        // 3a. Stock validation — refuse line items that would oversell a
        //     tracked variant unless overselling is allowed.
        //     "Tracked" is true when EITHER the org's `trackQuantityGlobally`
        //     is on OR the variant's per-row `trackQuantity` is on.
        //     "Oversell allowed" is true when EITHER `allowOversellGlobally`
        //     is on OR `continueSellingWhenOutOfStock` is on for the variant.
        const productSettings =
          await this.settings.getProductSettings(orgId);
        const oversellGlobally = productSettings.allowOversellGlobally === true;
        const trackGlobally = productSettings.trackQuantityGlobally === true;
        for (const li of dto.lineItems) {
          const v = variantById.get(li.productVariantId)!;
          const tracks = trackGlobally || v.trackQuantity !== false;
          const allowOversell =
            oversellGlobally || v.continueSellingWhenOutOfStock === true;
          if (tracks && !allowOversell && v.inventoryQuantity < li.quantity) {
            const vt = displayVariantTitle(v.title);
            throw new BadRequestException(
              `Insufficient stock for "${v.product.title}${vt ? ` — ${vt}` : ''}": ${v.inventoryQuantity} available, ${li.quantity} requested.`,
            );
          }
        }

        // 4. Resolve seller GSTIN (only required when invoice generation is on).
        const generateInvoice = dto.generateInvoice !== false;
        const org = await tx.organization.findUnique({
          where: { id: orgId },
          select: { gstEnabled: true, currency: true },
        });
        if (!org) {
          throw new NotFoundException('Organization not found');
        }
        // The one place the counter sale's currency is decided. Every price on
        // this order — line prices, totals, the invoice — is in it.
        const orderCurrency = (org.currency || 'INR').toUpperCase();

        let sellerGstin: { stateCode: string } | null = null;
        let sellerRegistrations: SellerRegistrations = {
          defaultStateCode: null,
          stateCodes: [],
        };

        if (generateInvoice && org.gstEnabled) {
          if (dto.sellerGstinId) {
            sellerGstin = await tx.organizationGstin.findFirst({
              where: {
                id: dto.sellerGstinId,
                organizationId: orgId,
                isActive: true,
              },
              select: { stateCode: true },
            });
          } else {
            // Load EVERY active registration, not just the default.
            //
            // This used to take the default GSTIN unconditionally, while
            // `InvoiceService.createForOrderTx` auto-selects the registration
            // MATCHING the place of supply and only then falls back to the
            // default. For a multi-state org those two rules disagree: an order
            // shipped into a state the merchant is registered in was taxed IGST
            // here and then invoiced CGST+SGST — a different tax head on the
            // same sale, one of them printed on a statutory document.
            //
            // Both sides now go through `sellerStateForSupply`, so they cannot
            // drift apart again.
            const gstins = await tx.organizationGstin.findMany({
              where: { organizationId: orgId, isActive: true },
              select: { stateCode: true, isDefault: true },
            });

            sellerRegistrations = {
              defaultStateCode:
                gstins.find((g) => g.isDefault)?.stateCode ??
                gstins[0]?.stateCode ??
                null,
              stateCodes: gstins.map((g) => g.stateCode),
            };

            // Two passes, matching the invoice: resolve a provisional place of
            // supply against the default registration, pick the registration
            // that actually supplies it, then re-resolve so an over-the-counter
            // sale lands on THAT registration's state rather than the default's.
            const provisionalPos = resolvePlaceOfSupply({
              explicitCode: dto.placeOfSupplyCode,
              shippingAddress: dto.shippingAddress ?? dto.customer.address,
              billingAddress:
                dto.billingAddress ?? dto.shippingAddress ?? dto.customer.address,
              customerBillingStateCode:
                dto.customer.billingStateCode ?? customer.billingStateCode,
              buyerGstin: dto.customer.gstin ?? customer.gstin,
              sellerStateCode: sellerRegistrations.defaultStateCode,
            });

            const stateCode = sellerStateForSupply(
              sellerRegistrations,
              provisionalPos,
            );
            sellerGstin = stateCode ? { stateCode } : null;
          }
        }

        // 5. Compute pricing per line item.
        //    Uses the SHARED resolver so the invoice cannot disagree with what
        //    the order was taxed with, and so the delivery address actually
        //    participates (Section 10(1)(a): place of supply for goods is where
        //    they are delivered). The resolved code is persisted on the order
        //    below and read back by the invoice.
        const placeOfSupplyCode = resolvePlaceOfSupply({
          explicitCode: dto.placeOfSupplyCode,
          shippingAddress: dto.shippingAddress ?? dto.customer.address,
          billingAddress:
            dto.billingAddress ?? dto.shippingAddress ?? dto.customer.address,
          customerBillingStateCode:
            dto.customer.billingStateCode ?? customer.billingStateCode,
          buyerGstin: dto.customer.gstin ?? customer.gstin,
          sellerStateCode: sellerGstin?.stateCode,
        });

        const isIntraState = sellerGstin
          ? this.calculator.isIntraState(
            sellerGstin.stateCode,
            placeOfSupplyCode,
          )
          : true;
        const resolvedGstType = isIntraState
          ? GstType.CGST_SGST
          : GstType.IGST;

        const lineItemsToCreate: Array<{
          variantId: string;
          title: string;
          variantTitle: string | null;
          sku: string | null;
          vendor: string | null;
          quantity: number;
          unitPrice: number;
          totalDiscount: number;
          lineTotal: number;
          taxAmount: number;
          taxable: boolean;
          /// The GST heads this line was charged, in the REST `tax_lines`
          /// shape (rate as a fraction) so `OrderLineItem.channelTaxLines`
          /// reads the same for offline and Shopify-pulled orders. The push
          /// to Shopify sends exactly these.
          taxLines: Array<{ title: string; rate: number; price: string }>;
        }> = [];

        let subtotal = 0;
        let totalTax = 0;

        // Every rate for the whole order in at most four queries, on THIS
        // transaction. This was one `resolveLineGstRate` call per line, each
        // issuing up to four queries on `this.prisma` rather than `tx` — so it
        // took a SECOND pooled connection per line while this transaction held
        // the first, and read the rates outside the Serializable snapshot that
        // prices the order.
        const lineGstRates = sellerGstin
          ? await this.taxResolver.resolveLineGstRates(
            orgId,
            placeOfSupplyCode,
            dto.lineItems.map((li) => {
              const v = variantById.get(li.productVariantId)!;
              return {
                productId: v.product.id,
                // toNullableNumber, not toNumber: null (no rate configured) and
                // 0 (explicitly exempt) must stay distinguishable. The variant's
                // own rate, when set, wins over the product's.
                variantGstRate: this.calculator.toNullableNumber(v.gstRate),
                productGstRate: this.calculator.toNullableNumber(v.product.gstRate),
                variantTaxable: v.taxable,
              };
            }),
            tx,
          )
          : dto.lineItems.map(() => 0);

        // Catalogue prices restated in the order's currency, once per line.
        // Resolved before the loop because it may hit the FX provider and the
        // loop body runs inside the Serializable transaction that prices the
        // order — see `catalogueUnitPrice`.
        const catalogueUnitPrices = await this.catalogueUnitPrices(
          orgId,
          orderCurrency,
          dto.lineItems.map((li) => variantById.get(li.productVariantId)!),
        );

        for (const [lineIndex, li] of dto.lineItems.entries()) {
          const v = variantById.get(li.productVariantId)!;
          // The cashier's typed price is authoritative and is already in the
          // order's currency; only the catalogue fallback needs converting.
          const unitPrice = li.unitPriceOverride ?? catalogueUnitPrices[lineIndex];
          const discount = li.discount ?? 0;

          // Validated here, not in the DTO: the unit price may come from the
          // variant rather than the payload, so the ceiling isn't knowable at
          // validation time. An over-large discount would otherwise produce a
          // negative taxable value, a negative invoice, and a decremented
          // customer lifetime value.
          const lineGross = this.calculator.round2(unitPrice * li.quantity);
          if (discount > lineGross) {
            throw new BadRequestException(
              `Discount (${discount}) cannot exceed the line total (${lineGross}) for "${v.product.title}".`,
            );
          }

          // Resolved above, in one batch. Still honours ProductVariant.taxable,
          // which no tax path read before this remediation.
          const gstRate = lineGstRates[lineIndex];

          const calc = this.calculator.calculateLineItem(
            { unitPrice, quantity: li.quantity, discount, gstRate },
            isIntraState,
          );

          subtotal += calc.taxableValue;
          totalTax += calc.totalTax;

          lineItemsToCreate.push({
            variantId: v.id,
            title: v.product.title,
            variantTitle: displayVariantTitle(v.title),
            sku: v.sku ?? null,
            vendor: v.product.vendorKey ?? v.product.vendor,
            quantity: li.quantity,
            unitPrice,
            totalDiscount: discount,
            lineTotal: calc.totalAmount,
            taxAmount: calc.totalTax,
            // Carried through so the persisted line records what it was
            // actually taxed as. Hardcoding `taxable: true` on the write made
            // ProductVariant.taxable unreachable — an order could never CARRY
            // a non-taxable line, so honouring the flag at rate resolution
            // would have changed nothing on this path.
            taxable: v.taxable !== false,
            taxLines: isIntraState
              ? [
                { title: 'CGST', rate: calc.cgstRate / 100, price: calc.cgstAmount.toFixed(2) },
                { title: 'SGST', rate: calc.sgstRate / 100, price: calc.sgstAmount.toFixed(2) },
              ].filter((t) => t.rate > 0)
              : [{ title: 'IGST', rate: calc.igstRate / 100, price: calc.igstAmount.toFixed(2) }]
                .filter((t) => t.rate > 0),
          });
        }

        const round = (n: number) => Math.round(n * 100) / 100;
        subtotal = round(subtotal);
        totalTax = round(totalTax);
        const grandTotal = round(subtotal + totalTax);

        // 6. Generate the next sequential orderNumber for the MANUAL channel.
        //    Scoped to this channel so offline sales run their own sequence
        //    instead of consuming the number Shopify is about to assign to its
        //    next online order. Collision safety comes from the PARTIAL unique
        //    index orders_channel_id_order_number_manual_key (manual rows only;
        //    Shopify legitimately re-issues numbers after store resets) plus
        //    the caller's bounded retry on P2002/P2034 — Serializable alone
        //    does not prevent this, and Prisma does not auto-retry
        //    serialization failures.
        const last = await tx.order.findFirst({
          where: { channelId: channel.id },
          orderBy: { orderNumber: 'desc' },
          select: { orderNumber: true },
        });
        const nextNumber = (last?.orderNumber ?? 1000) + 1;

        // 6a. Where the goods leave from — ONLY when the operator said so.
        //
        // Deliberately no default-warehouse fallback here. `Order.dispatch
        // WarehouseId` records a FACT (an operator's explicit choice, or
        // Shopify's real location assignment), and the invoice treats it as an
        // assertion: a warehouse registered under a different GSTIN than the
        // one issuing the invoice is refused outright. Stamping the org default
        // would turn the app's own guess into that assertion and refuse
        // ordinary sales — a supply into a state where the merchant holds a
        // second registration resolves that seller GSTIN, which the default
        // warehouse need have nothing to do with (fixture S5).
        //
        // With nothing stamped, the invoice falls back to the default itself,
        // where the same contradiction is silently dropped instead of fatal.
        let dispatchWarehouseId: string | null = null;
        if (dto.warehouseId) {
          const picked = await tx.warehouse.findFirst({
            where: { id: dto.warehouseId, organizationId: orgId, isActive: true },
            select: { id: true },
          });
          if (!picked) throw new NotFoundException('Warehouse not found');
          dispatchWarehouseId = picked.id;
        }

        // 7. Create the order with line items in a nested write.
        const now = new Date();
        const order = await tx.order.create({
          data: {
            organizationId: orgId,
            channelId: channel.id,
            customerId: customer.id,
            externalId: `manual_${randomUUID()}`,
            orderNumber: nextNumber,
            // "M" marks the order as manual/offline so it can never be confused
            // with a Shopify order carrying the same number on its own channel.
            name: `#M${nextNumber}`,
            financialStatus:
              dto.financialStatus ?? OrderFinancialStatus.PAID,
            fulfillmentStatus:
              dto.fulfillmentStatus ?? OrderFulfillmentStatus.FULFILLED,
            currency: orderCurrency,
            // A counter sale is priced in the org's own currency by
            // construction (the line above), so it converts at exactly 1 — no
            // rate lookup, and no dependence on the FX provider being up.
            // Set explicitly rather than left NULL, because NULL means
            // "unknown rate" and would exclude the order from every total.
            exchangeRate: 1,
            baseCurrency: orderCurrency,
            subtotalPrice: subtotal,
            totalPrice: grandTotal,
            totalTax,
            totalDiscounts: 0,
            totalShippingPrice: 0,
            // Prefer explicit order addresses (e.g. draft completion); else
            // customer.address so GST place-of-supply / packing slips aren't blank.
            shippingAddress: (dto.shippingAddress ??
              dto.customer.address ??
              null) as Prisma.InputJsonValue | undefined,
            billingAddress: (dto.billingAddress ??
              dto.shippingAddress ??
              dto.customer.address ??
              null) as Prisma.InputJsonValue | undefined,
            // What this order was ACTUALLY taxed with — the invoice reads these
            // back instead of re-deriving and possibly disagreeing.
            placeOfSupplyCode: sellerGstin ? placeOfSupplyCode : null,
            gstType: sellerGstin ? resolvedGstType : null,
            dispatchWarehouseId,
            // Unit prices are pre-tax and the tax is on the lines — the same
            // convention a Shopify order with `taxes_included: false` carries,
            // so the push and the eventual rebadge agree on every total.
            taxesIncluded: false,
            note: dto.note,
            metadata: {
              source: 'offline',
              paymentMethod: dto.paymentMethod,
              createdByUserId: userId,
            },
            externalCreatedAt: now,
            lineItems: {
              create: lineItemsToCreate.map((li) => ({
                variantId: li.variantId,
                externalId: `manual_${randomUUID()}`,
                title: li.title,
                variantTitle: li.variantTitle,
                sku: li.sku,
                vendor: li.vendor,
                quantity: li.quantity,
                price: li.unitPrice,
                totalDiscount: li.totalDiscount,
                taxable: li.taxable,
                // The MANUAL channel IS the sales channel here, so "tax the
                // channel charged" is the GST the CRM computed. Read back by
                // the Shopify push (see `pushOrder`).
                channelTaxAmount: li.taxAmount,
                channelTaxLines: li.taxLines as Prisma.InputJsonValue,
                requiresShipping: false,
              })),
            },
          },
          include: { lineItems: true },
        });

        // 8. Inventory decrement + audit trail. Skipped per-variant when
        //    trackQuantity=false AND the org-level trackQuantityGlobally
        //    override is off (e.g. digital goods / made-to-order). Each
        //    decrement gets an InventoryEvent row with reason="sale" so the
        //    org has a complete audit history of stock movements.
        //
        //    Warehousing orgs hold the truth in stock_levels; inventoryQuantity
        //    is only a cache the ledger recomputes as SUM(available). Writing
        //    that cache directly (as this did) took the units out of no
        //    warehouse, so the next applyMovement — an adjustment, or the
        //    Shopify per-location reconcile — recomputed the cache from
        //    stock_levels and RESURRECTED every sold unit. Observed on DEV
        //    2026-09-05: variant QA-2026-S-RED sold 2, cache 30→28, Kerala
        //    stayed at 30, and the next sync put the cache back to 55.
        //    This is the mirror image of the restock in `cancel`, which was
        //    already fixed for exactly this reason.
        const saleWarehousing = await this.ledger.isWarehousingEnabled(orgId);
        // Goods leave the warehouse the order dispatches from; without an
        // explicit pick that is the org default — the same rule the restock
        // uses to send them back, so a sale and its cancellation land on the
        // same shelf instead of drifting stock between warehouses.
        const saleWarehouseId = saleWarehousing
          ? (dispatchWarehouseId ??
            (
              await tx.warehouse.findFirst({
                where: { organizationId: orgId, isDefault: true },
                select: { id: true },
              })
            )?.id ??
            null)
          : null;
        if (saleWarehousing && !saleWarehouseId) {
          throw new BadRequestException(
            'This organisation tracks stock per warehouse but has no default warehouse. ' +
              'Set one under Products → Inventory → Warehouses, or choose a warehouse to dispatch from.',
          );
        }

        // Sorted by variantId: `applyMovement` takes a row lock per variant,
        // and every caller moving several variants in one transaction must take
        // those locks in the same order or two concurrent sales deadlock.
        const saleLines = [...dto.lineItems].sort((a, b) =>
          a.productVariantId.localeCompare(b.productVariantId),
        );

        for (const li of saleLines) {
          const v = variantById.get(li.productVariantId)!;
          if (!trackGlobally && v.trackQuantity === false) continue;
          soldVariantIds.push(v.id);

          if (saleWarehousing) {
            await this.ledger.applyMovement(
              {
                orgId,
                variantId: v.id,
                warehouseId: saleWarehouseId as string,
                // Stock leaves the system: out of AVAILABLE, into nothing.
                fromBucket: StockBucket.AVAILABLE,
                toBucket: null,
                quantity: li.quantity,
                reason: 'sale',
                referenceType: 'order',
                referenceId: order.id,
                actorId: userId,
                // Step 3a already refused this sale if the variant is tracked,
                // cannot oversell, and lacks the units ACROSS warehouses. Being
                // short at this one specific warehouse must not then fail a
                // counter sale the merchant is entitled to make — the shortfall
                // is recorded as negative available and surfaced by the
                // Inventory screen's "Oversold" filter.
                allowNegativeAvailable: true,
              },
              tx,
            );
            continue;
          }

          // Legacy orgs: one number per variant, no stock_levels to move.
          const updatedVariant = await tx.productVariant.update({
            where: { id: v.id },
            data: { inventoryQuantity: { decrement: li.quantity } },
            select: { inventoryQuantity: true },
          });
          await tx.inventoryEvent.create({
            data: {
              organizationId: orgId,
              variantId: v.id,
              quantityBefore: v.inventoryQuantity,
              quantityAfter: updatedVariant.inventoryQuantity,
              changeAmount: -li.quantity,
              reason: 'sale',
              referenceType: 'order',
              referenceId: order.id,
            },
          });
        }

        // 9. Customer counters are NOT incremented here. `ordersCount` and
        //    `totalSpent` are derived from the order table by
        //    LoyaltyService.recomputeForCustomer, which runs after this
        //    transaction commits. Incrementing in place is what allowed a later
        //    Shopify customer sync — which overwrites both fields wholesale —
        //    to wipe in-store purchase history.

        // 10. Timeline event.
        await tx.orderTimelineEvent.create({
          data: {
            orderId: order.id,
            actorId: userId,
            action: 'created',
            message: `Offline order created (${dto.paymentMethod})`,
          },
        });

        // 11. Generate invoice inline (soft-fail if GST isn't configured).
        let invoice: Awaited<
          ReturnType<typeof this.invoiceService.createForOrderTx>
        > | null = null;
        let invoiceError: string | null = null;

        if (generateInvoice && org.gstEnabled && sellerGstin) {
          try {
            invoice = await this.invoiceService.createForOrderTx(
              tx,
              orgId,
              order.id,
              {
                sellerGstinId: dto.sellerGstinId,
                // The RESOLVED code, not the raw (usually undefined) DTO field.
                // Passing the raw one made the invoice re-derive independently
                // and disagree with the tax the order just charged.
                placeOfSupplyCode,
                notes: dto.note,
              },
            );
          } catch (err) {
            // Soft-fail ONLY deliberate application-level rejections (missing
            // seller GSTIN, GST disabled, an invoice already issued). Those are
            // thrown after a successful query, so the transaction is still
            // healthy and the walk-in sale can proceed without its invoice.
            //
            // Every other error is a database failure, and swallowing one here
            // is never safe for two reasons:
            //   1. Postgres puts the transaction into aborted state (25P02) as
            //      soon as a statement errors, so every later statement in this
            //      transaction fails and COMMIT silently degrades to ROLLBACK —
            //      we would return a "successful" sale referencing an order row
            //      that was never persisted.
            //   2. Transient conflicts (P2002 on invoice number, P2034
            //      serialization abort, P2010 carrying SQLSTATE 40001) must
            //      reach retryOnNumberingConflict below to be retried at all.
            if (!(err instanceof HttpException)) {
              throw err;
            }
            invoiceError =
              err instanceof Error ? err.message : 'Invoice generation failed.';
            this.logger.warn(
              `Invoice soft-fail for offline order ${order.id}: ${invoiceError}`,
            );
            invoice = null;
          }
        } else if (generateInvoice && org.gstEnabled && !sellerGstin) {
          invoiceError =
            'No GSTIN registration found. Add one in Settings → Tax & GST.';
        } else if (generateInvoice && !org.gstEnabled) {
          invoiceError = 'GST is not enabled for this organization.';
        }

        // Persist the soft-fail, not just return it. This value was handed to
        // the caller once and then lost, so an offline sale that failed to
        // invoice left no trace anywhere — the same blind spot the Shopify
        // auto-invoice path had. Both now write the same two columns, and any
        // later successful issue clears them (see `createForOrderTx`).
        if (invoiceError) {
          await tx.order.update({
            where: { id: order.id },
            data: {
              invoiceError: invoiceError.slice(0, 500),
              invoiceErrorAt: new Date(),
            },
          });
        }

        return { order, invoice, invoiceError, soldVariantIds };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 15000,
      },
    );

    // Retry the whole sale on a numbering collision — order number OR invoice
    // number (the two sequences are both read-max-then-increment inside this
    // transaction). Safe to re-run because every side effect — numbers, stock
    // decrement — is allocated inside the transaction and only persists on
    // commit, so a rolled-back attempt consumes nothing.
    const result = await retryOnNumberingConflict(runSale, {
      isRetriableUniqueViolation: (e) =>
        uniqueViolationTargets(e, 'orderNumber') ||
        uniqueViolationTargets(e, 'invoiceNumber'),
      onRetry: (attempt) =>
        this.logger.warn(
          `Numbering collision on attempt ${attempt} — retrying sale`,
        ),
    });

    // Auto-push to Shopify — only if the org has opted in via
    // orderSettings.autoSyncToShopify. Default is OFF: offline orders stay
    // local and must be pushed manually (POST /orders/:id/sync) or in bulk
    // via the channels-page Sync action.
    // OUTSIDE the transaction so a queue/Redis hiccup never rolls back the
    // local sale.
    let orderPushedToShopify = false;
    try {
      const orderSettings = await this.settings.getOrderSettings(orgId);
      if (orderSettings.autoSyncToShopify) {
        const shopifyChannel = await this.shopifyPushService.findShopifyChannel(
          orgId,
        );
        if (shopifyChannel?.status === 'CONNECTED') {
          orderPushedToShopify = true;
          // Mark as PENDING immediately so the UI shows "Syncing to Shopify…"
          // even before the worker picks the job up.
          await this.markPendingSync(result.order.id, orgId);
          const queued = await this.shopifyPushEnqueuer.enqueueOrderPush({
            type: 'order',
            orderId: result.order.id,
            organizationId: orgId,
          });
          if (!queued) {
            // The claim above is only honest while a job exists. Without this
            // the order sat PENDING for ever: the server answered
            // ALREADY_QUEUED and the client hid the Sync action.
            await this.shopifyPushService.recordFailure(
              result.order.id,
              orgId,
              QUEUE_UNAVAILABLE_ERROR,
              /* incrementAttempt */ false,
            );
          }
        }
      }
    } catch (err) {
      this.logger.warn(
        `Skipping Shopify push enqueue for order ${result.order.id}: ${err}`,
      );
    }

    // An offline sale moves real stock, and Shopify wins on the next pull — so
    // without this push the decrement is silently reverted the next time the
    // per-location reconcile runs, and the units reappear as if never sold.
    //
    // Deliberately skipped when the order itself went to Shopify: Shopify
    // decrements its own inventory for an order it received, so setting
    // availability on top of that would take the units off twice. In that case
    // the pull reconciles us to Shopify's figure, which is already correct.
    //
    // Outside the transaction and non-fatal, exactly like the restock push in
    // `cancel`: a queue outage must not roll back a completed sale.
    if (result.soldVariantIds.length > 0 && !orderPushedToShopify) {
      try {
        await this.shopifyPushQueue.add(
          'push-availability',
          {
            type: 'push-availability',
            organizationId: orgId,
            variantIds: [...new Set(result.soldVariantIds)],
          },
          { attempts: 5, backoff: { type: 'exponential', delay: 10_000 } },
        );
      } catch (err) {
        this.logger.warn(
          `Failed to enqueue availability push after offline sale ${result.order.id}: ${err}`,
        );
      }
    }

    // The sale just moved ordersCount/totalSpent, and the loyalty tier is
    // derived from them. Non-fatal and outside the transaction — a tier refresh
    // must never roll back a completed sale.
    await this.loyalty
      .recomputeForCustomer(result.order.customerId!, orgId)
      .catch((err) =>
        this.logger.warn(
          `Loyalty recompute failed for order ${result.order.id}: ${err}`,
        ),
      );

    return result;
  }

  // ─── MANUAL SYNC TO SHOPIFY ───
  // Push a single MANUAL offline order to the connected Shopify store on
  // demand. Idempotent — already-synced orders return early; already-queued
  // ones don't re-enqueue; failed pushes are retried.
  /**
   * The orders immediately either side of this one, for the detail page's
   * Previous / Next rail.
   *
   * Replaces a client-side approach that fetched the first 100 UNFULFILLED
   * orders and searched them: opening a FULFILLED order found nothing, so both
   * buttons were dead (16 of 48 orders on the dev data), and past 100 orders
   * even open ones fell off the end. It also pulled 100 fully-hydrated orders on
   * every detail page view to compute two ids.
   *
   * Ordering is `COALESCE(external_created_at, created_at) DESC, id DESC` —
   * newest first, matching the orders list. The COALESCE matters because
   * `externalCreatedAt` is null for CRM-native orders, and the list's raw
   * `externalCreatedAt` sort would clump them; `id` breaks ties so the sequence
   * is total and stable (two orders can share a timestamp).
   *
   * Row-value comparison `(a, b) < (c, d)` gives the neighbour in one indexed
   * seek per direction rather than a scan.
   */
  async findAdjacent(id: string, orgId: string, vendorScope?: string) {
    const order = await this.prisma.order.findFirst({
      where: { id, organizationId: orgId, deletedAt: null },
      select: { id: true, externalCreatedAt: true, createdAt: true },
    });
    if (!order) throw new NotFoundException('Order not found');

    const anchor = order.externalCreatedAt ?? order.createdAt;
    // A vendor navigates only orders containing their own items — the same rule
    // the list applies via `where.lineItems.some.vendor`.
    const vendorFilter = vendorScope
      ? Prisma.sql`AND EXISTS (
          SELECT 1 FROM "order_line_items" li
          WHERE li."order_id" = o."id" AND li."vendor" = ${vendorScope}
        )`
      : Prisma.empty;
    const scope = Prisma.sql`
      o."organization_id" = ${orgId} AND o."deleted_at" IS NULL ${vendorFilter}`;

    const [older, newer, before, total] = await Promise.all([
      // "Next order" — the row after this one in a newest-first list.
      this.prisma.$queryRaw<Array<{ id: string }>>`
        SELECT o."id" FROM "orders" o WHERE ${scope}
          AND (COALESCE(o."external_created_at", o."created_at"), o."id") < (${anchor}, ${order.id})
        ORDER BY COALESCE(o."external_created_at", o."created_at") DESC, o."id" DESC LIMIT 1`,
      // "Previous" — the row before it.
      this.prisma.$queryRaw<Array<{ id: string }>>`
        SELECT o."id" FROM "orders" o WHERE ${scope}
          AND (COALESCE(o."external_created_at", o."created_at"), o."id") > (${anchor}, ${order.id})
        ORDER BY COALESCE(o."external_created_at", o."created_at") ASC, o."id" ASC LIMIT 1`,
      // How many sort ahead of it — gives an exact "N of M" with no window.
      this.prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*)::bigint AS count FROM "orders" o WHERE ${scope}
          AND (COALESCE(o."external_created_at", o."created_at"), o."id") > (${anchor}, ${order.id})`,
      this.prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*)::bigint AS count FROM "orders" o WHERE ${scope}`,
    ]);

    return {
      previousId: newer[0]?.id ?? null,
      nextId: older[0]?.id ?? null,
      position: Number(before[0]?.count ?? 0) + 1,
      total: Number(total[0]?.count ?? 0),
    };
  }

  async syncToShopify(id: string, orgId: string, userId?: string) {
    const order = await this.loadOrderWithChannel(id, orgId);

    if (order.channel.platform !== ChannelPlatform.MANUAL) {
      throw new BadRequestException(
        'Only offline (MANUAL channel) orders can be synced to Shopify. This order originated in Shopify.',
      );
    }

    const shopifyChannel = await this.shopifyPushService.findShopifyChannel(orgId);
    if (!shopifyChannel || shopifyChannel.status !== ChannelStatus.CONNECTED) {
      throw new BadRequestException(
        'No connected Shopify channel. Connect Shopify first, then sync.',
      );
    }

    const meta = (order.metadata as Prisma.JsonObject) ?? {};
    const sync = (meta.shopifySync ?? null) as
      | { status: 'PENDING' | 'SYNCED' | 'FAILED'; queuedAt?: string }
      | null;

    if (sync?.status === 'SYNCED') {
      return { status: 'ALREADY_SYNCED' as const, orderId: order.id };
    }
    // A PENDING claim is only trusted while it is young enough to still be
    // in flight. An older one means the job never ran or was lost (queue
    // down at claim time, job evicted) — let the merchant re-claim it. The
    // enqueuer's per-order job id makes that safe even if the old job is
    // somehow still live.
    if (sync?.status === 'PENDING' && !isStalePendingSync(sync)) {
      return { status: 'ALREADY_QUEUED' as const, orderId: order.id };
    }

    // The status read above is a snapshot; a worker can finish a push between
    // it and this claim. markPendingSync refuses to demote a SYNCED order, so a
    // lost claim means exactly that happened — report it rather than enqueueing
    // a duplicate push.
    const claimed = await this.markPendingSync(order.id, orgId);
    if (!claimed) {
      return { status: 'ALREADY_SYNCED' as const, orderId: order.id };
    }

    // Recorded only once the claim is won, so the timeline shows one entry per
    // push actually enqueued rather than one per button press. The push's own
    // success/failure lands in metadata.shopifySync, not here.
    await this.prisma.orderTimelineEvent.create({
      data: {
        orderId: order.id,
        actorId: userId ?? null,
        action: 'sync_queued',
        message: 'Queued for sync to Shopify',
      },
    });

    const queued = await this.shopifyPushEnqueuer.enqueueOrderPush({
      type: 'order',
      orderId: order.id,
      organizationId: orgId,
    });
    if (!queued) {
      await this.shopifyPushService.recordFailure(
        order.id,
        orgId,
        QUEUE_UNAVAILABLE_ERROR,
        /* incrementAttempt */ false,
      );
      throw new ServiceUnavailableException(
        'The Shopify sync queue is unavailable right now. The order is marked as failed to sync — try again in a few minutes.',
      );
    }
    return { status: 'QUEUED' as const, orderId: order.id };
  }

  /**
   * Claim an order for a Shopify push by stamping
   * metadata.shopifySync = { status: 'PENDING', attempts: 0 }.
   *
   * Atomic JSONB merge (H7) — does not read-modify-write the whole blob — and
   * guarded so it can never demote an order a worker has already marked
   * SYNCED. Without that guard a push completing between the caller's status
   * read and this write would be overwritten with PENDING, and the order would
   * be pushed to Shopify a second time.
   *
   * Returns true when this call won the claim.
   */
  private async markPendingSync(
    orderId: string,
    organizationId: string,
  ): Promise<boolean> {
    const updated = await mergeJsonMetadata(
      this.prisma,
      'orders',
      orderId,
      organizationId,
      {
        shopifySync: {
          status: 'PENDING',
          attempts: 0,
          // Dates the claim so `isStalePendingSync` can tell a lost job from
          // one still working through its retries.
          queuedAt: new Date().toISOString(),
        },
      },
      Prisma.sql`AND COALESCE("metadata" -> 'shopifySync' ->> 'status', '') <> 'SYNCED'`,
    );
    return updated > 0;
  }

  private async resolveCustomer(
    tx: Prisma.TransactionClient,
    orgId: string,
    manualChannelId: string,
    dto: CreateOfflineOrderDto,
  ) {
    const input = dto.customer;

    if (input.customerId) {
      const existing = await tx.customer.findFirst({
        where: { id: input.customerId, organizationId: orgId },
      });
      if (!existing) {
        throw new NotFoundException('Customer not found');
      }
      return existing;
    }

    if (input.email) {
      const byEmail = await tx.customer.findFirst({
        where: { organizationId: orgId, email: input.email },
      });
      if (byEmail) {
        return this.fillMissingCustomerFields(tx, byEmail, input);
      }
    }

    if (input.phone) {
      const byPhone = await tx.customer.findFirst({
        where: { organizationId: orgId, phone: input.phone },
      });
      if (byPhone) {
        return this.fillMissingCustomerFields(tx, byPhone, input);
      }
    }

    if (!input.email && !input.phone && !input.firstName && !input.lastName) {
      throw new BadRequestException(
        'Customer details required: provide at least one of customerId, email, phone, or a name.',
      );
    }

    return tx.customer.create({
      data: {
        organizationId: orgId,
        channelId: manualChannelId,
        externalId: `manual_${randomUUID()}`,
        email: input.email ?? null,
        firstName: input.firstName ?? null,
        lastName: input.lastName ?? null,
        phone: input.phone ?? null,
        gstin: input.gstin ?? null,
        billingStateCode: input.billingStateCode ?? null,
        ...(input.address
          ? {
            addresses: [input.address] as Prisma.InputJsonValue,
            defaultAddress: input.address as Prisma.InputJsonValue,
          }
          : {}),
      },
    });
  }

  private async fillMissingCustomerFields(
    tx: Prisma.TransactionClient,
    existing: {
      id: string;
      firstName: string | null;
      lastName: string | null;
      gstin: string | null;
      billingStateCode: string | null;
    },
    input: CreateOfflineOrderDto['customer'],
  ) {
    const patch: Prisma.CustomerUpdateInput = {};
    if (!existing.firstName && input.firstName) patch.firstName = input.firstName;
    if (!existing.lastName && input.lastName) patch.lastName = input.lastName;
    if (!existing.gstin && input.gstin) patch.gstin = input.gstin;
    if (!existing.billingStateCode && input.billingStateCode) {
      patch.billingStateCode = input.billingStateCode;
    }

    if (Object.keys(patch).length === 0) {
      return existing;
    }

    return tx.customer.update({ where: { id: existing.id }, data: patch });
  }

  // ─── PHASE 1: LIFECYCLE & METADATA ────────────────────────────────────────
  // Each operation branches on `order.channel.platform`:
  //   - SHOPIFY: call the matching GraphQL mutation, then mirror to DB.
  //   - MANUAL:  apply locally only.
  // A timeline event is written on every successful action so the order
  // detail page renders an audit trail regardless of channel.

  /**
   * Edit metadata on an existing order: tags, note, customer contact, address,
   * custom attributes. For SHOPIFY, fields propagate via `orderUpdate`. For
   * MANUAL, only fields with a local column are persisted (others are accepted
   * but ignored — they're meaningful only when there's a Shopify mirror).
   */
  async update(id: string, orgId: string, userId: string, dto: UpdateOrderDto) {
    const order = await this.loadOrderWithChannel(id, orgId);
    const isShopify = order.channel.platform === ChannelPlatform.SHOPIFY;

    // Shopify's `OrderInput` has no `billingAddress` field — it exists only on
    // `OrderCreateInput`. So this edit could never reach Shopify, and writing
    // it locally alone is worse than refusing: `upsertOrder` applies whatever
    // address the next `orders/updated` webhook carries, silently reverting it.
    // Refuse loudly instead. MANUAL orders are unaffected.
    if (isShopify && dto.billingAddress !== undefined) {
      throw new BadRequestException(
        "A Shopify order's billing address can't be changed here — Shopify's API doesn't accept it, so the change would be overwritten on the next sync. Update it in Shopify admin instead.",
      );
    }

    if (isShopify) {
      const { token, shopDomain } = await this.shopifyOAuth.getAccessToken(order.channel.id);
      const input: OrderUpdateInput = {
        id: ShopifyGraphqlClient.toGid('Order', order.externalId),
      };
      if (dto.tags !== undefined) input.tags = dto.tags;
      if (dto.note !== undefined) input.note = dto.note;
      if (dto.shippingAddress !== undefined) {
        input.shippingAddress = this.toShopifyAddress(dto.shippingAddress);
      }
      const result = await this.graphql.request<OrderUpdateResponse, OrderUpdateVariables>(
        { shopDomain, accessToken: token },
        ORDER_UPDATE_MUTATION,
        { input },
      );
      ShopifyGraphqlClient.throwIfUserErrors(result.orderUpdate.userErrors, 'orderUpdate');
    }

    return this.prisma.$transaction(async (tx) => {
      const data: Prisma.OrderUpdateInput = {};
      if (dto.tags !== undefined) data.tags = dto.tags;
      if (dto.note !== undefined) data.note = dto.note;
      if (dto.shippingAddress !== undefined) {
        data.shippingAddress = dto.shippingAddress as Prisma.InputJsonValue;
      }
      if (dto.billingAddress !== undefined) {
        data.billingAddress = dto.billingAddress as Prisma.InputJsonValue;
      }
      const updated = Object.keys(data).length > 0
        ? await tx.order.update({ where: { id }, data })
        : order;

      // Report what was actually WRITTEN, not what was sent. This was derived
      // from the DTO, so fields the write block ignored still appeared in the
      // event — a manual order recorded "Order details updated (email, phone)"
      // having stored neither. Deriving it from `data` means a field added to
      // the DTO without a matching write can't quietly lie again.
      const updatedFields = Object.keys(data);

      await tx.orderTimelineEvent.create({
        data: {
          orderId: id,
          actorId: userId,
          action: 'updated',
          message: `Order details updated (${updatedFields.join(', ') || 'no changes'})`,
          metadata: { updatedFields } as Prisma.InputJsonValue,
        },
      });
      return updated;
    });
  }

  /**
   * Cancel an order. Shopify's `orderCancel` is async — it returns a Job and
   * the actual cancellation happens in the background. We apply an optimistic
   * local update (cancelledAt, cancelReason, optional refund/restock status)
   * and rely on the `orders/cancelled` webhook to reconcile fully.
   */
  async cancel(id: string, orgId: string, userId: string, dto: CancelOrderDto) {
    const order = await this.loadOrderWithChannel(id, orgId);
    // Fast, friendly path for the common case. This read is NOT the real guard
    // — `cancelledAt` is written much later, inside the transaction below — so
    // the atomic claim there is what actually prevents two concurrent cancels
    // from both restocking inventory and both decrementing customer counters.
    if (order.cancelledAt) {
      throw new BadRequestException('Order is already cancelled');
    }
    const isShopify = order.channel.platform === ChannelPlatform.SHOPIFY;
    // Variants restocked into a warehouse bucket; pushed to Shopify after the
    // transaction commits so a failed push can never roll back the cancel.
    const restockedVariantIds: string[] = [];

    if (isShopify) {
      const { token, shopDomain } = await this.shopifyOAuth.getAccessToken(order.channel.id);
      const auth = { shopDomain, accessToken: token };
      const orderGid = ShopifyGraphqlClient.toGid('Order', order.externalId);

      // Shopify refuses to cancel an order that still has active fulfilments
      // ("Cannot cancel an order that has outstanding fulfillments"), so cancel
      // those first (best-effort), then cancel the order itself.
      const ffResp = await this.graphql.request<OrderFulfillmentsWithLinesResponse, { id: string }>(
        auth,
        ORDER_FULFILLMENTS_WITH_LINES_QUERY,
        { id: orderGid },
      );
      for (const f of ffResp.order?.fulfillments ?? []) {
        if (f.status === 'CANCELLED') continue;
        await this.cancelFulfillmentOnShopify(
          order,
          ShopifyGraphqlClient.extractId(f.id),
        ).catch((e) =>
          this.logger.warn(
            `Could not cancel fulfilment before order cancel on ${id}: ${e instanceof Error ? e.message : e
            }`,
          ),
        );
      }

      const variables: OrderCancelVariables = {
        orderId: orderGid,
        reason: dto.reason,
        refund: dto.refund ?? false,
        restock: dto.restock ?? true,
        notifyCustomer: dto.notifyCustomer ?? true,
        staffNote: dto.staffNote ?? null,
      };
      const result = await this.graphql.request<OrderCancelResponse, OrderCancelVariables>(
        auth,
        ORDER_CANCEL_MUTATION,
        variables,
      );
      ShopifyGraphqlClient.throwIfUserErrors(
        result.orderCancel.orderCancelUserErrors,
        'orderCancel',
      );

      // Reflect the fulfilment cancellations locally (webhooks reconcile too).
      await this.prisma.orderFulfillment.updateMany({
        where: { orderId: id, status: { not: 'cancelled' } },
        data: { status: 'cancelled' },
      });
    }

    const cancelled = await this.prisma.$transaction(async (tx) => {
      const data: Prisma.OrderUpdateManyMutationInput = {
        cancelReason: dto.reason,
        cancelledAt: new Date(),
      };
      if (dto.refund) data.financialStatus = OrderFinancialStatus.REFUNDED;
      if (dto.restock) data.fulfillmentStatus = OrderFulfillmentStatus.RESTOCKED;

      // Atomic claim. `cancelledAt: null` is the precondition, so exactly one
      // concurrent caller can transition the order — the loser matches zero
      // rows and bails out before the restock and counter reversal below.
      // No compensating revert is needed: the claim shares this transaction
      // with every side effect, so a rollback releases it automatically.
      // Same exception as the early check above, so a race-loser and a late
      // arrival are indistinguishable to the client.
      const claimed = await tx.order.updateMany({
        where: { id, organizationId: orgId, cancelledAt: null },
        data,
      });
      if (claimed.count === 0) {
        throw new BadRequestException('Order is already cancelled');
      }
      const updated = await tx.order.findUniqueOrThrow({ where: { id } });

      // Local restock for MANUAL channel orders. Shopify orders are restocked
      // server-side by the orderCancel mutation we already sent — adjusting
      // inventory locally would double-count once the next pull-sync lands.
      if (dto.restock && !isShopify) {
        const productSettings = await this.settings.getProductSettings(orgId);
        const trackGlobally = productSettings.trackQuantityGlobally === true;

        // Warehousing orgs hold the truth in stock_levels; inventoryQuantity is
        // only a cache the ledger recomputes. Incrementing that cache directly
        // (as this did) left stock_levels untouched, attributed the restock to
        // no warehouse, told Shopify nothing, and was silently discarded by the
        // next applyMovement, which recomputes the cache from stock_levels.
        const warehousing = await this.ledger.isWarehousingEnabled(orgId);
        // Goods return to the warehouse they were dispatched from; fall back to
        // the default for orders stamped before dispatch was recorded.
        const restockWarehouseId = warehousing
          ? (updated.dispatchWarehouseId ??
            (
              await tx.warehouse.findFirst({
                where: { organizationId: orgId, isDefault: true },
                select: { id: true },
              })
            )?.id ??
            null)
          : null;
        if (warehousing && !restockWarehouseId) {
          this.logger.warn(
            `Cannot restock order ${id}: org ${orgId} has warehousing on but no dispatch or default warehouse.`,
          );
        }

        const lineItems = await tx.orderLineItem.findMany({
          where: { orderId: id },
          include: { variant: true },
        });
        for (const li of lineItems) {
          if (!li.variant) continue;
          if (!trackGlobally && li.variant.trackQuantity === false) continue;

          if (warehousing) {
            if (!restockWarehouseId) continue;
            await this.ledger.applyMovement(
              {
                orgId,
                variantId: li.variant.id,
                warehouseId: restockWarehouseId,
                fromBucket: null,
                toBucket: StockBucket.AVAILABLE,
                quantity: li.quantity,
                reason: 'restock',
                referenceType: 'order',
                referenceId: id,
                actorId: userId,
                // A retried cancel must not restock twice. The atomic claim
                // above already blocks a second cancel; this covers a retry
                // that reaches here after a partial failure.
                idempotencyKey: `restock:${id}:${li.id}`,
              },
              tx,
            );
            restockedVariantIds.push(li.variant.id);
            continue;
          }

          // Legacy orgs: one number per variant, no stock_levels to move.
          const updatedVariant = await tx.productVariant.update({
            where: { id: li.variant.id },
            data: { inventoryQuantity: { increment: li.quantity } },
            select: { inventoryQuantity: true },
          });
          await tx.inventoryEvent.create({
            data: {
              organizationId: orgId,
              variantId: li.variant.id,
              quantityBefore: li.variant.inventoryQuantity,
              quantityAfter: updatedVariant.inventoryQuantity,
              changeAmount: li.quantity,
              reason: 'restock',
              referenceType: 'order',
              referenceId: id,
            },
          });
        }
      }

      // Customer counters are not adjusted here — they are derived from the
      // order table, and the `cancelledAt` we just set removes this order from
      // that derivation. The recompute below applies it.

      await tx.orderTimelineEvent.create({
        data: {
          orderId: id,
          actorId: userId,
          action: 'cancelled',
          message: `Order cancelled (${dto.reason})${dto.staffNote ? `: ${dto.staffNote}` : ''}`,
          metadata: {
            reason: dto.reason,
            refund: dto.refund ?? false,
            restock: dto.restock ?? true,
            notifyCustomer: dto.notifyCustomer ?? true,
          } as Prisma.InputJsonValue,
        },
      });
      return updated;
    });

    // Re-derive the customer's counters (and therefore their tier) now that
    // this order is cancelled. Every channel, not just MANUAL — the counters
    // are derived from all orders. Non-fatal and outside the transaction: a
    // tier refresh must never roll back a cancellation, and because the values
    // are derived rather than incremental, a failure here is repaired by the
    // next recompute rather than lost.
    if (order.customerId) {
      await this.loyalty
        .recomputeForCustomer(order.customerId, orgId)
        .catch((err) =>
          this.logger.warn(
            `Loyalty recompute failed after cancelling order ${id}: ${err}`,
          ),
        );
    }

    // Restocked units are only real to Shopify once pushed. Outside the
    // transaction and non-fatal for the same reason as the loyalty recompute:
    // a queue outage must not roll back a completed cancellation. The push is
    // per-warehouse, so it lands at the location the goods returned to.
    if (restockedVariantIds.length > 0) {
      try {
        await this.shopifyPushQueue.add(
          'push-availability',
          {
            type: 'push-availability',
            organizationId: orgId,
            variantIds: [...new Set(restockedVariantIds)],
          },
          { attempts: 5, backoff: { type: 'exponential', delay: 10_000 } },
        );
      } catch (err) {
        this.logger.warn(
          `Failed to enqueue availability push after cancelling order ${id}: ${err}`,
        );
      }
    }

    return cancelled;
  }

  /** Archive (close) an order. Reversible via `open()`. */
  async close(id: string, orgId: string, userId: string) {
    const order = await this.loadOrderWithChannel(id, orgId);
    if (order.closedAt) {
      throw new BadRequestException('Order is already closed');
    }
    const isShopify = order.channel.platform === ChannelPlatform.SHOPIFY;

    if (isShopify) {
      const { token, shopDomain } = await this.shopifyOAuth.getAccessToken(order.channel.id);
      const result = await this.graphql.request<OrderCloseResponse, OrderCloseOrOpenVariables>(
        { shopDomain, accessToken: token },
        ORDER_CLOSE_MUTATION,
        { input: { id: ShopifyGraphqlClient.toGid('Order', order.externalId) } },
      );
      ShopifyGraphqlClient.throwIfUserErrors(result.orderClose.userErrors, 'orderClose');
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.order.update({
        where: { id },
        data: { closedAt: new Date() },
      });
      await tx.orderTimelineEvent.create({
        data: { orderId: id, actorId: userId, action: 'closed', message: 'Order archived' },
      });
      return updated;
    });
  }

  /** Un-archive (reopen) a previously closed order. */
  async open(id: string, orgId: string, userId: string) {
    const order = await this.loadOrderWithChannel(id, orgId);
    if (!order.closedAt) {
      throw new BadRequestException('Order is already open');
    }
    const isShopify = order.channel.platform === ChannelPlatform.SHOPIFY;

    if (isShopify) {
      const { token, shopDomain } = await this.shopifyOAuth.getAccessToken(order.channel.id);
      const result = await this.graphql.request<OrderOpenResponse, OrderCloseOrOpenVariables>(
        { shopDomain, accessToken: token },
        ORDER_OPEN_MUTATION,
        { input: { id: ShopifyGraphqlClient.toGid('Order', order.externalId) } },
      );
      ShopifyGraphqlClient.throwIfUserErrors(result.orderOpen.userErrors, 'orderOpen');
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.order.update({
        where: { id },
        data: { closedAt: null },
      });
      await tx.orderTimelineEvent.create({
        data: { orderId: id, actorId: userId, action: 'reopened', message: 'Order re-opened' },
      });
      return updated;
    });
  }

  /** Mark an outstanding order as paid (e.g. cash-on-delivery, wire, COD). */
  async markPaid(id: string, orgId: string, userId: string) {
    const order = await this.loadOrderWithChannel(id, orgId);
    if (order.financialStatus === OrderFinancialStatus.PAID) {
      throw new BadRequestException('Order is already paid');
    }
    const isShopify = order.channel.platform === ChannelPlatform.SHOPIFY;

    if (isShopify) {
      const { token, shopDomain } = await this.shopifyOAuth.getAccessToken(order.channel.id);
      const result = await this.graphql.request<
        OrderMarkAsPaidResponse,
        OrderMarkAsPaidVariables
      >(
        { shopDomain, accessToken: token },
        ORDER_MARK_AS_PAID_MUTATION,
        { input: { id: ShopifyGraphqlClient.toGid('Order', order.externalId) } },
      );
      ShopifyGraphqlClient.throwIfUserErrors(
        result.orderMarkAsPaid.userErrors,
        'orderMarkAsPaid',
      );
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.order.update({
        where: { id },
        data: { financialStatus: OrderFinancialStatus.PAID },
      });
      await tx.orderTimelineEvent.create({
        data: { orderId: id, actorId: userId, action: 'paid', message: 'Order marked as paid' },
      });
      return row;
    });

    // This IS the payment edge, so it invoices on the same terms as a Shopify
    // webhook. Writing PAID locally used to defeat the webhook trigger: the
    // reconciling `orders/updated` then saw PAID → PAID, which is not a
    // transition, so marking an order paid in the CRM never produced an
    // invoice. After the commit and non-throwing, like every other caller.
    await this.invoiceService.autoInvoiceForPaidOrder(orgId, id);
    return updated;
  }

  /**
   * Capture an authorized payment. Only valid for SHOPIFY orders — MANUAL
   * orders don't have an authorize/capture cycle; use `markPaid` instead.
   *
   * Flow for Shopify:
   *   1. Query the order's transactions to find a successful AUTHORIZATION.
   *   2. Call `orderCapture` against that transaction.
   *   3. Mirror the financialStatus locally (the orders/updated webhook also
   *      fires and reconciles within seconds).
   */
  async capture(id: string, orgId: string, userId: string, dto: CapturePaymentDto) {
    const order = await this.loadOrderWithChannel(id, orgId);
    if (
      order.financialStatus === OrderFinancialStatus.PAID ||
      order.financialStatus === OrderFinancialStatus.REFUNDED
    ) {
      throw new BadRequestException('Order has no capturable balance');
    }
    if (order.channel.platform !== ChannelPlatform.SHOPIFY) {
      throw new BadRequestException(
        'Manual orders have no authorize/capture cycle. Use mark-paid instead.',
      );
    }

    const { token, shopDomain } = await this.shopifyOAuth.getAccessToken(order.channel.id);
    const auth = { shopDomain, accessToken: token };
    const gid = ShopifyGraphqlClient.toGid('Order', order.externalId);

    const txResp = await this.graphql.request<
      OrderCapturableTransactionsResponse,
      OrderCapturableTransactionsVariables
    >(auth, ORDER_CAPTURABLE_TRANSACTIONS_QUERY, { id: gid });

    const authTx = txResp.order?.transactions.find(
      (t) => t.kind === 'AUTHORIZATION' && t.status === 'SUCCESS',
    );
    if (!authTx) {
      throw new BadRequestException(
        'No authorize transaction available to capture against this order.',
      );
    }

    // Never capture more than was authorised.
    //
    // The only prior checks were "not already PAID/REFUNDED" and "is Shopify";
    // `dto.amount` went straight into the mutation, and the DTO caps it at
    // nothing (`@IsNumber() @Min(0)`). Shopify was the sole backstop on a path
    // that moves real money. The authorised figure is already in hand — it is
    // this method's own fallback below — so this costs no extra call.
    //
    // Rejected rather than silently clamped: quietly correcting a wrong amount
    // hides whatever produced it.
    const authorized = Number(authTx.amountSet.shopMoney.amount);
    if (dto.amount !== undefined && Number.isFinite(authorized) && dto.amount > authorized) {
      throw new BadRequestException(
        `Cannot capture ${dto.amount.toFixed(2)} — only ${authorized.toFixed(2)} ` +
        `${authTx.amountSet.shopMoney.currencyCode} was authorised on this order.`,
      );
    }

    const amountStr =
      dto.amount !== undefined ? dto.amount.toFixed(2) : authTx.amountSet.shopMoney.amount;

    const capResp = await this.graphql.request<OrderCaptureResponse, OrderCaptureVariables>(
      auth,
      ORDER_CAPTURE_MUTATION,
      {
        input: {
          id: gid,
          parentTransactionId: authTx.id,
          amount: amountStr,
          currency: dto.currency ?? authTx.amountSet.shopMoney.currencyCode,
          finalCapture: dto.finalCapture ?? false,
        },
      },
    );
    ShopifyGraphqlClient.throwIfUserErrors(capResp.orderCapture.userErrors, 'orderCapture');

    const captured = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.order.update({
        where: { id },
        data: { financialStatus: OrderFinancialStatus.PAID },
      });
      await tx.orderTimelineEvent.create({
        data: {
          orderId: id,
          actorId: userId,
          action: 'captured',
          message: `Payment captured (${amountStr} ${dto.currency ?? authTx.amountSet.shopMoney.currencyCode})`,
          metadata: {
            transactionId: capResp.orderCapture.transaction?.id ?? null,
            amount: amountStr,
            finalCapture: dto.finalCapture ?? false,
          } as Prisma.InputJsonValue,
        },
      });
      return updated;
    });

    // Capturing IS the payment edge — same reasoning as `markPaid`.
    await this.invoiceService.autoInvoiceForPaidOrder(orgId, id);
    return captured;
  }

  // ─── PHASE 2: FULFILLMENT & TRACKING ──────────────────────────────────────
  // Three actions: create a fulfillment (mark items shipped + tracking),
  // update tracking on an existing fulfillment, cancel a fulfillment.
  // SHOPIFY orders round-trip via the matching GraphQL mutations and the
  // fulfillments/* + orders/fulfilled webhooks reconcile state. MANUAL orders
  // are purely local — the OrderFulfillment row and the per-line-item
  // `fulfillmentStatus` column carry the truth.

  /**
   * Return the line items still available to fulfill. For Shopify this calls
   * `order.fulfillmentOrders` and flattens the open FOs into a UI-friendly
   * shape (preserving the FO id so the UI doesn't need to know about it,
   * but `createFulfillment` can recover it from the line item ID). For
   * manual orders it just lists local line items not yet marked fulfilled.
   */
  /**
   * What is still shippable on an order. For a VENDOR this is narrowed to their
   * own lines: the dialog this feeds sits on orders that routinely carry several
   * vendors, and an unscoped list showed each of them everyone else's titles,
   * SKUs and quantities. The write paths were never exposed — `createFulfillment`
   * asserts ownership — but the read leaked all the same.
   */
  async listFulfillableLineItems(
    orderId: string,
    orgId: string,
    vendorScope?: string,
  ) {
    const order = await this.loadOrderWithChannel(orderId, orgId);

    if (order.channel.platform === ChannelPlatform.SHOPIFY) {
      const { token, shopDomain } = await this.shopifyOAuth.getAccessToken(order.channel.id);
      const resp = await this.graphql.request<
        OrderFulfillmentOrdersResponse,
        { id: string }
      >(
        { shopDomain, accessToken: token },
        ORDER_FULFILLMENT_ORDERS_QUERY,
        { id: ShopifyGraphqlClient.toGid('Order', order.externalId) },
      );
      const fos = resp.order?.fulfillmentOrders.nodes ?? [];

      // Shopify knows nothing about our vendor column, so resolve the vendor's
      // lines locally and match on the Shopify line-item id they mirror.
      let visible: Set<string> | null = null;
      if (vendorScope) {
        const mine = await this.prisma.orderLineItem.findMany({
          where: { orderId, vendor: vendorScope },
          select: { externalId: true },
        });
        visible = new Set(mine.map((l) => l.externalId));
      }
      const keep = (shopifyLineId: string) => !visible || visible.has(shopifyLineId);

      return {
        source: 'shopify' as const,
        fulfillmentOrders: fos
          .map((fo) => ({
            id: fo.id,
            status: fo.status,
            locationName: fo.assignedLocation?.name ?? null,
            lineItems: fo.lineItems.nodes
              .filter((li) => keep(ShopifyGraphqlClient.extractId(li.lineItem.id)))
              .map((li) => ({
            // `lineItemId` is the OrderLineItem numeric ID; that's what the
            // create-fulfillment endpoint accepts. The internal FO line item
            // ID is resolved server-side from it.
                lineItemId: ShopifyGraphqlClient.extractId(li.lineItem.id),
                title: li.lineItem.title,
                variantTitle: li.lineItem.variantTitle,
                sku: li.lineItem.sku,
                remainingQuantity: li.remainingQuantity,
                totalQuantity: li.totalQuantity,
              })),
          }))
          // A fulfilment order holding none of this vendor's lines would
          // otherwise render as an empty group in the dialog.
          .filter((fo) => fo.lineItems.length > 0),
      };
    }

    // Every line, filtered in JS on what is actually left to ship.
    //
    // This used to be `where: { fulfillmentStatus: { not: 'fulfilled' } }`,
    // which Prisma compiles to `status <> 'fulfilled'` — SQL three-valued logic
    // drops NULL rows, and NULL is precisely how an unfulfilled line is stored.
    // On the dev DB that filter matched 1 of 80 lines while 76 were NULL, so the
    // Fulfil dialog on a manual order came up empty and offline orders could not
    // be fulfilled at all.
    const allLines = await this.prisma.orderLineItem.findMany({
      where: { orderId, ...(vendorScope ? { vendor: vendorScope } : {}) },
      orderBy: { createdAt: 'asc' },
    });
    const lineItems = allLines.filter((li) => li.quantity - li.fulfilledQuantity > 0);
    return {
      source: 'manual' as const,
      fulfillmentOrders: [
        {
          id: 'manual',
          status: 'OPEN',
          locationName: null,
          lineItems: lineItems.map((li) => ({
            lineItemId: li.id,
            title: li.title,
            variantTitle: li.variantTitle,
            sku: li.sku,
            remainingQuantity: li.quantity - li.fulfilledQuantity,
            totalQuantity: li.quantity,
          })),
        },
      ],
    };
  }

  /**
   * Create a fulfillment for the selected line items with optional tracking.
   *
   * For SHOPIFY: queries the order's fulfillment orders, maps each requested
   * line item to its FO line item, groups by FO, and calls `fulfillmentCreate`.
   * The fulfillments/create + orders/fulfilled webhooks update the local DB.
   *
   * For MANUAL: creates an `OrderFulfillment` row, flips the chosen line items'
   * `fulfillmentStatus` to "fulfilled", and recomputes the order-level status.
   */
  // ─── VENDOR-SCOPED ORDER ACCESS ───

  /**
   * A vendor's view of an order: ONLY their line items (with image + unit price +
   * line total) + a per-vendor subtotal + ship-to / bill-to (incl. phone) +
   * customer name/email + order note + the fulfilments touching their items.
   * Still hides the order's overall totals/tax/shipping, payment/financial
   * status, refunds, timeline, and other vendors' items.
   */
  async findOneForVendor(id: string, orgId: string, vendorScope: string) {
    const order = await this.prisma.order.findFirst({
      where: {
        id,
        organizationId: orgId,
        deletedAt: null,
        lineItems: { some: { vendor: vendorScope } },
      },
      include: {
        customer: {
          select: { firstName: true, lastName: true, email: true, phone: true },
        },
        lineItems: {
          where: { vendor: vendorScope },
          select: {
            id: true,
            title: true,
            variantTitle: true,
            sku: true,
            quantity: true,
            fulfilledQuantity: true,
            price: true,
            fulfillmentStatus: true,
            variant: {
              select: {
                image: { select: { src: true } },
                product: {
                  select: { images: { select: { src: true }, orderBy: { position: 'asc' }, take: 1 } },
                },
              },
            },
          },
          orderBy: { createdAt: 'asc' },
        },
        fulfillments: true,
      },
    });
    if (!order) throw new NotFoundException('Order not found');

    // Map each line to the (live) fulfilment that contains it, so the UI can
    // offer per-product "mark delivered" / "switch back to unfulfilled".
    const lineToFulfillmentId = new Map<string, string>();
    for (const f of order.fulfillments) {
      if (f.status === 'cancelled') continue;
      for (const lid of this.fulfillmentLineItemIds(f.metadata)) {
        if (!lineToFulfillmentId.has(lid)) lineToFulfillmentId.set(lid, f.id);
      }
    }

    const lineTracking = this.buildLineTrackingMap(order.fulfillments);
    const lineItems = order.lineItems.map((li) => {
      const unitPrice = Number(li.price);
      const tracking = lineTracking.get(li.id);
      return {
        id: li.id,
        title: li.title,
        variantTitle: li.variantTitle,
        sku: li.sku,
        quantity: li.quantity,
        fulfilledQuantity: li.fulfilledQuantity,
        price: li.price,
        lineTotal: unitPrice * li.quantity,
        imageUrl: li.variant?.image?.src ?? li.variant?.product?.images?.[0]?.src ?? null,
        fulfillmentStatus: li.fulfillmentStatus,
        fulfillmentId: lineToFulfillmentId.get(li.id) ?? null,
        trackingNumber: tracking?.trackingNumber ?? null,
        trackingUrl: tracking?.trackingUrl ?? null,
        trackingCompany: tracking?.trackingCompany ?? null,
      };
    });
    const vendorSubtotal = lineItems.reduce((sum, li) => sum + li.lineTotal, 0);

    const myLineIds = new Set(lineItems.map((li) => li.id));
    const fulfillments = order.fulfillments
      .filter((f) => this.fulfillmentLineItemIds(f.metadata).some((x) => myLineIds.has(x)))
      .map((f) => ({
        id: f.id,
        status: f.status,
        trackingNumber: f.trackingNumber,
        trackingUrl: f.trackingUrl,
        trackingCompany: f.trackingCompany,
        shippedAt: f.shippedAt,
        createdAt: f.createdAt,
      }));

    return {
      id: order.id,
      orderNumber: order.orderNumber,
      name: order.name,
      fulfillmentStatus: order.fulfillmentStatus,
      currency: order.currency,
      createdAt: order.externalCreatedAt ?? order.createdAt,
      shipTo: this.sanitizeShipTo(order.shippingAddress),
      billingAddress: this.sanitizeShipTo(order.billingAddress),
      email: order.customer?.email ?? null,
      phone: order.customer?.phone ?? null,
      note: order.note,
      customer: order.customer
        ? {
            firstName: order.customer.firstName,
            lastName: order.customer.lastName,
            email: order.customer.email,
          }
        : null,
      lineItems,
      vendorSubtotal,
      fulfillments,
    };
  }

  /**
   * Set a vendor's own line items to a working status ('in_progress' or
   * 'on_hold'). Updates the local line status, then best-effort syncs to Shopify:
   * 'on_hold' → holds the fulfilment order(s); 'in_progress' → releases the hold.
   * Shopify failures are logged and never block the local update.
   */
  async setVendorItemsStatus(
    orderId: string,
    orgId: string,
    userId: string,
    status: 'in_progress' | 'on_hold' | 'released',
    lineItemIds: string[],
    vendorScope?: string,
    reason?: string,
  ) {
    const order = await this.loadOrderWithChannel(orderId, orgId);
    if (!lineItemIds?.length) throw new BadRequestException('No line items provided');

    if (vendorScope) {
      await this.assertLineItemsOwnedByVendor(orderId, lineItemIds, vendorScope);
    }
    // 'released' clears the hold → the items go back to unfulfilled locally.
    // Paired with its timeline entry in one transaction: holds are the action a
    // merchant is most likely to need to account for later, and this endpoint
    // recorded nothing at all.
    const STATUS_MESSAGE: Record<typeof status, string> = {
      in_progress: 'Items marked in progress',
      on_hold: 'Items put on hold',
      released: 'Hold released on items',
    };
    await this.prisma.$transaction(async (tx) => {
      if (status === 'released') {
        // Releasing a hold returns the line to whatever its shipped quantity
        // says it is — NOT unconditionally to unfulfilled. A line that was
        // half-shipped and then held used to come back reading "unfulfilled",
        // hiding units that had already gone out.
        const held = await tx.orderLineItem.findMany({
          where: { id: { in: lineItemIds }, orderId },
          select: {
            id: true, quantity: true, fulfilledQuantity: true,
            // Read so the line's CURRENT status can be passed as `previous`
            // below. Hard-coding null there defeated the "never downgrade a
            // delivered line" branch, so releasing a hold silently demoted a
            // delivered line back to merely fulfilled.
            fulfillmentStatus: true,
          },
        });
        for (const li of held) {
          await tx.orderLineItem.update({
            where: { id: li.id },
            data: {
              fulfillmentStatus: this.statusForFulfilledQuantity(
                li.fulfilledQuantity,
                li.quantity,
                li.fulfillmentStatus,
              ),
            },
          });
        }
      } else {
        await tx.orderLineItem.updateMany({
          where: { id: { in: lineItemIds }, orderId },
          data: { fulfillmentStatus: status },
        });
      }
      // The header was never re-derived here, so holding an item left the order
      // still reading FULFILLED.
      await this.refreshOrderFulfillmentStatus(tx, orderId);
      await tx.orderTimelineEvent.create({
        data: {
          orderId,
          actorId: userId,
          action: 'items_status_changed',
          message:
            `${STATUS_MESSAGE[status]} (${lineItemIds.length})` +
            (reason ? `: ${reason}` : ''),
          metadata: { status, lineItemIds, reason } as Prisma.InputJsonValue,
        },
      });
    });

    if (order.channel.platform === ChannelPlatform.SHOPIFY) {
      await this.syncVendorStatusToShopify(order, lineItemIds, status, reason).catch((e) =>
        this.logger.warn(
          `Shopify status sync failed for order ${orderId}: ${e instanceof Error ? e.message : e}`,
        ),
      );
    }
    return { updated: lineItemIds.length, status };
  }

  /**
   * Best-effort: reflect the vendor's status on the Shopify fulfilment orders
   * containing their line items.
   *   on_hold     → (reopen if in-progress, then) fulfillmentOrderHold
   *   released    → fulfillmentOrderReleaseHold (if held) or fulfillmentOrderOpen
   *                 (if in-progress) — i.e. back to OPEN / unfulfilled
   *   in_progress → release any hold, then fulfillmentOrderReportProgress
   * FO-level for v1 (a fulfilment order shared with another vendor is affected
   * wholesale; per-line partial holds are a follow-up). `reportProgress` needs
   * API 2026-04+, so that one call is pinned to that version.
   */
  private async syncVendorStatusToShopify(
    order: { id: string; externalId: string; channel: { id: string } },
    lineItemIds: string[],
    status: 'in_progress' | 'on_hold' | 'released',
    reason?: string,
  ) {
    const localLines = await this.prisma.orderLineItem.findMany({
      where: { id: { in: lineItemIds }, orderId: order.id },
      select: { externalId: true },
    });
    const externalIds = new Set(localLines.map((l) => l.externalId));
    if (externalIds.size === 0) return;

    const { token, shopDomain } = await this.shopifyOAuth.getAccessToken(order.channel.id);
    const auth = { shopDomain, accessToken: token };
    const orderGid = ShopifyGraphqlClient.toGid('Order', order.externalId);

    const foResp = await this.graphql.request<OrderFulfillmentOrdersResponse, { id: string }>(
      auth,
      ORDER_ALL_FULFILLMENT_ORDERS_QUERY,
      { id: orderGid },
    );
    const fos = foResp.order?.fulfillmentOrders.nodes ?? [];
    // Per fulfilment order, the FO line items that belong to THIS vendor, so we
    // act on only their items — not the whole order's.
    const targets = fos
      .map((fo) => ({
        foId: fo.id,
        foStatus: fo.status,
        lineItems: fo.lineItems.nodes
          .filter((foli) => externalIds.has(ShopifyGraphqlClient.extractId(foli.lineItem.id)))
          .map((foli) => ({ id: foli.id, quantity: foli.remainingQuantity })),
      }))
      // Same guard as createFulfillment: a CLOSED / CANCELLED fulfilment order
      // falls through every status branch below and would still get a hold or
      // open mutation fired at it. Holds split fulfilment orders, so these
      // closed remnants are exactly what this method leaves behind.
      .filter((t) => t.lineItems.length > 0 && !isUnfulfillableFo(t.foStatus));

    for (const t of targets) {
      if (status === 'on_hold') {
        // A fulfilment order that's mid-progress (IN_PROGRESS) must be reopened
        // before Shopify will let it be held.
        if (t.foStatus === 'IN_PROGRESS') {
          await this.graphql
            .request<FulfillmentOrderOpenResponse, FulfillmentOrderOpenVariables>(
              auth,
              FULFILLMENT_ORDER_OPEN_MUTATION,
              { id: t.foId },
            )
            .catch(() => undefined);
        }
        await this.graphql.request<FulfillmentOrderHoldResponse, FulfillmentOrderHoldVariables>(
          auth,
          FULFILLMENT_ORDER_HOLD_MUTATION,
          {
            id: t.foId,
            fulfillmentHold: {
              reason: 'OTHER',
              reasonNotes: reason?.trim() || 'Placed on hold by vendor via CRM',
              // Hold ONLY this vendor's line items (Shopify splits the FO).
              fulfillmentOrderLineItems: t.lineItems,
            },
          },
        );
      } else if (status === 'released') {
        // "Released" means back to unfulfilled/OPEN. How we get there depends on
        // the FO's current state: release a hold, or reopen an in-progress FO.
        if (t.foStatus === 'ON_HOLD') {
          await this.graphql.request<
            FulfillmentOrderReleaseHoldResponse,
            FulfillmentOrderReleaseHoldVariables
          >(auth, FULFILLMENT_ORDER_RELEASE_HOLD_MUTATION, { id: t.foId });
        } else if (t.foStatus === 'IN_PROGRESS') {
          const res = await this.graphql.request<
            FulfillmentOrderOpenResponse,
            FulfillmentOrderOpenVariables
          >(auth, FULFILLMENT_ORDER_OPEN_MUTATION, { id: t.foId });
          ShopifyGraphqlClient.throwIfUserErrors(
            res.fulfillmentOrderOpen.userErrors,
            'fulfillmentOrderOpen',
          );
        }
        // OPEN already means unfulfilled — nothing to push.
      } else {
        // in_progress: release any hold, then report progress (requires 2026-04+).
        await this.graphql
          .request<FulfillmentOrderReleaseHoldResponse, FulfillmentOrderReleaseHoldVariables>(
            auth,
            FULFILLMENT_ORDER_RELEASE_HOLD_MUTATION,
            { id: t.foId },
          )
          .catch(() => undefined);
        await this.graphql.request<FulfillmentOrderReportProgressResponse, { id: string }>(
          auth,
          FULFILLMENT_ORDER_REPORT_PROGRESS_MUTATION,
          { id: t.foId },
          '2026-04',
        );
      }
    }
  }

  /** Assert every given line item belongs to the order AND the vendor. */
  private async assertLineItemsOwnedByVendor(
    orderId: string,
    lineItemIds: string[],
    vendorScope: string,
  ) {
    const lines = await this.prisma.orderLineItem.findMany({
      where: { id: { in: lineItemIds }, orderId },
      select: { id: true, vendor: true },
    });
    if (lines.length !== lineItemIds.length || lines.some((l) => l.vendor !== vendorScope)) {
      throw new ForbiddenException('You can only act on your own line items.');
    }
  }

  /** Assert a fulfilment's line items belong to the vendor. */
  private async assertFulfillmentOwnedByVendor(
    orderId: string,
    fulfillmentId: string,
    vendorScope: string,
  ) {
    const f = await this.prisma.orderFulfillment.findFirst({
      where: { id: fulfillmentId, orderId },
      select: { metadata: true, externalId: true },
    });
    if (!f) throw new NotFoundException('Fulfillment not found');

    // Who else has items on this order? Scoped to the order — the previous
    // query looked line items up by id ALONE, so it trusted the metadata to
    // name lines that actually belong here.
    const orderLines = await this.prisma.orderLineItem.findMany({
      where: { orderId },
      select: { id: true, vendor: true },
    });
    const foreignLines = orderLines.filter((l) => l.vendor !== vendorScope);

    // Whole order belongs to this vendor ⇒ no fulfilment on it can touch
    // anyone else's goods, whatever the metadata says. This is what keeps
    // vendors working on Shopify-synced fulfilments, which carry no
    // lineItemIds until `resolveFulfillmentForLine` lazily backfills them.
    if (foreignLines.length === 0) return;

    // Mixed-vendor order: attribution has to be proven.
    const ids = this.fulfillmentLineItemIds(f.metadata);

    // A Shopify-created fulfilment's lineItemIds are backfilled one line at a
    // time, so they are a SUBSET of its real contents — never evidence that it
    // excludes another vendor. Refuse rather than guess.
    const isShopifyFulfillment =
      !!f.externalId && !f.externalId.startsWith('manual_');
    if (isShopifyFulfillment) {
      throw new ForbiddenException(
        'This shipment also contains another supplier\'s items, so it cannot be edited here. Update tracking on your own item instead.',
      );
    }

    // Manual fulfilment: we wrote the metadata, so it is complete. Fail CLOSED
    // — `[].some()` is false, so unresolvable ids used to PASS this check.
    const claimed = orderLines.filter((l) => ids.includes(l.id));
    if (
      ids.length === 0 ||
      claimed.length !== ids.length ||
      claimed.some((l) => l.vendor !== vendorScope)
    ) {
      throw new ForbiddenException('You can only update your own fulfilments.');
    }
  }

  /** Extract the manual-fulfilment lineItemIds array from fulfilment metadata. */
  private fulfillmentLineItemIds(metadata: Prisma.JsonValue | null): string[] {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return [];
    const ids = (metadata as Record<string, unknown>).lineItemIds;
    return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : [];
  }

  /**
   * Map each line-item id → the tracking on the (live) fulfilment that ships it,
   * so the UI can show tracking inline on the product row.
   */
  private buildLineTrackingMap(
    fulfillments: Array<{
      status: string;
      trackingNumber: string | null;
      trackingUrl: string | null;
      trackingCompany: string | null;
      metadata: Prisma.JsonValue | null;
    }>,
  ) {
    const map = new Map<
      string,
      { trackingNumber: string | null; trackingUrl: string | null; trackingCompany: string | null }
    >();
    for (const f of fulfillments) {
      if (f.status === 'cancelled') continue;
      if (!f.trackingNumber && !f.trackingUrl && !f.trackingCompany) continue;
      for (const lid of this.fulfillmentLineItemIds(f.metadata)) {
        map.set(lid, {
          trackingNumber: f.trackingNumber,
          trackingUrl: f.trackingUrl,
          trackingCompany: f.trackingCompany,
        });
      }
    }
    return map;
  }

  /** Flatten a raw address bag to name + postal address + phone. */
  private sanitizeShipTo(addr: Prisma.JsonValue | null) {
    if (!addr || typeof addr !== 'object' || Array.isArray(addr)) return null;
    const a = addr as Record<string, unknown>;
    const str = (k: string) => (typeof a[k] === 'string' ? (a[k] as string) : null);
    const name =
      str('name') ?? ([str('first_name'), str('last_name')].filter(Boolean).join(' ') || null);
    const shipTo = {
      name,
      company: str('company'),
      address1: str('address1'),
      address2: str('address2'),
      city: str('city'),
      province: str('province') ?? str('province_code'),
      zip: str('zip'),
      country: str('country') ?? str('country_code'),
      phone: str('phone'),
    };
    // An object of nothing but nulls is not an address. This used to return it
    // anyway, which diverged from the client's own `resolveAddress` (it yields
    // null when every field is falsy): an address carrying only a `stateCode`
    // showed the owner a tidy "No shipping address" and the vendor a stack of
    // blank lines. Same data, two answers.
    return Object.values(shipTo).some(Boolean) ? shipTo : null;
  }

  /** Mark a fulfilment as delivered locally + in Shopify (best-effort). */
  async markFulfillmentDelivered(
    orderId: string,
    orgId: string,
    userId: string,
    fulfillmentId: string,
    vendorScope?: string,
  ) {
    const order = await this.loadOrderWithChannel(orderId, orgId);
    const fulfillment = await this.prisma.orderFulfillment.findFirst({
      where: { id: fulfillmentId, orderId },
    });
    if (!fulfillment) throw new NotFoundException('Fulfillment not found');
    if (vendorScope) {
      await this.assertFulfillmentOwnedByVendor(orderId, fulfillmentId, vendorScope);
    }

    // Reflect delivery on the line items so the per-product UI shows "delivered".
    const deliveredLineIds = this.fulfillmentLineItemIds(fulfillment.metadata);

    // One transaction: the shipment, its line items and the timeline entry were
    // three independent commits, so a failure between them left a delivered
    // shipment whose lines still read "fulfilled" and no record of who did it.
    await this.prisma.$transaction(async (tx) => {
      await tx.orderFulfillment.update({
        where: { id: fulfillmentId },
        data: { status: 'delivered', deliveredAt: new Date() },
      });

      if (deliveredLineIds.length > 0) {
        await tx.orderLineItem.updateMany({
          where: { id: { in: deliveredLineIds }, orderId },
          data: { fulfillmentStatus: 'delivered' },
        });
        await this.refreshOrderFulfillmentStatus(tx, orderId);
      }

      // `userId` was accepted and discarded, so this action left no trace at all.
      await tx.orderTimelineEvent.create({
        data: {
          orderId,
          actorId: userId,
          action: 'delivered',
          message: fulfillment.trackingNumber
            ? `Shipment delivered (${fulfillment.trackingNumber})`
            : 'Shipment delivered',
          metadata: {
            fulfillmentId,
            lineItemIds: deliveredLineIds,
          } as Prisma.InputJsonValue,
        },
      });
    });

    if (order.channel.platform === ChannelPlatform.SHOPIFY && fulfillment.externalId) {
      await this.markDeliveredOnShopify(order, fulfillment.externalId).catch((e) =>
        this.logger.warn(
          `Shopify delivered event failed for order ${orderId}: ${e instanceof Error ? e.message : e}`,
        ),
      );
    }
    return { id: fulfillmentId, status: 'delivered' };
  }

  /** Best-effort: create a DELIVERED fulfilment event on Shopify. */
  private async markDeliveredOnShopify(
    order: { channel: { id: string } },
    fulfillmentExternalId: string,
  ) {
    const { token, shopDomain } = await this.shopifyOAuth.getAccessToken(order.channel.id);
    await this.graphql.request<FulfillmentEventCreateResponse, FulfillmentEventCreateVariables>(
      { shopDomain, accessToken: token },
      FULFILLMENT_EVENT_CREATE_MUTATION,
      {
        fulfillmentEvent: {
          fulfillmentId: ShopifyGraphqlClient.toGid('Fulfillment', fulfillmentExternalId),
          status: 'DELIVERED',
        },
      },
    );
  }

  /**
   * Find the live fulfilment that ships a given local line item. Uses our local
   * lineItemIds metadata first; if missing (fulfilled in Shopify admin, or before
   * we tagged fulfilments) it asks Shopify which fulfilment covers the line and
   * records the mapping locally so the next action is instant. Returns the local
   * OrderFulfillment row, or null if nothing live covers the line.
   */
  private async resolveFulfillmentForLine(
    order: {
      id: string;
      externalId: string;
      channel: { id: string; platform: ChannelPlatform };
    },
    line: { id: string; externalId: string | null },
  ) {
    const local = await this.prisma.orderFulfillment.findMany({
      where: { orderId: order.id, status: { not: 'cancelled' } },
    });
    const match = local.find((f) => this.fulfillmentLineItemIds(f.metadata).includes(line.id));
    if (match) return match;

    if (order.channel.platform !== ChannelPlatform.SHOPIFY || !line.externalId) return null;

    const { token, shopDomain } = await this.shopifyOAuth.getAccessToken(order.channel.id);
    const resp = await this.graphql.request<OrderFulfillmentsWithLinesResponse, { id: string }>(
      { shopDomain, accessToken: token },
      ORDER_FULFILLMENTS_WITH_LINES_QUERY,
      { id: ShopifyGraphqlClient.toGid('Order', order.externalId) },
    );
    const remote = resp.order?.fulfillments ?? [];

    // Backfill EVERY shipment in this response, not just the one line asked
    // about. The response already carries all of them with their lines, so
    // recording one id at a time cost the same call and left the stored array a
    // permanent subset — which is why per-line tracking stayed blank on
    // Shopify orders even after a line had been resolved once.
    const localLines = await this.prisma.orderLineItem.findMany({
      where: { orderId: order.id },
      select: {
        id: true, externalId: true, quantity: true,
        fulfillmentStatus: true, fulfilledQuantity: true,
      },
    });
    const existingIds = new Map<string, string[]>();
    for (const f of local) {
      if (f.externalId) existingIds.set(f.externalId, this.fulfillmentLineItemIds(f.metadata));
    }
    const { lineItemIdsByExternalId, linePatches } = mapFulfilmentLines(
      remote.map((f) => ({
        externalId: ShopifyGraphqlClient.extractId(f.id),
        status: f.status,
        lines: f.fulfillmentLineItems.nodes
          .filter((n) => n.lineItem)
          .map((n) => ({
            shopifyLineId: ShopifyGraphqlClient.extractId(n.lineItem!.id),
            quantity: n.quantity,
          })),
      })),
      localLines,
      existingIds,
    );

    let resolved: Awaited<ReturnType<typeof this.prisma.orderFulfillment.upsert>> | null = null;
    for (const [externalId, lineItemIds] of lineItemIdsByExternalId) {
      const row = await this.prisma.orderFulfillment.upsert({
        where: { orderId_externalId: { orderId: order.id, externalId } },
        create: {
          orderId: order.id,
          externalId,
          status: 'fulfilled',
          shippedAt: new Date(),
          metadata: { lineItemIds } as Prisma.InputJsonValue,
        },
        update: { metadata: { lineItemIds } as Prisma.InputJsonValue },
      });
      // Only a live shipment can answer for the line — a cancelled one is
      // recorded for membership but must not be handed back as its fulfilment.
      if (lineItemIds.includes(line.id) && row.status !== 'cancelled') resolved = row;
    }

    // The order's own line rows carry no shipped counts on the Shopify path, so
    // correct them while we know the truth. Best-effort: the caller's action
    // matters more than this bookkeeping.
    for (const patch of linePatches) {
      await this.prisma.orderLineItem
        .update({
          where: { id: patch.id },
          data: {
            fulfilledQuantity: patch.fulfilledQuantity,
            fulfillmentStatus: patch.fulfillmentStatus,
          },
        })
        .catch(() => undefined);
    }

    return resolved;
  }

  /** Best-effort: cancel a fulfilment on Shopify. */
  private async cancelFulfillmentOnShopify(
    order: { channel: { id: string } },
    fulfillmentExternalId: string,
  ) {
    const { token, shopDomain } = await this.shopifyOAuth.getAccessToken(order.channel.id);
    const result = await this.graphql.request<FulfillmentCancelResponse, FulfillmentCancelVariables>(
      { shopDomain, accessToken: token },
      FULFILLMENT_CANCEL_MUTATION,
      { id: ShopifyGraphqlClient.toGid('Fulfillment', fulfillmentExternalId) },
    );
    ShopifyGraphqlClient.throwIfUserErrors(result.fulfillmentCancel.userErrors, 'fulfillmentCancel');
  }

  /**
   * Vendor action: mark ONE of their products as delivered. Resolves the
   * fulfilment that ships the line, flips the line + that fulfilment to
   * 'delivered', and fires Shopify's DELIVERED event (best-effort).
   */
  async markVendorItemDelivered(
    orderId: string,
    orgId: string,
    userId: string,
    lineId: string,
    vendorScope?: string,
  ) {
    const order = await this.loadOrderWithChannel(orderId, orgId);
    const line = await this.prisma.orderLineItem.findFirst({
      where: { id: lineId, orderId },
      select: { id: true, externalId: true, vendor: true, fulfillmentStatus: true },
    });
    if (!line) throw new NotFoundException('Line item not found');
    if (vendorScope && line.vendor !== vendorScope) {
      throw new ForbiddenException('You can only update your own items.');
    }

    const fulfillment = await this.resolveFulfillmentForLine(order, line);

    await this.prisma.$transaction(async (tx) => {
      await tx.orderLineItem.update({
        where: { id: lineId },
        data: { fulfillmentStatus: 'delivered' },
      });
      if (fulfillment) {
        await tx.orderFulfillment.update({
          where: { id: fulfillment.id },
          data: { status: 'delivered', deliveredAt: new Date() },
        });
      }
      await this.refreshOrderFulfillmentStatus(tx, orderId);
      await tx.orderTimelineEvent.create({
        data: {
          orderId,
          actorId: userId,
          action: 'item_delivered',
          message: 'Item marked as delivered',
          metadata: {
            lineItemId: lineId,
            fulfillmentId: fulfillment?.id ?? null,
          } as Prisma.InputJsonValue,
        },
      });
    });

    if (fulfillment) {
      if (order.channel.platform === ChannelPlatform.SHOPIFY && fulfillment.externalId) {
        await this.markDeliveredOnShopify(order, fulfillment.externalId).catch((e) =>
          this.logger.warn(
            `Shopify delivered event failed for order ${orderId}: ${e instanceof Error ? e.message : e}`,
          ),
        );
      }
    }
    return { id: lineId, status: 'delivered' };
  }

  /**
   * Vendor action: switch ONE of their products back to unfulfilled. Cancels the
   * fulfilment that ships the line on Shopify and reverts that fulfilment's lines
   * locally. Delivered items are terminal and cannot be reverted.
   */
  async unfulfillVendorItem(
    orderId: string,
    orgId: string,
    userId: string,
    lineId: string,
    vendorScope?: string,
  ) {
    const order = await this.loadOrderWithChannel(orderId, orgId);
    const line = await this.prisma.orderLineItem.findFirst({
      where: { id: lineId, orderId },
      select: { id: true, externalId: true, vendor: true, fulfillmentStatus: true },
    });
    if (!line) throw new NotFoundException('Line item not found');
    if (vendorScope && line.vendor !== vendorScope) {
      throw new ForbiddenException('You can only update your own items.');
    }
    if (line.fulfillmentStatus === 'delivered') {
      throw new BadRequestException('Delivered items cannot be changed.');
    }

    const fulfillment = await this.resolveFulfillmentForLine(order, line);

    if (order.channel.platform === ChannelPlatform.SHOPIFY && fulfillment?.externalId) {
      await this.cancelFulfillmentOnShopify(order, fulfillment.externalId).catch((e) =>
        this.logger.warn(
          `Shopify fulfillment cancel failed for order ${orderId}: ${e instanceof Error ? e.message : e}`,
        ),
      );
    }

    // Cancelling a fulfilment reverts ALL of its lines to unfulfilled.
    const revertIds = fulfillment ? this.fulfillmentLineItemIds(fulfillment.metadata) : [];
    const ids = revertIds.length ? revertIds : [lineId];

    // A shared shipment can carry another supplier's items, and this reverts
    // every line on it. The fulfil path asserts ownership before acting; this
    // one did not, so a vendor could wipe a co-vendor's lines by unfulfilling
    // their own. Refuse rather than silently reverting a subset, which would
    // leave the shipment cancelled while its other lines still read fulfilled.
    if (vendorScope && ids.length > 1) {
      const foreign = await this.prisma.orderLineItem.count({
        where: { id: { in: ids }, orderId, vendor: { not: vendorScope } },
      });
      if (foreign > 0) {
        throw new BadRequestException(
          "This shipment also contains another supplier's items, so it cannot be " +
          'unfulfilled here. Ask the merchant to cancel the shipment instead.',
        );
      }
    }
    // One transaction: reverting the lines, cancelling the shipment and
    // recomputing the order's status are a single logical change, and a partial
    // apply leaves the order header disagreeing with its own line items.
    await this.prisma.$transaction(async (tx) => {
      // Cancelling the shipment un-ships its units, so the count has to go back
      // to zero as well — leaving it set would keep the order reading PARTIAL
      // (or FULFILLED) for a shipment that no longer exists.
      await tx.orderLineItem.updateMany({
        where: { id: { in: ids }, orderId },
        data: { fulfillmentStatus: null, fulfilledQuantity: 0 },
      });
      if (fulfillment) {
        await tx.orderFulfillment.update({
          where: { id: fulfillment.id },
          data: { status: 'cancelled' },
        });
      }
      await this.refreshOrderFulfillmentStatus(tx, orderId);
      await tx.orderTimelineEvent.create({
        data: {
          orderId,
          actorId: userId,
          action: 'item_unfulfilled',
          message:
            ids.length > 1
              ? `Item switched back to unfulfilled (${ids.length} lines on the shipment)`
              : 'Item switched back to unfulfilled',
          metadata: {
            lineItemId: lineId,
            lineItemIds: ids,
            fulfillmentId: fulfillment?.id ?? null,
          } as Prisma.InputJsonValue,
        },
      });
    });
    return { id: lineId, status: 'unfulfilled' };
  }

  async createFulfillment(
    orderId: string,
    orgId: string,
    userId: string,
    dto: CreateFulfillmentDto,
    vendorScope?: string,
  ) {
    const order = await this.loadOrderWithChannel(orderId, orgId);

    if (vendorScope) {
      await this.assertLineItemsOwnedByVendor(
        orderId,
        dto.lineItems.map((li) => li.lineItemId),
        vendorScope,
      );
    }

    if (order.channel.platform === ChannelPlatform.SHOPIFY) {
      const { token, shopDomain } = await this.shopifyOAuth.getAccessToken(order.channel.id);
      const auth = { shopDomain, accessToken: token };
      const orderGid = ShopifyGraphqlClient.toGid('Order', order.externalId);

      // The requested IDs may be LOCAL OrderLineItem ids (vendor flow, from
      // findOneForVendor) or already SHOPIFY line-item ids (merchant flow, from
      // listFulfillableLineItems). Translate local ids → their Shopify externalId
      // so the FO matching below (keyed by the Shopify line-item id) works for both.
      const localLines = await this.prisma.orderLineItem.findMany({
        where: { orderId, id: { in: dto.lineItems.map((li) => li.lineItemId) } },
        select: { id: true, externalId: true },
      });
      const localIdToExternal = new Map(localLines.map((l) => [l.id, l.externalId]));
      const requestedByLineItem = new Map(
        dto.lineItems.map((li) => [localIdToExternal.get(li.lineItemId) ?? li.lineItemId, li]),
      );
      const requestedExternalIds = new Set(requestedByLineItem.keys());

      // Read ALL fulfilment orders (any status) so items that are on hold or
      // mid-progress are still found. Shopify won't fulfil those until they're
      // back to OPEN, so release / reopen the affected ones first, then re-read.
      const readFulfillmentOrders = async () => {
        const resp = await this.graphql.request<OrderFulfillmentOrdersResponse, { id: string }>(
          auth,
          ORDER_ALL_FULFILLMENT_ORDERS_QUERY,
          { id: orderGid },
        );
        return resp.order?.fulfillmentOrders.nodes ?? [];
      };
      let fos = await readFulfillmentOrders();
      if (fos.length >= FULFILLMENT_ORDER_PAGE_SIZE) {
        // Neither FO query paginates. Silently dropping fulfilment orders would
        // make the first-match selection below arbitrary, so make it visible.
        this.logger.warn(
          `Order ${orderId} returned ${fos.length} fulfilment orders — the query caps at ` +
          `${FULFILLMENT_ORDER_PAGE_SIZE}, so some may be missing and fulfilment may pick the wrong one.`,
        );
      }
      let reopened = false;
      for (const fo of fos) {
        // Only repair fulfilment orders that can still be fulfilled. A CLOSED or
        // CANCELLED one is terminal — firing a release/open at it achieves
        // nothing and muddies the log.
        if (isUnfulfillableFo(fo.status)) continue;
        const hasRequested = fo.lineItems.nodes.some((foli) =>
          requestedExternalIds.has(ShopifyGraphqlClient.extractId(foli.lineItem.id)),
        );
        if (!hasRequested) continue;
        // A failed repair used to be swallowed whole: `.catch(() => undefined)`
        // with no userErrors check, so the fulfilment order stayed held and the
        // only symptom was a baffling error from fulfillmentCreate further down.
        // Still non-fatal — one stuck fulfilment order must not block shipping
        // from another.
        const repair = async (
          label: string,
          run: () => Promise<{ userErrors?: Array<{ message: string }> } | undefined>,
        ) => {
          try {
            const res = await run();
            const errs = res?.userErrors ?? [];
            if (errs.length > 0) {
              this.logger.warn(
                `${label} on fulfilment order ${fo.id} (order ${orderId}) reported: ` +
                errs.map((e) => e.message).join('; '),
              );
            }
          } catch (e) {
            this.logger.warn(
              `${label} on fulfilment order ${fo.id} (order ${orderId}) failed: ` +
              (e instanceof Error ? e.message : String(e)),
            );
          }
          reopened = true;
        };

        if (fo.status === 'ON_HOLD') {
          await repair('releaseHold', async () => {
            const r = await this.graphql.request<
              FulfillmentOrderReleaseHoldResponse,
              FulfillmentOrderReleaseHoldVariables
            >(auth, FULFILLMENT_ORDER_RELEASE_HOLD_MUTATION, { id: fo.id });
            return r.fulfillmentOrderReleaseHold;
          });
        } else if (fo.status === 'IN_PROGRESS' || fo.status === 'SCHEDULED') {
          // SCHEDULED was missing: a scheduled fulfilment order also has to be
          // opened before Shopify will accept a fulfilment against it.
          await repair('open', async () => {
            const r = await this.graphql.request<
              FulfillmentOrderOpenResponse,
              FulfillmentOrderOpenVariables
            >(auth, FULFILLMENT_ORDER_OPEN_MUTATION, { id: fo.id });
            return r.fulfillmentOrderOpen;
          });
        }
      }
      if (reopened) fos = await readFulfillmentOrders();

      // Only fulfilment orders that can actually accept a fulfilment, OPEN ones
      // first.
      //
      // This filter is the fix for "Fulfillment order N has an unfulfillable
      // status = closed". Cancelling a fulfilment makes Shopify CLOSE its
      // fulfilment order and create a replacement OPEN one carrying the same
      // items — and the closed one KEEPS its `remainingQuantity`, because those
      // units were never actually shipped. The loop below had no status check
      // and leaned on `qty <= 0` as an accidental one, which only holds for a
      // fulfilment order closed by being fulfilled. Shopify returns them
      // oldest-first, so the dead one was matched first, consumed the line via
      // the `delete` below, and the live replacement was never reached.
      //
      // Sorting OPEN first also makes the greedy first-match deterministic
      // instead of dependent on Shopify's ordering.
      const fulfillable = selectFulfillableFos(fos);

      // Group the requested line items by which FulfillmentOrder owns them.
      // If a single OrderLineItem spans multiple FOs (multi-location), we
      // greedily take from the first match — multi-location partial
      // fulfillment is Phase 2b. The remainingQuantity ceiling protects
      // against over-fulfilling.
      const grouped = new Map<string, Array<{ id: string; quantity: number }>>();
      // How many units each line is actually shipping on this call, keyed by
      // Shopify line-item id. The local write below needs this: it used to flip
      // every requested line to 'fulfilled' outright, so a 2-of-5 shipment read
      // as a complete line locally while Shopify correctly held 3 in reserve.
      const shippedByExternalId = new Map<string, number>();
      for (const fo of fulfillable) {
        for (const foli of fo.lineItems.nodes) {
          const orderLineItemId = ShopifyGraphqlClient.extractId(foli.lineItem.id);
          const req = requestedByLineItem.get(orderLineItemId);
          if (!req) continue;
          const qty =
            req.quantity !== undefined
              ? Math.min(req.quantity, foli.remainingQuantity)
              : foli.remainingQuantity;
          if (qty <= 0) continue;
          const list = grouped.get(fo.id) ?? [];
          list.push({ id: foli.id, quantity: qty });
          grouped.set(fo.id, list);
          shippedByExternalId.set(
            orderLineItemId,
            (shippedByExternalId.get(orderLineItemId) ?? 0) + qty,
          );
          requestedByLineItem.delete(orderLineItemId);
        }
      }
      if (grouped.size === 0) {
        // Name what was actually seen — "not fulfillable" with no reason sent
        // people hunting through Shopify admin.
        const seen = fos.map((fo) => `${ShopifyGraphqlClient.extractId(fo.id)}=${fo.status}`);
        throw new BadRequestException(
          'None of the requested line items are currently fulfillable — they may already ' +
          'be fulfilled, or their fulfilment orders are closed or cancelled. ' +
          `Fulfilment orders on this order: ${seen.length ? seen.join(', ') : 'none'}.`,
        );
      }

      const lineItemsByFulfillmentOrder = Array.from(grouped.entries()).map(
        ([fulfillmentOrderId, fulfillmentOrderLineItems]) => ({
          fulfillmentOrderId,
          fulfillmentOrderLineItems,
        }),
      );

      // Where this shipment leaves from, when every fulfilment order taking
      // part agrees. A split across locations has no single origin, so nothing
      // is stamped rather than picking one arbitrarily.
      const dispatchLocationId = singleDistinct(
        fulfillable
          .filter((fo) => grouped.has(fo.id))
          .map((fo) =>
            fo.assignedLocation?.location?.id
              ? ShopifyGraphqlClient.extractId(fo.assignedLocation.location.id)
              : null,
          ),
      );

      const result = await this.graphql.request<
        FulfillmentCreateResponse,
        FulfillmentCreateVariables
      >(auth, FULFILLMENT_CREATE_MUTATION, {
        fulfillment: {
          lineItemsByFulfillmentOrder,
          notifyCustomer: dto.notifyCustomer ?? true,
          trackingInfo: dto.tracking
            ? {
              number: dto.tracking.number ?? null,
              url: dto.tracking.url ?? null,
              company: dto.tracking.company ?? null,
            }
            : null,
        },
      });
      // A rejected fulfilment is the merchant's problem to act on, not a server
      // fault — it escaped as an unhandled 500 while the "nothing fulfillable"
      // path above returned a clean 400 for the same class of problem.
      try {
        ShopifyGraphqlClient.throwIfUserErrors(
          result.fulfillmentCreate.userErrors,
          'fulfillmentCreate',
        );
      } catch (e) {
        const detail = e instanceof Error ? e.message.replace(/^fulfillmentCreate: /, '') : String(e);
        this.logger.warn(`fulfillmentCreate rejected for order ${orderId}: ${detail}`);
        throw new BadRequestException(`Shopify rejected this fulfilment: ${detail}`);
      }

      // Reflect the shipment locally.
      //
      // There is NO inbound reconciliation to fall back on: `fulfillments/create`
      // is not a valid Shopify webhook topic (see WEBHOOK_TOPICS in
      // shopify-oauth.service.ts) and the GraphQL order pull deliberately omits
      // per-line fulfilment status, so whatever is written here is what the CRM
      // believes until someone acts on the line again. The comments that used to
      // sit here claiming "the webhook reconciles authoritatively" were wrong.
      //
      // One transaction: the timeline entry, the line quantities, the order
      // header and the shipment row were four independent commits following an
      // already-committed remote side effect, so any failure between them left
      // the CRM disagreeing with Shopify with no record of why.
      const shopifyFulfillmentId = ShopifyGraphqlClient.extractId(
        result.fulfillmentCreate.fulfillment?.id ?? '',
      );
      const requestedIds = dto.lineItems.map((li) => li.lineItemId);

      await this.prisma.$transaction(async (tx) => {
        await tx.orderTimelineEvent.create({
          data: {
            orderId,
            actorId: userId,
            action: 'fulfilled',
            message: dto.tracking?.number
              ? `Fulfillment initiated (tracking ${dto.tracking.number}${dto.tracking.company ? ` via ${dto.tracking.company}` : ''
              })`
              : 'Fulfillment initiated',
            metadata: {
              shopifyFulfillmentId: result.fulfillmentCreate.fulfillment?.id ?? null,
              tracking: dto.tracking ?? null,
              notifyCustomer: dto.notifyCustomer ?? true,
            } as Prisma.InputJsonValue,
          },
        });

        // Requested ids may be local cuids (vendor flow) or Shopify line-item
        // ids (merchant flow), so match on either.
        const affected = await tx.orderLineItem.findMany({
          where: {
            orderId,
            OR: [{ id: { in: requestedIds } }, { externalId: { in: requestedIds } }],
          },
          select: {
            id: true,
            externalId: true,
            quantity: true,
            fulfilledQuantity: true,
            fulfillmentStatus: true,
          },
        });

        for (const li of affected) {
          // Fall back to the whole remaining line when Shopify gave us no
          // per-line figure (it always should, but a silent 0 would make a real
          // shipment invisible locally).
          const shipped =
            shippedByExternalId.get(li.externalId) ?? li.quantity - li.fulfilledQuantity;
          const total = Math.min(li.fulfilledQuantity + Math.max(shipped, 0), li.quantity);
          await tx.orderLineItem.update({
            where: { id: li.id },
            data: {
              fulfilledQuantity: total,
              fulfillmentStatus: this.statusForFulfilledQuantity(
                total,
                li.quantity,
                li.fulfillmentStatus,
              ),
            },
          });
        }

        await this.refreshOrderFulfillmentStatus(tx, orderId);

        // First-write-only stamp of the dispatch point (see
        // ShopifySyncService.stampDispatchWarehouse for the same rule): an
        // order already invoiced must keep the origin its invoice snapshotted.
        if (dispatchLocationId) {
          const dispatchWarehouse = await tx.warehouse.findFirst({
            where: {
              organizationId: orgId,
              shopifyLocationId: dispatchLocationId,
              isActive: true,
            },
            select: { id: true },
          });
          if (dispatchWarehouse) {
            await tx.order.updateMany({
              where: { id: orderId, organizationId: orgId, dispatchWarehouseId: null },
              data: { dispatchWarehouseId: dispatchWarehouse.id },
            });
          }
        }

        // Record a local OrderFulfillment so it appears in the vendor's
        // shipments and can be marked delivered; lineItemIds attributes it.
        if (shopifyFulfillmentId) {
          const lineItemIds = affected.map((l) => l.id);
          await tx.orderFulfillment.upsert({
            where: { orderId_externalId: { orderId, externalId: shopifyFulfillmentId } },
            create: {
              orderId,
              externalId: shopifyFulfillmentId,
              status: 'fulfilled',
              trackingNumber: dto.tracking?.number ?? null,
              trackingUrl: dto.tracking?.url ?? null,
              trackingCompany: dto.tracking?.company ?? null,
              shippedAt: new Date(),
              metadata: { lineItemIds } as Prisma.InputJsonValue,
            },
            update: { metadata: { lineItemIds } as Prisma.InputJsonValue },
          });
        }
      });

      return this.prisma.order.findUnique({ where: { id: orderId } });
    }

    // ── Manual branch ──────────────────────────────────────────────────────
    return this.prisma.$transaction(async (tx) => {
      const requestedIds = dto.lineItems.map((li) => li.lineItemId);
      const lineItems = await tx.orderLineItem.findMany({
        where: { orderId, id: { in: requestedIds } },
      });
      if (lineItems.length !== requestedIds.length) {
        throw new BadRequestException(
          'One or more line items were not found on this order.',
        );
      }

      // Reject a request for more than is left to ship before writing anything.
      // The DB CHECK would catch it, but as an opaque 500 rather than a message.
      const requestedQty = new Map(dto.lineItems.map((li) => [li.lineItemId, li.quantity]));
      for (const li of lineItems) {
        const remaining = li.quantity - li.fulfilledQuantity;
        const want = requestedQty.get(li.id) ?? remaining;
        if (want > remaining) {
          throw new BadRequestException(
            `Cannot fulfil ${want} of "${li.title}" — only ${remaining} of ${li.quantity} remain.`,
          );
        }
        if (remaining <= 0) {
          throw new BadRequestException(`"${li.title}" is already fully fulfilled.`);
        }
      }

      const fulfillment = await tx.orderFulfillment.create({
        data: {
          orderId,
          externalId: `manual_${randomUUID()}`,
          status: 'fulfilled',
          trackingNumber: dto.tracking?.number ?? null,
          trackingUrl: dto.tracking?.url ?? null,
          trackingCompany: dto.tracking?.company ?? null,
          shippedAt: new Date(),
          metadata: {
            lineItemIds: lineItems.map((li) => li.id),
          } as Prisma.InputJsonValue,
        },
      });

      // Per line, not `updateMany` — a partial shipment advances the count and
      // leaves the line 'partial', so the remainder stays fulfillable.
      for (const li of lineItems) {
        const remaining = li.quantity - li.fulfilledQuantity;
        const shipped = requestedQty.get(li.id) ?? remaining;
        const total = li.fulfilledQuantity + shipped;
        await tx.orderLineItem.update({
          where: { id: li.id },
          data: {
            fulfilledQuantity: total,
            fulfillmentStatus: this.statusForFulfilledQuantity(
              total,
              li.quantity,
              li.fulfillmentStatus,
            ),
          },
        });
      }

      await this.refreshOrderFulfillmentStatus(tx, orderId);

      await tx.orderTimelineEvent.create({
        data: {
          orderId,
          actorId: userId,
          action: 'fulfilled',
          message: `Fulfillment recorded (${lineItems.length} item${lineItems.length === 1 ? '' : 's'}${dto.tracking?.number ? `, tracking ${dto.tracking.number}` : ''
            })`,
          metadata: {
            fulfillmentId: fulfillment.id,
            tracking: dto.tracking ?? null,
            lineItemIds: lineItems.map((li) => li.id),
          } as Prisma.InputJsonValue,
        },
      });

      return fulfillment;
    });
  }

  /** Update tracking number/URL/carrier on an existing fulfillment. */
  /**
   * Add / update tracking for a single product (by line id) — resolves the
   * fulfilment that ships the line (local mapping, else Shopify), then reuses
   * updateTracking to push to Shopify (fulfillmentTrackingInfoUpdate) and store
   * it locally. Works for both the owner and a scoped vendor.
   */
  async updateItemTracking(
    orderId: string,
    orgId: string,
    userId: string,
    lineId: string,
    dto: UpdateTrackingDto,
    vendorScope?: string,
  ) {
    const order = await this.loadOrderWithChannel(orderId, orgId);
    const line = await this.prisma.orderLineItem.findFirst({
      where: { id: lineId, orderId },
      select: { id: true, externalId: true, vendor: true },
    });
    if (!line) throw new NotFoundException('Line item not found');
    if (vendorScope && line.vendor !== vendorScope) {
      throw new ForbiddenException('You can only update your own items.');
    }
    const fulfillment = await this.resolveFulfillmentForLine(order, line);
    if (!fulfillment) {
      throw new BadRequestException('Fulfil this item before adding tracking.');
    }
    // Forward the scope. Owning the LINE is not the same as owning the
    // FULFILMENT — a shipment can span several vendors, and writing tracking
    // on it rewrites the number every one of their customers sees. Dropping
    // `vendorScope` here silently skipped that check.
    return this.updateTracking(
      orderId,
      fulfillment.id,
      orgId,
      userId,
      dto,
      vendorScope,
    );
  }

  async updateTracking(
    orderId: string,
    fulfillmentId: string,
    orgId: string,
    userId: string,
    dto: UpdateTrackingDto,
    vendorScope?: string,
  ) {
    const order = await this.loadOrderWithChannel(orderId, orgId);

    if (vendorScope) {
      await this.assertFulfillmentOwnedByVendor(orderId, fulfillmentId, vendorScope);
    }
    const fulfillment = await this.prisma.orderFulfillment.findFirst({
      where: { id: fulfillmentId, orderId },
    });
    if (!fulfillment) throw new NotFoundException('Fulfillment not found');

    const isShopifyFulfillment =
      order.channel.platform === ChannelPlatform.SHOPIFY &&
      !!fulfillment.externalId &&
      !fulfillment.externalId.startsWith('manual_');

    if (isShopifyFulfillment) {
      const { token, shopDomain } = await this.shopifyOAuth.getAccessToken(order.channel.id);
      const result = await this.graphql.request<
        FulfillmentTrackingInfoUpdateResponse,
        FulfillmentTrackingInfoUpdateVariables
      >(
        { shopDomain, accessToken: token },
        FULFILLMENT_TRACKING_INFO_UPDATE_MUTATION,
        {
          fulfillmentId: ShopifyGraphqlClient.toGid('Fulfillment', fulfillment.externalId!),
          trackingInfoInput: {
            number: dto.tracking.number ?? null,
            url: dto.tracking.url ?? null,
            company: dto.tracking.company ?? null,
          },
          notifyCustomer: dto.notifyCustomer ?? true,
        },
      );
      ShopifyGraphqlClient.throwIfUserErrors(
        result.fulfillmentTrackingInfoUpdate.userErrors,
        'fulfillmentTrackingInfoUpdate',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.orderFulfillment.update({
        where: { id: fulfillmentId },
        data: {
          trackingNumber: dto.tracking.number ?? null,
          trackingUrl: dto.tracking.url ?? null,
          trackingCompany: dto.tracking.company ?? null,
        },
      });
      await tx.orderTimelineEvent.create({
        data: {
          orderId,
          actorId: userId,
          action: 'tracking_updated',
          message: `Tracking updated${dto.tracking.number ? `: ${dto.tracking.number}` : ''
            }${dto.tracking.company ? ` (${dto.tracking.company})` : ''}`,
          metadata: {
            fulfillmentId,
            tracking: { ...dto.tracking },
          } as Prisma.InputJsonValue,
        },
      });
      return updated;
    });
  }

  /**
   * Cancel a fulfillment. SHOPIFY fulfillments round-trip via
   * `fulfillmentCancel`. MANUAL fulfillments reverse the local state:
   * line items un-fulfilled, order status recomputed.
   */
  async cancelFulfillment(
    orderId: string,
    fulfillmentId: string,
    orgId: string,
    userId: string,
    vendorScope?: string,
  ) {
    const order = await this.loadOrderWithChannel(orderId, orgId);
    const fulfillment = await this.prisma.orderFulfillment.findFirst({
      where: { id: fulfillmentId, orderId },
    });
    if (!fulfillment) throw new NotFoundException('Fulfillment not found');
    if (fulfillment.status === 'cancelled') {
      throw new BadRequestException('Fulfillment is already cancelled');
    }
    // A vendor may only unfulfil a shipment built from their own line items.
    if (vendorScope) {
      await this.assertFulfillmentOwnedByVendor(orderId, fulfillmentId, vendorScope);
    }

    const isShopifyFulfillment =
      order.channel.platform === ChannelPlatform.SHOPIFY &&
      !!fulfillment.externalId &&
      !fulfillment.externalId.startsWith('manual_');

    if (isShopifyFulfillment) {
      const { token, shopDomain } = await this.shopifyOAuth.getAccessToken(order.channel.id);
      const result = await this.graphql.request<
        FulfillmentCancelResponse,
        FulfillmentCancelVariables
      >(
        { shopDomain, accessToken: token },
        FULFILLMENT_CANCEL_MUTATION,
        { id: ShopifyGraphqlClient.toGid('Fulfillment', fulfillment.externalId!) },
      );
      ShopifyGraphqlClient.throwIfUserErrors(
        result.fulfillmentCancel.userErrors,
        'fulfillmentCancel',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.orderFulfillment.update({
        where: { id: fulfillmentId },
        data: { status: 'cancelled' },
      });

      // Reverse the line-item status flips done at create-time so the items
      // return to "unfulfilled". Owner-driven Shopify cancels defer to the
      // webhook, but a vendor unfulfil needs immediate local feedback.
      if (!isShopifyFulfillment || vendorScope) {
        const meta = (fulfillment.metadata ?? {}) as Record<string, unknown>;
        const lineItemIds = Array.isArray(meta.lineItemIds)
          ? (meta.lineItemIds as string[])
          : [];
        if (lineItemIds.length > 0) {
          await tx.orderLineItem.updateMany({
            // `orderId` was missing here: the ids come from a JSON blob, so
            // without it a stale or hand-edited metadata array could revert a
            // line belonging to a different order.
            where: { id: { in: lineItemIds }, orderId },
            data: { fulfillmentStatus: null, fulfilledQuantity: 0 },
          });
        }
        await this.refreshOrderFulfillmentStatus(tx, orderId);
      }

      await tx.orderTimelineEvent.create({
        data: {
          orderId,
          actorId: userId,
          action: 'fulfillment_cancelled',
          message: 'Fulfillment cancelled',
          metadata: { fulfillmentId } as Prisma.InputJsonValue,
        },
      });
      return updated;
    });
  }

  /**
   * Compute order-level fulfillment status from the per-line-item state.
   *
   * Counts UNITS, not lines. The old version counted lines whose status read
   * 'fulfilled'/'delivered', which reported a 5-unit order FULFILLED as soon as
   * its single line was touched — even by a 1-unit shipment. Shopify's own
   * PARTIAL is quantity-aware, so a line-count rule also guaranteed the two
   * systems disagreed on exactly the orders that matter.
   *
   * `fulfilledQuantity` is authoritative; the status string is only consulted
   * for rows that predate the column and were never re-fulfilled (backfilled by
   * migration 20260828120000, so this is belt-and-braces).
   */
  private computeFulfillmentStatus(
    items: { fulfillmentStatus: string | null; quantity: number; fulfilledQuantity?: number }[],
  ): OrderFulfillmentStatus {
    let ordered = 0;
    let shipped = 0;
    for (const li of items) {
      // The `?? ` fallback below never fired: the column is NOT NULL with a
      // default of 0, so a Shopify line — which the sync gives a status but no
      // count — read 0 rather than undefined. Recomputing the header on such an
      // order flipped it from FULFILLED to UNFULFILLED. Treat a zero count on a
      // line whose status says shipped as fully shipped.
      const counted = li.fulfilledQuantity ?? 0;
      const done =
        counted > 0
          ? counted
          : li.fulfillmentStatus === 'fulfilled' || li.fulfillmentStatus === 'delivered'
            ? li.quantity
            : 0;
      ordered += li.quantity;
      shipped += Math.min(done, li.quantity);
    }
    if (shipped === 0) return OrderFulfillmentStatus.UNFULFILLED;
    if (shipped >= ordered) return OrderFulfillmentStatus.FULFILLED;
    return OrderFulfillmentStatus.PARTIAL;
  }

  /**
   * Re-derive and persist `Order.fulfillmentStatus` from its lines, inside the
   * caller's transaction.
   *
   * Three mutation paths (`setVendorItemsStatus`, `markFulfillmentDelivered`,
   * `markVendorItemDelivered`) changed line state and never recomputed the
   * header, so putting an item on hold left the order still reading FULFILLED.
   * Measured on the dev DB before this fix: 15 of 51 orders had a header that
   * disagreed with their own lines.
   */
  private async refreshOrderFulfillmentStatus(
    tx: Prisma.TransactionClient,
    orderId: string,
  ): Promise<void> {
    const items = await tx.orderLineItem.findMany({
      where: { orderId },
      select: { fulfillmentStatus: true, quantity: true, fulfilledQuantity: true },
    });
    if (items.length === 0) return;
    await tx.order.update({
      where: { id: orderId },
      data: { fulfillmentStatus: this.computeFulfillmentStatus(items) },
    });
  }

  /**
   * The line-item status implied by how much of it has shipped. Keeps the
   * status string and `fulfilledQuantity` from drifting apart.
   */
  private statusForFulfilledQuantity(
    fulfilled: number,
    ordered: number,
    previous: string | null,
  ): string | null {
    if (fulfilled <= 0) return null;
    if (fulfilled >= ordered) {
      // Never downgrade a delivered line back to merely fulfilled.
      return previous === 'delivered' ? 'delivered' : 'fulfilled';
    }
    return 'partial';
  }

  // ─── PHASE 1 HELPERS ──────────────────────────────────────────────────────

  private async loadOrderWithChannel(id: string, orgId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id, organizationId: orgId, deletedAt: null },
      include: { channel: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }

  /**
   * Map an arbitrary address object (accepts both REST snake_case and the
   * camelCase shape Shopify GraphQL expects) into a MailingAddressInput.
   * Unknown fields fall through; the merchant DB stores addresses as raw
   * JSON so we tolerate variation.
   */
  private toShopifyAddress(addr: Record<string, unknown>): MailingAddressInput {
    const pick = (...keys: string[]): string | null => {
      for (const k of keys) {
        const v = addr[k];
        if (typeof v === 'string') return v;
      }
      return null;
    };
    return {
      address1: pick('address1'),
      address2: pick('address2'),
      city: pick('city'),
      province: pick('province'),
      country: pick('country'),
      countryCode: pick('countryCode', 'country_code'),
      zip: pick('zip'),
      firstName: pick('firstName', 'first_name'),
      lastName: pick('lastName', 'last_name'),
      phone: pick('phone'),
      company: pick('company'),
    };
  }
}