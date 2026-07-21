import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  ChannelPlatform,
  ChannelStatus,
  DraftOrderStatus,
  Prisma,
} from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { GstCalculatorService } from '../gst/gst-calculator.service';
import { TaxResolverService } from '../gst/tax-resolver.service';
import { OrderService } from '../order/order.service';
import { ShopifyGraphqlClient } from '../channel/shopify-graphql.client';
import { ShopifyOAuthService } from '../channel/shopify-oauth.service';
import { ShopifySyncService } from '../channel/shopify-sync.service';
import { OrganizationSettingsService } from '../organization-settings/organization-settings.service';
import { DraftMirrorEnqueuer } from './draft-mirror.enqueuer';
import {
  DRAFT_ORDER_COMPLETE_MUTATION,
  DRAFT_ORDER_CREATE_MUTATION,
  DRAFT_ORDER_DELETE_MUTATION,
  DRAFT_ORDER_INVOICE_SEND_MUTATION,
  DRAFT_ORDER_UPDATE_MUTATION,
  DraftOrderCompleteResponse,
  DraftOrderCompleteVariables,
  DraftOrderCreateResponse,
  DraftOrderCreateVariables,
  DraftOrderDeleteResponse,
  DraftOrderDeleteVariables,
  DraftOrderInputShape,
  DraftOrderInvoiceSendResponse,
  DraftOrderInvoiceSendVariables,
  DraftOrderLineItemInput,
  DraftOrderUpdateResponse,
  DraftOrderUpdateVariables,
} from '../channel/shopify-graphql.types';
import { CreateDraftOrderDto } from './dto/create-draft-order.dto';
import { UpdateDraftOrderDto } from './dto/update-draft-order.dto';
import { CompleteDraftDto } from './dto/complete-draft.dto';
import { SendDraftInvoiceDto } from './dto/send-invoice.dto';
import { QueryDraftOrdersDto } from './dto/query-drafts.dto';

/**
 * Draft orders — in-progress / quote-style orders that haven't been
 * finalized. Sits beside `OrderService` (which handles finalized Orders);
 * they share the offline-order completion path so the same GST math,
 * customer resolution, and (optional) invoice generation rules apply on
 * either entry point.
 *
 * Dual-channel: MANUAL workspaces keep drafts purely local. SHOPIFY-
 * connected workspaces auto-mirror to Shopify via `draftOrderCreate` /
 * `Update` / `Delete` / `Complete` / `InvoiceSend`. Mirror failures are
 * logged but do NOT fail the local action — drafts must be saveable even
 * if Shopify is temporarily down. The merchant can re-sync stuck drafts
 * later.
 */
@Injectable()
export class DraftOrderService {
  private readonly logger = new Logger(DraftOrderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly calculator: GstCalculatorService,
    private readonly taxResolver: TaxResolverService,
    private readonly orderService: OrderService,
    private readonly graphql: ShopifyGraphqlClient,
    private readonly shopifyOAuth: ShopifyOAuthService,
    private readonly shopifySync: ShopifySyncService,
    private readonly mirrorEnqueuer: DraftMirrorEnqueuer,
    private readonly settings: OrganizationSettingsService,
  ) {}

  /**
   * Returns true when the org has opted into auto-pushing drafts to Shopify.
   * Drafts ride on `orderSettings.autoSyncToShopify` — they're pre-orders, so
   * sharing the same opt-in as offline orders matches user intent ("I want
   * Shopify to know about my counter-sales") and avoids adding yet another
   * toggle. When this is false, mirror jobs are NOT enqueued; the draft stays
   * local until the merchant hits "Sync Now" on the channels page.
   */
  private async autoMirrorEnabled(orgId: string): Promise<boolean> {
    const orderSettings = await this.settings.getOrderSettings(orgId);
    return orderSettings.autoSyncToShopify === true;
  }

