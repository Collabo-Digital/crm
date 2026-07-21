import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  ChannelPlatform,
  ChannelStatus,
  OrderFinancialStatus,
  OrderFulfillmentStatus,
  Prisma,
} from '@prisma/client';
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
import { ShopifyPushService } from '../channel/shopify-push.service';
import { ShopifyGraphqlClient } from '../channel/shopify-graphql.client';
import { ShopifyOAuthService } from '../channel/shopify-oauth.service';
import { OrganizationSettingsService } from '../organization-settings/organization-settings.service';
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

    // VENDOR role: a deliberately narrow projection — no customer, and the
    // amount is the vendor's own subtotal (their items only), matching the
    // vendor order detail page's `vendorSubtotal`.
    if (vendorScope) {
      return {
        data: data.map((order) => ({
          id: order.id,
          orderNumber: order.orderNumber,
          name: order.name,
          fulfillmentStatus: order.fulfillmentStatus,
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
        lineItems: {
          include: {
            variant: {
              select: {
                id: true,
                title: true,
                sku: true,
                price: true,
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
        timeline: { orderBy: { createdAt: 'desc' } },
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
    // Determine current and previous periods
    const now = new Date();
    const currentStart = query.dateFrom ? new Date(query.dateFrom) : new Date(now.getFullYear(), now.getMonth(), 1);
    const currentEnd = query.dateTo ? new Date(query.dateTo) : now;

    // Previous period = same duration, shifted back
    const duration = currentEnd.getTime() - currentStart.getTime();
    const previousStart = new Date(currentStart.getTime() - duration);
    const previousEnd = new Date(currentStart.getTime() - 1); // 1ms before current period starts

    const channelFilter = query.channelId ? { channelId: query.channelId } : {};

    const [
      currentOrders,
      previousOrders,
      currentPendingOrders,
      previousPendingOrders,
      currentSales,
      previousSales,
      currentProductsSold,
      previousProductsSold,
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

      // Total sales revenue (current period)
      this.prisma.order.aggregate({
        where: {
          organizationId: orgId, deletedAt: null, ...channelFilter,
          financialStatus: { in: ['PAID', 'PARTIALLY_PAID'] },
          externalCreatedAt: { gte: currentStart, lte: currentEnd },
        },
        _sum: { totalPrice: true },
      }),
      // Total sales revenue (previous period)
      this.prisma.order.aggregate({
        where: {
          organizationId: orgId, deletedAt: null, ...channelFilter,
          financialStatus: { in: ['PAID', 'PARTIALLY_PAID'] },
          externalCreatedAt: { gte: previousStart, lte: previousEnd },
        },
        _sum: { totalPrice: true },
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
    ]);

    return {
      period: {
        current: { from: currentStart.toISOString(), to: currentEnd.toISOString() },
        previous: { from: previousStart.toISOString(), to: previousEnd.toISOString() },
      },

      totalNewOrders: {
        current: currentOrders,
        previous: previousOrders,
        change: this.calcChange(currentOrders, previousOrders),
      },

      pendingOrders: {
        current: currentPendingOrders,
        previous: previousPendingOrders,
        change: this.calcChange(currentPendingOrders, previousPendingOrders),
      },

      totalSales: {
        current: currentSales._sum.totalPrice ?? 0,
        previous: previousSales._sum.totalPrice ?? 0,
        change: this.calcChange(
          Number(currentSales._sum.totalPrice ?? 0),
          Number(previousSales._sum.totalPrice ?? 0),
        ),
      },

      totalProductsSold: {
        current: currentProductsSold._sum.quantity ?? 0,
        previous: previousProductsSold._sum.quantity ?? 0,
        change: this.calcChange(
          currentProductsSold._sum.quantity ?? 0,
          previousProductsSold._sum.quantity ?? 0,
        ),
      },
    };
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

    const result = await this.prisma.$transaction(
      async (tx) => {
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
          include: { product: true },
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
            throw new BadRequestException(
              `Insufficient stock for "${v.product.title}${v.title && v.title !== 'Default Title' ? ` — ${v.title}` : ''}": ${v.inventoryQuantity} available, ${li.quantity} requested.`,
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

        let sellerGstin: { stateCode: string } | null = null;
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
            sellerGstin = await tx.organizationGstin.findFirst({
              where: { organizationId: orgId, isDefault: true, isActive: true },
              select: { stateCode: true },
            });
          }
        }

        // 5. Compute pricing per line item.
        const placeOfSupplyCode =
          dto.placeOfSupplyCode ||
          dto.customer.billingStateCode ||
          customer.billingStateCode ||
          sellerGstin?.stateCode ||
          '00';

        const isIntraState = sellerGstin
          ? this.calculator.isIntraState(
            sellerGstin.stateCode,
            placeOfSupplyCode,
          )
          : true;

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
        }> = [];

        let subtotal = 0;
        let totalTax = 0;

        for (const li of dto.lineItems) {
          const v = variantById.get(li.productVariantId)!;
          const unitPrice =
            li.unitPriceOverride ?? this.calculator.toNumber(v.price);
          const discount = li.discount ?? 0;

          const productGstRate = this.calculator.toNumber(v.product.gstRate);
          const gstRate = sellerGstin
            ? await this.taxResolver.resolveGstRate(
              orgId,
              v.product.id,
              productGstRate || null,
              placeOfSupplyCode,
            )
            : 0;

          const calc = this.calculator.calculateLineItem(
            { unitPrice, quantity: li.quantity, discount, gstRate },
            isIntraState,
          );

          subtotal += calc.taxableValue;
          totalTax += calc.totalTax;

          lineItemsToCreate.push({
            variantId: v.id,
            title: v.product.title,
            variantTitle: v.title || null,
            sku: v.sku ?? null,
            vendor: v.product.vendorKey ?? v.product.vendor,
            quantity: li.quantity,
            unitPrice,
            totalDiscount: discount,
            lineTotal: calc.totalAmount,
            taxAmount: calc.totalTax,
          });
        }

        const round = (n: number) => Math.round(n * 100) / 100;
        subtotal = round(subtotal);
        totalTax = round(totalTax);
        const grandTotal = round(subtotal + totalTax);

        // 6. Generate next sequential orderNumber. Serializable isolation +
        //    @@unique([channelId, externalId]) keep this collision-free under
        //    concurrency; the runtime will retry on serialization conflict.
        const last = await tx.order.findFirst({
          where: { organizationId: orgId },
          orderBy: { orderNumber: 'desc' },
          select: { orderNumber: true },
        });
        const nextNumber = (last?.orderNumber ?? 1000) + 1;

        // 7. Create the order with line items in a nested write.
        const now = new Date();
        const order = await tx.order.create({
          data: {
            organizationId: orgId,
            channelId: channel.id,
            customerId: customer.id,
            externalId: `manual_${randomUUID()}`,
            orderNumber: nextNumber,
            name: `#${nextNumber}`,
            financialStatus:
              dto.financialStatus ?? OrderFinancialStatus.PAID,
            fulfillmentStatus:
              dto.fulfillmentStatus ?? OrderFulfillmentStatus.FULFILLED,
            currency: org.currency || 'INR',
            subtotalPrice: subtotal,
            totalPrice: grandTotal,
            totalTax,
            totalDiscounts: 0,
            totalShippingPrice: 0,
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
                taxable: true,
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
        for (const li of dto.lineItems) {
          const v = variantById.get(li.productVariantId)!;
          if (!trackGlobally && v.trackQuantity === false) continue;
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

        // 9. Update customer denormalized counters.
        await tx.customer.update({
          where: { id: customer.id },
          data: {
            ordersCount: { increment: 1 },
            totalSpent: { increment: grandTotal },
          },
        });

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
                placeOfSupplyCode: dto.placeOfSupplyCode,
                notes: dto.note,
              },
            );
          } catch (err) {
            // Soft-fail: a missing GST detail (no seller GSTIN, etc.) must not
            // block a walk-in sale. Log it and proceed; the merchant can issue
            // the invoice later from the order detail page.
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

        return { order, invoice, invoiceError };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 15000,
      },
    );

    // Auto-push to Shopify — only if the org has opted in via
    // orderSettings.autoSyncToShopify. Default is OFF: offline orders stay
    // local and must be pushed manually (POST /orders/:id/sync) or in bulk
    // via the channels-page Sync action.
    // OUTSIDE the transaction so a queue/Redis hiccup never rolls back the
    // local sale.
    try {
      const orderSettings = await this.settings.getOrderSettings(orgId);
      if (orderSettings.autoSyncToShopify) {
        const shopifyChannel = await this.shopifyPushService.findShopifyChannel(
          orgId,
        );
        if (shopifyChannel?.status === 'CONNECTED') {
          // Mark as PENDING immediately so the UI shows "Syncing to Shopify…"
          // even before the worker picks the job up.
          await this.markPendingSync(result.order.id);
          await this.shopifyPushEnqueuer.enqueueOrderPush({
            type: 'order',
            orderId: result.order.id,
            organizationId: orgId,
          });
        }
      }
    } catch (err) {
      this.logger.warn(
        `Skipping Shopify push enqueue for order ${result.order.id}: ${err}`,
      );
    }

    return result;
  }

  // ─── MANUAL SYNC TO SHOPIFY ───
  // Push a single MANUAL offline order to the connected Shopify store on
  // demand. Idempotent — already-synced orders return early; already-queued
  // ones don't re-enqueue; failed pushes are retried.
  async syncToShopify(id: string, orgId: string) {
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
      | { status: 'PENDING' | 'SYNCED' | 'FAILED' }
      | null;

    if (sync?.status === 'SYNCED') {
      return { status: 'ALREADY_SYNCED' as const, orderId: order.id };
    }
    if (sync?.status === 'PENDING') {
      return { status: 'ALREADY_QUEUED' as const, orderId: order.id };
    }

    await this.markPendingSync(order.id);
    await this.shopifyPushEnqueuer.enqueueOrderPush({
      type: 'order',
      orderId: order.id,
      organizationId: orgId,
    });
    return { status: 'QUEUED' as const, orderId: order.id };
  }

  /** Stamp metadata.shopifySync = { status: 'PENDING', attempts: 0 }. */
  private async markPendingSync(orderId: string): Promise<void> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { metadata: true },
    });
    const meta =
      order?.metadata && typeof order.metadata === 'object' && !Array.isArray(order.metadata)
        ? (order.metadata as Prisma.JsonObject)
        : {};
    await this.prisma.order.update({
      where: { id: orderId },
      data: {
        metadata: {
          ...meta,
          shopifySync: { status: 'PENDING', attempts: 0 },
        } as Prisma.InputJsonObject,
      },
    });
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

    if (isShopify) {
      const { token, shopDomain } = await this.shopifyOAuth.getAccessToken(order.channel.id);
      const input: OrderUpdateInput = {
        id: ShopifyGraphqlClient.toGid('Order', order.externalId),
      };
      if (dto.tags !== undefined) input.tags = dto.tags;
      if (dto.note !== undefined) input.note = dto.note;
      if (dto.email !== undefined) input.email = dto.email;
      if (dto.phone !== undefined) input.phone = dto.phone;
      if (dto.poNumber !== undefined) input.poNumber = dto.poNumber;
      if (dto.customAttributes !== undefined) input.customAttributes = dto.customAttributes;
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

    const updatedFields = Object.keys(dto).filter(
      (k) => (dto as Record<string, unknown>)[k] !== undefined,
    );

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
    if (order.cancelledAt) {
      throw new BadRequestException('Order is already cancelled');
    }
    const isShopify = order.channel.platform === ChannelPlatform.SHOPIFY;

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

    return this.prisma.$transaction(async (tx) => {
      const data: Prisma.OrderUpdateInput = {
        cancelReason: dto.reason,
        cancelledAt: new Date(),
      };
      if (dto.refund) data.financialStatus = OrderFinancialStatus.REFUNDED;
      if (dto.restock) data.fulfillmentStatus = OrderFulfillmentStatus.RESTOCKED;
      const updated = await tx.order.update({ where: { id }, data });

      // Local restock for MANUAL channel orders. Shopify orders are restocked
      // server-side by the orderCancel mutation we already sent — adjusting
      // inventory locally would double-count once the next pull-sync lands.
      if (dto.restock && !isShopify) {
        const productSettings = await this.settings.getProductSettings(orgId);
        const trackGlobally = productSettings.trackQuantityGlobally === true;
        const lineItems = await tx.orderLineItem.findMany({
          where: { orderId: id },
          include: { variant: true },
        });
        for (const li of lineItems) {
          if (!li.variant) continue;
          if (!trackGlobally && li.variant.trackQuantity === false) continue;
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

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.order.update({
        where: { id },
        data: { financialStatus: OrderFinancialStatus.PAID },
      });
      await tx.orderTimelineEvent.create({
        data: { orderId: id, actorId: userId, action: 'paid', message: 'Order marked as paid' },
      });
      return updated;
    });
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

    return this.prisma.$transaction(async (tx) => {
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
  async listFulfillableLineItems(orderId: string, orgId: string) {
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
      return {
        source: 'shopify' as const,
        fulfillmentOrders: fos.map((fo) => ({
          id: fo.id,
          status: fo.status,
          locationName: fo.assignedLocation?.name ?? null,
          lineItems: fo.lineItems.nodes.map((li) => ({
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
        })),
      };
    }

    const lineItems = await this.prisma.orderLineItem.findMany({
      where: { orderId, fulfillmentStatus: { not: 'fulfilled' } },
      orderBy: { createdAt: 'asc' },
    });
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
            remainingQuantity: li.quantity,
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
   * line total) + a per-vendor subtotal + ship-to (name + postal address, no
   * contact) + the fulfilments touching their items. Still hides the order's
   * overall totals/tax/shipping, payment/financial status, refunds, timeline,
   * customer contact, and other vendors' items.
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
        lineItems: {
          where: { vendor: vendorScope },
          select: {
            id: true,
            title: true,
            variantTitle: true,
            sku: true,
            quantity: true,
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
    _userId: string,
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
    await this.prisma.orderLineItem.updateMany({
      where: { id: { in: lineItemIds }, orderId },
      data: { fulfillmentStatus: status === 'released' ? null : status },
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
      .filter((t) => t.lineItems.length > 0);

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
      select: { metadata: true },
    });
    if (!f) throw new NotFoundException('Fulfillment not found');
    const ids = this.fulfillmentLineItemIds(f.metadata);
    if (ids.length === 0) {
      throw new ForbiddenException('This fulfilment is not attributable to your items.');
    }
    const lines = await this.prisma.orderLineItem.findMany({
      where: { id: { in: ids } },
      select: { vendor: true },
    });
    if (lines.some((l) => l.vendor !== vendorScope)) {
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

  /** Ship-to name + postal address only — drops phone/email. */
  private sanitizeShipTo(addr: Prisma.JsonValue | null) {
    if (!addr || typeof addr !== 'object' || Array.isArray(addr)) return null;
    const a = addr as Record<string, unknown>;
    const str = (k: string) => (typeof a[k] === 'string' ? (a[k] as string) : null);
    const name =
      str('name') ?? ([str('first_name'), str('last_name')].filter(Boolean).join(' ') || null);
    return {
      name,
      company: str('company'),
      address1: str('address1'),
      address2: str('address2'),
      city: str('city'),
      province: str('province') ?? str('province_code'),
      zip: str('zip'),
      country: str('country') ?? str('country_code'),
    };
  }

  /** Mark a fulfilment as delivered locally + in Shopify (best-effort). */
  async markFulfillmentDelivered(
    orderId: string,
    orgId: string,
    _userId: string,
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

    await this.prisma.orderFulfillment.update({
      where: { id: fulfillmentId },
      data: { status: 'delivered', deliveredAt: new Date() },
    });

    // Reflect delivery on the line items so the per-product UI shows "delivered".
    const deliveredLineIds = this.fulfillmentLineItemIds(fulfillment.metadata);
    if (deliveredLineIds.length > 0) {
      await this.prisma.orderLineItem.updateMany({
        where: { id: { in: deliveredLineIds }, orderId },
        data: { fulfillmentStatus: 'delivered' },
      });
    }

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
    const shopifyMatch = (resp.order?.fulfillments ?? []).find(
      (f) =>
        f.status !== 'CANCELLED' &&
        f.fulfillmentLineItems.nodes.some(
          (n) => n.lineItem && ShopifyGraphqlClient.extractId(n.lineItem.id) === line.externalId,
        ),
    );
    if (!shopifyMatch) return null;

    // Record the mapping so per-product actions are instant next time.
    const externalId = ShopifyGraphqlClient.extractId(shopifyMatch.id);
    const existing = local.find((f) => f.externalId === externalId);
    const lineItemIds = Array.from(
      new Set([
        ...(existing ? this.fulfillmentLineItemIds(existing.metadata) : []),
        line.id,
      ]),
    );
    return this.prisma.orderFulfillment.upsert({
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
    _userId: string,
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

    await this.prisma.orderLineItem.update({
      where: { id: lineId },
      data: { fulfillmentStatus: 'delivered' },
    });
    if (fulfillment) {
      await this.prisma.orderFulfillment.update({
        where: { id: fulfillment.id },
        data: { status: 'delivered', deliveredAt: new Date() },
      });
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
    _userId: string,
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
    await this.prisma.orderLineItem.updateMany({
      where: { id: { in: ids }, orderId },
      data: { fulfillmentStatus: null },
    });
    if (fulfillment) {
      await this.prisma.orderFulfillment.update({
        where: { id: fulfillment.id },
        data: { status: 'cancelled' },
      });
    }
    const allItems = await this.prisma.orderLineItem.findMany({ where: { orderId } });
    await this.prisma.order.update({
      where: { id: orderId },
      data: { fulfillmentStatus: this.computeFulfillmentStatus(allItems) },
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
      let reopened = false;
      for (const fo of fos) {
        const hasRequested = fo.lineItems.nodes.some((foli) =>
          requestedExternalIds.has(ShopifyGraphqlClient.extractId(foli.lineItem.id)),
        );
        if (!hasRequested) continue;
        if (fo.status === 'ON_HOLD') {
          await this.graphql
            .request<FulfillmentOrderReleaseHoldResponse, FulfillmentOrderReleaseHoldVariables>(
              auth,
              FULFILLMENT_ORDER_RELEASE_HOLD_MUTATION,
              { id: fo.id },
            )
            .catch(() => undefined);
          reopened = true;
        } else if (fo.status === 'IN_PROGRESS') {
          await this.graphql
            .request<FulfillmentOrderOpenResponse, FulfillmentOrderOpenVariables>(
              auth,
              FULFILLMENT_ORDER_OPEN_MUTATION,
              { id: fo.id },
            )
            .catch(() => undefined);
          reopened = true;
        }
      }
      if (reopened) fos = await readFulfillmentOrders();

      // Group the requested line items by which FulfillmentOrder owns them.
      // If a single OrderLineItem spans multiple FOs (multi-location), we
      // greedily take from the first match — multi-location partial
      // fulfillment is Phase 2b. The remainingQuantity ceiling protects
      // against over-fulfilling.
      const grouped = new Map<string, Array<{ id: string; quantity: number }>>();
      for (const fo of fos) {
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
          requestedByLineItem.delete(orderLineItemId);
        }
      }
      if (grouped.size === 0) {
        throw new BadRequestException(
          'None of the requested line items are currently fulfillable.',
        );
      }

      const lineItemsByFulfillmentOrder = Array.from(grouped.entries()).map(
        ([fulfillmentOrderId, fulfillmentOrderLineItems]) => ({
          fulfillmentOrderId,
          fulfillmentOrderLineItems,
        }),
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
      ShopifyGraphqlClient.throwIfUserErrors(
        result.fulfillmentCreate.userErrors,
        'fulfillmentCreate',
      );

      // Local OrderFulfillment row is created when fulfillments/create
      // webhook fires (via upsertOrder), so just record the action in our
      // timeline here for immediate UI feedback.
      await this.prisma.orderTimelineEvent.create({
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

      // Optimistically reflect the fulfilment locally so the UI updates
      // immediately; the fulfillments/create webhook reconciles authoritatively
      // (idempotent). requestedIds may be local OR Shopify line-item ids.
      const fulfilledRequestedIds = dto.lineItems.map((li) => li.lineItemId);
      await this.prisma.orderLineItem.updateMany({
        where: {
          orderId,
          OR: [
            { id: { in: fulfilledRequestedIds } },
            { externalId: { in: fulfilledRequestedIds } },
          ],
        },
        data: { fulfillmentStatus: 'fulfilled' },
      });
      const itemsAfter = await this.prisma.orderLineItem.findMany({ where: { orderId } });
      await this.prisma.order.update({
        where: { id: orderId },
        data: { fulfillmentStatus: this.computeFulfillmentStatus(itemsAfter) },
      });

      // Record a local OrderFulfillment so it appears in the vendor's shipments
      // and can be marked delivered. Upsert by Shopify's fulfillment id (the
      // webhook reconciles the same row); lineItemIds attributes it to the vendor.
      const shopifyFulfillmentId = ShopifyGraphqlClient.extractId(
        result.fulfillmentCreate.fulfillment?.id ?? '',
      );
      if (shopifyFulfillmentId) {
        const fulfilledLocalIds = (
          await this.prisma.orderLineItem.findMany({
            where: {
              orderId,
              OR: [
                { id: { in: fulfilledRequestedIds } },
                { externalId: { in: fulfilledRequestedIds } },
              ],
            },
            select: { id: true },
          })
        ).map((l) => l.id);
        await this.prisma.orderFulfillment.upsert({
          where: { orderId_externalId: { orderId, externalId: shopifyFulfillmentId } },
          create: {
            orderId,
            externalId: shopifyFulfillmentId,
            status: 'fulfilled',
            trackingNumber: dto.tracking?.number ?? null,
            trackingUrl: dto.tracking?.url ?? null,
            trackingCompany: dto.tracking?.company ?? null,
            shippedAt: new Date(),
            metadata: { lineItemIds: fulfilledLocalIds } as Prisma.InputJsonValue,
          },
          update: { metadata: { lineItemIds: fulfilledLocalIds } as Prisma.InputJsonValue },
        });
      }

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

      await tx.orderLineItem.updateMany({
        where: { id: { in: lineItems.map((li) => li.id) } },
        data: { fulfillmentStatus: 'fulfilled' },
      });

      const allItems = await tx.orderLineItem.findMany({ where: { orderId } });
      const newStatus = this.computeFulfillmentStatus(allItems);
      await tx.order.update({
        where: { id: orderId },
        data: { fulfillmentStatus: newStatus },
      });

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
    return this.updateTracking(orderId, fulfillment.id, orgId, userId, dto);
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
            where: { id: { in: lineItemIds } },
            data: { fulfillmentStatus: null },
          });
        }
        const allItems = await tx.orderLineItem.findMany({ where: { orderId } });
        const newStatus = this.computeFulfillmentStatus(allItems);
        await tx.order.update({
          where: { id: orderId },
          data: { fulfillmentStatus: newStatus },
        });
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

  /** Compute order-level fulfillment status from the per-line-item state. */
  private computeFulfillmentStatus(
    items: { fulfillmentStatus: string | null }[],
  ): OrderFulfillmentStatus {
    const fulfilled = items.filter(
      (li) => li.fulfillmentStatus === 'fulfilled' || li.fulfillmentStatus === 'delivered',
    ).length;
    if (fulfilled === 0) return OrderFulfillmentStatus.UNFULFILLED;
    if (fulfilled === items.length) return OrderFulfillmentStatus.FULFILLED;
    return OrderFulfillmentStatus.PARTIAL;
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