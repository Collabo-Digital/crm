import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ChannelPlatform, ChannelStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { mergeJsonMetadata } from '../common/utils/jsonb-merge.util';
import { ShopifyOAuthService } from './shopify-oauth.service';
import { ShopifyGraphqlClient, ShopifyGraphqlError, ShopifyAuthContext } from './shopify-graphql.client';
import { OrganizationSettingsService } from '../organization-settings/organization-settings.service';
import { InventoryLedgerService } from '../inventory/inventory-ledger.service';
import {
  LOCATIONS_QUERY,
  LocationsResponse,
  ORDER_CREATE_MUTATION,
  OrderCreatePushResponse,
  PRODUCT_SET_MUTATION,
  ProductSetResponse,
  PRODUCT_UPDATE_MUTATION,
  ProductUpdatePushResponse,
  PRODUCT_VARIANTS_BULK_UPDATE_MUTATION,
  ProductVariantsBulkUpdateResponse,
  PRODUCT_VARIANTS_BULK_CREATE_MUTATION,
  ProductVariantsBulkCreateResponse,
  PRODUCT_OPTIONS_QUERY,
  ProductOptionsQueryResponse,
  PRODUCT_OPTIONS_CREATE_MUTATION,
  ProductOptionsCreateResponse,
  PRODUCT_OPTION_UPDATE_MUTATION,
  ProductOptionUpdateResponse,
  PRODUCT_OPTIONS_DELETE_MUTATION,
  ProductOptionsDeleteResponse,
  PRODUCT_OPTIONS_REORDER_MUTATION,
  ProductOptionsReorderResponse,
  ShopifyLiveOption,
  ShopifyLiveVariantOptions,
  INVENTORY_SET_QUANTITIES_MUTATION,
  InventorySetQuantitiesResponse,
  VARIANT_INVENTORY_ITEM_QUERY,
  VariantInventoryItemResponse,
  ORDER_FULFILLMENT_ORDERS_QUERY,
  OrderFulfillmentOrdersResponse,
  FULFILLMENT_CREATE_MUTATION,
  FulfillmentCreateResponse,
  SHOP_INFO_QUERY,
  ShopInfoResponse,
} from './shopify-graphql.types';
import { FxRateService } from '../common/fx/fx-rate.service';
import {
  isNoopPlan,
  isPlaceholderRemoteOptions,
  LocalOption,
  planOptionReconcile,
} from './product-options-reconcile.util';
import { DEFAULT_VARIANT_TITLE } from '../product/variant-title.util';

/** The option-bearing columns of a `ProductVariant` row the push reconciles. */
interface OptionCarryingVariant {
  id: string;
  externalId: string;
  title: string;
  option1: string | null;
  option2: string | null;
  option3: string | null;
}

// CRM weight_unit strings (REST heritage: kg/g/lb/oz) → GraphQL WeightUnit enum.
const WEIGHT_UNIT_TO_GRAPHQL: Record<string, string> = {
  kg: 'KILOGRAMS',
  g: 'GRAMS',
  lb: 'POUNDS',
  oz: 'OUNCES',
};

/** Shape persisted on Order.metadata.shopifySync to track push state. */
export interface ShopifySyncMetadata {
  status: 'PENDING' | 'SYNCED' | 'FAILED';
  shopifyOrderId?: string;
  shopifyOrderName?: string;
  error?: string;
  syncedAt?: string;
  /// When the PENDING claim was stamped. Lets a claim whose job never ran
  /// (queue unreachable, job evicted) be told apart from one still in flight.
  queuedAt?: string;
  attempts: number;
}

/**
 * A PENDING claim older than this is treated as abandoned and may be
 * re-claimed. The worker retries 5× with exponential backoff (10s → 160s),
 * so a live job finishes or fails well inside this window. Mirrored on the
 * client (`app/lib/shopify-sync.ts`) so the Sync action reappears at the
 * same moment the server would accept it.
 */
export const STALE_PENDING_SYNC_MS = 15 * 60 * 1000;

export function isStalePendingSync(
  sync: Pick<ShopifySyncMetadata, 'status' | 'queuedAt'> | null | undefined,
  now: number = Date.now(),
): boolean {
  if (sync?.status !== 'PENDING') return false;
  // Rows claimed before `queuedAt` existed cannot prove they are still live.
  if (!sync.queuedAt) return true;
  const at = Date.parse(sync.queuedAt);
  return !Number.isFinite(at) || now - at > STALE_PENDING_SYNC_MS;
}

/**
 * Per-line tax the CRM computed for an offline order, persisted on
 * `OrderLineItem.channelTaxLines` in the REST `tax_lines` shape Shopify
 * itself uses (rate as a fraction, price as a string) so pull and push read
 * the same thing.
 */
export interface StoredTaxLine {
  title: string;
  rate: number;
  price: string;
}

export function readStoredTaxLines(value: Prisma.JsonValue | null | undefined): StoredTaxLine[] {
  if (!Array.isArray(value)) return [];
  const out: StoredTaxLine[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const line = raw as Record<string, unknown>;
    const title = typeof line.title === 'string' ? line.title : null;
    const rate = typeof line.rate === 'number' ? line.rate : Number(line.rate);
    const price = line.price === undefined || line.price === null ? null : String(line.price);
    if (!title || !Number.isFinite(rate) || price === null) continue;
    out.push({ title, rate, price });
  }
  return out;
}

/**
 * Pushes a locally-created (offline / in-store) order to the merchant's
 * connected Shopify store. Inventory is decremented automatically by Shopify
 * via `inventory_behaviour: 'decrement_obeying_policy'` — we do NOT make a
 * separate inventory adjust call.
 */
@Injectable()
export class ShopifyPushService {
  private readonly logger = new Logger(ShopifyPushService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly shopifyOAuth: ShopifyOAuthService,
    private readonly graphql: ShopifyGraphqlClient,
    private readonly orgSettings: OrganizationSettingsService,
    // Warehousing decides where stock quantities are written. ChannelModule
    // already imports InventoryModule for the ledger, so no cycle.
    private readonly inventoryLedger: InventoryLedgerService,
    // Restates catalogue prices in the destination store's currency — see
    // `priceConverter`.
    private readonly fx: FxRateService,
  ) { }

  /**
   * The `barcode` fragment of a variant push payload, or `{}` to omit it.
   *
   * Omitting is not the same as clearing: Shopify leaves an absent field
   * untouched, so a suppressed generated code never disturbs whatever the store
   * already holds. (The old spread was `v.barcode ? {...} : {}` for the same
   * reason — the CRM can set a Shopify barcode but never blank one.)
   *
   * Only GENERATED codes are gated. A barcode that came from Shopify or was
   * typed by a person is the merchant's own data and always round-trips.
   * Legacy rows with a NULL source are treated as manual — we do not withhold a
   * barcode we cannot prove we minted.
   */
  private barcodeForPush(
    v: { barcode: string | null; barcodeSource: string | null },
    pushGeneratedBarcodes: boolean,
  ): Record<string, string> {
    if (!v.barcode) return {};
    if (v.barcodeSource === 'GENERATED' && !pushGeneratedBarcodes) return {};
    return { barcode: v.barcode };
  }

  /** Resolve the org's connected SHOPIFY channel (if any). Null = nothing to push. */
  async findShopifyChannel(orgId: string) {
    return this.prisma.channel.findUnique({
      where: {
        organizationId_platform: {
          organizationId: orgId,
          platform: ChannelPlatform.SHOPIFY,
        },
      },
    });
  }