  // ─── LIST ───
  async findAll(orgId: string, query: QueryDraftOrdersDto) {
    const where: Prisma.DraftOrderWhereInput = {
      organizationId: orgId,
      deletedAt: null,
    };

    if (query.status) where.status = query.status;
    if (query.channelId) where.channelId = query.channelId;
    if (query.customerId) where.customerId = query.customerId;

    if (query.search) {
      const term = query.search.trim();
      where.OR = [
        { name: { contains: term, mode: 'insensitive' } },
        { customerEmail: { contains: term, mode: 'insensitive' } },
        {
          customer: {
            OR: [
              { firstName: { contains: term, mode: 'insensitive' } },
              { lastName: { contains: term, mode: 'insensitive' } },
              { email: { contains: term, mode: 'insensitive' } },
            ],
          },
        },
      ];
    }

    if (query.dateFrom || query.dateTo) {
      where.createdAt = {};
      if (query.dateFrom) where.createdAt.gte = new Date(query.dateFrom);
      if (query.dateTo) where.createdAt.lte = new Date(query.dateTo);
    }

    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;
    const sortBy = query.sortBy ?? 'updatedAt';
    const sortOrder = query.sortOrder ?? 'desc';

    const [data, total] = await Promise.all([
      this.prisma.draftOrder.findMany({
        where,
        include: {
          customer: { select: { id: true, firstName: true, lastName: true, email: true } },
          channel: { select: { id: true, name: true, platform: true } },
          _count: { select: { lineItems: true } },
          completedOrder: { select: { id: true, name: true } },
        },
        orderBy: { [sortBy]: sortOrder },
        skip,
        take: limit,
      }),
      this.prisma.draftOrder.count({ where }),
    ]);

    return {
      data: data.map((d) => ({
        id: d.id,
        name: d.name,
        status: d.status,
        currency: d.currency,
        totalPrice: d.totalPrice,
        subtotalPrice: d.subtotalPrice,
        totalTax: d.totalTax,
        totalDiscounts: d.totalDiscounts,
        totalShippingPrice: d.totalShippingPrice,
        customerEmail: d.customerEmail,
        note: d.note,
        tags: d.tags,
        invoiceUrl: d.invoiceUrl,
        invoiceSentAt: d.invoiceSentAt,
        completedAt: d.completedAt,
        completedOrder: d.completedOrder,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
        customer: d.customer,
        channel: d.channel,
        itemCount: d._count.lineItems,
      })),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  // ─── DETAIL ───
  async findOne(id: string, orgId: string) {
    const draft = await this.prisma.draftOrder.findFirst({
      where: { id, organizationId: orgId, deletedAt: null },
      include: {
        customer: true,
        channel: { select: { id: true, name: true, platform: true } },
        lineItems: {
          include: {
            variant: {
              select: { id: true, title: true, sku: true, price: true },
            },
          },
        },
        completedOrder: {
          select: { id: true, name: true, orderNumber: true },
        },
      },
    });
    if (!draft) throw new NotFoundException('Draft order not found');
    return draft;
  }

  // ─── CREATE ───
  async create(orgId: string, userId: string, dto: CreateDraftOrderDto) {
    const variantIds = dto.lineItems.map((li) => li.productVariantId);
    if (new Set(variantIds).size !== variantIds.length) {
      throw new BadRequestException(
        'Duplicate variant IDs are not allowed; merge them into a single line item.',
      );
    }

    const draft = await this.prisma.$transaction(async (tx) => {
      // 1. Resolve or lazy-create the MANUAL channel for this org.
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

      // 2. Resolve customer (optional — drafts can be anonymous).
      const customer = dto.customer
        ? await this.resolveCustomer(tx, orgId, channel.id, dto.customer)
        : null;

      // 3. Fetch variants for line-item snapshots + tax math.
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

      const org = await tx.organization.findUnique({
        where: { id: orgId },
        select: { gstEnabled: true, currency: true },
      });
      if (!org) throw new NotFoundException('Organization not found');

      // 4. Compute pricing. Use seller-default GSTIN for state code if
      //    we have GST enabled. Drafts don't generate invoices, so we
      //    don't need a sellerGstinId from the DTO.
      let sellerState: string | null = null;
      if (org.gstEnabled) {
        const sellerGstin = await tx.organizationGstin.findFirst({
          where: { organizationId: orgId, isDefault: true, isActive: true },
          select: { stateCode: true },
        });
        sellerState = sellerGstin?.stateCode ?? null;
      }

      const placeOfSupplyCode =
        dto.placeOfSupplyCode ||
        dto.customer?.billingStateCode ||
        customer?.billingStateCode ||
        sellerState ||
        '00';

      const isIntraState = sellerState
        ? this.calculator.isIntraState(sellerState, placeOfSupplyCode)
        : true;

      const lineRows: Array<{
        variantId: string;
        title: string;
        variantTitle: string | null;
        sku: string | null;
        quantity: number;
        unitPrice: number;
        totalDiscount: number;
      }> = [];

      let subtotal = 0;
      let totalTax = 0;

      for (const li of dto.lineItems) {
        const v = variantById.get(li.productVariantId)!;
        const unitPrice = li.unitPriceOverride ?? this.calculator.toNumber(v.price);
        const discount = li.discount ?? 0;

        const productGstRate = this.calculator.toNumber(v.product.gstRate);
        const gstRate = sellerState
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

        lineRows.push({
          variantId: v.id,
          title: v.product.title,
          variantTitle: v.title || null,
          sku: v.sku ?? null,
          quantity: li.quantity,
          unitPrice,
          totalDiscount: discount,
        });
      }

      const round = (n: number) => Math.round(n * 100) / 100;
      subtotal = round(subtotal);
      totalTax = round(totalTax);
      const grandTotal = round(subtotal + totalTax);

      const draft = await tx.draftOrder.create({
        data: {
          organizationId: orgId,
          channelId: channel.id,
          customerId: customer?.id,
          customerEmail: customer?.email ?? dto.customer?.email ?? null,
          status: DraftOrderStatus.OPEN,
          currency: org.currency || 'INR',
          subtotalPrice: subtotal,
          totalPrice: grandTotal,
          totalTax,
          totalDiscounts: 0,
          totalShippingPrice: 0,
          note: dto.note,
          tags: dto.tags ?? [],
          // Stable local-CRM name. We used to leave this null and adopt
          // Shopify's "#D1234" on mirror, but that meant the same draft
          // had two different names depending on whether you looked at
          // it before or after sync. Now we set a random local name at
          // creation; the Shopify-side name still exists via
          // `externalId` and the admin URL for cross-reference but the
          // CRM never overwrites this column post-creation.
          name: `Draft-${randomUUID().slice(0, 6).toUpperCase()}`,
          // Prisma's nullable JSON columns reject raw `null` — they want
          // `Prisma.JsonNull` or the field omitted entirely. We just skip
          // the field when the DTO didn't include it.
          ...(dto.shippingAddress !== undefined && {
            shippingAddress: dto.shippingAddress as Prisma.InputJsonValue,
          }),
          ...(dto.billingAddress !== undefined && {
            billingAddress: dto.billingAddress as Prisma.InputJsonValue,
          }),
          metadata: {
            createdByUserId: userId,
            placeOfSupplyCode,
          } as Prisma.InputJsonObject,
          lineItems: {
            create: lineRows.map((r) => ({
              variantId: r.variantId,
              externalId: `manual_${randomUUID()}`,
              title: r.title,
              variantTitle: r.variantTitle,
              sku: r.sku,
              quantity: r.quantity,
              price: r.unitPrice,
              totalDiscount: r.totalDiscount,
              taxable: true,
              requiresShipping: false,
            })),
          },
        },
        include: {
          customer: true,
          channel: { select: { id: true, name: true, platform: true } },
          lineItems: true,
        },
      });

      return draft;
    });

    // Auto-mirror to Shopify via BullMQ (Redis-backed). Gated on
    // `orderSettings.autoSyncToShopify` — drafts stay local by default; the
    // merchant has to either flip the toggle in Settings → Orders or hit
    // "Sync Now" on the channels page to push them. Returns instantly;
    // BullMQ owns retry + backoff. Local row is saved regardless of Shopify
    // availability — the `externalId` and `name` columns fill in once the
    // mirror job runs successfully.
    if (await this.autoMirrorEnabled(orgId)) {
      await this.mirrorEnqueuer.enqueueCreate({
        type: 'draft-create',
        draftId: draft.id,
        organizationId: orgId,
      });
    } else {
      this.logger.log(
        `[draft-mirror] Auto-sync OFF for org ${orgId} — draft ${draft.id} not pushed to Shopify (use channels-page "Sync Now" to mirror).`,
      );
    }

    return this.findOne(draft.id, orgId);
  }

  // ─── UPDATE ───
  async update(id: string, orgId: string, userId: string, dto: UpdateDraftOrderDto) {
    const existing = await this.prisma.draftOrder.findFirst({
      where: { id, organizationId: orgId, deletedAt: null },
      select: { id: true, status: true },
    });
    if (!existing) throw new NotFoundException('Draft order not found');
    if (existing.status !== DraftOrderStatus.OPEN) {
      throw new BadRequestException(
        `Cannot edit a draft in status ${existing.status}. Only OPEN drafts are editable.`,
      );
    }

    // If line items are present in the patch, recompute totals by rebuilding
    // the line-item list. Otherwise just patch top-level fields.
    if (dto.lineItems && dto.lineItems.length > 0) {
      // Reuse the create() math via a small detour: delete existing line
      // items, then run the create-style pricing pass. Easier than diffing.
      await this.prisma.draftOrderLineItem.deleteMany({
        where: { draftOrderId: id },
      });
      // Re-pricing happens inside a separate transaction below.
      const reCreated = await this.recomputeLineItemsAndTotals(
        id,
        orgId,
        userId,
        dto,
      );
      if (await this.autoMirrorEnabled(orgId)) {
        await this.mirrorEnqueuer.enqueueUpdate({
          type: 'draft-update',
          draftId: id,
          organizationId: orgId,
        });
      }
      return this.findOne(id, orgId);
    }

    const data: Prisma.DraftOrderUpdateInput = {};
    if (dto.note !== undefined) data.note = dto.note;
    if (dto.tags !== undefined) data.tags = dto.tags;
    if (dto.shippingAddress !== undefined) {
      data.shippingAddress = dto.shippingAddress as Prisma.InputJsonValue;
    }
    if (dto.billingAddress !== undefined) {
      data.billingAddress = dto.billingAddress as Prisma.InputJsonValue;
    }
    // Customer changes: only allow if the patch provides a non-empty customer.
    if (dto.customer) {
      const channel = await this.prisma.draftOrder.findUnique({
        where: { id },
        select: { channelId: true },
      });
      const resolved = await this.resolveCustomer(
        this.prisma,
        orgId,
        channel!.channelId,
        dto.customer,
      );
      data.customer = { connect: { id: resolved.id } };
      data.customerEmail = resolved.email ?? dto.customer.email ?? null;
    }

    const updated = await this.prisma.draftOrder.update({
      where: { id },
      data,
      include: {
        customer: true,
        channel: { select: { id: true, name: true, platform: true } },
        lineItems: true,
      },
    });

    if (await this.autoMirrorEnabled(orgId)) {
      await this.mirrorEnqueuer.enqueueUpdate({
        type: 'draft-update',
        draftId: updated.id,
        organizationId: orgId,
      });
    }

    return this.findOne(updated.id, orgId);
  }

  /**
   * After a `lineItems` patch comes in, we recompute totals from scratch
   * by walking the same path as create(). Done in its own transaction so
   * a recompute failure doesn't half-update the draft.
   */
  private async recomputeLineItemsAndTotals(
    id: string,
    orgId: string,
    userId: string,
    dto: UpdateDraftOrderDto,
  ) {
    const draftMeta = await this.prisma.draftOrder.findUniqueOrThrow({
      where: { id },
      select: { channelId: true, customerId: true },
    });

    // Reuse create() shape — build a CreateDraftOrderDto from the patch +
    // existing draft metadata, then call the create logic against an
    // existing row (we update in place rather than insert).
    const variantIds = (dto.lineItems ?? []).map((li) => li.productVariantId);

    return this.prisma.$transaction(async (tx) => {
      const variants = await tx.productVariant.findMany({
        where: {
          id: { in: variantIds },
          product: { organizationId: orgId },
        },
        include: { product: true },
      });
      const variantById = new Map(variants.map((v) => [v.id, v]));
      const missing = variantIds.filter((vid) => !variantById.has(vid));
      if (missing.length > 0) {
        throw new NotFoundException(
          `Product variants not found: ${missing.join(', ')}`,
        );
      }

      const org = await tx.organization.findUniqueOrThrow({
        where: { id: orgId },
        select: { gstEnabled: true, currency: true },
      });

      let sellerState: string | null = null;
      if (org.gstEnabled) {
        const sellerGstin = await tx.organizationGstin.findFirst({
          where: { organizationId: orgId, isDefault: true, isActive: true },
          select: { stateCode: true },
        });
        sellerState = sellerGstin?.stateCode ?? null;
      }

      const placeOfSupplyCode =
        dto.placeOfSupplyCode || sellerState || '00';
      const isIntraState = sellerState
        ? this.calculator.isIntraState(sellerState, placeOfSupplyCode)
        : true;

      let subtotal = 0;
      let totalTax = 0;
      const lineRows: Array<{
        variantId: string;
        title: string;
        variantTitle: string | null;
        sku: string | null;
        quantity: number;
        unitPrice: number;
        totalDiscount: number;
      }> = [];

      for (const li of dto.lineItems ?? []) {
        const v = variantById.get(li.productVariantId)!;
        const unitPrice =
          li.unitPriceOverride ?? this.calculator.toNumber(v.price);
        const discount = li.discount ?? 0;

        const productGstRate = this.calculator.toNumber(v.product.gstRate);
        const gstRate = sellerState
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
        lineRows.push({
          variantId: v.id,
          title: v.product.title,
          variantTitle: v.title || null,
          sku: v.sku ?? null,
          quantity: li.quantity,
          unitPrice,
          totalDiscount: discount,
        });
      }

      const round = (n: number) => Math.round(n * 100) / 100;
      subtotal = round(subtotal);
      totalTax = round(totalTax);
      const grandTotal = round(subtotal + totalTax);

      await tx.draftOrderLineItem.createMany({
        data: lineRows.map((r) => ({
          draftOrderId: id,
          variantId: r.variantId,
          externalId: `manual_${randomUUID()}`,
          title: r.title,
          variantTitle: r.variantTitle,
          sku: r.sku,
          quantity: r.quantity,
          price: r.unitPrice,
          totalDiscount: r.totalDiscount,
          taxable: true,
          requiresShipping: false,
        })),
      });

      const topLevel: Prisma.DraftOrderUpdateInput = {
        subtotalPrice: subtotal,
        totalPrice: grandTotal,
        totalTax,
        totalDiscounts: 0,
      };
      if (dto.note !== undefined) topLevel.note = dto.note;
      if (dto.tags !== undefined) topLevel.tags = dto.tags;
      if (dto.shippingAddress !== undefined) {
        topLevel.shippingAddress = dto.shippingAddress as Prisma.InputJsonValue;
      }
      if (dto.billingAddress !== undefined) {
        topLevel.billingAddress = dto.billingAddress as Prisma.InputJsonValue;
      }
      if (dto.customer) {
        const resolved = await this.resolveCustomer(
          tx,
          orgId,
          draftMeta.channelId,
          dto.customer,
        );
        topLevel.customer = { connect: { id: resolved.id } };
        topLevel.customerEmail = resolved.email ?? dto.customer.email ?? null;
      }

      return tx.draftOrder.update({
        where: { id },
        data: topLevel,
        include: {
          customer: true,
          channel: { select: { id: true, name: true, platform: true } },
          lineItems: true,
        },
      });
    });
  }

  // ─── DELETE ───
  async softDelete(id: string, orgId: string) {
    const existing = await this.prisma.draftOrder.findFirst({
      where: { id, organizationId: orgId, deletedAt: null },
      select: { id: true, status: true, externalId: true },
    });
    if (!existing) throw new NotFoundException('Draft order not found');
    if (existing.status === DraftOrderStatus.COMPLETED) {
      throw new BadRequestException(
        'Cannot delete a completed draft. Cancel or refund the resulting order instead.',
      );
    }

    // Local soft-delete commits immediately. Shopify-side delete is
    // queued — BullMQ retries handle transient failures so we don't need
    // a synchronous best-effort attempt here.
    await this.prisma.draftOrder.update({
      where: { id },
      data: { deletedAt: new Date() },
    });

    if (existing.externalId) {
      await this.mirrorEnqueuer.enqueueDelete({
        type: 'draft-delete',
        externalId: existing.externalId,
        organizationId: orgId,
      });
    }

    return { id, deletedAt: new Date().toISOString() };
  }

  /**
   * Channels-page "Sync Now" hook — push every locally-unsynced draft
   * (status OPEN, no externalId, not soft-deleted) to Shopify. Unlike the
   * per-action mirror this is unconditional with respect to the org's
   * auto-sync setting: the merchant explicitly clicked Sync, so we honour
   * that intent. Each draft becomes one BullMQ job so retry semantics are
   * per-draft.
   */
  async bulkMirrorUnsyncedDrafts(orgId: string): Promise<void> {
    const shopify = await this.findShopifyChannel(orgId);
    if (!shopify || shopify.status !== ChannelStatus.CONNECTED) {
      this.logger.log(
        `[draft-mirror] No connected Shopify channel for org ${orgId} — bulk mirror skipped.`,
      );
      return;
    }

    const drafts = await this.prisma.draftOrder.findMany({
      where: {
        organizationId: orgId,
        deletedAt: null,
        status: DraftOrderStatus.OPEN,
        externalId: null,
      },
      select: { id: true },
    });

    if (drafts.length === 0) {
      this.logger.log(`[draft-mirror] No unsynced drafts to push for org ${orgId}.`);
      return;
    }

    this.logger.log(
      `[draft-mirror] Bulk-pushing ${drafts.length} unsynced draft(s) for org ${orgId}.`,
    );
    for (const d of drafts) {
      await this.mirrorEnqueuer.enqueueCreate({
        type: 'draft-create',
        draftId: d.id,
        organizationId: orgId,
      });
    }
  }

  // ─── COMPLETE → real Order ───
  async complete(
    id: string,
    orgId: string,
    userId: string,
    dto: CompleteDraftDto,
  ) {
    const draft = await this.prisma.draftOrder.findFirst({
      where: { id, organizationId: orgId, deletedAt: null },
      include: {
        customer: true,
        channel: true,
        lineItems: true,
      },
    });
    if (!draft) throw new NotFoundException('Draft order not found');
    if (draft.status === DraftOrderStatus.COMPLETED) {
      throw new BadRequestException(
        'Draft is already completed. See the linked order.',
      );
    }

    // ── Shopify completion path ──────────────────────────────────────────
    // If the draft was mirrored to Shopify, call draftOrderComplete which
    // converts the Shopify draft into a real Shopify Order. We then trigger
    // a one-shot order sync so the new order lands in our DB.
    if (draft.externalId) {
      const shopify = await this.findShopifyChannel(orgId);
      if (shopify && shopify.status === ChannelStatus.CONNECTED) {
        return this.completeViaShopify(draft.id, orgId, shopify.id, dto);
      }
      // Shopify draft exists but channel is disconnected — fall through to
      // the manual completion path below as a graceful degrade.
    }

    if (!dto.paymentMethod) {
      throw new BadRequestException(
        'paymentMethod is required when completing a draft (CASH, CARD, UPI, or OTHER).',
      );
    }

    // Build the offline-order DTO from the draft and delegate to
    // OrderService.createOfflineOrder — same machinery as walk-in sales,
    // so GST / invoice / customer-counter updates are consistent.
    const result = await this.orderService.createOfflineOrder(orgId, userId, {
      customer: {
        customerId: draft.customerId ?? undefined,
        email: draft.customer?.email ?? draft.customerEmail ?? undefined,
        phone: draft.customer?.phone ?? undefined,
        firstName: draft.customer?.firstName ?? undefined,
        lastName: draft.customer?.lastName ?? undefined,
        gstin: draft.customer?.gstin ?? undefined,
        billingStateCode: draft.customer?.billingStateCode ?? undefined,
      },
      lineItems: draft.lineItems.map((li) => ({
        productVariantId: li.variantId!,
        quantity: li.quantity,
        unitPriceOverride: this.calculator.toNumber(li.price),
        discount: this.calculator.toNumber(li.totalDiscount),
      })),
      paymentMethod: dto.paymentMethod,
      note: draft.note ?? undefined,
      generateInvoice: dto.generateInvoice ?? true,
      sellerGstinId: dto.sellerGstinId,
    });

    // Link the draft to the newly-created order and mark COMPLETED.
    await this.prisma.draftOrder.update({
      where: { id: draft.id },
      data: {
        status: DraftOrderStatus.COMPLETED,
        completedAt: new Date(),
        completedOrderId: result.order.id,
      },
    });

    return {
      draftId: draft.id,
      order: result.order,
      invoice: result.invoice,
      invoiceError: result.invoiceError,
    };
  }

  // ─── SEND INVOICE ───
  // Hosted-checkout invoice email. Only meaningful for drafts that have a
  // Shopify mirror — there's no equivalent in our local-only path because
  // there's no payment processor to take payment.
  async sendInvoice(
    id: string,
    orgId: string,
    userId: string,
    dto: SendDraftInvoiceDto,
  ) {
    const draft = await this.prisma.draftOrder.findFirst({
      where: { id, organizationId: orgId, deletedAt: null },
      include: { channel: true, customer: true },
    });
    if (!draft) throw new NotFoundException('Draft order not found');
    if (!draft.externalId) {
      throw new BadRequestException(
        'This draft is not mirrored to Shopify. Connect a Shopify channel and re-create the draft to use hosted invoice emails.',
      );
    }
    if (draft.status === DraftOrderStatus.COMPLETED) {
      throw new BadRequestException(
        'Cannot send invoice for a completed draft.',
      );
    }

    const shopify = await this.findShopifyChannel(orgId);
    if (!shopify || shopify.status !== ChannelStatus.CONNECTED) {
      throw new BadRequestException(
        'No connected Shopify channel. Reconnect Shopify and try again.',
      );
    }

    const recipient = dto.to ?? draft.customerEmail ?? draft.customer?.email;
    if (!recipient) {
      throw new BadRequestException(
        'No recipient email. Attach a customer or pass `to` in the request body.',
      );
    }

    const { token, shopDomain } = await this.shopifyOAuth.getAccessToken(
      shopify.id,
    );
    const draftGid = ShopifyGraphqlClient.toGid('DraftOrder', draft.externalId);

    const result = await this.graphql.request<
      DraftOrderInvoiceSendResponse,
      DraftOrderInvoiceSendVariables
    >(
      { shopDomain, accessToken: token },
      DRAFT_ORDER_INVOICE_SEND_MUTATION,
      {
        id: draftGid,
        email: {
          to: recipient,
          subject: dto.subject,
          customMessage: dto.customMessage,
          bcc: dto.bcc,
        },
      },
    );
    ShopifyGraphqlClient.throwIfUserErrors(
      result.draftOrderInvoiceSend.userErrors,
      'draftOrderInvoiceSend',
    );

    const remote = result.draftOrderInvoiceSend.draftOrder;
    const updated = await this.prisma.draftOrder.update({
      where: { id: draft.id },
      data: {
        status: DraftOrderStatus.INVOICE_SENT,
        invoiceUrl: remote?.invoiceUrl ?? draft.invoiceUrl,
        invoiceSentAt: remote?.invoiceSentAt
          ? new Date(remote.invoiceSentAt)
          : new Date(),
      },
    });
    return updated;
  }

  // ─── HELPERS ───

  /**
   * Resolve a customer for a draft: by id, then email, then phone, else
   * create. Trimmed-down copy of OrderService.resolveCustomer — drafts
   * don't require any one identifier (anonymous drafts are valid via the
   * callsite gating in create()).
   */
  private async resolveCustomer(
    tx: Prisma.TransactionClient | PrismaService,
    orgId: string,
    manualChannelId: string,
    input: NonNullable<CreateDraftOrderDto['customer']>,
  ) {
    if (input.customerId) {
      const existing = await tx.customer.findFirst({
        where: { id: input.customerId, organizationId: orgId },
      });
      if (!existing) throw new NotFoundException('Customer not found');
      return existing;
    }
    if (input.email) {
      const byEmail = await tx.customer.findFirst({
        where: { organizationId: orgId, email: input.email },
      });
      if (byEmail) return byEmail;
    }
    if (input.phone) {
      const byPhone = await tx.customer.findFirst({
        where: { organizationId: orgId, phone: input.phone },
      });
      if (byPhone) return byPhone;
    }
    if (
      !input.email &&
      !input.phone &&
      !input.firstName &&
      !input.lastName
    ) {
      throw new BadRequestException(
        'Customer details required: provide customerId, email, phone, or a name (or omit the customer block entirely for an anonymous draft).',
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

  // ─── SHOPIFY MIRROR HELPERS ───────────────────────────────────────────

  /** Returns the org's connected Shopify channel, or null. */
  private async findShopifyChannel(orgId: string) {
    return this.prisma.channel.findUnique({
      where: {
        organizationId_platform: {
          organizationId: orgId,
          platform: ChannelPlatform.SHOPIFY,
        },
      },
    });
  }

  /**
   * Convert a local DraftOrder + its line items into the Shopify
   * `DraftOrderInput` shape. Only variants that have a Shopify externalId
   * are included — CRM-only products without a Shopify mirror are dropped
   * with a warning, since `draftOrderCreate` can't reference them.
   */
  private async buildShopifyInput(
    draftId: string,
  ): Promise<DraftOrderInputShape> {
    const draft = await this.prisma.draftOrder.findUniqueOrThrow({
      where: { id: draftId },
      include: {
        lineItems: {
          include: {
            variant: { select: { externalId: true } },
          },
        },
        customer: { select: { externalId: true, email: true } },
      },
    });

    const lineItems: DraftOrderLineItemInput[] = [];
    for (const li of draft.lineItems) {
      // `ProductVariant.externalId` is a required column on every variant —
      // for CRM-only (MANUAL channel) products it's set to a synthetic
      // `manual_<uuid>` so it's always truthy. Only treat it as a real
      // Shopify variant ID when it doesn't carry the `manual_` prefix;
      // otherwise fall through to a custom-titled line item (no Shopify
      // inventory link, but the draft still pushes correctly).
      const shopifyVariantId =
        li.variant?.externalId &&
        !li.variant.externalId.startsWith('manual_')
          ? li.variant.externalId
          : null;

      if (shopifyVariantId) {
        lineItems.push({
          variantId: ShopifyGraphqlClient.toGid(
            'ProductVariant',
            shopifyVariantId,
          ),
          quantity: li.quantity,
          originalUnitPrice: this.calculator.toNumber(li.price).toFixed(2),
        });
      } else {
        // Variant is CRM-only — Shopify can't reference it, so we send
        // a custom line item with the snapshot title + price instead.
        lineItems.push({
          title: li.variantTitle
            ? `${li.title} — ${li.variantTitle}`
            : li.title,
          quantity: li.quantity,
          originalUnitPrice: this.calculator.toNumber(li.price).toFixed(2),
        });
      }
    }

    const input: DraftOrderInputShape = {
      lineItems,
      note: draft.note,
      tags: draft.tags,
      email: draft.customerEmail ?? draft.customer?.email,
    };

    // Attach the Shopify customer GID if we have one (so the draft on
    // Shopify is tied to the same customer record there).
    if (
      draft.customer?.externalId &&
      !draft.customer.externalId.startsWith('manual_')
    ) {
      input.purchasingEntity = {
        customerId: ShopifyGraphqlClient.toGid(
          'Customer',
          draft.customer.externalId,
        ),
      };
    }

    return input;
  }

  /**
   * Push a freshly-created CRM draft to Shopify. Stores the resulting
   * Shopify draft id + name on the local row. Best-effort: if Shopify is
   * disconnected or the call fails, the local draft is unchanged and the
   * caller can retry later by editing the draft (mirrorUpdate will detect
   * the missing externalId and switch back to mirrorCreate).
   */
  /**
   * Public so the BullMQ `DraftMirrorProcessor` can invoke it. The
   * service-level methods don't catch their own errors — they bubble
   * back up to BullMQ which decides retry/backoff. The transport-layer
   * callers (`create`, `update`, etc.) enqueue via `DraftMirrorEnqueuer`
   * and never await this directly.
   */
  async mirrorCreateToShopify(
    draftId: string,
    orgId: string,
  ): Promise<void> {
    const shopify = await this.findShopifyChannel(orgId);
    if (!shopify) {
      this.logger.warn(
        `[draft-mirror] No SHOPIFY channel for org ${orgId} — draft ${draftId} stays local. Connect Shopify and re-save the draft to mirror it.`,
      );
      return;
    }
    // We only honour an explicit DISCONNECTED state. ERROR / SYNCING /
    // IDLE all carry valid credentials — the mirror call will surface
    // its own failure (and BullMQ will retry) if the token is actually
    // unusable.
    if (shopify.status === ChannelStatus.DISCONNECTED) {
      this.logger.warn(
        `[draft-mirror] Shopify channel ${shopify.id} is DISCONNECTED — skipping draft ${draftId}.`,
      );
      return;
    }
    if (shopify.status !== ChannelStatus.CONNECTED) {
      this.logger.log(
        `[draft-mirror] Shopify channel ${shopify.id} status is ${shopify.status} — attempting mirror anyway.`,
      );
    }

    const { token, shopDomain } = await this.shopifyOAuth.getAccessToken(
      shopify.id,
    );
    const input = await this.buildShopifyInput(draftId);

    this.logger.log(
      `[draft-mirror] Pushing draft ${draftId} to ${shopDomain} (line items: ${input.lineItems?.length ?? 0})`,
    );

    const result = await this.graphql.request<
      DraftOrderCreateResponse,
      DraftOrderCreateVariables
    >(
      { shopDomain, accessToken: token },
      DRAFT_ORDER_CREATE_MUTATION,
      { input },
    );
    ShopifyGraphqlClient.throwIfUserErrors(
      result.draftOrderCreate.userErrors,
      'draftOrderCreate',
    );

    const remote = result.draftOrderCreate.draftOrder;
    if (!remote) {
      throw new Error(
        'draftOrderCreate returned no draftOrder and no userErrors — unexpected Shopify response shape',
      );
    }

    await this.prisma.draftOrder.update({
      where: { id: draftId },
      data: {
        externalId: ShopifyGraphqlClient.extractId(remote.id),
        // Intentionally NOT overwriting `name` — the local-CRM name is set
        // at creation and we keep it stable across sync. Shopify's
        // "#D1234" lives implicitly in externalId.
        invoiceUrl: remote.invoiceUrl,
        externalCreatedAt: new Date(remote.createdAt),
        externalUpdatedAt: new Date(remote.updatedAt),
      },
    });
    this.logger.log(
      `[draft-mirror] Mirrored draft ${draftId} to Shopify as ${remote.name} (${remote.id}).`,
    );
  }

  /**
   * After a local update, push the same change to Shopify. If the draft
   * doesn't have an externalId yet (mirror was skipped on create or
   * failed), we try to create it now — best-effort.
   */
  /** Public for the same reason as `mirrorCreateToShopify` above. */
  async mirrorUpdateToShopify(
    draftId: string,
    orgId: string,
  ): Promise<void> {
    const draft = await this.prisma.draftOrder.findUnique({
      where: { id: draftId },
      select: { externalId: true },
    });
    if (!draft?.externalId) {
      // No Shopify mirror yet — try create instead.
      return this.mirrorCreateToShopify(draftId, orgId);
    }

    const shopify = await this.findShopifyChannel(orgId);
    if (!shopify) {
      this.logger.warn(
        `[draft-mirror] No SHOPIFY channel for org ${orgId} — draft ${draftId} update not mirrored.`,
      );
      return;
    }
    if (shopify.status === ChannelStatus.DISCONNECTED) {
      this.logger.warn(
        `[draft-mirror] Shopify channel ${shopify.id} is DISCONNECTED — skipping draft ${draftId} update.`,
      );
      return;
    }

    const { token, shopDomain } = await this.shopifyOAuth.getAccessToken(
      shopify.id,
    );
    const input = await this.buildShopifyInput(draftId);

    const result = await this.graphql.request<
      DraftOrderUpdateResponse,
      DraftOrderUpdateVariables
    >(
      { shopDomain, accessToken: token },
      DRAFT_ORDER_UPDATE_MUTATION,
      {
        id: ShopifyGraphqlClient.toGid('DraftOrder', draft.externalId),
        input,
      },
    );
    ShopifyGraphqlClient.throwIfUserErrors(
      result.draftOrderUpdate.userErrors,
      'draftOrderUpdate',
    );

    const remote = result.draftOrderUpdate.draftOrder;
    if (remote) {
      await this.prisma.draftOrder.update({
        where: { id: draftId },
        data: {
          // Intentionally NOT overwriting `name` — stays as the local-CRM
          // value set at creation.
          invoiceUrl: remote.invoiceUrl,
          externalUpdatedAt: new Date(remote.updatedAt),
        },
      });
    }
  }

  /** Best-effort delete on the Shopify side. Public for the queue processor. */
  async mirrorDeleteToShopify(
    externalId: string,
    orgId: string,
  ): Promise<void> {
    const shopify = await this.findShopifyChannel(orgId);
    if (!shopify || shopify.status === ChannelStatus.DISCONNECTED) {
      this.logger.warn(
        `[draft-mirror] Cannot delete Shopify draft ${externalId} — channel missing or disconnected.`,
      );
      return;
    }

    const { token, shopDomain } = await this.shopifyOAuth.getAccessToken(
      shopify.id,
    );

    const result = await this.graphql.request<
      DraftOrderDeleteResponse,
      DraftOrderDeleteVariables
    >(
      { shopDomain, accessToken: token },
      DRAFT_ORDER_DELETE_MUTATION,
      {
        input: { id: ShopifyGraphqlClient.toGid('DraftOrder', externalId) },
      },
    );
    ShopifyGraphqlClient.throwIfUserErrors(
      result.draftOrderDelete.userErrors,
      'draftOrderDelete',
    );
  }

  /**
   * Convert a Shopify-mirrored draft to a real Shopify order via
   * `draftOrderComplete`. Then trigger a one-shot sync so the new order
   * lands in our local DB. The draft is marked COMPLETED and linked to
   * the freshly-synced local Order row (if present).
   */
  private async completeViaShopify(
    draftLocalId: string,
    orgId: string,
    shopifyChannelId: string,
    dto: CompleteDraftDto,
  ) {
    const draft = await this.prisma.draftOrder.findUniqueOrThrow({
      where: { id: draftLocalId },
      select: { id: true, externalId: true },
    });
    if (!draft.externalId) {
      throw new BadRequestException(
        'Draft has no Shopify mirror to complete from.',
      );
    }

    const { token, shopDomain } = await this.shopifyOAuth.getAccessToken(
      shopifyChannelId,
    );

    const result = await this.graphql.request<
      DraftOrderCompleteResponse,
      DraftOrderCompleteVariables
    >(
      { shopDomain, accessToken: token },
      DRAFT_ORDER_COMPLETE_MUTATION,
      {
        id: ShopifyGraphqlClient.toGid('DraftOrder', draft.externalId),
        paymentPending: dto.paymentPending ?? false,
      },
    );
    ShopifyGraphqlClient.throwIfUserErrors(
      result.draftOrderComplete.userErrors,
      'draftOrderComplete',
    );

    const remoteDraft = result.draftOrderComplete.draftOrder;
    const shopifyOrderId = remoteDraft?.order?.legacyResourceId ?? null;

    // Sync orders so the newly-converted Shopify order appears locally.
    // Fire-and-forget — completion still succeeds even if sync is slow.
    this.shopifySync
      .runSync(shopifyChannelId, orgId, ['orders'])
      .catch((err) => {
        this.logger.warn(
          `Post-completion order sync failed for org ${orgId}: ${
            err instanceof Error ? err.message : err
          }`,
        );
      });

    // Try to link to the locally-upserted order. The webhook usually
    // arrives first; fall back to looking up by externalId.
    let localOrder = null as
      | { id: string; name: string }
      | null;
    if (shopifyOrderId) {
      localOrder = await this.prisma.order.findFirst({
        where: {
          organizationId: orgId,
          channelId: shopifyChannelId,
          externalId: String(shopifyOrderId),
        },
        select: { id: true, name: true },
      });
    }

    await this.prisma.draftOrder.update({
      where: { id: draft.id },
      data: {
        status: DraftOrderStatus.COMPLETED,
        completedAt: new Date(),
        ...(localOrder && { completedOrderId: localOrder.id }),
      },
    });

    return {
      draftId: draft.id,
      order: localOrder,
      shopifyOrderName: remoteDraft?.order?.name ?? null,
      invoice: null,
      invoiceError: localOrder
        ? null
        : 'Order created in Shopify; will appear in CRM once the sync completes.',
    };
  }
}