  /** Main entry point — invoked by the BullMQ processor. */
  async pushOrder(orderId: string, orgId: string): Promise<void> {
    const channel = await this.findShopifyChannel(orgId);
    if (!channel || channel.status !== ChannelStatus.CONNECTED) {
      this.logger.warn(
        `Skipping Shopify push for order ${orderId}: no connected SHOPIFY channel for org ${orgId}`,
      );
      await this.recordFailure(
        orderId,
        orgId,
        'No connected Shopify channel.',
        /* incrementAttempt */ false,
      );
      return;
    }

    const order = await this.prisma.order.findFirst({
      where: { id: orderId, organizationId: orgId },
      include: {
        customer: true,
        channel: { select: { platform: true } },
        lineItems: { include: { variant: true } },
      },
    });
    if (!order) {
      throw new NotFoundException(`Order ${orderId} not found`);
    }

    // Re-entry guard. If the order already sits on the SHOPIFY channel, the
    // `orders/create` webhook has already rebadged it — pushing again would
    // create a SECOND Shopify order. Same if metadata already records a
    // successful push. This closes the window where `orderCreate` succeeded
    // but `recordSuccess` failed and BullMQ retried the job.
    if (order.channel.platform === ChannelPlatform.SHOPIFY) {
      this.logger.log(
        `Order ${orderId} is already on the Shopify channel (rebadged) — skipping push.`,
      );
      await this.recordSuccess(orderId, orgId, order.externalId, order.name);
      return;
    }
    const priorSync = this.readSyncMeta(order.metadata);
    if (priorSync?.status === 'SYNCED' && priorSync.shopifyOrderId) {
      this.logger.log(
        `Order ${orderId} already synced to Shopify order ${priorSync.shopifyOrderId} — skipping push.`,
      );
      return;
    }

    const { token, shopDomain } = await this.shopifyOAuth.getAccessToken(
      channel.id,
    );

    // Resolve (or cache) the primary location id. Shopify decrements inventory
    // against the location set on the order's fulfillment.
    const locationId = await this.resolveLocationId(channel.id, shopDomain, token);

    // Build the orderCreate input. Variants with a real Shopify variant_id
    // (externalId on the local ProductVariant) reference that variant by GID.
    // CRM-only items (no Shopify mapping; externalId starts with `manual_`)
    // fall back to a custom line item — `{title, priceSet, quantity}` without
    // a variantId records the item as a one-off on the order.
    const auth: ShopifyAuthContext = { shopDomain, accessToken: token };
    const currency = order.currency;
    const money = (amount: string) => ({ shopMoney: { amount, currencyCode: currency } });

    // `orderCreate` does NOT compute tax: without `taxLines` Shopify records
    // the pre-tax unit prices as the whole order (verified on collabo-test
    // #1008: total 1499.90, tax 0, against a 1769.90 SALE transaction). The
    // offline path stores the GST it actually charged per line, so send it
    // and the Shopify total matches the transaction — and the rebadge later
    // writes the same totals back instead of erasing the tax on an order
    // that already has a GST invoice.
    const lineItems = order.lineItems.map((li) => {
      const externalId = li.variant?.externalId;
      const hasShopifyVariant = !!externalId && !externalId.startsWith('manual_');
      const taxLines = readStoredTaxLines(li.channelTaxLines).map((t) => ({
        title: t.title,
        rate: t.rate,
        priceSet: money(t.price),
      }));
      const base = {
        quantity: li.quantity,
        priceSet: money(li.price.toString()),
        ...(taxLines.length > 0 ? { taxLines } : {}),
      };
      return hasShopifyVariant
        ? { variantId: ShopifyGraphqlClient.toGid('ProductVariant', externalId!), ...base }
        : { title: li.variantTitle ? `${li.title} — ${li.variantTitle}` : li.title, ...base };
    });

    // Customers originally synced from Shopify are associated by GID so no
    // duplicate is created; manual customers ride as email/phone on the order.
    const customerExternalId = order.customer?.externalId;
    const customerBlock =
      customerExternalId && !customerExternalId.startsWith('manual_') && /^\d+$/.test(customerExternalId)
        ? { toAssociate: { id: ShopifyGraphqlClient.toGid('Customer', customerExternalId) } }
        : undefined;

    const grandTotal = order.totalPrice.toString();

    const orderInput: Record<string, unknown> = {
      currency,
      // Line prices are pre-tax; the tax rides on `taxLines` above.
      taxesIncluded: false,
      email: order.customer?.email ?? undefined,
      phone: order.customer?.phone ?? undefined,
      note: order.note ?? undefined,
      tags: ['offline', 'collabo-crm', 'pos'],
      sourceName: 'collabo-crm',
      sourceIdentifier: String(order.id || ''),
      lineItems,
      ...(customerBlock ? { customer: customerBlock } : {}),
      // A successful SALE transaction covering the total marks the order paid.
      transactions: [
        {
          kind: 'SALE',
          status: 'SUCCESS',
          amountSet: money(grandTotal),
          gateway: this.resolveGateway(order.metadata),
        },
      ],
    };

    const result = await this.graphql.request<OrderCreatePushResponse>(auth, ORDER_CREATE_MUTATION, {
      order: orderInput,
      options: {
        sendReceipt: false,
        sendFulfillmentReceipt: false,
        inventoryBehaviour: 'DECREMENT_OBEYING_POLICY',
      },
    });
    ShopifyGraphqlClient.throwIfUserErrors(
      result.orderCreate?.userErrors,
      `orderCreate for CRM order ${order.name}`,
    );
    const remoteOrder = result.orderCreate?.order;
    if (!remoteOrder?.id) {
      throw new Error('Shopify order create returned no id');
    }

    await this.adoptShopifyLineItemIds(order.lineItems, remoteOrder);

    // Mirror the local PAID + FULFILLED state by fulfilling the new order's
    // fulfillment orders at the resolved location. Best-effort — if locations
    // couldn't be read (missing read_locations) or fulfillment fails, the
    // order still lands paid but unfulfilled.
    if (locationId) {
      try {
        await this.fulfillEntireOrder(auth, remoteOrder.id);
      } catch (err) {
        this.logger.warn(
          `Could not auto-fulfill pushed order ${remoteOrder.name}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    await this.recordSuccess(
      orderId,
      orgId,
      ShopifyGraphqlClient.extractId(remoteOrder.id),
      remoteOrder.name,
    );

    this.logger.log(
      `Pushed CRM order ${order.name} → Shopify order ${remoteOrder.name} (${ShopifyGraphqlClient.extractId(remoteOrder.id)})`,
    );
  }

  /**
   * Stamp Shopify's line-item ids onto the local rows we just pushed.
   *
   * Offline line items are created with `manual_<uuid>` external ids. Shopify's
   * copy of the same order uses Shopify's ids, so when the `orders/create`
   * webhook comes back and rebadges the order (C4), the line-item upsert keyed
   * on (orderId, externalId) matches nothing and inserts a SECOND set of rows —
   * the order then holds every item twice, and everything counted from line
   * items double-counts it. Adopting the ids here means the webhook updates our
   * rows in place instead, which also preserves each row's link to the local
   * product variant (Shopify returns CRM-only items as custom lines with no
   * variant, so a delete-and-recreate would lose that link).
   *
   * Best-effort by design: the Shopify order already exists by this point, so
   * throwing would send the job back to BullMQ and push a SECOND order. On any
   * doubt we log and leave the ids alone — the H2 reconcile in the sync path
   * then cleans up the duplicates instead.
   */
  private async adoptShopifyLineItemIds(
    localLines: Array<{ id: string; externalId: string; variant: { externalId: string | null } | null }>,
    remoteOrder: { name: string; lineItems?: { nodes: Array<{ id: string; variant: { id: string } | null }> } },
  ): Promise<void> {
    try {
      const remoteNodes = remoteOrder.lineItems?.nodes ?? [];
      if (remoteNodes.length === 0) return;

      // We submitted the lines in `order.lineItems` order, so index ↔ index
      // holds — but only trust it when the counts agree. A mismatch means
      // Shopify merged, split or dropped something, and mislabelling a row is
      // worse than leaving it alone.
      if (remoteNodes.length !== localLines.length) {
        this.logger.warn(
          `Shopify returned ${remoteNodes.length} line item(s) for ${remoteOrder.name} but ${localLines.length} were pushed — ` +
          `leaving local line ids untouched.`,
        );
        return;
      }

      const remoteByVariantGid = new Map<string, { id: string }>();
      for (const node of remoteNodes) {
        if (node.variant?.id) remoteByVariantGid.set(node.variant.id, node);
      }

      const claimed = new Set<string>();
      const updates: Array<{ id: string; externalId: string }> = [];

      localLines.forEach((local, index) => {
        // Only rows still carrying a local id are candidates; a re-run must not
        // rewrite an id we already adopted.
        if (!local.externalId?.startsWith('manual_')) return;

        const variantExternalId = local.variant?.externalId;
        const hasShopifyVariant = !!variantExternalId && !variantExternalId.startsWith('manual_');
        const byVariant = hasShopifyVariant
          ? remoteByVariantGid.get(
            ShopifyGraphqlClient.toGid('ProductVariant', variantExternalId!),
          )
          : undefined;

        const match = byVariant ?? remoteNodes[index];
        if (!match || claimed.has(match.id)) return;
        claimed.add(match.id);
        updates.push({ id: local.id, externalId: ShopifyGraphqlClient.extractId(match.id) });
      });

      if (updates.length === 0) return;

      await this.prisma.$transaction(
        updates.map((u) =>
          this.prisma.orderLineItem.update({
            where: { id: u.id },
            data: { externalId: u.externalId },
          }),
        ),
      );
      this.logger.log(
        `Adopted ${updates.length} Shopify line-item id(s) for ${remoteOrder.name} — the order webhook will now update these rows instead of duplicating them.`,
      );
    } catch (err) {
      this.logger.warn(
        `Could not adopt Shopify line-item ids for ${remoteOrder.name}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /** Fulfill every open fulfillment order on a just-created Shopify order. */
  private async fulfillEntireOrder(auth: ShopifyAuthContext, orderGid: string): Promise<void> {
    const res = await this.graphql.request<OrderFulfillmentOrdersResponse>(
      auth,
      ORDER_FULFILLMENT_ORDERS_QUERY,
      { id: orderGid },
    );
    for (const fo of res.order?.fulfillmentOrders?.nodes ?? []) {
      const createRes = await this.graphql.request<FulfillmentCreateResponse>(
        auth,
        FULFILLMENT_CREATE_MUTATION,
        {
          fulfillment: {
            lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: fo.id }],
            notifyCustomer: false,
          },
        },
      );
      const errors = createRes.fulfillmentCreate?.userErrors ?? [];
      if (errors.length > 0) {
        this.logger.warn(
          `fulfillmentCreate for ${fo.id}: ${errors.map((e) => e.message).join('; ')}`,
        );
      }
    }
  }

  /**
   * Look up the shop's primary location once and cache on channel.metadata.
   * Returns null when the merchant's token lacks `read_locations` (so the
   * caller can degrade gracefully — order push without fulfillments,
   * product push without inventory seed).
   */
  private async resolveLocationId(
    channelId: string,
    shopDomain: string,
    token: string,
  ): Promise<number | null> {
    const channel = await this.prisma.channel.findUnique({
      where: { id: channelId },
      select: { metadata: true },
    });
    const cached = (channel?.metadata as any)?.shopifyLocationId;
    if (typeof cached === 'number') return cached;

    let nodes: LocationsResponse['locations']['nodes'];
    try {
      // Only the primary is wanted here, so a single page is enough — the
      // sort puts no guarantee on position, but `isPrimary` is unique and a
      // shop with >50 locations having its primary beyond the first page is
      // not a case worth a second round trip on the fulfillment hot path.
      // ShopifyLocationSyncService pages properly because it needs them all.
      const res = await this.graphql.request<LocationsResponse>(
        { shopDomain, accessToken: token },
        LOCATIONS_QUERY,
        { first: 50 },
      );
      nodes = res.locations?.nodes ?? [];
    } catch (err) {
      // Missing read_locations scope (or similar access errors) degrade
      // gracefully — order push without fulfillments, product push without
      // an inventory seed. Same behavior as the old REST 403 path.
      if (err instanceof ShopifyGraphqlError) {
        this.logger.warn(
          `Cannot read Shopify locations for channel ${channelId} (${err.code}). ` +
          `Ensure the app has the 'read_locations' scope to enable fulfillment at the primary location. ` +
          `Order/product push will continue without an explicit location.`,
        );
        return null;
      }
      throw err;
    }

    const primary =
      nodes.find((l) => l.isPrimary && l.isActive) ??
      nodes.find((l) => l.isActive) ??
      nodes[0];
    if (!primary) {
      this.logger.warn(`Shop ${shopDomain} has no active locations`);
      return null;
    }

    const numericId = Number(ShopifyGraphqlClient.extractId(primary.id));

    // Cache for next time
    const meta = (channel?.metadata as Prisma.JsonObject) ?? {};
    await this.prisma.channel.update({
      where: { id: channelId },
      data: {
        metadata: { ...meta, shopifyLocationId: numericId } as Prisma.InputJsonObject,
      },
    });

    return numericId;
  }

  /** Map our paymentMethod to a Shopify gateway label (display only). */
  private resolveGateway(metadata: Prisma.JsonValue): string {
    if (
      metadata &&
      typeof metadata === 'object' &&
      !Array.isArray(metadata) &&
      'paymentMethod' in metadata
    ) {
      const pm = (metadata as Record<string, unknown>).paymentMethod;
      if (typeof pm === 'string') return `manual_${pm.toLowerCase()}`;
    }
    return 'manual';
  }

  // ─── METADATA WRITERS ───
  // Atomic JSONB merges (H7). Reads are only used to compute the next
  // shopifySync.attempts value; the write never replaces the whole blob.

  private async recordSuccess(
    orderId: string,
    organizationId: string,
    shopifyOrderId: string,
    shopifyOrderName: string,
  ): Promise<void> {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, organizationId },
      select: { metadata: true },
    });
    const prev = this.readSyncMeta(order?.metadata);
    const next: ShopifySyncMetadata = {
      status: 'SYNCED',
      shopifyOrderId,
      shopifyOrderName,
      syncedAt: new Date().toISOString(),
      attempts: (prev?.attempts ?? 0) + 1,
    };
    await this.writeSyncMeta(orderId, organizationId, next);
  }

  /**
   * Record a failure on the order's metadata. `incrementAttempt=false` is for
   * pre-flight skips (no channel connected) where retrying won't help.
   */
  async recordFailure(
    orderId: string,
    organizationId: string,
    error: string,
    incrementAttempt = true,
  ): Promise<void> {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, organizationId },
      select: { metadata: true },
    });
    const prev = this.readSyncMeta(order?.metadata);
    const next: ShopifySyncMetadata = {
      status: 'FAILED',
      error,
      attempts: (prev?.attempts ?? 0) + (incrementAttempt ? 1 : 0),
      ...(prev?.shopifyOrderId
        ? { shopifyOrderId: prev.shopifyOrderId }
        : {}),
      ...(prev?.shopifyOrderName
        ? { shopifyOrderName: prev.shopifyOrderName }
        : {}),
    };
    await this.writeSyncMeta(orderId, organizationId, next);
  }

  private readSyncMeta(metadata: Prisma.JsonValue | null | undefined):
    | ShopifySyncMetadata
    | null {
    if (
      !metadata ||
      typeof metadata !== 'object' ||
      Array.isArray(metadata)
    ) {
      return null;
    }
    const m = (metadata as Record<string, unknown>).shopifySync;
    return (m as ShopifySyncMetadata) ?? null;
  }

  private async writeSyncMeta(
    orderId: string,
    organizationId: string,
    next: ShopifySyncMetadata,
  ): Promise<void> {
    await mergeJsonMetadata(this.prisma, 'orders', orderId, organizationId, {
      shopifySync: next,
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // PRODUCT PUSH (CRM → Shopify)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Push a single CRM-native product to Shopify, then rebadge the local
   * Product + variants + images from the MANUAL channel to the SHOPIFY channel
   * using the new Shopify IDs. After this completes, the existing read-
   * direction sync handles future updates.
   *
   * Supports:
   *   - Multiple variants (each with its own option1/2/3, sku, price, stock).
   *   - Product-level option types (Size, Color, …).
   *   - Multiple images (uploaded to /uploads/, sent to Shopify by `src` URL
   *     as productSet `files`).
   * Not carried over from the REST era: per-variant image linkage — merchants
   * can set variant images in Shopify Admin if needed.
   */
  async pushProduct(productId: string, orgId: string): Promise<void> {
    const shopify = await this.findShopifyChannel(orgId);
    if (!shopify || shopify.status !== ChannelStatus.CONNECTED) {
      this.logger.warn(
        `Skipping product push for ${productId}: no connected SHOPIFY channel for org ${orgId}`,
      );
      await this.recordProductFailure(
        productId,
        orgId,
        'No connected Shopify channel.',
        false,
      );
      return;
    }

    const product = await this.prisma.product.findFirst({
      where: { id: productId, organizationId: orgId, deletedAt: null },
      include: {
        variants: { orderBy: { position: 'asc' } },
        images: { orderBy: { position: 'asc' } },
        channel: true,
      },
    });
    if (!product) {
      throw new NotFoundException(`Product ${productId} not found`);
    }

    if (product.variants.length === 0) {
      throw new Error(`Product ${product.id} has no variants to push`);
    }

    const { token, shopDomain } = await this.shopifyOAuth.getAccessToken(shopify.id);

    // Catalogue prices are bare decimals whose currency is whatever their
    // channel trades in. Pushing sends them to a store that may price in a
    // different one AND rebadges the product onto that store — so an
    // unconverted push does not merely mislabel, it re-denominates: a ₹120
    // counter-sale product became a $120 listing, ~95x its intended price.
    const convertPrice = await this.priceConverter(product, shopify, token, shopDomain);

    // Read the org's product settings once per push so the global
    // overrides flow through to Shopify's per-variant inventory fields.
    const productSettings = await this.orgSettings.getProductSettings(orgId);
    const oversellGlobally = productSettings.allowOversellGlobally === true;
    const trackGlobally = productSettings.trackQuantityGlobally === true;

    // Barcodes the CRM minted for label printing are internal codes, not GTINs.
    // The push serialises the whole variant row, so without this gate one would
    // land in the merchant's Shopify `barcode` field on the next unrelated push
    // — occupying the slot a real GTIN belongs in, and detached from whatever
    // action actually caused it. Opt-in per org; Shopify-sourced and
    // hand-entered barcodes are unaffected either way.
    const inventorySettings = await this.orgSettings.getInventorySettings(orgId);
    const pushGeneratedBarcodes = inventorySettings.pushGeneratedBarcodes === true;

    // SHOPIFY-channel product → push as an update (PUT). The CRM allows
    // editing synced products; this is the path that propagates those local
    // edits back to the Shopify store. New variants are also handled (POST);
    // image changes on synced products are still out of scope.
    if (product.channel.platform === ChannelPlatform.SHOPIFY) {
      await this.pushProductUpdate(
        product,
        orgId,
        shopify.id,
        shopDomain,
        token,
        oversellGlobally,
        trackGlobally,
        pushGeneratedBarcodes,
      );
      await this.recordProductSuccess(productId, orgId, product.externalId);
      this.logger.log(
        `Pushed update for Shopify product "${product.title}" (${product.externalId}).`,
      );
      return;
    }

    // One-shot create via productSet — options, variants, images, per-variant
    // inventory quantities AND inventory-item fields (cost / HS code / country
    // of origin / weight / tracked) all ride in a single synchronous mutation.
    const auth: ShopifyAuthContext = { shopDomain, accessToken: token };
    const locationId = await this.resolveLocationId(shopify.id, shopDomain, token);
    const input = this.buildProductSetInput(
      product,
      oversellGlobally,
      trackGlobally,
      pushGeneratedBarcodes,
      locationId,
      convertPrice,
    );

    const result = await this.graphql.request<ProductSetResponse>(auth, PRODUCT_SET_MUTATION, {
      input,
      synchronous: true,
    });
    ShopifyGraphqlClient.throwIfUserErrors(
      result.productSet?.userErrors,
      `productSet for "${product.title}"`,
    );
    const remote = result.productSet?.product;
    if (!remote?.id) {
      throw new Error('Shopify product create returned no id');
    }

    // Rebadge transaction: switch product + variants + images to SHOPIFY
    // channel/IDs. Variants are zip-aligned by index, which is safe because
    // Shopify preserves the order we sent. Media likewise zips by order.
    const remoteProductId = ShopifyGraphqlClient.extractId(remote.id);
    await this.prisma.$transaction(async (tx) => {
      await tx.product.update({
        where: { id: product.id },
        data: {
          channelId: shopify.id,
          externalId: remoteProductId,
          externalCreatedAt: new Date(),
        },
      });

      const remoteVariants = remote.variants.nodes;
      for (let i = 0; i < product.variants.length && i < remoteVariants.length; i++) {
        const localVariant = product.variants[i];
        const remoteVariant = remoteVariants[i];
        // The prices sent to Shopify are stored back, because this same
        // transaction rebadges the product onto the destination channel — and
        // a catalogue price is read in ITS channel's currency. Keeping the
        // pre-conversion number here would leave the local record claiming
        // "$120" for a listing Shopify holds at $1.26.
        const converted = {
          price: convertPrice(localVariant.price),
          compareAtPrice:
            localVariant.compareAtPrice != null
              ? convertPrice(localVariant.compareAtPrice)
              : null,
          cost: localVariant.cost != null ? convertPrice(localVariant.cost) : null,
        };

        await tx.productVariant.update({
          where: { id: localVariant.id },
          data: {
            externalId: ShopifyGraphqlClient.extractId(remoteVariant.id),
            inventoryItemId: remoteVariant.inventoryItem
              ? ShopifyGraphqlClient.extractId(remoteVariant.inventoryItem.id)
              : null,
            ...(converted.price != null ? { price: converted.price } : {}),
            ...(localVariant.compareAtPrice != null && converted.compareAtPrice != null
              ? { compareAtPrice: converted.compareAtPrice }
              : {}),
            ...(localVariant.cost != null && converted.cost != null
              ? { cost: converted.cost }
              : {}),
          },
        });
      }

      const remoteMedia = remote.media.nodes;
      for (let i = 0; i < product.images.length && i < remoteMedia.length; i++) {
        await tx.productImage.update({
          where: { id: product.images[i].id },
          data: { externalId: ShopifyGraphqlClient.extractId(remoteMedia[i].id) },
        });
      }
    });

    await this.recordProductSuccess(productId, orgId, remoteProductId);

    // productSet seeded the whole quantity at the primary location, because
    // that is the only location its per-variant input can name. For an org
    // running multi-location warehouses that is the wrong distribution — the
    // stock may live in a different warehouse entirely — so redistribute now
    // that the rebadge transaction above has persisted each inventoryItemId.
    // Skipped for non-warehousing orgs, where the seed is already correct and
    // this would be a redundant mutation.
    if (await this.inventoryLedger.isWarehousingEnabled(orgId)) {
      await this.pushAvailability(orgId, product.variants.map((v) => v.id));
    }

    this.logger.log(
      `Pushed CRM product "${product.title}" → Shopify product ${remoteProductId} (${product.variants.length} variants, ${product.images.length} images)`,
    );
  }

  /**
   * Build the ProductSetInput for a one-shot GraphQL product create. Handles
   * both single-variant (placeholder Title/Default Title option) and
   * multi-variant products.
   */
  private buildProductSetInput(
    product: {
      title: string;
      bodyHtml: string | null;
      vendor: string | null;
      productType: string | null;
      status: 'ACTIVE' | 'DRAFT' | 'ARCHIVED';
      tags: string[];
      options: Prisma.JsonValue;
      variants: Array<{
        price: any;
        sku: string | null;
        option1: string | null;
        option2: string | null;
        option3: string | null;
        compareAtPrice: any;
        requiresShipping: boolean;
        taxable: boolean;
        barcode: string | null;
        barcodeSource: string | null;
        weight: any;
        weightUnit: string | null;
        cost: any;
        hsCode: string | null;
        countryOfOrigin: string | null;
        inventoryQuantity: number;
        trackQuantity: boolean;
        continueSellingWhenOutOfStock: boolean;
      }>;
      images: Array<{ src: string; alt: string | null; position: number }>;
    },
    oversellGlobally: boolean,
    trackGlobally: boolean,
    pushGeneratedBarcodes: boolean,
    locationId: number | null,
    /**
     * Restates money in the destination store's currency — see
     * `priceConverter`. Passed in rather than resolved here because it needs an
     * async rate lookup and this builder is pure.
     */
    convertPrice: (value: Prisma.Decimal | number | string | null) => string | null,
  ): Record<string, unknown> {
    const optionNames = this.deriveOptionTypes(product);
    const hasRealOptions = optionNames.length > 0;
    // Shopify's placeholder for "no options" — mirrors what REST did
    // implicitly with option1: 'Default Title'.
    const effectiveOptions = hasRealOptions ? optionNames : ['Title'];
    const optionKeys = ['option1', 'option2', 'option3'] as const;

    const valuesForOption = (idx: number): string[] => {
      if (!hasRealOptions) return ['Default Title'];
      const distinct = new Set<string>();
      for (const v of product.variants) {
        const value = v[optionKeys[idx]];
        if (value) distinct.add(value);
      }
      return distinct.size > 0 ? [...distinct] : ['Default'];
    };

    const productOptions = effectiveOptions.map((name, i) => ({
      name,
      position: i + 1,
      values: valuesForOption(i).map((v) => ({ name: v })),
    }));

    const variants = product.variants.map((v) => ({
      optionValues: hasRealOptions
        ? effectiveOptions.map((name, i) => ({
            optionName: name,
            name: v[optionKeys[i]] ?? 'Default',
          }))
        : [{ optionName: 'Title', name: 'Default Title' }],
      // Money fields go through `convertPrice` — see `priceConverter`. Cost is
      // money too: leaving it unconverted would make every margin on the store
      // nonsense in the other direction.
      price: convertPrice(v.price)!,
      ...(v.compareAtPrice != null
        ? { compareAtPrice: convertPrice(v.compareAtPrice)! }
        : {}),
      ...(v.sku ? { sku: v.sku } : {}),
      ...(this.barcodeForPush(v, pushGeneratedBarcodes)),
      taxable: v.taxable,
      inventoryPolicy:
        oversellGlobally || v.continueSellingWhenOutOfStock ? 'CONTINUE' : 'DENY',
      inventoryItem: {
        tracked: trackGlobally || v.trackQuantity,
        requiresShipping: v.requiresShipping,
        ...(v.cost != null ? { cost: convertPrice(v.cost)! } : {}),
        ...(v.hsCode ? { harmonizedSystemCode: v.hsCode } : {}),
        ...(v.countryOfOrigin ? { countryCodeOfOrigin: v.countryOfOrigin } : {}),
        ...(v.weight
          ? {
              measurement: {
                weight: {
                  value: Number(v.weight),
                  unit: WEIGHT_UNIT_TO_GRAPHQL[v.weightUnit ?? ''] ?? 'KILOGRAMS',
                },
              },
            }
          : {}),
      },
      ...(locationId && v.inventoryQuantity > 0
        ? {
            inventoryQuantities: [
              {
                locationId: ShopifyGraphqlClient.toGid('Location', locationId),
                name: 'available',
                quantity: v.inventoryQuantity,
              },
            ],
          }
        : {}),
    }));

    return {
      title: product.title,
      ...(product.bodyHtml ? { descriptionHtml: product.bodyHtml } : {}),
      ...(product.vendor ? { vendor: product.vendor } : {}),
      ...(product.productType ? { productType: product.productType } : {}),
      status: product.status,
      tags: product.tags ?? [],
      productOptions,
      variants,
      ...(product.images.length > 0
        ? {
            files: product.images.map((img) => ({
              originalSource: img.src,
              ...(img.alt ? { alt: img.alt } : {}),
              contentType: 'IMAGE',
            })),
          }
        : {}),
    };
  }

  /**
   * Push CRM-side edits of an already-synced product back to Shopify (GraphQL):
   *   - productUpdate              — title / body / vendor / type / tags / status
   *   - productVariantsBulkCreate  — variants added locally (admin only)
   *   - productVariantsBulkUpdate  — pricing / sku / barcode / weight / policy /
   *                                  tracked / cost / HS code / country-of-origin
   *                                  (sku, cost, weight etc. live on inventoryItem)
   *   - inventorySetQuantities     — stock (available) per variant at the location
   *
   * Between productUpdate and the variant mutations, `reconcileProductOptions`
   * makes Shopify's option STRUCTURE match `Product.options` (create / add
   * values / delete / reorder) and writes Shopify's resulting per-variant
   * option assignment back to the CRM. Without that step a variant that names
   * a new option is rejected by productVariantsBulkCreate — and that rejection
   * used to be swallowed, so the product was stamped SYNCED with nothing
   * changed on Shopify. Every Shopify userError in this method now throws; the
   * processor records it as FAILED with the message.
   *
   * Vendors cannot add or restructure variants (enforced in the UI); they only
   * edit existing fields. Image changes on synced products are out of scope.
   */
  private async pushProductUpdate(
    product: {
      id: string;
      externalId: string;
      title: string;
      bodyHtml: string | null;
      vendor: string | null;
      productType: string | null;
      status: 'ACTIVE' | 'DRAFT' | 'ARCHIVED';
      tags: string[];
      options: Prisma.JsonValue;
      variants: Array<{
        id: string;
        externalId: string;
        inventoryItemId: string | null;
        title: string;
        option1: string | null;
        option2: string | null;
        option3: string | null;
        price: any;
        sku: string | null;
        compareAtPrice: any;
        barcode: string | null;
        barcodeSource: string | null;
        weight: any;
        weightUnit: string | null;
        cost: any;
        hsCode: string | null;
        countryOfOrigin: string | null;
        inventoryQuantity: number;
        trackQuantity: boolean;
        continueSellingWhenOutOfStock: boolean;
        requiresShipping: boolean;
        taxable: boolean;
      }>;
    },
    orgId: string,
    channelId: string,
    shopDomain: string,
    token: string,
    oversellGlobally: boolean,
    trackGlobally: boolean,
    pushGeneratedBarcodes: boolean,
  ): Promise<void> {
    const auth: ShopifyAuthContext = { shopDomain, accessToken: token };
    // The stock push below resolves its own target location(s) — per mapped
    // warehouse when the org runs multi-location, primary otherwise.
    const productGid = ShopifyGraphqlClient.toGid('Product', product.externalId);

    // Top-level product fields.
    const updateRes = await this.graphql.request<ProductUpdatePushResponse>(
      auth,
      PRODUCT_UPDATE_MUTATION,
      {
        input: {
          id: productGid,
          title: product.title,
          descriptionHtml: product.bodyHtml ?? null,
          vendor: product.vendor ?? null,
          productType: product.productType ?? null,
          status: product.status,
          tags: product.tags ?? [],
        },
      },
    );
    ShopifyGraphqlClient.throwIfUserErrors(
      updateRes.productUpdate?.userErrors,
      `productUpdate ${product.externalId}`,
    );

    // Option structure first: everything below names options by name, so
    // they must exist on Shopify before any variant is created. This may
    // rewrite option columns on existing rows and drop generated duplicates —
    // hence the reassignment.
    const reconciled = await this.reconcileProductOptions(auth, product, productGid);
    product.variants = reconciled.variants;
    const optionNames = reconciled.optionNames;

    type PushVariant = (typeof product.variants)[number];

    // Shared per-variant input — sku / cost / weight / HS code / country /
    // tracked all live on inventoryItem in the GraphQL bulk inputs.
    const sharedVariantInput = (v: PushVariant): Record<string, unknown> => ({
      price: v.price.toString(),
      compareAtPrice: v.compareAtPrice != null ? v.compareAtPrice.toString() : null,
      ...(this.barcodeForPush(v, pushGeneratedBarcodes)),
      taxable: v.taxable,
      inventoryPolicy:
        oversellGlobally || v.continueSellingWhenOutOfStock ? 'CONTINUE' : 'DENY',
      inventoryItem: {
        tracked: trackGlobally || v.trackQuantity,
        requiresShipping: v.requiresShipping,
        ...(v.sku ? { sku: v.sku } : {}),
        ...(v.cost != null ? { cost: Number(v.cost).toFixed(2) } : {}),
        ...(v.hsCode ? { harmonizedSystemCode: v.hsCode } : {}),
        ...(v.countryOfOrigin ? { countryCodeOfOrigin: v.countryOfOrigin } : {}),
        ...(v.weight
          ? {
              measurement: {
                weight: {
                  value: Number(v.weight),
                  unit: WEIGHT_UNIT_TO_GRAPHQL[v.weightUnit ?? ''] ?? 'KILOGRAMS',
                },
              },
            }
          : {}),
      },
    });

    const newLocal = product.variants.filter(
      (v) => !v.externalId || v.externalId.startsWith('manual_'),
    );
    const existing = product.variants.filter(
      (v) => v.externalId && !v.externalId.startsWith('manual_'),
    );

    // inventoryItemId per local variant id — sourced from the DB and topped up
    // from mutation responses; drives the stock push at the end.
    const inventoryItemIds = new Map<string, string>();
    for (const v of existing) {
      if (v.inventoryItemId) inventoryItemIds.set(v.id, v.inventoryItemId);
    }

    // Brand-new variants added locally (admin only — vendors can't add).
    // Errors are NOT caught here: a rejected create must fail the job so the
    // merchant sees "Sync failed" + Shopify's reason instead of a green badge.
    if (newLocal.length > 0) {
      const res = await this.graphql.request<ProductVariantsBulkCreateResponse>(
        auth,
        PRODUCT_VARIANTS_BULK_CREATE_MUTATION,
        {
          productId: productGid,
          variants: newLocal.map((v) => ({
            optionValues:
              optionNames.length > 0
                ? optionNames.map((name, i) => ({
                    optionName: name,
                    name: [v.option1, v.option2, v.option3][i] ?? 'Default',
                  }))
                : [{ optionName: 'Title', name: v.option1 ?? v.title ?? DEFAULT_VARIANT_TITLE }],
            ...sharedVariantInput(v),
          })),
        },
      );
      ShopifyGraphqlClient.throwIfUserErrors(
        res.productVariantsBulkCreate?.userErrors,
        `productVariantsBulkCreate ${product.externalId}`,
      );
      const created = res.productVariantsBulkCreate?.productVariants ?? [];
      for (let i = 0; i < newLocal.length && i < created.length; i++) {
        const rv = created[i];
        const invId = rv.inventoryItem
          ? ShopifyGraphqlClient.extractId(rv.inventoryItem.id)
          : null;
        await this.prisma.productVariant.update({
          where: { id: newLocal[i].id },
          data: {
            externalId: ShopifyGraphqlClient.extractId(rv.id),
            inventoryItemId: invId,
          },
        });
        if (invId) inventoryItemIds.set(newLocal[i].id, invId);
      }
    }

    // Existing variants — one bulk field-update call. Option assignment was
    // already settled by the reconcile above; this is fields only.
    if (existing.length > 0) {
      const res = await this.graphql.request<ProductVariantsBulkUpdateResponse>(
        auth,
        PRODUCT_VARIANTS_BULK_UPDATE_MUTATION,
        {
          productId: productGid,
          variants: existing.map((v) => ({
            id: ShopifyGraphqlClient.toGid('ProductVariant', v.externalId),
            ...sharedVariantInput(v),
          })),
        },
      );
      ShopifyGraphqlClient.throwIfUserErrors(
        res.productVariantsBulkUpdate?.userErrors,
        `productVariantsBulkUpdate ${product.externalId}`,
      );
      // Backfill inventoryItemIds from the response for variants where older
      // pulls didn't persist them.
      const returned = res.productVariantsBulkUpdate?.productVariants ?? [];
      const byExternalId = new Map(
        returned.map((rv) => [ShopifyGraphqlClient.extractId(rv.id), rv]),
      );
      for (const v of existing) {
        if (inventoryItemIds.has(v.id)) continue;
        const rv = byExternalId.get(v.externalId);
        const invId = rv?.inventoryItem
          ? ShopifyGraphqlClient.extractId(rv.inventoryItem.id)
          : null;
        if (invId) {
          inventoryItemIds.set(v.id, invId);
          await this.prisma.productVariant.update({
            where: { id: v.id },
            data: { inventoryItemId: invId },
          });
        }
      }
    }

    // Push current stock (available) — one mutation for every tracked variant,
    // at every mapped location when the org runs multi-location warehouses,
    // otherwise at the primary location as before.
    const tracked = product.variants.filter((v) => trackGlobally || v.trackQuantity);
    if (tracked.length > 0) {
      const invIdByVariant = await this.resolveInventoryItemIds(
        auth,
        tracked.map((v) => ({
          id: v.id,
          externalId: v.externalId,
          inventoryItemId: inventoryItemIds.get(v.id) ?? null,
        })),
      );
      const quantities = await this.buildAvailabilityQuantities(
        orgId,
        channelId,
        shopDomain,
        token,
        tracked,
        invIdByVariant,
      );
      if (quantities.length > 0) {
        await this.setInventoryQuantities(auth, quantities);
      }
    }
  }

  /**
   * Push the current sellable quantity (variant.inventoryQuantity — for
   * warehousing orgs the SUM of StockLevel.available) for specific variants to
   * the primary Shopify location. Runs as a `push-availability` queue job
   * after CRM-origin stock operations (adjustment, enable-seed, receipt,
   * return restock). Variants that never existed on Shopify (manual_ external
   * ids without an inventory item) are skipped — nothing to sync.
   */
  async pushAvailability(orgId: string, variantIds: string[]): Promise<void> {
    if (variantIds.length === 0) return;
    const shopify = await this.findShopifyChannel(orgId);
    if (!shopify || shopify.status !== ChannelStatus.CONNECTED) {
      this.logger.log(
        `Skipping availability push for org ${orgId}: no connected Shopify channel`,
      );
      return;
    }
    const { token, shopDomain } = await this.shopifyOAuth.getAccessToken(shopify.id);
    const auth: ShopifyAuthContext = { shopDomain, accessToken: token };

    const variants = await this.prisma.productVariant.findMany({
      where: {
        id: { in: variantIds },
        organizationId: orgId,
        product: { deletedAt: null },
      },
      select: {
        id: true,
        externalId: true,
        inventoryItemId: true,
        inventoryQuantity: true,
      },
    });
    if (variants.length === 0) return;

    const invIdByVariant = await this.resolveInventoryItemIds(auth, variants);
    const quantities = await this.buildAvailabilityQuantities(
      orgId,
      shopify.id,
      shopDomain,
      token,
      variants,
      invIdByVariant,
    );

    if (quantities.length > 0) {
      await this.setInventoryQuantities(auth, quantities);
    }
  }

  /**
   * Inventory item ids for a set of variants, backfilling from Shopify for the
   * ones older pulls never persisted. Variants with no id (never pushed, or
   * `manual_` locals) are simply absent from the map.
   */
  private async resolveInventoryItemIds(
    auth: ShopifyAuthContext,
    variants: Array<{ id: string; externalId: string | null; inventoryItemId: string | null }>,
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const v of variants) {
      let invId = v.inventoryItemId;
      if (!invId && v.externalId && !v.externalId.startsWith('manual_')) {
        invId = await this.backfillInventoryItemId(auth, v.id, v.externalId);
      }
      if (invId) out.set(v.id, invId);
    }
    return out;
  }

  /**
   * One `{ inventoryItem, location, quantity }` triple per mapped warehouse.
   *
   * **Warehousing is the switch**, not "does this org have mapped warehouses".
   * The latter is a proxy that reads the wrong thing: a stray warehouse row —
   * which the locations sync could once create for a legacy org — flipped this
   * into per-warehouse mode, where a legacy org has no stock_levels at all, so
   * it emitted nothing and stock sync stopped silently (no mutation, hence no
   * error). Testing the flag directly makes that unrepresentable.
   *
   *  - **Warehousing on, with mapped warehouses** → push each warehouse's own
   *    `available` to the location it mirrors. Pushing the org-wide total to
   *    the primary (as this did originally) left other locations untouched, so
   *    Shopify's displayed total became our number PLUS whatever they held.
   *  - **Otherwise** → legacy orgs, and warehousing orgs whose locations sync
   *    has not run yet. Falls back to the previous behaviour exactly.
   *
   * A variant with no stock row *at a mapped warehouse* emits nothing for that
   * location — symmetric with the pull, which treats an absent inventory level
   * as "not stocked here" rather than as zero. But a variant with no stock row
   * at ALL is not covered by the bucket model (created after the enable seed,
   * or trackQuantity:false so never seeded), and falls back to the primary
   * location so it keeps syncing rather than silently dropping out.
   */
  private async buildAvailabilityQuantities(
    orgId: string,
    channelId: string,
    shopDomain: string,
    token: string,
    variants: Array<{ id: string; inventoryQuantity: number }>,
    invIdByVariant: Map<string, string>,
  ): Promise<Array<{ inventoryItemId: string; locationId: string; quantity: number }>> {
    // The pre-multi-location behaviour, kept as a named helper because two
    // callers need it: whole-org fallback, and per-variant fallback below.
    const pushAtPrimary = async (subset: typeof variants) => {
      if (subset.length === 0) return [];
      const locationId = await this.resolveLocationId(channelId, shopDomain, token);
      if (!locationId) {
        this.logger.warn(
          `Skipping availability push for org ${orgId}: no resolvable Shopify location`,
        );
        return [];
      }
      return subset.flatMap((v) => {
        const invId = invIdByVariant.get(v.id);
        if (!invId) return [];
        return [
          {
            inventoryItemId: ShopifyGraphqlClient.toGid('InventoryItem', invId),
            locationId: ShopifyGraphqlClient.toGid('Location', locationId),
            quantity: v.inventoryQuantity,
          },
        ];
      });
    };

    const warehousing = await this.inventoryLedger.isWarehousingEnabled(orgId);
    const mapped = warehousing
      ? await this.prisma.warehouse.findMany({
          where: {
            organizationId: orgId,
            shopifyLocationId: { not: null },
            isActive: true,
          },
          select: { id: true, shopifyLocationId: true },
        })
      : [];

    if (mapped.length === 0) return pushAtPrimary(variants);

    const locationByWarehouse = new Map(
      mapped.map((w) => [w.id, w.shopifyLocationId as string]),
    );
    const levels = await this.prisma.stockLevel.findMany({
      where: {
        variantId: { in: variants.map((v) => v.id) },
        warehouseId: { in: mapped.map((w) => w.id) },
        locationId: null,
      },
      select: { variantId: true, warehouseId: true, available: true },
    });

    const perLocation = levels.flatMap((level) => {
      const invId = invIdByVariant.get(level.variantId);
      const shopifyLocationId = locationByWarehouse.get(level.warehouseId);
      if (!invId || !shopifyLocationId) return [];
      return [
        {
          inventoryItemId: ShopifyGraphqlClient.toGid('InventoryItem', invId),
          locationId: ShopifyGraphqlClient.toGid('Location', shopifyLocationId),
          quantity: level.available,
        },
      ];
    });

    // A variant with NO stock row anywhere is outside the bucket model — it
    // was created after the enable seed, or has trackQuantity:false so the
    // seed skipped it. It used to push its cached quantity; without this it
    // would silently stop syncing the moment warehousing was switched on.
    const covered = new Set(levels.map((l) => l.variantId));
    const uncovered = variants.filter((v) => !covered.has(v.id));
    if (uncovered.length > 0) {
      perLocation.push(...(await pushAtPrimary(uncovered)));
    }

    return perLocation;
  }

  /** Set absolute available quantities in one mutation. Best-effort — a
   *  failure is logged and never aborts the push. */
  private async setInventoryQuantities(
    auth: ShopifyAuthContext,
    quantities: Array<{ inventoryItemId: string; locationId: string; quantity: number }>,
  ): Promise<void> {
    try {
      const res = await this.graphql.request<InventorySetQuantitiesResponse>(
        auth,
        INVENTORY_SET_QUANTITIES_MUTATION,
        {
          input: {
            name: 'available',
            reason: 'correction',
            ignoreCompareQuantity: true,
            quantities,
          },
        },
      );
      const errors = res.inventorySetQuantities?.userErrors ?? [];
      if (errors.length > 0) {
        // Logged at ERROR, not WARN: a rejected push leaves Shopify holding a
        // number the CRM believes it changed, and the two only reconverge on
        // the next pull. The most common cause is an inventory item that is
        // not stocked at the target location, so the location list is named
        // here — that is the detail that makes it diagnosable, and it used to
        // be absent entirely.
        const locations = [...new Set(quantities.map((q) => q.locationId))].join(', ');
        this.logger.error(
          `inventorySetQuantities rejected ${errors.length} of ${quantities.length} quantity write(s) ` +
          `across location(s) ${locations}: ${errors.map((e) => e.message).join('; ')}`,
        );
      } else {
        this.logger.log(`Inventory set for ${quantities.length} variant/location pair(s)`);
      }
    } catch (err) {
      this.logger.error(
        `Inventory update failed for ${quantities.length} quantity write(s): ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /**
   * A function that restates a catalogue price in the destination store's
   * currency, or the identity when no conversion is needed.
   *
   * Pushing a product REBADGES it onto the destination channel (see the
   * rebadge transaction in `pushProduct`), so after the push its price is read
   * in that store's currency. Sending the number unchanged therefore does not
   * mislabel the price, it re-denominates it — a ₹120 counter-sale product
   * became a $120 listing.
   *
   * Unlike an order's rate, this is deliberately TODAY's rate and is not
   * stored: a catalogue price is a live figure being set now, not an
   * accounting fact being recorded about the past.
   *
   * Fails the push when a conversion is needed but the rate cannot be reached.
   * Publishing a wrong price to a live storefront is worse than not publishing.
   */
  private async priceConverter(
    product: { channel: { currency: string | null } | null; organizationId: string },
    shopify: { id: string; currency: string | null },
    token: string,
    shopDomain: string,
  ): Promise<(value: Prisma.Decimal | number | string | null) => string | null> {
    const identity = (value: Prisma.Decimal | number | string | null) =>
      value === null || value === undefined ? null : String(value);

    const target = await this.destinationCurrency(shopify, token, shopDomain);

    // The product's own channel says what its prices are denominated in; a
    // CRM-native product has none, and is priced in the org's currency — the
    // same rule `OrderService` applies to a counter sale.
    const org = await this.prisma.organization.findUnique({
      where: { id: product.organizationId },
      select: { currency: true },
    });
    const source = (product.channel?.currency ?? org?.currency ?? '').toUpperCase();

    // Unknown on either side means there is no pair to convert — pushing
    // unchanged is the only honest option, and is what already happens today.
    if (!target || !source || source === target) return identity;

    const rate = await this.fx.getRate(source, target, new Date());
    if (rate == null) {
      throw new Error(
        `Cannot push: ${source}→${target} exchange rate unavailable, and sending ` +
          `${source} prices to a ${target} store would publish wrong prices.`,
      );
    }

    this.logger.log(
      `Converting catalogue prices ${source}→${target} at ${rate} for push to ${shopDomain}`,
    );

    return (value) => {
      if (value === null || value === undefined) return null;
      const num = Number(value);
      if (!Number.isFinite(num)) return null;
      // 2dp is what Shopify stores for every currency this app serves.
      return (num * rate).toFixed(2);
    };
  }

  /**
   * The currency a Shopify store prices in.
   *
   * Prefers the value already learned from that store's orders, and otherwise
   * asks Shopify directly — a store that has never synced an order still has a
   * currency, and guessing it would be exactly the mistake this fixes. The
   * answer is cached back onto the channel so later pushes skip the call.
   */
  private async destinationCurrency(
    shopify: { id: string; currency: string | null },
    token: string,
    shopDomain: string,
  ): Promise<string | null> {
    if (shopify.currency) return shopify.currency.toUpperCase();

    try {
      const res = await this.graphql.request<ShopInfoResponse>(
        { shopDomain, accessToken: token },
        SHOP_INFO_QUERY,
      );
      const code = res?.shop?.currencyCode?.toUpperCase() ?? null;
      if (code) {
        // `currency: null` in the where clause keeps this fill-once: a store's
        // currency should not silently change under a running catalogue.
        await this.prisma.channel.updateMany({
          where: { id: shopify.id, currency: null },
          data: { currency: code },
        });
      }
      return code;
    } catch (err) {
      this.logger.warn(
        `Could not read shop currency for ${shopDomain}: ${(err as Error).message}`,
      );
      return null;
    }
  }

  /** Older product pulls didn't persist inventory_item_id. Fetch it from
   *  Shopify for an existing variant and cache it locally so inventory can be
   *  pushed. Best-effort → null on failure. */
  private async backfillInventoryItemId(
    auth: ShopifyAuthContext,
    variantId: string,
    variantExternalId: string,
  ): Promise<string | null> {
    try {
      const res = await this.graphql.request<VariantInventoryItemResponse>(
        auth,
        VARIANT_INVENTORY_ITEM_QUERY,
        { id: ShopifyGraphqlClient.toGid('ProductVariant', variantExternalId) },
      );
      const invGid = res.productVariant?.inventoryItem?.id;
      if (!invGid) return null;
      const invId = ShopifyGraphqlClient.extractId(invGid);
      await this.prisma.productVariant.update({
        where: { id: variantId },
        data: { inventoryItemId: invId },
      });
      return invId;
    } catch (err) {
      this.logger.warn(
        `Failed to resolve inventory_item_id for variant ${variantExternalId}: ${err}`,
      );
      return null;
    }
  }

  /**
   * Make Shopify's option structure match `Product.options`, then bring the
   * CRM's per-variant option columns in line with what Shopify did about it.
   *
   * Runs before any variant mutation on the update path, because those name
   * options by name and Shopify rejects a variant naming an option it does not
   * have. Mutations run in the order delete → create → add values → reorder,
   * each one failing the push on a userError.
   *
   * Returns the option names (in slot order) the variant mutations must use,
   * and the variant list the rest of the push should work from: option
   * columns of existing rows updated to Shopify's assignment, and generated
   * `manual_` rows that now duplicate an existing combination removed.
   */
  private async reconcileProductOptions<V extends OptionCarryingVariant>(
    auth: ShopifyAuthContext,
    product: {
      id: string;
      externalId: string;
      options: Prisma.JsonValue;
      variants: V[];
    },
    productGid: string,
  ): Promise<{ optionNames: string[]; variants: V[] }> {
    const snapshot = await this.graphql.request<ProductOptionsQueryResponse>(
      auth,
      PRODUCT_OPTIONS_QUERY,
      { id: productGid },
    );
    if (!snapshot.product) {
      throw new Error(
        `Shopify product ${product.externalId} no longer exists — cannot push local edits`,
      );
    }
    let remoteOptions: ShopifyLiveOption[] = snapshot.product.options;
    let remoteVariants: ShopifyLiveVariantOptions[] = snapshot.product.variants.nodes;
    const adopt = (
      p:
        | { options: ShopifyLiveOption[]; variants: { nodes: ShopifyLiveVariantOptions[] } }
        | null
        | undefined,
    ) => {
      if (!p) return;
      remoteOptions = p.options;
      remoteVariants = p.variants.nodes;
    };

    const local = this.localOptionsForPush(product, remoteOptions);
    const plan = planOptionReconcile(local, remoteOptions);
    const ctx = `product ${product.externalId}`;

    if (!isNoopPlan(plan)) {
      if (plan.toDelete.length > 0) {
        const res = await this.graphql.request<ProductOptionsDeleteResponse>(
          auth,
          PRODUCT_OPTIONS_DELETE_MUTATION,
          { productId: productGid, options: plan.toDelete, strategy: 'POSITION' },
        );
        ShopifyGraphqlClient.throwIfUserErrors(
          res.productOptionsDelete?.userErrors,
          `productOptionsDelete ${ctx}`,
        );
        adopt(res.productOptionsDelete?.product);
        this.logger.log(`Deleted ${plan.toDelete.length} option(s) on ${ctx}.`);
      }

      if (plan.toCreate.length > 0) {
        const res = await this.graphql.request<ProductOptionsCreateResponse>(
          auth,
          PRODUCT_OPTIONS_CREATE_MUTATION,
          { productId: productGid, options: plan.toCreate, variantStrategy: 'LEAVE_AS_IS' },
        );
        ShopifyGraphqlClient.throwIfUserErrors(
          res.productOptionsCreate?.userErrors,
          `productOptionsCreate ${ctx}`,
        );
        adopt(res.productOptionsCreate?.product);
        this.logger.log(
          `Created option(s) ${plan.toCreate.map((o) => `"${o.name}"`).join(', ')} on ${ctx}.`,
        );

        // Shopify replaces the Title/Default Title placeholder when a real
        // option arrives. If it survived anyway, remove it: DEFAULT strategy
        // suffices for a one-value option, and the pre-existing variant
        // already carries the new options' first values so nothing dangles.
        const leftover = remoteOptions.find(
          (o) =>
            o.name === 'Title' &&
            o.values.length === 1 &&
            o.values[0] === DEFAULT_VARIANT_TITLE &&
            !local.some((l) => l.name === 'Title'),
        );
        if (leftover) {
          const sweep = await this.graphql.request<ProductOptionsDeleteResponse>(
            auth,
            PRODUCT_OPTIONS_DELETE_MUTATION,
            { productId: productGid, options: [leftover.id], strategy: 'DEFAULT' },
          );
          ShopifyGraphqlClient.throwIfUserErrors(
            sweep.productOptionsDelete?.userErrors,
            `productOptionsDelete (Title placeholder) ${ctx}`,
          );
          adopt(sweep.productOptionsDelete?.product);
        }
      }

      for (const add of plan.valuesToAdd) {
        const res = await this.graphql.request<ProductOptionUpdateResponse>(
          auth,
          PRODUCT_OPTION_UPDATE_MUTATION,
          {
            productId: productGid,
            option: { id: add.optionId },
            optionValuesToAdd: add.values,
          },
        );
        ShopifyGraphqlClient.throwIfUserErrors(
          res.productOptionUpdate?.userErrors,
          `productOptionUpdate "${add.optionName}" ${ctx}`,
        );
        if (res.productOptionUpdate?.product) {
          remoteOptions = res.productOptionUpdate.product.options;
        }
        this.logger.log(
          `Added value(s) ${add.values.map((v) => `"${v.name}"`).join(', ')} to option "${add.optionName}" on ${ctx}.`,
        );
      }

      if (plan.reorder) {
        const res = await this.graphql.request<ProductOptionsReorderResponse>(
          auth,
          PRODUCT_OPTIONS_REORDER_MUTATION,
          { productId: productGid, options: plan.reorder },
        );
        ShopifyGraphqlClient.throwIfUserErrors(
          res.productOptionsReorder?.userErrors,
          `productOptionsReorder ${ctx}`,
        );
        adopt(res.productOptionsReorder?.product);
      }
    }

    // Always, not only after a structural change: a push that failed after
    // the options landed leaves Shopify's assignment un-mirrored, and the
    // retry's plan is a no-op.
    const optionNames = local.map((o) => o.name);
    const variants = await this.adoptRemoteVariantOptions(product, optionNames, remoteVariants);
    return { optionNames, variants };
  }

  /**
   * The CRM's option definition in the shape the reconcile compares:
   * `Product.options` names + values, topped up with any value a variant
   * carries that the JSON forgot. JSON values come first, in their order,
   * because the FIRST value is what both sides assign to pre-existing
   * variants when an option is added.
   *
   * Legacy rows with no options JSON but real variant values only have
   * positional names ("Option 1"). For those, take Shopify's names by
   * position — otherwise the plan would be a destructive delete + create of
   * every real option on the store.
   */
  private localOptionsForPush(
    product: {
      options: Prisma.JsonValue;
      variants: Array<{ option1: string | null; option2: string | null; option3: string | null }>;
    },
    remoteOptions: ShopifyLiveOption[],
  ): LocalOption[] {
    const optionKeys = ['option1', 'option2', 'option3'] as const;
    let names = this.deriveOptionTypes(product);
    if (names.length === 0) return [];

    const stored = Array.isArray(product.options)
      ? (product.options.filter(
          (o) => o && typeof o === 'object' && !Array.isArray(o),
        ) as Array<Record<string, unknown>>)
      : null;

    if (!stored) {
      const remoteReal = isPlaceholderRemoteOptions(remoteOptions)
        ? []
        : [...remoteOptions].sort((a, b) => a.position - b.position);
      if (remoteReal.length < names.length) {
        throw new Error(
          `Product uses ${names.length} option slot(s) but has no option definitions; set its options in the CRM before syncing.`,
        );
      }
      names = names.map((_, i) => remoteReal[i].name);
    }

    return names.map((name, i) => {
      const entry = stored?.find((o) => o.name === name);
      const values = new Set<string>(
        Array.isArray(entry?.values)
          ? entry.values.filter((v): v is string => typeof v === 'string' && v.length > 0)
          : [],
      );
      for (const v of product.variants) {
        const value = v[optionKeys[i]];
        if (value && value !== DEFAULT_VARIANT_TITLE) values.add(value);
      }
      if (values.size === 0) values.add('Default');
      return { name, values: [...values] };
    });
  }

  /**
   * Write Shopify's per-variant option assignment back onto the CRM rows and
   * drop rows that can no longer exist.
   *
   * After productOptionsCreate(LEAVE_AS_IS) every pre-existing Shopify variant
   * carries the first value of each new option. The CRM's generator used to
   * leave that slot null on existing rows and create the full cartesian
   * product alongside — "S / Red" (no material) next to a generated
   * "S / Red / Cotton". Shopify has now made the original "S / Red / Cotton"
   * too, so the generated twin can never be created there; it is deleted here.
   * Variants Shopify itself removed (productOptionsDelete POSITION) go the
   * same way. A delete that anything still references fails the push with the
   * variant named — better than a silent divergence.
   *
   * Returned in the caller's original order.
   */
  private async adoptRemoteVariantOptions<V extends OptionCarryingVariant>(
    product: { externalId: string; variants: V[] },
    optionNames: string[],
    remoteVariants: ShopifyLiveVariantOptions[],
  ): Promise<V[]> {
    const remoteById = new Map(
      remoteVariants.map((rv) => [ShopifyGraphqlClient.extractId(rv.id), rv]),
    );
    const isManual = (v: V) => !v.externalId || v.externalId.startsWith('manual_');
    const tripleOf = (v: V) => `${v.option1 ?? ''}|${v.option2 ?? ''}|${v.option3 ?? ''}`;

    const kept = new Set<string>();
    const takenTriples = new Set<string>();

    for (const v of product.variants) {
      if (isManual(v)) continue;
      const rv = remoteById.get(v.externalId);
      if (!rv) {
        await this.deleteVariantRow(
          v,
          product.externalId,
          'no longer exists on Shopify after the option change',
        );
        continue;
      }
      const next: [string | null, string | null, string | null] = [null, null, null];
      for (let i = 0; i < optionNames.length && i < 3; i++) {
        next[i] = rv.selectedOptions.find((s) => s.name === optionNames[i])?.value ?? null;
      }
      const labels = next.filter(Boolean) as string[];
      const title =
        optionNames.length === 0 || labels.length === 0
          ? DEFAULT_VARIANT_TITLE
          : labels.join(' / ');
      if (optionNames.length === 0) next[0] = DEFAULT_VARIANT_TITLE;

      if (
        v.option1 !== next[0] ||
        v.option2 !== next[1] ||
        v.option3 !== next[2] ||
        v.title !== title
      ) {
        await this.prisma.productVariant.update({
          where: { id: v.id },
          data: { option1: next[0], option2: next[1], option3: next[2], title },
        });
        v.option1 = next[0];
        v.option2 = next[1];
        v.option3 = next[2];
        v.title = title;
      }
      takenTriples.add(tripleOf(v));
      kept.add(v.id);
    }

    for (const v of product.variants) {
      if (!isManual(v)) continue;
      const triple = tripleOf(v);
      if (takenTriples.has(triple)) {
        await this.deleteVariantRow(
          v,
          product.externalId,
          'duplicates a combination Shopify already assigned to an existing variant',
        );
        continue;
      }
      takenTriples.add(triple);
      kept.add(v.id);
    }

    return product.variants.filter((v) => kept.has(v.id));
  }

  private async deleteVariantRow(
    v: OptionCarryingVariant,
    productExternalId: string,
    reason: string,
  ): Promise<void> {
    try {
      await this.prisma.productVariant.delete({ where: { id: v.id } });
      this.logger.log(
        `Removed CRM variant "${v.title}" (${v.id}) of Shopify product ${productExternalId}: ${reason}.`,
      );
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003') {
        throw new Error(
          `Variant "${v.title}" ${reason}, but orders or stock records still reference it so it cannot be removed automatically. Resolve it in the CRM and sync again.`,
        );
      }
      throw err;
    }
  }

  /**
   * Derive option type names from `Product.options` (preferred) or fall back
   * to inferring from variants when a multi-variant product was created
   * without an explicit options block.
   */
  private deriveOptionTypes(product: {
    options: Prisma.JsonValue;
    variants: Array<{ option1: string | null; option2: string | null; option3: string | null }>;
  }): string[] {
    if (Array.isArray(product.options)) {
      return product.options
        .filter((o) => o && typeof o === 'object' && !Array.isArray(o))
        .map((o) => (o as Record<string, unknown>).name as string)
        .filter(Boolean);
    }
    // Infer from variants — if any variant has option2 set, we have 2 options, etc.
    const has1 = product.variants.some((v) => v.option1 && v.option1 !== 'Default Title');
    const has2 = product.variants.some((v) => !!v.option2);
    const has3 = product.variants.some((v) => !!v.option3);
    if (!has1) return [];
    if (has3) return ['Option 1', 'Option 2', 'Option 3'];
    if (has2) return ['Option 1', 'Option 2'];
    return ['Option 1'];
  }

  /**
   * Push every CRM-only (MANUAL channel) product for the org. Called when a
   * Shopify store is freshly connected. Sequential to respect Shopify's
   * rate limits.
   */
  /**
   * Triggered by the channels-page "Push to Shopify" / "Sync Now" button.
   * Picks up two kinds of pending work in a single sweep:
   *
   *   1. MANUAL-channel products that have never been pushed (no shopifySync
   *      metadata) or last attempted FAILED → create on Shopify.
   *   2. SHOPIFY-channel products with status `OUT_OF_SYNC` (the user edited
   *      them locally) or `FAILED` (the previous push update failed) → push
   *      the local edits via the update path in `pushProduct`.
   *
   * Already-SYNCED and currently-PENDING products are left alone so we don't
   * race in-flight jobs or re-push unchanged data.
   */
  async bulkPushManualProducts(orgId: string): Promise<void> {
    // Pull every product for the org with its channel platform; filter in
    // app code because Prisma JSON-path queries against optional nested
    // fields are awkward, and the row count is bounded by the catalog size.
    const products = await this.prisma.product.findMany({
      where: { organizationId: orgId, deletedAt: null },
      include: { channel: { select: { platform: true } } },
    });

    const toPush = products.filter((p) => {
      const sync = this.readProductSyncMeta(p.metadata);
      const status = sync?.status;
      // Skip in-flight + already-good states regardless of channel.
      if (status === 'PENDING' || status === 'SYNCED') return false;
      if (p.channel.platform === ChannelPlatform.MANUAL) {
        // MANUAL: push if never pushed or last attempt failed.
        return !status || status === 'FAILED';
      }
      if (p.channel.platform === ChannelPlatform.SHOPIFY) {
        // SHOPIFY-rebadged: push only when there's something to send.
        return status === 'OUT_OF_SYNC' || status === 'FAILED';
      }
      return false;
    });

    if (toPush.length === 0) {
      this.logger.log(`Org ${orgId} has no products pending Shopify push.`);
      return;
    }

    this.logger.log(
      `Bulk-pushing ${toPush.length} pending product(s) for org ${orgId}…`,
    );

    let succeeded = 0;
    let failed = 0;
    for (const p of toPush) {
      try {
        await this.pushProduct(p.id, orgId);
        succeeded++;
      } catch (err) {
        failed++;
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`Bulk push: product ${p.id} failed: ${msg}`);
        await this.recordProductFailure(p.id, orgId, msg).catch(() => undefined);
      }
    }

    this.logger.log(
      `Bulk product push complete for org ${orgId}: ${succeeded} succeeded, ${failed} failed.`,
    );
  }

  /**
   * Push every unsynced offline (MANUAL channel) order to the connected
   * Shopify store. Mirror of `bulkPushManualProducts`. Triggered by the
   * channels-page Sync action after the pull step completes.
   */
  async bulkPushUnsyncedOrders(orgId: string): Promise<void> {
    const manual = await this.prisma.channel.findUnique({
      where: {
        organizationId_platform: {
          organizationId: orgId,
          platform: ChannelPlatform.MANUAL,
        },
      },
    });
    if (!manual) {
      this.logger.log(`Org ${orgId} has no MANUAL channel — nothing to bulk-push.`);
      return;
    }

    const orders = await this.prisma.order.findMany({
      where: {
        organizationId: orgId,
        channelId: manual.id,
        deletedAt: null,
      },
      select: { id: true, metadata: true },
    });

    const unsynced = orders.filter((o) => !this.isAlreadySynced(o.metadata));
    if (unsynced.length === 0) {
      this.logger.log(`Org ${orgId} has no unsynced offline orders to push.`);
      return;
    }

    this.logger.log(
      `Bulk-pushing ${unsynced.length} unsynced offline order(s) for org ${orgId}…`,
    );

    let succeeded = 0;
    let failed = 0;
    for (const o of unsynced) {
      try {
        await this.pushOrder(o.id, orgId);
        succeeded++;
      } catch (err) {
        failed++;
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`Bulk push: order ${o.id} failed: ${msg}`);
        await this.recordFailure(o.id, orgId, msg, /* incrementAttempt */ true).catch(
          () => undefined,
        );
      }
    }

    this.logger.log(
      `Bulk order push complete for org ${orgId}: ${succeeded} succeeded, ${failed} failed.`,
    );
  }

  /** Returns true when metadata.shopifySync.status is exactly 'SYNCED'. */
  private isAlreadySynced(metadata: Prisma.JsonValue | null | undefined): boolean {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      return false;
    }
    const sync = (metadata as Prisma.JsonObject).shopifySync;
    if (!sync || typeof sync !== 'object' || Array.isArray(sync)) return false;
    return (sync as Prisma.JsonObject).status === 'SYNCED';
  }

  // ─── PRODUCT METADATA WRITERS ───

  private async recordProductSuccess(
    productId: string,
    organizationId: string,
    shopifyProductId: string,
  ): Promise<void> {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, organizationId },
      select: { metadata: true },
    });
    const prev = this.readProductSyncMeta(product?.metadata);
    const next = {
      status: 'SYNCED' as const,
      shopifyProductId,
      syncedAt: new Date().toISOString(),
      attempts: (prev?.attempts ?? 0) + 1,
    };
    await this.writeProductSyncMeta(productId, organizationId, next);
  }

  async recordProductFailure(
    productId: string,
    organizationId: string,
    error: string,
    incrementAttempt = true,
  ): Promise<void> {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, organizationId },
      select: { metadata: true },
    });
    const prev = this.readProductSyncMeta(product?.metadata);
    const next = {
      status: 'FAILED' as const,
      error,
      attempts: (prev?.attempts ?? 0) + (incrementAttempt ? 1 : 0),
      ...(prev?.shopifyProductId ? { shopifyProductId: prev.shopifyProductId } : {}),
    };
    await this.writeProductSyncMeta(productId, organizationId, next);
  }

  private readProductSyncMeta(metadata: Prisma.JsonValue | null | undefined):
    | { status: string; shopifyProductId?: string; error?: string; attempts: number }
    | null {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
    const m = (metadata as Record<string, unknown>).shopifySync;
    return (m as any) ?? null;
  }

  private async writeProductSyncMeta(
    productId: string,
    organizationId: string,
    next: object,
  ): Promise<void> {
    await mergeJsonMetadata(this.prisma, 'products', productId, organizationId, {
      shopifySync: next,
    });
  }
}
