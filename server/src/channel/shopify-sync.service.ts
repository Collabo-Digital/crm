import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
    ChannelPlatform,
    ChannelStatus,
    SyncStatus,
    ProductStatus,
    OrderFinancialStatus,
    OrderFulfillmentStatus,
    OrderCancelReason,
    CustomerState,
    Prisma,
} from '@prisma/client';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { resolvePlaceOfSupply } from '../gst/place-of-supply.util';
import {
    extractShippingTax,
    sumTaxLines,
} from './shopify-tax-lines.util';
import { extractRefundTax } from './refund-tax.util';
import { planImageReconcile } from './product-image-identity.util';
import { normalizeShopifyOptions } from './product-options.util';
import {
    gstTypeForSupply,
    type SellerRegistrations,
} from '../gst/seller-registration.util';
import { ShopifyOAuthService } from './shopify-oauth.service';
import { LoyaltyService } from '../loyalty/loyalty.service';
import {
    ShopifyGraphqlClient,
    ShopifyGraphqlError,
    ShopifyAuthResolver,
} from './shopify-graphql.client';
import { ShopifyPushEnqueuer } from './shopify-push.enqueuer';
import { InventoryLedgerService } from '../inventory/inventory-ledger.service';
import { ShopifyLocationSyncService } from './shopify-location-sync.service';
import { InvoiceService } from '../invoice/invoice.service';
import { OrganizationSettingsService } from '../organization-settings/organization-settings.service';
import { FxRateService } from '../common/fx/fx-rate.service';
import { becamePaid } from './order-paid-transition.util';
import { CRM_SOURCE_NAME, carriesCrmMarker, isLocallyPushedPayload, localOrderIdOf } from './order-rebadge.util';
import {
    mapFulfilmentLines,
    shippedFromPayload,
    shouldAcceptRemoteFulfilmentStatus,
    statusForShippedUnits,
} from './fulfillment-line-map.util';
import {
    DRAFT_MIRROR_QUEUE,
    DraftMirrorJobData,
} from '../draft-order/draft-mirror.queue';
import {
    MailingAddress,
    OrdersListResponse,
    OrdersListVariables,
    OrderLineItemsPageResponse,
    OrderLineItemsPageVariables,
    ORDER_LINE_ITEMS_PAGE_QUERY,
    ORDER_REFUNDS_QUERY,
    OrderRefundsResponse,
    OrderRefundsVariables,
    OrderNode,
    ORDERS_LIST_QUERY,
    ORDERS_COUNT_QUERY,
    PRODUCTS_COUNT_QUERY,
    CUSTOMERS_COUNT_QUERY,
    PRODUCTS_LIST_QUERY,
    ProductsListResponse,
    ProductsListVariables,
    ProductSyncNode,
    PRODUCTS_INVENTORY_QUERY,
    ProductsInventoryResponse,
    CUSTOMERS_LIST_QUERY,
    CustomersListResponse,
    CustomersListVariables,
    CustomerSyncNode,
    COLLECTIONS_LIST_QUERY,
    CollectionsListResponse,
    CollectionsListVariables,
    CollectionSyncNode,
    COLLECTION_PRODUCTS_QUERY,
    CollectionProductsResponse,
    PageInfo,
    ORDER_FULFILLMENT_LOCATIONS_QUERY,
    OrderFulfillmentLocationsResponse,
} from './shopify-graphql.types';
import { singleDistinct } from './single-distinct.util';
import { parseProductSettings } from '../organization-settings/schemas/product-settings.schema';

const GRAPHQL_PAGE_SIZE = 50;

/// Orders are fetched in smaller pages than everything else. Even with the
/// refunds fan-out moved to `drainRefunds`, an order node is by far the most
/// expensive thing we ask Shopify for -- it still carries line items,
/// fulfillments, two addresses and five money bags -- and Shopify prices a
/// query before running it against a fixed per-query ceiling. Halving the page
/// size is the cheapest way to stay under it; `paginateOrdersGraphql` degrades
/// further on its own if a particular shop still trips the limit.
///
/// Lowered 25 -> 15 when `taxLines` was added to the line-item and shipping-line
/// selections (needed to reconcile declared tax against collected tax). Every
/// line item now carries a nested connection of its own, so the estimated cost
/// of an order node rose sharply; these two changes belong together and should
/// be reverted together. `MAX_COST_EXCEEDED` degradation remains the backstop.
const ORDERS_PAGE_SIZE = 15;

/// Entity types this service knows how to pull, in the order `runSync` runs
/// them. The order is load-bearing:
///   locations before inventory - the per-location reconcile needs the
///             warehouse mapping to exist first;
///   products  before inventory - once products has applied the quantities,
///             the inventory pass skips its duplicate catalogue scan;
///   orders    before customers - `upsertOrder` creates stub customer rows
///             that the customers pass then enriches.
export const PULL_ENTITY_TYPES = [
    'locations',
    'products',
    'orders',
    'customers',
    'inventory',
    'collections',
] as const;

/// Bulk push directions the channels-page Sync action fans out to.
export const PUSH_ENTITY_TYPES = ['products', 'orders', 'drafts'] as const;

/// Above this many line items in a single order payload we stop trusting the
/// array to be complete and skip the H2 reconcile rather than risk deleting
/// real lines. Shopify documents no completeness guarantee for very large
/// order webhooks, and the largest order in this dataset has 8 items — so the
/// cap costs nothing in practice and only bites on wholesale-sized orders.
const LINE_ITEM_RECONCILE_CAP = 100;

/// How far back to rewind the sync watermark from the run's start time.
/// `updated_at` is stamped by SHOPIFY's clock and compared against OURS, so a
/// few seconds of drift between the two servers would reopen the very window
/// the start-time stamp exists to close. Re-reading a couple of minutes of
/// orders is free: the upserts are idempotent and `upsertOrder`'s
/// compare-and-set makes re-applying an unchanged order a no-op.
const SYNC_WATERMARK_SKEW_MS = 2 * 60 * 1000;

/// A saved pagination cursor is only worth resuming while Shopify still
/// honours it and the run it belongs to is plausibly the one being retried.
/// Past this age a log is retired rather than resurrected — the failure mode
/// it guards against is a crashed run left pinned at IN_PROGRESS whose stale
/// cursor would otherwise be picked up days later.
export const SYNC_RESUME_MAX_AGE_MS = 6 * 60 * 60 * 1000;

// GraphQL WeightUnit enum → REST weight_unit strings the DB already stores.
const WEIGHT_UNIT_MAP: Record<string, string> = {
    KILOGRAMS: 'kg',
    GRAMS: 'g',
    POUNDS: 'lb',
    OUNCES: 'oz',
};

/**
 * Channel-reported tax for one line, as a partial Prisma patch.
 *
 * CONDITIONAL, like `customerId` and the addresses in `upsertOrder`'s patch:
 * when the payload carries no `tax_lines` key at all the returned object is
 * empty, so the upsert leaves whatever is stored untouched rather than writing
 * NULL over a figure an earlier, richer payload supplied.
 */
function channelTax(li: { tax_lines?: unknown }): {
    channelTaxAmount?: Prisma.Decimal;
    channelTaxLines?: Prisma.InputJsonValue;
} {
    const amount = sumTaxLines(li?.tax_lines);
    if (amount === null) return {};

    return {
        channelTaxAmount: amount,
        channelTaxLines: li.tax_lines as Prisma.InputJsonValue,
    };
}

/** Short enough that a GSTIN edit mid-sync is picked up. */
const GST_CONTEXT_TTL_MS = 60_000;

@Injectable()
export class ShopifySyncService {
    /** Per-org GST posture, shared across every upsertOrder in a sync run. */
    private static readonly gstContextCache = new Map<
        string,
        { value: { enabled: boolean; registrations: SellerRegistrations }; expiresAt: number }
    >();

    private readonly logger = new Logger(ShopifySyncService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly shopifyOAuth: ShopifyOAuthService,
        private readonly loyalty: LoyaltyService,
        private readonly graphql: ShopifyGraphqlClient,
        private readonly pushEnqueuer: ShopifyPushEnqueuer,
        private readonly inventoryLedger: InventoryLedgerService,
        private readonly locationSync: ShopifyLocationSyncService,
        private readonly config: ConfigService,
        // Auto-invoicing a Shopify order once it is paid. Both are read only
        // on the live-webhook path — see `maybeAutoInvoice`.
        private readonly invoiceService: InvoiceService,
        private readonly orgSettings: OrganizationSettingsService,
        // Books each incoming order at the FX rate for its own order date, so
        // a USD store inside an INR workspace reports real rupees.
        private readonly fx: FxRateService,
        @InjectQueue(DRAFT_MIRROR_QUEUE)
        private readonly draftMirrorQueue: Queue<DraftMirrorJobData>,
    ) { }

    /**
     * Enqueue a single `bulk-mirror` trigger so the draft-order processor
     * fans out one `draft-create` job per unsynced draft. Lives here (not in
     * `ShopifyPushEnqueuer`) because drafts have their own dedicated queue
     * with separate retry/backoff config.
     */
    private async enqueueDraftBulkMirror(orgId: string): Promise<void> {
        try {
            await this.draftMirrorQueue.add(
                'mirror-bulk',
                { type: 'bulk-mirror', organizationId: orgId },
                {
                    attempts: 3,
                    backoff: { type: 'exponential' as const, delay: 5_000 },
                    removeOnComplete: { age: 60 * 60 * 24 * 7 },
                    removeOnFail: { age: 60 * 60 * 24 * 30 },
                },
            );
        } catch (err) {
            this.logger.warn(
                `Failed to enqueue draft bulk-mirror for org ${orgId}: ${err}`,
            );
        }
    }

    async runSync(channelId: string, orgId: string, entityTypes: string[]): Promise<void> {
        const channel = await this.prisma.channel.findUnique({ where: { id: channelId } });
        if (!channel) throw new Error(`Channel ${channelId} not found`);

        // Non-Shopify channels (MANUAL, INSTAGRAM, WHATSAPP) have no remote
        // source to pull from. We still want to honour the user's "Sync"
        // gesture on the MANUAL channel by running the bulk push of unsynced
        // local items to whichever Shopify channel the org has — but we must
        // never try to resolve OAuth credentials for the MANUAL channel
        // itself. Mark the sync done cleanly and fall through to the bulk
        // push at the bottom of this method.
        if (channel.platform !== ChannelPlatform.SHOPIFY) {
            this.logger.log(
                `Sync requested on non-Shopify channel ${channelId} ` +
                `(platform=${channel.platform}); skipping pull, running bulk push only.`,
            );
            await this.prisma.channel.update({
                where: { id: channelId },
                data: {
                    syncStatus: SyncStatus.COMPLETED,
                    status: ChannelStatus.CONNECTED,
                    lastSyncedAt: new Date(),
                },
            });
            // No pull to fail here, so the push always runs - but it still
            // honours the per-entity push toggles.
            const enabledPush = await this.enabledEntities(channelId, 'push');
            try {
                if (enabledPush.has('products')) {
                    await this.pushEnqueuer.enqueueBulkProductPush({
                        type: 'bulk-products',
                        organizationId: orgId,
                    });
                }
                if (enabledPush.has('orders')) {
                    await this.pushEnqueuer.enqueueBulkOrderPush({
                        type: 'bulk-orders',
                        organizationId: orgId,
                    });
                }
                if (enabledPush.has('drafts')) {
                    await this.enqueueDraftBulkMirror(orgId);
                }
            } catch (err) {
                this.logger.warn(
                    `Failed to enqueue bulk push for org ${orgId}: ${err}`,
                );
            }
            return;
        }

        // Mark as syncing - `syncStatus` ONLY.
        //
        // `status` is CONNECTION health: whether we can still talk to this
        // store. It used to double as sync health, so a backfill that was
        // merely slow (or that failed on one entity) rendered the store as
        // "Error" on the channels page - indistinguishable from a revoked
        // token, and the reason a large store looked like it had failed to
        // connect when it was in fact connected and syncing.
        await this.prisma.channel.update({
            where: { id: channelId },
            data: { syncStatus: SyncStatus.IN_PROGRESS },
        });

        let allSucceeded = true;
        /// Entities that finished cleanly in THIS run. Drives the inventory
        /// pass's skip so the catalogue is only walked once.
        const completedEntities = new Set<string>();
        let initError: Error | null = null;
        let token: string | null = null;
        let shopDomain: string | null = null;

        // The watermark this run will claim, captured BEFORE any Shopify call.
        //
        // This used to be `new Date()` evaluated in the `finally` below, i.e.
        // the moment the run FINISHED — while `syncOrders` asks Shopify for
        // `updated_at >= lastSyncedAt`. Anything edited while the run was in
        // flight was therefore already older than the new watermark and was
        // never fetched again: not delayed, lost. Stamping the start instead
        // means the next run re-covers the window this one was working in.
        const syncStartedAt = new Date(Date.now() - SYNC_WATERMARK_SKEW_MS);

        // EVERYTHING below this point is wrapped in a try/finally so the
        // channel's syncStatus *cannot* get stuck on IN_PROGRESS. Previously
        // `getAccessToken` was outside the try, so a credential / decryption
        // failure would leave the row pinned and the UI button stuck on
        // "Syncing…" forever (and BullMQ retries hit the same wall).
        try {
            try {
                const auth = await this.shopifyOAuth.getAccessToken(channelId);
                token = auth.token;
                shopDomain = auth.shopDomain;
            } catch (err) {
                allSucceeded = false;
                initError = err instanceof Error ? err : new Error(String(err));
                this.logger.error(
                    `Sync init failed for channel ${channelId}: could not resolve access token`,
                    initError,
                );
            }

            if (token && shopDomain) {
                // The initial resolve above stays, purely so bad credentials
                // fail fast before any entity runs. Everything below re-resolves
                // per request through this.
                const getAuth = this.authResolver(channelId);
                const enabledPull = await this.enabledEntities(channelId, 'pull');

                // Run in PULL_ENTITY_TYPES order rather than the order the job
                // happened to list them in - see that constant for why the
                // order is load-bearing.
                const requested = PULL_ENTITY_TYPES.filter((e) => entityTypes.includes(e));
                const skipped = requested.filter((e) => !enabledPull.has(e));
                if (skipped.length) {
                    this.logger.log(
                        `Skipping ${skipped.join(', ')} for channel ${channelId} - switched off in this channel's sync settings.`,
                    );
                }

                for (const entityType of requested.filter((e) => enabledPull.has(e))) {
                    try {
                        switch (entityType) {
                            case 'locations':
                                await this.locationSync.syncLocations(channelId, orgId, getAuth);
                                break;
                            case 'products':
                                await this.syncProducts(channelId, orgId, getAuth);
                                break;
                            case 'orders':
                                await this.syncOrders(channelId, orgId, getAuth);
                                break;
                            case 'customers':
                                await this.syncCustomers(channelId, orgId, getAuth);
                                break;
                            case 'inventory':
                                await this.syncInventory(
                                    channelId, orgId, getAuth,
                                    completedEntities.has('products'),
                                );
                                break;
                            case 'collections':
                                await this.syncCollections(channelId, orgId, getAuth);
                                break;
                        }
                        completedEntities.add(entityType);

                        // Stamp THIS entity the moment it succeeds, so a retry
                        // of the whole job re-reads almost nothing for the
                        // parts that already finished. Previously one shared
                        // watermark advanced only when EVERY entity succeeded,
                        // which is what turned a single failing entity into
                        // three full catalogue rescans per trigger.
                        await this.markEntitySynced(channelId, entityType, syncStartedAt);
                    } catch (error) {
                        allSucceeded = false;
                        // A 401 here does NOT mean the grant is dead. It used to
                        // flip the channel to DISCONNECTED, which stranded a
                        // perfectly healthy store behind a Reconnect button every
                        // time a token expired mid-run. Only the token layer can
                        // tell "expired" from "revoked", and
                        // `refreshAccessToken` / `getAccessToken` already set
                        // DISCONNECTED themselves when the grant really is gone.
                        // Recorded here only so the cause is visible in the log.
                        if (error instanceof ShopifyGraphqlError && error.code === 'AUTH_FAILED') {
                            this.logger.warn(
                                `Auth failed during ${entityType} on channel ${channelId}. Leaving the channel's connection status alone - the token layer owns that decision.`,
                            );
                        }
                        this.logger.error(`Sync failed for ${entityType} on channel ${channelId}`, error);
                    }
                }
            }
        } finally {
            // Defensive: even if the update itself throws (e.g. DB hiccup),
            // we don't want to swallow that on top of an existing error.
            await this.prisma.channel.update({
                where: { id: channelId },
                data: {
                    syncStatus: allSucceeded ? SyncStatus.COMPLETED : SyncStatus.FAILED,
                    // `status` is CONNECTION health and this method no longer
                    // writes a failure into it at all -- neither ERROR (which
                    // made a rate-limited backfill look unconnectable) nor
                    // DISCONNECTED (which a merely-expired token would trigger).
                    // Both belong to the token layer. On success we still repair
                    // a stale ERROR/SYNCING left behind by the old behaviour.
                    ...(allSucceeded ? { status: ChannelStatus.CONNECTED } : {}),
                    // Display only (the channels page's "5m ago"). The sync
                    // FILTER now comes from ChannelSyncState per entity.
                    lastSyncedAt: allSucceeded ? syncStartedAt : undefined,
                },
            }).catch((err) => {
                this.logger.error(
                    `Failed to clear syncStatus for channel ${channelId} (manual unstick may be needed)`,
                    err,
                );
            });
        }

        // Push local items up to Shopify - but ONLY after a clean pull.
        //
        // This used to run unconditionally, before the throw below. With
        // `attempts: 3` on the queue that meant three bulk pushes fired during
        // exactly the retry storm a failing pull produces, and
        // `bulkPushUnsyncedOrders` re-scans every manual order each time.
        // Gating on success also means a store whose pull is broken cannot
        // start creating real Shopify orders from a backlog nobody has
        // reviewed - `pushOrder` calls `orderCreate`, and a Shopify order
        // cannot be un-created.
        if (allSucceeded) {
            const enabledPush = await this.enabledEntities(channelId, 'push');
            try {
                if (enabledPush.has('products')) {
                    await this.pushEnqueuer.enqueueBulkProductPush({
                        type: 'bulk-products',
                        organizationId: orgId,
                    });
                }
                if (enabledPush.has('orders')) {
                    await this.pushEnqueuer.enqueueBulkOrderPush({
                        type: 'bulk-orders',
                        organizationId: orgId,
                    });
                }
                if (enabledPush.has('drafts')) {
                    await this.enqueueDraftBulkMirror(orgId);
                }
            } catch (err) {
                this.logger.warn(
                    `Failed to enqueue post-sync bulk push for org ${orgId}: ${err}`,
                );
            }
        } else {
            this.logger.warn(
                `Skipping the bulk push for org ${orgId}: the pull from Shopify did not complete cleanly.`,
            );
        }

        // Surface the initial-credential error preferentially so the BullMQ
        // failure log shows the underlying cause, not a generic "syncs failed".
        if (initError) throw initError;
        if (!allSucceeded) throw new Error('One or more entity syncs failed');
    }

    // ─── SYNC PRODUCTS ───
    private async syncProducts(channelId: string, orgId: string, getAuth: ShopifyAuthResolver) {
        const syncLog = await this.createSyncLog(channelId, orgId, 'products');
        let processed = 0;
        let failed = 0;

        try {
            await this.updateTotalEstimated(syncLog.id, getAuth, PRODUCTS_COUNT_QUERY, 'productsCount');

            const vendorMetafield = await this.getVendorMetafieldConfig(orgId);
            const queryString = await this.resolveEntityQuery(channelId, 'products');
            let pages = 0;
            for await (const page of this.paginateProductsGraphql(getAuth, syncLog.cursor, vendorMetafield, queryString)) {
                for (const node of page.products) {
                    try {
                        const sp = this.transformGraphqlProduct(node);
                        // Vendor metafield is inlined in the query — no extra call.
                        // undefined = feature off (leave vendorKey untouched).
                        const vendorKey = vendorMetafield
                            ? (node.vendorMetafield?.value != null ? String(node.vendorMetafield.value) : null)
                            : undefined;
                        await this.upsertProduct(channelId, orgId, sp, vendorKey);
                        processed++;
                    } catch (error) {
                        failed++;
                        this.logger.error(`Failed product ${node.id}`, error);
                    }
                }
                pages++;
                await this.prisma.syncLog.update({
                    where: { id: syncLog.id },
                    data: { recordsProcessed: processed, recordsFailed: failed, cursor: page.nextCursor },
                });
            }

            if (pages === 0) {
                // A successful request always yields a page — an empty result
                // yields one page with zero nodes. Yielding nothing means the
                // generator bailed without talking to Shopify, so this is a
                // swallowed failure. Recording COMPLETED here would null the
                // cursor and stamp a watermark, skipping the data for good.
                throw new Error(
                    'Products sync produced no pages — treating as a failure rather than ' +
                    'recording a false COMPLETED (which would stamp a watermark and skip the data).',
                );
            }
            await this.completeSyncLog(syncLog.id, processed, failed);
        } catch (error) {
            await this.failSyncLog(syncLog.id, processed, failed, error);
            throw error;
        }
    }

    private async *paginateProductsGraphql(
        getAuth: ShopifyAuthResolver,
        startCursor: string | null,
        vendorMetafield: { namespace: string; key: string } | null,
        queryString: string | null,
    ): AsyncGenerator<{ products: ProductSyncNode[]; nextCursor: string | null }> {
        let cursor: string | null = startCursor ?? null;
        do {
            const variables: ProductsListVariables = {
                first: GRAPHQL_PAGE_SIZE,
                after: cursor,
                query: queryString,
                withMetafield: !!vendorMetafield,
                // $mfKey is non-null in the query — pass a harmless placeholder
                // when the feature is off (the field is skipped via @include).
                mfNamespace: vendorMetafield?.namespace ?? 'custom',
                mfKey: vendorMetafield?.key ?? 'vendor',
            };
            const res = await this.graphql.request<ProductsListResponse, ProductsListVariables>(
                // Resolved per page, not per job: a catalogue backfill can
                // easily outlive the one-hour token.
                await getAuth(),
                PRODUCTS_LIST_QUERY,
                variables,
            );
            const nextCursor = res.products.pageInfo.hasNextPage
                ? res.products.pageInfo.endCursor
                : null;
            yield { products: res.products.nodes, nextCursor };
            cursor = nextCursor;
        } while (cursor);
    }

    // GraphQL ProductSyncNode → the REST snake_case shape `upsertProduct`
    // consumes (shared with the products/* webhooks). Same bridging strategy
    // as `transformGraphqlOrder` below.
    private transformGraphqlProduct(node: ProductSyncNode): Record<string, any> {
        const variants = node.variants.nodes.map((v) => {
            const weight = v.inventoryItem?.measurement?.weight ?? null;
            return {
                id: ShopifyGraphqlClient.extractId(v.id),
                title: v.title,
                sku: v.sku,
                barcode: v.barcode,
                price: v.price,
                compare_at_price: v.compareAtPrice,
                inventory_quantity: v.inventoryQuantity ?? 0,
                inventory_item_id: v.inventoryItem
                    ? ShopifyGraphqlClient.extractId(v.inventoryItem.id)
                    : null,
                weight: weight?.value ?? null,
                weight_unit: weight?.unit ? (WEIGHT_UNIT_MAP[weight.unit] ?? weight.unit.toLowerCase()) : null,
                // REST option1/2/3 follow the product's option order — so do
                // GraphQL selectedOptions.
                option1: v.selectedOptions?.[0]?.value ?? null,
                option2: v.selectedOptions?.[1]?.value ?? null,
                option3: v.selectedOptions?.[2]?.value ?? null,
                position: v.position,
                requires_shipping: v.inventoryItem?.requiresShipping ?? true,
                taxable: v.taxable,
                // REST names for the inventory toggles the push writes as
                // `inventoryPolicy` / `inventoryItem.tracked` — so the values
                // the CRM sends round-trip instead of drifting after any edit
                // made in Shopify Admin.
                inventory_policy: v.inventoryPolicy ? v.inventoryPolicy.toLowerCase() : undefined,
                inventory_management: v.inventoryItem
                    ? (v.inventoryItem.tracked ? 'shopify' : null)
                    : undefined,
                // Inventory-item fields the REST product webhook does NOT carry
                // (they live on the inventory item there). Only the GraphQL
                // pull can refresh them; `upsertProduct` leaves the column
                // alone when the key is absent.
                cost: v.inventoryItem ? (v.inventoryItem.unitCost?.amount ?? null) : undefined,
                hs_code: v.inventoryItem ? (v.inventoryItem.harmonizedSystemCode ?? null) : undefined,
                country_of_origin: v.inventoryItem
                    ? (v.inventoryItem.countryCodeOfOrigin ?? null)
                    : undefined,
            };
        });

        const images = node.media.nodes
            .filter((m) => m.image?.url)
            .map((m, i) => ({
                id: ShopifyGraphqlClient.extractId(m.id),
                src: m.image!.url,
                alt: m.image!.altText,
                position: i + 1,
            }));

        return {
            id: ShopifyGraphqlClient.extractId(node.id),
            title: node.title,
            body_html: node.descriptionHtml,
            vendor: node.vendor,
            product_type: node.productType,
            status: node.status ? node.status.toLowerCase() : 'active',
            // `upsertProduct` splits on ',' — mirror the REST string shape.
            tags: Array.isArray(node.tags) ? node.tags.join(', ') : '',
            published_at: node.publishedAt,
            created_at: node.createdAt,
            updated_at: node.updatedAt,
            options: node.options?.length
                ? node.options.map((o) => ({ name: o.name, values: o.values, position: o.position }))
                : null,
            variants,
            images,
        };
    }

    // ─── SYNC ORDERS ───
    // Reads orders via the Shopify Admin GraphQL API (Phase 0 migration).
    // The downstream `upsertOrder` still consumes the REST snake_case shape, so
    // `transformGraphqlOrder` bridges the two — one place to maintain.
    // Note: if an existing syncLog has a REST `page_info` cursor from before
    // this migration, the next run will re-start that entity from the
    // beginning. Cursors are opaque per-API so we can't translate.
    private async syncOrders(channelId: string, orgId: string, getAuth: ShopifyAuthResolver) {
        const syncLog = await this.createSyncLog(channelId, orgId, 'orders');
        let processed = 0;
        let failed = 0;

        try {
            // Informational only (drives the totalEstimated progress UI).
            await this.updateTotalEstimated(syncLog.id, getAuth, ORDERS_COUNT_QUERY, 'ordersCount');

            // First backfill → the initial window; afterwards → only what has
            // changed since THIS entity last completed. Previously this read
            // `channel.lastSyncedAt`, which never advanced while any entity was
            // failing, so orders stayed a full-history scan indefinitely.
            const queryString = await this.resolveEntityQuery(channelId, 'orders');
            this.logger.log(
                `Orders sync for channel ${channelId}: ${queryString ?? 'no filter (full pull)'}`,
            );

            let pages = 0;
            for await (const page of this.paginateOrdersGraphql(getAuth, syncLog.cursor, queryString)) {
                for (const node of page.orders) {
                    try {
                        await this.drainLineItems(getAuth, node);
                        await this.drainRefunds(getAuth, node);
                        const so = this.transformGraphqlOrder(node);
                        await this.upsertOrder(channelId, orgId, so);
                        processed++;
                    } catch (error) {
                        failed++;
                        this.logger.error(`Failed order ${node.id}`, error);
                    }
                }
                pages++;
                await this.prisma.syncLog.update({
                    where: { id: syncLog.id },
                    data: { recordsProcessed: processed, recordsFailed: failed, cursor: page.nextCursor },
                });
            }

            if (pages === 0) {
                // See PULL_ENTITY_TYPES / paginate* — a generator that yields
                // no pages at all has not talked to Shopify, so this is a
                // swallowed failure, not an empty store.
                throw new Error(
                    'Orders sync produced no pages — treating as a failure rather than ' +
                    'recording a false COMPLETED (which would stamp a watermark and skip the data).',
                );
            }
            await this.completeSyncLog(syncLog.id, processed, failed);
        } catch (error) {
            await this.failSyncLog(syncLog.id, processed, failed, error);
            throw error;
        }
    }

    // ─── ORDERS GRAPHQL PAGINATION ───
    // Yields each page of orders. Sorted by UPDATED_AT ascending so the cursor
    // checkpoint stored in syncLog walks forward chronologically — matches
    // the previous REST behavior of `updated_at_min` filtering.
    private async *paginateOrdersGraphql(
        getAuth: ShopifyAuthResolver,
        startCursor: string | null,
        queryString: string | null,
    ): AsyncGenerator<{ orders: OrderNode[]; nextCursor: string | null }> {
        let cursor: string | null = startCursor ?? null;
        let pageSize = ORDERS_PAGE_SIZE;
        for (;;) {
            const variables: OrdersListVariables = {
                first: pageSize,
                after: cursor,
                query: queryString,
                sortKey: 'UPDATED_AT',
                reverse: false,
            };
            let res: OrdersListResponse;
            try {
                res = await this.graphql.request<OrdersListResponse, OrdersListVariables>(
                    await getAuth(),
                    ORDERS_LIST_QUERY,
                    variables,
                );
            } catch (error) {
                // Shopify prices a query before running it and rejects anything
                // over its cap. Retrying identically can never succeed, but
                // asking for fewer orders can — and a cursor stays valid across
                // a changed `first`. Degrade instead of failing the whole sync.
                //
                // This block used to sit in a `do…while (cursor)`, where
                // `continue` jumps to the CONDITION rather than the top of the
                // body. On a fresh sync `cursor` is null, so the loop exited
                // having retried nothing and `syncOrders` reported COMPLETED
                // with 0 orders — a silent, permanent data loss. The `for(;;)`
                // with an explicit exit at the bottom is what makes the retry
                // actually happen.
                if (
                    error instanceof ShopifyGraphqlError &&
                    error.code === 'MAX_COST_EXCEEDED' &&
                    pageSize > 1
                ) {
                    pageSize = Math.max(1, Math.floor(pageSize / 2));
                    this.logger.warn(
                        `Orders query rejected as too costly; retrying same cursor with first=${pageSize}.`,
                    );
                    continue;
                }
                throw error;
            }
            const nextCursor = res.orders.pageInfo.hasNextPage
                ? res.orders.pageInfo.endCursor
                : null;
            yield { orders: res.orders.nodes, nextCursor };
            if (!nextCursor) return;
            cursor = nextCursor;
        }
    }

    /**
     * Pull the remaining line items for an order that has more than the first
     * page, mutating `node.lineItems.nodes` in place.
     *
     * ORDERS_LIST_QUERY asks for 100. An order with more used to import a
     * subset with NO signal: `totalPrice` comes from Shopify so the header
     * stayed correct, while the GST invoice (built by walking line items)
     * understated the sale and vendors whose items fell in the missing tail
     * never saw the order. Raising the number is not a fix — Shopify caps it at
     * 250 and a bigger `first` costs more; draining is the fix.
     *
     * Orders within one page (all of them, in practice) issue zero extra calls.
     *
     * NOTE: `fulfillments`/`refunds` are plain list fields, not connections —
     * they expose no pageInfo and cannot be drained this way. Their 50-item
     * caps remain.
     */
    private async drainLineItems(
        getAuth: ShopifyAuthResolver,
        node: OrderNode,
    ): Promise<void> {
        let page = node.lineItems.pageInfo;
        let guard = 0;
        while (page?.hasNextPage && page.endCursor && guard++ < 50) {
            const res = await this.graphql.request<
                OrderLineItemsPageResponse,
                OrderLineItemsPageVariables
            >(await getAuth(), ORDER_LINE_ITEMS_PAGE_QUERY, {
                id: node.id,
                first: 100,
                after: page.endCursor,
            });
            const more = res.order?.lineItems;
            if (!more || more.nodes.length === 0) break;
            node.lineItems.nodes.push(...more.nodes);
            page = more.pageInfo;
        }
        if (guard > 0) {
            this.logger.log(
                `Order ${node.id}: drained ${node.lineItems.nodes.length} line items across ${guard + 1} pages.`,
            );
        }
    }

    /**
     * Populate an order's refunds, but only when it has any.
     *
     * ORDERS_LIST_QUERY used to select `refunds(first: 50)` nesting
     * `refundLineItems(first: 50)` — ~2,500 requested nodes per order, which
     * Shopify prices against a fixed per-query ceiling BEFORE running the
     * query. Multiplied by the page size that put the list query structurally
     * over the limit, and is why orders failed to sync while products (no
     * nested connections) imported cleanly.
     *
     * The list query now carries only the scalar `totalRefundedSet`. Refunds
     * are rare, so the overwhelming majority of orders take zero extra calls
     * and the ones that do need a call pay for exactly what they use.
     */
    private async drainRefunds(
        getAuth: ShopifyAuthResolver,
        node: OrderNode,
    ): Promise<void> {
        const status = node.displayFinancialStatus ?? '';
        const refunded = Number(node.totalRefundedSet?.shopMoney?.amount ?? 0);
        const hasRefund =
            status === 'REFUNDED' ||
            status === 'PARTIALLY_REFUNDED' ||
            (Number.isFinite(refunded) && refunded > 0);

        if (!hasRefund) {
            // ORDERS_LIST_QUERY no longer returns the field at all, so give
            // `transformGraphqlOrder` the empty array it expects rather than
            // leaving it undefined.
            node.refunds = [];
            return;
        }

        // Resolved only here, past the has-refunds gate, so the common case
        // (no refunds) still costs zero extra work.
        const res = await this.graphql.request<OrderRefundsResponse, OrderRefundsVariables>(
            await getAuth(),
            ORDER_REFUNDS_QUERY,
            { id: node.id },
        );
        node.refunds = res.order?.refunds ?? [];
    }

    // ─── GRAPHQL → REST SHAPE TRANSFORMER ───
    // Lets `upsertOrder` (also called from the REST webhook controller) keep
    // consuming the same snake_case object. When we eventually retire REST
    // webhooks too, `upsertOrder` can switch to consuming OrderNode directly
    // and this transformer can be deleted.
    private transformGraphqlOrder(node: OrderNode): Record<string, any> {
        const customer = node.customer
            ? {
                id: ShopifyGraphqlClient.extractId(node.customer.id),
                email: node.customer.email,
                first_name: node.customer.firstName,
                last_name: node.customer.lastName,
            }
            : null;

        const lineItems = node.lineItems.nodes.map((li) => ({
            id: ShopifyGraphqlClient.extractId(li.id),
            product_id: li.variant?.product?.id
                ? ShopifyGraphqlClient.extractId(li.variant.product.id)
                : null,
            variant_id: li.variant?.id
                ? ShopifyGraphqlClient.extractId(li.variant.id)
                : null,
            title: li.title,
            variant_title: li.variantTitle,
            sku: li.sku,
            quantity: li.quantity,
            price: li.originalUnitPriceSet?.shopMoney?.amount ?? '0',
            total_discount: li.totalDiscountSet?.shopMoney?.amount ?? '0',
            // Emitted under its REST name so both ingestion paths converge —
            // webhook payloads already carry `fulfillable_quantity`. This is
            // what lets the upsert derive a shipped count, and from it a
            // per-line status, on the pull path.
            fulfillable_quantity: li.unfulfilledQuantity,
            // `fulfillment_status` is intentionally omitted — GraphQL OrderLineItem
            // has no flat equivalent; leaving it `undefined` means the upsert
            // preserves any prior value rather than overwriting with null.
            requires_shipping: li.requiresShipping,
            taxable: li.taxable,
            // Emitted in REST shape so both ingestion paths converge: webhook
            // payloads already carry `tax_lines`, so `writeOrderChildren` needs
            // no branch. `undefined` (not `[]`) when GraphQL did not return the
            // field, because "not told" and "told zero" are different facts.
            tax_lines: li.taxLines
                ? li.taxLines.map((t) => ({
                    title: t.title,
                    rate: t.rate,
                    price: t.priceSet?.shopMoney?.amount ?? "0",
                }))
                : undefined,
            properties: li.customAttributes?.length
                ? li.customAttributes.map((a) => ({ name: a.key, value: a.value }))
                : null,
        }));

        const fulfillments = node.fulfillments.map((ff) => {
            const track = ff.trackingInfo?.[0];
            return {
                id: ShopifyGraphqlClient.extractId(ff.id),
                status: ff.status ? ff.status.toLowerCase() : 'pending',
                tracking_number: track?.number ?? null,
                tracking_url: track?.url ?? null,
                tracking_company: track?.company ?? null,
                created_at: ff.createdAt,
            };
        });

        // `?? []` because ORDERS_LIST_QUERY no longer selects refunds -- the
        // field is populated by `drainRefunds`, and an order with none never
        // gets a follow-up call.
        const refunds = (node.refunds ?? []).map((rf) => ({
            id: ShopifyGraphqlClient.extractId(rf.id),
            note: rf.note,
            processed_at: rf.createdAt,
            // `total_tax` is what makes the NULL-vs-ZERO contract hold on this
            // path. Without it `extractRefundTax` walked a tax-less array and
            // returned 0.00 — recording a taxed refund as a TAX-FREE one, which
            // is the one thing the nullable columns exist to distinguish.
            refund_line_items: rf.refundLineItems?.nodes?.map((rli) => ({
                id: ShopifyGraphqlClient.extractId(rli.id),
                quantity: rli.quantity,
                line_item_id: ShopifyGraphqlClient.extractId(rli.lineItem.id),
                restock_type: rli.restockType,
                total_tax: rli.totalTaxSet?.shopMoney?.amount,
            })) ?? undefined,
            transactions: [{ amount: rf.totalRefundedSet?.shopMoney?.amount ?? '0' }],
        }));

        return {
            id: ShopifyGraphqlClient.extractId(node.id),
            order_number: node.number,
            name: node.name,
            email: node.email,
            phone: node.phone,
            note: node.note,
            // `upsertOrder` calls `.split(',')` on `so.tags` — preserve REST shape.
            tags: Array.isArray(node.tags) ? node.tags.join(', ') : '',
            currency: node.currencyCode,
            subtotal_price: node.currentSubtotalPriceSet?.shopMoney?.amount ?? '0',
            total_price: node.totalPriceSet?.shopMoney?.amount ?? '0',
            total_tax: node.totalTaxSet?.shopMoney?.amount ?? '0',
            taxes_included: node.taxesIncluded,
            // REST shape again — `extractShippingTax` reads shipping_lines[].tax_lines
            // from both paths.
            shipping_lines: node.shippingLine
                ? [{
                    title: node.shippingLine.title,
                    tax_lines: (node.shippingLine.taxLines ?? []).map((t) => ({
                        title: t.title,
                        rate: t.rate,
                        price: t.priceSet?.shopMoney?.amount ?? "0",
                    })),
                }]
                : undefined,
            total_discounts: node.totalDiscountsSet?.shopMoney?.amount ?? '0',
            total_shipping_price_set: {
                shop_money: {
                    amount: node.totalShippingPriceSet?.shopMoney?.amount ?? '0',
                    currency_code:
                        node.totalShippingPriceSet?.shopMoney?.currencyCode ?? node.currencyCode,
                },
            },
            // Carried through so the pull path can rebadge a pushed offline
            // order, exactly as the webhook path does. Without these, a sync
            // that beats the webhook would still create a duplicate.
            source_identifier: node.sourceIdentifier ?? null,
            source_name: node.sourceName ?? null,
            financial_status: node.displayFinancialStatus
                ? node.displayFinancialStatus.toLowerCase()
                : null,
            // Shopify GraphQL surfaces UNFULFILLED as an explicit enum; REST returned
            // null in that case. Keep the existing mapper happy by mirroring REST.
            fulfillment_status:
                node.displayFulfillmentStatus === 'UNFULFILLED'
                    ? null
                    : node.displayFulfillmentStatus
                        ? node.displayFulfillmentStatus.toLowerCase()
                        : null,
            cancel_reason: node.cancelReason ? node.cancelReason.toLowerCase() : null,
            cancelled_at: node.cancelledAt,
            closed_at: node.closedAt,
            created_at: node.createdAt,
            updated_at: node.updatedAt,
            shipping_address: node.shippingAddress ? this.transformAddress(node.shippingAddress) : null,
            billing_address: node.billingAddress ? this.transformAddress(node.billingAddress) : null,
            customer,
            line_items: lineItems,
            fulfillments,
            refunds,
        };
    }

    private transformAddress(addr: MailingAddress): Record<string, any> {
        return {
            address1: addr.address1,
            address2: addr.address2,
            city: addr.city,
            province: addr.province,
            province_code: addr.provinceCode,
            country: addr.country,
            country_code: addr.countryCodeV2,
            zip: addr.zip,
            first_name: addr.firstName,
            last_name: addr.lastName,
            name: addr.name,
            phone: addr.phone,
            company: addr.company,
        };
    }

    // ─── SYNC CUSTOMERS ───
    private async syncCustomers(channelId: string, orgId: string, getAuth: ShopifyAuthResolver) {
        const syncLog = await this.createSyncLog(channelId, orgId, 'customers');
        let processed = 0;
        let failed = 0;

        try {
            await this.updateTotalEstimated(syncLog.id, getAuth, CUSTOMERS_COUNT_QUERY, 'customersCount');

            const queryString = await this.resolveEntityQuery(channelId, 'customers');
            let pages = 0;
            for await (const page of this.paginateCustomersGraphql(getAuth, syncLog.cursor, queryString)) {
                for (const node of page.customers) {
                    try {
                        await this.upsertCustomer(channelId, orgId, this.transformGraphqlCustomer(node));
                        processed++;
                    } catch (error) {
                        failed++;
                        this.logger.error(`Failed customer ${node.id}`, error);
                    }
                }
                pages++;
                await this.prisma.syncLog.update({
                    where: { id: syncLog.id },
                    data: { recordsProcessed: processed, recordsFailed: failed, cursor: page.nextCursor },
                });
            }

            if (pages === 0) {
                // A successful request always yields a page — an empty result
                // yields one page with zero nodes. Yielding nothing means the
                // generator bailed without talking to Shopify, so this is a
                // swallowed failure. Recording COMPLETED here would null the
                // cursor and stamp a watermark, skipping the data for good.
                throw new Error(
                    'Customers sync produced no pages — treating as a failure rather than ' +
                    'recording a false COMPLETED (which would stamp a watermark and skip the data).',
                );
            }
            await this.completeSyncLog(syncLog.id, processed, failed);
        } catch (error) {
            await this.failSyncLog(syncLog.id, processed, failed, error);
            throw error;
        }
    }

    private async *paginateCustomersGraphql(
        getAuth: ShopifyAuthResolver,
        startCursor: string | null,
        queryString: string | null,
    ): AsyncGenerator<{ customers: CustomerSyncNode[]; nextCursor: string | null }> {
        let cursor: string | null = startCursor ?? null;
        do {
            const variables: CustomersListVariables = {
                first: GRAPHQL_PAGE_SIZE,
                after: cursor,
                query: queryString,
            };
            const res = await this.graphql.request<CustomersListResponse, CustomersListVariables>(
                await getAuth(),
                CUSTOMERS_LIST_QUERY,
                variables,
            );
            const nextCursor = res.customers.pageInfo.hasNextPage
                ? res.customers.pageInfo.endCursor
                : null;
            yield { customers: res.customers.nodes, nextCursor };
            cursor = nextCursor;
        } while (cursor);
    }

    // GraphQL CustomerSyncNode → REST snake_case shape for `upsertCustomer`
    // (shared with the customers/* webhooks).
    private transformGraphqlCustomer(node: CustomerSyncNode): Record<string, any> {
        return {
            id: ShopifyGraphqlClient.extractId(node.id),
            email: node.email,
            first_name: node.firstName,
            last_name: node.lastName,
            phone: node.phone,
            state: node.state ? node.state.toLowerCase() : 'enabled',
            verified_email: node.verifiedEmail,
            accepts_marketing: node.emailMarketingConsent?.marketingState === 'SUBSCRIBED',
            orders_count: parseInt(node.numberOfOrders ?? '0', 10) || 0,
            total_spent: node.amountSpent?.amount ?? '0',
            // `upsertCustomer` splits on ',' — mirror the REST string shape.
            tags: Array.isArray(node.tags) ? node.tags.join(', ') : '',
            note: node.note,
            addresses: node.addresses?.length
                ? node.addresses.map((a) => this.transformAddress(a))
                : null,
            default_address: node.defaultAddress ? this.transformAddress(node.defaultAddress) : null,
            created_at: node.createdAt,
            updated_at: node.updatedAt,
        };
    }

    // ─── SYNC INVENTORY ───
    private async syncInventory(
        channelId: string,
        orgId: string,
        getAuth: ShopifyAuthResolver,
        productsAlreadySynced: boolean,
    ) {
        const syncLog = await this.createSyncLog(channelId, orgId, 'inventory');
        let processed = 0;
        let failed = 0;

        // `upsertProduct` ALREADY writes variant.inventoryQuantity and records
        // the ledger event, because PRODUCTS_LIST_QUERY carries
        // `inventoryQuantity` on every variant. When products ran in this same
        // job, this pass would re-paginate the entire catalogue via
        // PRODUCTS_INVENTORY_QUERY purely to read a field we already have —
        // and the default sync sends both entity types, so every sync walked
        // the catalogue twice. Skip it and keep the pass for the case where a
        // merchant syncs inventory WITHOUT products.
        const warehousing = await this.inventoryLedger.isWarehousingEnabled(orgId);

        // Warehousing orgs hold stock per warehouse, so the aggregate this
        // pass reads (variant.inventoryQuantity — Shopify's SUM across every
        // location) is the wrong number for them: it would flatten the split
        // into whichever warehouse happened to be written last. They get the
        // per-location reconcile instead, which owns its own sync log — so
        // this branch is checked BEFORE the products-pass skip below.
        //
        // This used to be an outright no-op ("Phase D"), which meant a
        // warehousing org's stock never updated from Shopify at all.
        if (warehousing) {
            await this.completeSyncLog(syncLog.id, 0, 0);
            await this.locationSync.pullLocationInventory(channelId, orgId, getAuth);
            return;
        }

        // `upsertProduct` ALREADY writes variant.inventoryQuantity and records
        // the ledger event, because PRODUCTS_LIST_QUERY carries
        // `inventoryQuantity` on every variant. When products ran in this same
        // job, this pass would re-paginate the entire catalogue via
        // PRODUCTS_INVENTORY_QUERY purely to read a field we already have —
        // and the default sync sends both entity types, so every sync walked
        // the catalogue twice. Keep the pass for merchants who sync inventory
        // WITHOUT products.
        if (productsAlreadySynced) {
            this.logger.log(
                `Inventory for channel ${channelId} was applied by the products pass — skipping the duplicate catalogue scan.`,
            );
            await this.completeSyncLog(syncLog.id, 0, 0);
            return;
        }

        try {
            const queryString = await this.resolveEntityQuery(channelId, 'inventory');
            let cursor: string | null = syncLog.cursor ?? null;
            do {
                const res: ProductsInventoryResponse = await this.graphql.request<ProductsInventoryResponse>(
                    await getAuth(),
                    PRODUCTS_INVENTORY_QUERY,
                    { first: GRAPHQL_PAGE_SIZE, after: cursor, query: queryString },
                );
                for (const product of res.products.nodes) {
                    for (const variant of product.variants.nodes) {
                        try {
                            const quantity = variant.inventoryQuantity ?? 0;
                            const existing = await this.prisma.productVariant.findFirst({
                                where: {
                                    externalId: ShopifyGraphqlClient.extractId(variant.id),
                                    product: { channelId },
                                },
                            });
                            if (existing && existing.inventoryQuantity !== quantity) {
                                await this.prisma.$transaction([
                                    this.prisma.productVariant.update({
                                        where: { id: existing.id },
                                        data: { inventoryQuantity: quantity },
                                    }),
                                    this.prisma.inventoryEvent.create({
                                        data: {
                                            organizationId: orgId, variantId: existing.id,
                                            quantityBefore: existing.inventoryQuantity,
                                            quantityAfter: quantity,
                                            changeAmount: quantity - existing.inventoryQuantity,
                                            reason: 'sync', referenceType: 'sync',
                                        },
                                    }),
                                ]);
                                processed++;
                            }
                        } catch (error) {
                            failed++;
                        }
                    }
                }
                cursor = res.products.pageInfo.hasNextPage ? res.products.pageInfo.endCursor : null;
                await this.prisma.syncLog.update({
                    where: { id: syncLog.id },
                    data: { recordsProcessed: processed, recordsFailed: failed, cursor },
                });
            } while (cursor);
            await this.completeSyncLog(syncLog.id, processed, failed);
        } catch (error) {
            await this.failSyncLog(syncLog.id, processed, failed, error);
            throw error;
        }
    }

    // ─── SYNC COLLECTIONS ───
    private async syncCollections(channelId: string, orgId: string, getAuth: ShopifyAuthResolver) {
        const syncLog = await this.createSyncLog(channelId, orgId, 'collections');
        let processed = 0;
        let failed = 0;

        try {
            // One GraphQL connection covers custom AND smart collections —
            // `ruleSet` is non-null only for smart ones. Product membership
            // (previously REST `collects.json`) is inlined per collection.
            const queryString = await this.resolveEntityQuery(channelId, 'collections');
            let cursor: string | null = syncLog.cursor ?? null;
            do {
                const res: CollectionsListResponse = await this.graphql.request<
                    CollectionsListResponse,
                    CollectionsListVariables
                >(await getAuth(), COLLECTIONS_LIST_QUERY, { first: 25, after: cursor, query: queryString });

                for (const node of res.collections.nodes) {
                    try {
                        const col = {
                            id: ShopifyGraphqlClient.extractId(node.id),
                            title: node.title,
                            handle: node.handle,
                            // GraphQL enum BEST_SELLING → REST "best-selling"
                            sort_order: node.sortOrder
                                ? node.sortOrder.toLowerCase().replace(/_/g, '-')
                                : null,
                            published_at: null,
                        };
                        await this.upsertCollection(
                            channelId, orgId, col,
                            node.ruleSet ? 'smart' : 'custom',
                        );
                        await this.syncCollectionProducts(channelId, getAuth, node);
                        processed++;
                    } catch (error) {
                        failed++;
                        this.logger.error(`Failed collection ${node.id}`, error);
                    }
                }

                cursor = res.collections.pageInfo.hasNextPage
                    ? res.collections.pageInfo.endCursor
                    : null;
                await this.prisma.syncLog.update({
                    where: { id: syncLog.id },
                    data: { recordsProcessed: processed, recordsFailed: failed, cursor },
                });
            } while (cursor);

            await this.completeSyncLog(syncLog.id, processed, failed);
        } catch (error) {
            await this.failSyncLog(syncLog.id, processed, failed, error);
            throw error;
        }
    }

    // Product-collection links (replaces REST `collects.json`). The first page
    // of product ids rides along on the collections query; oversized
    // collections are drained with COLLECTION_PRODUCTS_QUERY.
    private async syncCollectionProducts(
        channelId: string,
        getAuth: ShopifyAuthResolver,
        node: CollectionSyncNode,
    ): Promise<void> {
        const collection = await this.prisma.collection.findFirst({
            where: { channelId, externalId: ShopifyGraphqlClient.extractId(node.id) },
            select: { id: true },
        });
        if (!collection) return;

        let position = 0;
        let productNodes = node.products.nodes;
        let pageInfo: PageInfo = node.products.pageInfo;

        for (;;) {
            for (const p of productNodes) {
                position++;
                const product = await this.prisma.product.findFirst({
                    where: { channelId, externalId: ShopifyGraphqlClient.extractId(p.id) },
                    select: { id: true },
                });
                if (!product) continue;
                await this.prisma.productCollection.upsert({
                    where: { productId_collectionId: { productId: product.id, collectionId: collection.id } },
                    create: { productId: product.id, collectionId: collection.id, position },
                    update: { position },
                });
            }
            if (!pageInfo.hasNextPage || !pageInfo.endCursor) break;
            const res = await this.graphql.request<CollectionProductsResponse>(
                await getAuth(),
                COLLECTION_PRODUCTS_QUERY,
                { id: node.id, first: 100, after: pageInfo.endCursor },
            );
            productNodes = res.collection?.products.nodes ?? [];
            pageInfo = res.collection?.products.pageInfo ?? { hasNextPage: false, endCursor: null };
        }
    }

    // ─── UPSERT HELPERS ───

    async upsertProduct(channelId: string, orgId: string, sp: any, vendorKey?: string | null) {
        const externalId = String(sp.id);
        const tags = sp.tags ? sp.tags.split(',').map((t: string) => t.trim()).filter(Boolean) : [];
        // Only touch vendor_key when a value was resolved (string|null). undefined = leave as-is.
        const vendorKeyUpdate = vendorKey === undefined ? {} : { vendorKey };

        // Down to the three keys ProductOptionDto accepts back. The webhook
        // door delivers REST options carrying id/product_id, and storing those
        // made every later save of the product 400 — see product-options.util.
        // The Title/Default Title placeholder still stores null.
        const normalizedOptions =
            normalizeShopifyOptions(sp.options) ?? Prisma.DbNull;

        const product = await this.prisma.product.upsert({
            where: { channelId_externalId: { channelId, externalId } },
            create: {
                organizationId: orgId, channelId, externalId,
                title: sp.title, bodyHtml: sp.body_html, vendor: sp.vendor, vendorKey: vendorKey ?? null,
                productType: sp.product_type, status: this.mapProductStatus(sp.status),
                tags, options: normalizedOptions,
                publishedAt: sp.published_at ? new Date(sp.published_at) : null,
                externalCreatedAt: sp.created_at ? new Date(sp.created_at) : null,
                externalUpdatedAt: sp.updated_at ? new Date(sp.updated_at) : null,
            },
            update: {
                title: sp.title, bodyHtml: sp.body_html, vendor: sp.vendor, ...vendorKeyUpdate,
                productType: sp.product_type, status: this.mapProductStatus(sp.status),
                tags, options: normalizedOptions,
                publishedAt: sp.published_at ? new Date(sp.published_at) : null,
                externalUpdatedAt: sp.updated_at ? new Date(sp.updated_at) : null,
            },
        });

        // Warehousing orgs: variant.inventoryQuantity is a derived cache
        // (SUM of StockLevel.available) — the product pull must never stomp
        // it. Quantity reconciliation for those orgs is the Phase D drift
        // flow. Legacy orgs keep the pull-writes-quantity behavior, now WITH
        // ledger events (previously this path mutated stock silently).
        const warehousing = await this.inventoryLedger.isWarehousingEnabled(orgId);
        // The org-wide "all products" overrides force what the PUSH sends for
        // inventory_policy / tracked, so what Shopify holds while they are ON
        // is the forced value, not the merchant's per-variant choice. Pulling
        // it back would flip every variant's own toggle to the forced value —
        // the merchant switches a variant off, syncs, and finds it back on —
        // and would leave every row stuck that way once the override is
        // turned off again. While an override is ON its column is left alone.
        const productSettings = await this.orgSettings.getProductSettings(orgId);
        const oversellForced = productSettings.allowOversellGlobally === true;
        const trackForced = productSettings.trackQuantityGlobally === true;
        const priorVariants = await this.prisma.productVariant.findMany({
            where: { productId: product.id },
            // barcodeSource decides whether an incoming empty barcode is allowed
            // to clear the local one — see the update branch below.
            select: {
                externalId: true, inventoryQuantity: true, sku: true,
                barcode: true, barcodeSource: true,
            },
        });
        const priorByExt = new Map(priorVariants.map((v) => [v.externalId, v]));

        for (const sv of sp.variants || []) {
            const incomingQty = sv.inventory_quantity ?? 0;
            const prior = priorByExt.get(String(sv.id));

            // Barcode is the one field here Shopify is NOT unconditionally
            // authoritative for.
            //
            // This branch used to write `barcode: sv.barcode` flat, so a Shopify
            // variant with no barcode set the local value to NULL — destroying
            // codes minted by SkuGeneratorService for label printing. That is
            // not gated on the Sync button: the products/update webhook runs
            // this same upsert, so any edit in Shopify Admin (or by another app)
            // wiped them in real time, and labels already stuck on stock stopped
            // resolving at inventory.service's `where: { barcode }` lookup.
            //
            // Only GENERATED codes are protected, and only against an ABSENT
            // incoming value. A merchant who deliberately clears a Shopify-sourced
            // barcode still has that respected, and a real barcode arriving from
            // Shopify always wins — including over one of ours, because a GTIN
            // outranks an internal code.
            //
            // `undefined` means "leave the column alone" in Prisma, the same
            // idiom inventoryItemId uses two lines down.
            const incomingBarcode = sv.barcode || null;
            const keepLocalBarcode =
                incomingBarcode === null && prior?.barcodeSource === 'GENERATED';

            // Inventory toggles. Both doors carry these — REST as
            // `inventory_policy` ('continue' | 'deny') and
            // `inventory_management` ('shopify' | null), GraphQL bridged to the
            // same names in transformGraphqlProduct. Absent key = leave alone,
            // the same `undefined` idiom inventoryItemId uses below.
            const continueSelling: boolean | undefined =
                oversellForced || sv.inventory_policy === undefined
                    ? undefined
                    : String(sv.inventory_policy).toLowerCase() === 'continue';
            const trackQuantity: boolean | undefined =
                trackForced || sv.inventory_management === undefined
                    ? undefined
                    : sv.inventory_management === 'shopify';
            // Inventory-item fields: only the GraphQL pull supplies them (the
            // REST product webhook has no cost / HS code / country). Absent key
            // = leave alone, so a webhook never blanks what the pull fetched.
            const cost = sv.cost === undefined ? undefined : (sv.cost != null ? String(sv.cost) : null);
            const hsCode = sv.hs_code === undefined ? undefined : (sv.hs_code || null);
            const countryOfOrigin =
                sv.country_of_origin === undefined ? undefined : (sv.country_of_origin || null);

            const row = await this.prisma.productVariant.upsert({
                where: { productId_externalId: { productId: product.id, externalId: String(sv.id) } },
                create: {
                    productId: product.id, organizationId: orgId,
                    externalId: String(sv.id), title: sv.title || 'Default',
                    sku: sv.sku, barcode: incomingBarcode,
                    barcodeSource: incomingBarcode ? 'SHOPIFY' : null,
                    price: sv.price,
                    compareAtPrice: sv.compare_at_price,
                    inventoryQuantity: warehousing ? 0 : incomingQty,
                    inventoryItemId: sv.inventory_item_id ? String(sv.inventory_item_id) : null,
                    weight: sv.weight ? String(sv.weight) : null, weightUnit: sv.weight_unit,
                    option1: sv.option1, option2: sv.option2, option3: sv.option3,
                    position: sv.position ?? 1, requiresShipping: sv.requires_shipping ?? true,
                    taxable: sv.taxable ?? true,
                    ...(continueSelling !== undefined ? { continueSellingWhenOutOfStock: continueSelling } : {}),
                    ...(trackQuantity !== undefined ? { trackQuantity } : {}),
                    ...(cost !== undefined ? { cost } : {}),
                    ...(hsCode !== undefined ? { hsCode } : {}),
                    ...(countryOfOrigin !== undefined ? { countryOfOrigin } : {}),
                },
                update: {
                    title: sv.title || 'Default', sku: sv.sku,
                    ...(keepLocalBarcode
                        ? {}
                        : {
                              barcode: incomingBarcode,
                              barcodeSource: incomingBarcode ? 'SHOPIFY' : null,
                          }),
                    price: sv.price, compareAtPrice: sv.compare_at_price,
                    ...(warehousing ? {} : { inventoryQuantity: incomingQty }),
                    inventoryItemId: sv.inventory_item_id ? String(sv.inventory_item_id) : undefined,
                    weight: sv.weight ? String(sv.weight) : null, weightUnit: sv.weight_unit,
                    option1: sv.option1, option2: sv.option2, option3: sv.option3, position: sv.position ?? 1,
                    // Both were written on create but never refreshed, so a
                    // change made in Shopify Admin drifted permanently.
                    requiresShipping: sv.requires_shipping ?? true,
                    taxable: sv.taxable ?? true,
                    continueSellingWhenOutOfStock: continueSelling,
                    trackQuantity,
                    cost,
                    hsCode,
                    countryOfOrigin,
                },
            });
            if (!warehousing) {
                const before = prior?.inventoryQuantity ?? 0;
                if (before !== incomingQty) {
                    await this.inventoryLedger.recordQuantityChange(this.prisma, {
                        orgId,
                        variantId: row.id,
                        quantityBefore: before,
                        quantityAfter: incomingQty,
                        reason: 'sync',
                        referenceType: 'product_sync',
                        referenceId: externalId,
                        sku: row.sku,
                    });
                }
            }
        }

        await this.reconcileProductImages(product.id, sp.images);
    }

    /**
     * Make this product's stored images match a Shopify payload.
     *
     * The decision lives in `planImageReconcile` (pure, unit-tested); this is
     * only the executor. What it must get right is the ORDER, which is
     * load-bearing in both directions:
     *
     *   repoint variants -> delete rows -> write the incoming set
     *
     * `ProductVariant.image` is `onDelete: SetNull`, so deleting before
     * repointing would silently blank a variant's image rather than move it to
     * the surviving row. And a survivor cannot take the incoming externalId
     * while a doomed row still holds that value, or the (productId, externalId)
     * unique fires mid-transaction.
     */
    private async reconcileProductImages(productId: string, rawImages: unknown) {
        const existing = await this.prisma.productImage.findMany({
            where: { productId },
            orderBy: { createdAt: 'asc' }, // oldest first — the survivor rule
            select: { id: true, externalId: true, src: true },
        });

        const { doomed, writes } = planImageReconcile(existing, rawImages);
        if (doomed.length === 0 && writes.length === 0) return;

        await this.prisma.$transaction(async (tx) => {
            for (const row of doomed) {
                await tx.productVariant.updateMany({
                    where: { imageId: row.id },
                    data: { imageId: row.repointTo },
                });
            }

            if (doomed.length > 0) {
                await tx.productImage.deleteMany({
                    where: { id: { in: doomed.map((row) => row.id) } },
                });
            }

            for (const w of writes) {
                const data = {
                    externalId: w.externalId,
                    src: w.src,
                    alt: w.alt,
                    position: w.position,
                };
                if (w.updateId) {
                    await tx.productImage.update({ where: { id: w.updateId }, data });
                } else {
                    await tx.productImage.create({ data: { productId, ...data } });
                }
            }
        });
    }

    /**
     * Timeline entries for what changed on an order in Shopify.
     *
     * Nothing in the inbound path used to write `OrderTimelineEvent` at all, so
     * an order paid, fulfilled or cancelled in Shopify Admin left no trace and a
     * Shopify-sourced order's activity feed was permanently empty.
     *
     * Three properties keep this from inventing history:
     *  - It diffs STORED state against the payload, so a webhook redelivery or a
     *    re-run of the full sync produces no transition and therefore no event.
     *  - The caller only invokes it after the compare-and-set on
     *    `externalUpdatedAt` has actually applied, so stale payloads are already
     *    excluded.
     *  - Events are stamped with the Shopify timestamp, not now(). Otherwise a
     *    first-time sync of a two-year-old store would date every historical
     *    order to today.
     *
     * `actorId` is null: the actor is a Shopify user we have no record of.
     */
    private buildShopifyTimelineEvents(
        before: {
            financialStatus: OrderFinancialStatus;
            fulfillmentStatus: OrderFulfillmentStatus;
            cancelledAt: Date | null;
            closedAt: Date | null;
        },
        after: {
            financialStatus: OrderFinancialStatus;
            fulfillmentStatus: OrderFulfillmentStatus;
            cancelledAt: Date | null;
            closedAt: Date | null;
        },
        at: Date,
    ): { action: string; message: string; createdAt: Date }[] {
        const events: { action: string; message: string; createdAt: Date }[] = [];
        const push = (action: string, message: string) =>
            events.push({ action, message, createdAt: at });

        if (before.financialStatus !== after.financialStatus) {
            if (after.financialStatus === OrderFinancialStatus.PAID) {
                push('paid', 'Payment received in Shopify');
            } else {
                push(
                    'payment_status_changed',
                    `Payment status changed to ${after.financialStatus} in Shopify`,
                );
            }
        }

        if (before.fulfillmentStatus !== after.fulfillmentStatus) {
            if (after.fulfillmentStatus === OrderFulfillmentStatus.FULFILLED) {
                push('fulfilled', 'Order fulfilled in Shopify');
            } else {
                push(
                    'fulfillment_status_changed',
                    `Fulfilment status changed to ${after.fulfillmentStatus} in Shopify`,
                );
            }
        }

        if (!before.cancelledAt && after.cancelledAt) {
            push('cancelled', 'Order cancelled in Shopify');
        }
        if (!before.closedAt && after.closedAt) {
            push('closed', 'Order archived in Shopify');
        } else if (before.closedAt && !after.closedAt) {
            push('reopened', 'Order re-opened in Shopify');
        }

        return events;
    }

    /**
     * @param opts.live TRUE only for a real-time Shopify webhook. Defaults to
     * FALSE, which is what the bulk/backfill loop in `syncOrders` passes — and
     * the reason auto-invoicing never fires on a backfill. On first connect
     * that loop walks up to `initialOrderWindowDays()` of history; invoicing
     * those would stamp every historical order with today's date and consume a
     * block of statutory serial numbers in one burst. The guard defaults
     * closed so any future caller is non-invoicing unless it opts in.
     */
    async upsertOrder(
        channelId: string,
        orgId: string,
        so: any,
        opts: { live?: boolean } = {},
    ) {
        const externalId = String(so.id);

        let customerId: string | null = null;

        // Read for place-of-supply resolution below; the customer row is already

        // being loaded, so this costs nothing extra.

        let customerBillingStateCode: string | null = null;

        let customerGstin: string | null = null;
        if (so.customer?.id) {
            const customer = await this.prisma.customer.findFirst({ where: { channelId, externalId: String(so.customer.id) } });
            if (customer) {
                customerId = customer.id;
                customerBillingStateCode = customer.billingStateCode;
                customerGstin = customer.gstin;
            } else {
                try {
                    const stub = await this.prisma.customer.create({
                        data: { organizationId: orgId, channelId, externalId: String(so.customer.id), email: so.customer.email, firstName: so.customer.first_name, lastName: so.customer.last_name },
                    });
                    customerId = stub.id;
                } catch {
                    // Create can fail on (channelId, externalId) — a concurrent
                    // stub — OR on the org-level (organizationId, email) unique
                    // when a row with this email exists from a previous channel
                    // connection. Link the order to whichever row matches; the
                    // customers sync pass fully adopts it later.
                    const existing = await this.prisma.customer.findFirst({
                        where: {
                            OR: [
                                { channelId, externalId: String(so.customer.id) },
                                ...(so.customer.email
                                    ? [{ organizationId: orgId, email: so.customer.email }]
                                    : []),
                            ],
                        },
                        select: { id: true },
                    });
                    customerId = existing?.id ?? null;
                }
            }
        }

        const tags = so.tags ? so.tags.split(',').map((t: string) => t.trim()).filter(Boolean) : [];
        const shippingPrice = so.total_shipping_price_set?.shop_money?.amount ?? so.total_shipping_price ?? '0';

        // REBADGE: is this an offline order WE pushed, coming back to us?
        //
        // `pushOrder` stamps the Shopify order with sourceIdentifier = the local
        // order id. Without reading it back, the `orders/create` webhook for an
        // order we just created finds no row under (shopifyChannel, shopifyId)
        // and inserts a SECOND one — so every pushed counter sale existed twice
        // and was counted twice in revenue, top products and customer totals.
        //
        // Adopt the existing row instead: re-point it at the Shopify identity
        // and let the upsert below take its normal update branch. Adopting
        // Shopify's number/name is deliberate — the row IS the Shopify order
        // now, and dropping the `manual_` externalId also moves it cleanly out
        // of the manual order-number index.
        //
        // Local ids are cuids, so a foreign source_identifier cannot collide;
        // the MANUAL-platform filter closes the remaining gap.
        let existing = await this.prisma.order.findUnique({
            where: { channelId_externalId: { channelId, externalId } },
            // financialStatus/fulfillmentStatus/cancelledAt/closedAt are read
            // ONLY to diff against the incoming payload for timeline events —
            // see buildShopifyTimelineEvents. Nothing else consumes them.
            select: {
                id: true, externalUpdatedAt: true, financialStatus: true,
                fulfillmentStatus: true, cancelledAt: true, closedAt: true,
                // Addresses feed place-of-supply resolution. The patch below keeps
                // addresses STICKY (a payload carrying none must not null out what we
                // hold), so resolving from `so.*` alone would let a fulfilment or tag
                // webhook re-resolve a correctly-addressed order down to the seller
                // state and silently flip it from IGST to CGST+SGST.
                shippingAddress: true, billingAddress: true,
            },
        });
        //
        // The identifier alone decides (see order-rebadge.util). `source_name`
        // and the `collabo-crm` tag are checked only to WARN when Shopify has
        // rewritten the markers — a duplicate row is the silent failure this
        // block exists to prevent, so a marker mismatch must be visible.
        const localOrderId = localOrderIdOf(so);
        if (!existing && localOrderId) {
            const pushedLocally = await this.prisma.order.findFirst({
                where: {
                    id: localOrderId,
                    organizationId: orgId,
                    channel: { platform: ChannelPlatform.MANUAL },
                },
                select: {
                    id: true, name: true, customerId: true, externalUpdatedAt: true,
                    financialStatus: true, fulfillmentStatus: true,
                    cancelledAt: true, closedAt: true,
                    shippingAddress: true, billingAddress: true,
                },
            });
            if (pushedLocally) {
                if (!carriesCrmMarker(so)) {
                    this.logger.warn(
                        `Shopify order ${externalId} names local order ${pushedLocally.name} (${pushedLocally.id}) ` +
                        `via source_identifier but carries source_name="${so.source_name ?? ''}" and no ` +
                        `"${CRM_SOURCE_NAME}" tag — rebadging on the identifier alone. Check the push markers.`,
                    );
                }
                await this.prisma.order.update({
                    where: { id: pushedLocally.id },
                    data: {
                        channelId,
                        externalId,
                        orderNumber: so.order_number,
                        name: so.name || `#${so.order_number}`,
                    },
                });
                // Keep the buyer we already know. The upsert below runs its
                // UPDATE branch on this row and would write `customerId: null`
                // for a walk-in sale (Shopify carries no customer, so the
                // lookup above resolved none) — orphaning the order from the
                // customer whose revenue it counts towards. A customer the
                // payload DOES resolve still wins.
                if (!customerId) customerId = pushedLocally.customerId;
                // The row now answers to the Shopify identity, so the write
                // below must take its UPDATE path, not insert a second row.
                existing = {
                    id: pushedLocally.id,
                    externalUpdatedAt: pushedLocally.externalUpdatedAt,
                    financialStatus: pushedLocally.financialStatus,
                    fulfillmentStatus: pushedLocally.fulfillmentStatus,
                    cancelledAt: pushedLocally.cancelledAt,
                    closedAt: pushedLocally.closedAt,
                    shippingAddress: pushedLocally.shippingAddress,
                    billingAddress: pushedLocally.billingAddress,
                };
                this.logger.log(
                    `Rebadged locally-pushed order ${pushedLocally.name} (${pushedLocally.id}) ` +
                    `as Shopify order ${externalId} — no duplicate created.`,
                );
            }
        }

        // Resolve every variant/product the payload references in TWO reads.
        // The line-item loop used to issue up to three serial queries per item;
        // these run before the transaction opens, so the transaction below
        // contains writes only and stays short.
        const payloadLines: any[] = Array.isArray(so.line_items) ? so.line_items : [];
        const variantExternalIds = [
            ...new Set(
                payloadLines.filter((li) => li.variant_id).map((li) => String(li.variant_id)),
            ),
        ];
        const productExternalIds = [
            ...new Set(
                payloadLines.filter((li) => li.product_id).map((li) => String(li.product_id)),
            ),
        ];
        const [variantRows, productRows] = await Promise.all([
            variantExternalIds.length
                ? this.prisma.productVariant.findMany({
                    where: { externalId: { in: variantExternalIds }, product: { channelId } },
                    select: {
                        id: true,
                        externalId: true,
                        product: { select: { vendor: true, vendorKey: true } },
                    },
                })
                : Promise.resolve([]),
            productExternalIds.length
                ? this.prisma.product.findMany({
                    where: { channelId, externalId: { in: productExternalIds } },
                    select: { externalId: true, vendor: true, vendorKey: true },
                })
                : Promise.resolve([]),
        ]);
        const variantByExternalId = new Map(variantRows.map((v) => [v.externalId, v] as const));
        const productByExternalId = new Map(productRows.map((p) => [p.externalId, p] as const));

        const incomingUpdatedAt = so.updated_at ? new Date(so.updated_at) : null;

        

        // GST place of supply and tax head, stamped on the ORDER.

        //

        // These two columns were written in exactly ONE place — the offline order

        // path — so for every Shopify order they stayed null and the invoice fell

        // through to re-deriving place of supply from the address at invoice time.

        // That is precisely the divergence migration 20260731120000 was written to

        // eliminate, and it never held for the majority of orders — including the

        // ones auto-invoicing now targets.

        //

        // Resolved from the MERGED address: `so.*` when the payload carries one,

        // otherwise what we already hold. See the sticky-address note on the

        // `existing` select.

        // Channel-reported tax, stored so the invoice can reconcile what it

        // DECLARES against what was actually COLLECTED. Conditional spreads

        // below: a payload that omits these must not null out a figure an

        // earlier one supplied.

        const shippingTax = extractShippingTax(so);

        const channelTaxPatch = {

            ...(so.taxes_included !== undefined ? { taxesIncluded: Boolean(so.taxes_included) } : {}),

            ...(shippingTax

                ? {

                    channelShippingTaxAmount: shippingTax.amount,

                    channelShippingTaxLines: shippingTax.lines as Prisma.InputJsonValue,

                }

                : {}),

        };

        

        const gst = await this.gstContext(orgId);

        const mergedShippingAddress = so.shipping_address ?? existing?.shippingAddress ?? null;

        const mergedBillingAddress = so.billing_address ?? existing?.billingAddress ?? null;

        const placeOfSupplyCode = gst.enabled

            ? resolvePlaceOfSupply({

                shippingAddress: mergedShippingAddress,

                billingAddress: mergedBillingAddress,

                customerBillingStateCode,

                buyerGstin: customerGstin,

                sellerStateCode: gst.registrations.defaultStateCode,

            })

            : null;

        // Null when GST is off or the org holds no active registration — which is

        // what these columns already mean for a non-GST org.

        const resolvedGstType = gst.enabled

            ? gstTypeForSupply(gst.registrations, placeOfSupplyCode)

            : null;

        // What an UPDATE is allowed to touch.
        //
        // `customerId`, `shippingAddress` and `billingAddress` are conditional
        // on purpose. They used to be written unconditionally, so a payload
        // that carried none of them wrote NULL over what we already held —
        // which destroys real data for any order that started life here: a
        // counter sale pushed to Shopify and rebadged holds a buyer and a
        // delivery address Shopify never learned about. A value Shopify DOES
        // send still wins. The trade-off is deliberate: removing a customer or
        // an address in Shopify no longer clears it locally.
        //
        // `subtotalPrice`/`currency` were missing from the update path
        // altogether, so an order edited in Shopify kept its original subtotal
        // for ever while its total moved.
        //
        // `cancelledAt`/`closedAt`/`tags` stay unconditional — Shopify is the
        // authority on those, and making them sticky would stop an un-cancel
        // or a removed tag from ever propagating.
        const patch: Prisma.OrderUncheckedUpdateManyInput = {
            financialStatus: this.mapFinancialStatus(so.financial_status),
            fulfillmentStatus: this.mapFulfillmentStatus(so.fulfillment_status),
            totalPrice: so.total_price || '0', totalTax: so.total_tax || '0',
            totalDiscounts: so.total_discounts || '0', totalShippingPrice: shippingPrice,
            subtotalPrice: so.subtotal_price ?? undefined,
            currency: so.currency ?? undefined,
            note: so.note, tags,
            cancelReason: this.mapCancelReason(so.cancel_reason),
            cancelledAt: so.cancelled_at ? new Date(so.cancelled_at) : null,
            closedAt: so.closed_at ? new Date(so.closed_at) : null,
            externalUpdatedAt: incomingUpdatedAt,
            // UNCONDITIONAL, deliberately, unlike customerId and the addresses
            // below: these are DERIVED from the merged address, so a corrected
            // shipping address in Shopify must move the place of supply with it.
            placeOfSupplyCode,
            gstType: resolvedGstType,
            ...channelTaxPatch,
            ...(customerId ? { customerId } : {}),
            ...(so.shipping_address ? { shippingAddress: so.shipping_address } : {}),
            ...(so.billing_address ? { billingAddress: so.billing_address } : {}),
        };

        // Set inside the transaction, acted on only AFTER it commits — see the
        // `maybeAutoInvoice` call below for why the invoice cannot be written
        // in here. Holds the order id when this payload is the moment the order
        // became PAID, and stays null on every other payload.
        let becamePaidOrderId: string | null = null;

        // Resolved BEFORE the transaction: it may call the rate provider over
        // the network, and holding a Postgres transaction open across an HTTP
        // round trip is how connection pools get exhausted. A failed lookup
        // returns nulls, which simply leaves the order unconverted.
        const fxPatch = await this.fx.ratePatch(
            orgId,
            so.currency || 'USD',
            so.created_at ? new Date(so.created_at) : new Date(),
        );

        // One transaction for the order and all of its children. Previously the
        // header, line items, fulfillments and refunds were four independent
        // commits, so a failure part-way left a half-written order that the
        // Shopify retry then landed on top of.
        await this.prisma.$transaction(async (tx) => {
            let orderId: string;

            if (!existing) {
                // upsert, not create: two webhooks for a brand-new order can
                // race, and (channelId, externalId) is unique.
                const created = await tx.order.upsert({
                    where: { channelId_externalId: { channelId, externalId } },
                    create: {
                        organizationId: orgId, channelId, customerId, externalId,
                        orderNumber: so.order_number, name: so.name || `#${so.order_number}`,
                        financialStatus: this.mapFinancialStatus(so.financial_status),
                        fulfillmentStatus: this.mapFulfillmentStatus(so.fulfillment_status),
                        currency: so.currency || 'USD', ...fxPatch,
                        subtotalPrice: so.subtotal_price || '0',
                        totalPrice: so.total_price || '0', totalTax: so.total_tax || '0',
                        totalDiscounts: so.total_discounts || '0', totalShippingPrice: shippingPrice,
                        shippingAddress: so.shipping_address || null, billingAddress: so.billing_address || null,
                        note: so.note, tags,
                        cancelReason: this.mapCancelReason(so.cancel_reason),
                        cancelledAt: so.cancelled_at ? new Date(so.cancelled_at) : null,
                        closedAt: so.closed_at ? new Date(so.closed_at) : null,
                        externalCreatedAt: so.created_at ? new Date(so.created_at) : null,
                        externalUpdatedAt: incomingUpdatedAt,
                        placeOfSupplyCode,
                        gstType: resolvedGstType,
                        ...channelTaxPatch,
                    },
                    update: patch,
                    select: { id: true },
                });
                orderId = created.id;

                // `existing` was read OUTSIDE this transaction, so two
                // concurrent deliveries of the same new order can both arrive
                // here. The upsert above resolves that correctly, but
                // everything below is "first sighting" work and would run
                // twice — which is exactly what happened: orders carrying two
                // `created` entries, and a second PAID transition that tried
                // to issue an invoice the first delivery had already issued.
                // A prior `created` event is the in-transaction proof that
                // this order was already known.
                const alreadySeen = await tx.orderTimelineEvent.findFirst({
                    where: { orderId, action: 'created' },
                    select: { id: true },
                });

                if (!alreadySeen) {
                    // No prior state to diff against, so an order that arrives
                    // already paid IS the transition.
                    if (becamePaid(null, this.mapFinancialStatus(so.financial_status))) {
                        becamePaidOrderId = orderId;
                    }

                    // One 'created' entry, dated to Shopify's own created_at so
                    // a backfill of an existing store does not date every
                    // historical order to the sync run.
                    await tx.orderTimelineEvent.create({
                        data: {
                            orderId,
                            actorId: null,
                            action: 'created',
                            message: `Order placed in ${isLocallyPushedPayload(so) ? 'the CRM' : 'Shopify'}`,
                            metadata: { source: 'shopify' } as Prisma.InputJsonValue,
                            createdAt: so.created_at ? new Date(so.created_at) : new Date(),
                        },
                    });
                }
            } else {
                // Compare-and-set on `externalUpdatedAt`. It was written on
                // every upsert and never read, so an `orders/create` arriving
                // after its own `orders/updated` silently reverted the order —
                // a fulfilled order flipping back to unfulfilled, with nothing
                // logged. `lte` (not `lt`) keeps an identical redelivery
                // idempotent instead of making it look like a conflict.
                const applied = await tx.order.updateMany({
                    where: {
                        id: existing.id,
                        ...(incomingUpdatedAt
                            ? {
                                OR: [
                                    { externalUpdatedAt: null },
                                    { externalUpdatedAt: { lte: incomingUpdatedAt } },
                                ],
                            }
                            : {}),
                    },
                    data: patch,
                });
                if (applied.count === 0) {
                    // Deliberately returns before the children are written —
                    // a stale payload must not rewrite line items either.
                    this.logger.debug(
                        `Stale Shopify payload for order ${externalId} (updated_at=${so.updated_at}) — newer state already stored, skipping.`,
                    );
                    return;
                }
                orderId = existing.id;

                // Fill a MISSING rate only — deliberately not part of `patch`,
                // which runs on every Shopify update. Re-rating a booked order
                // each time its status changed would move figures that have
                // already been reported and filed on. `exchangeRate: null` in
                // the where clause is what makes this fill-once.
                if (fxPatch.exchangeRate != null) {
                    await tx.order.updateMany({
                        where: { id: orderId, exchangeRate: null },
                        data: fxPatch,
                    });
                }

                // Sits after the `applied.count === 0` return above, so a stale
                // payload that lost the compare-and-set never reaches here and
                // cannot trigger an invoice out of order.
                if (
                    becamePaid(
                        existing.financialStatus,
                        patch.financialStatus as OrderFinancialStatus,
                    )
                ) {
                    becamePaidOrderId = orderId;
                }

                // Only reached when the write actually applied, so a redelivered
                // or stale payload can never produce a duplicate entry.
                const timelineEvents = this.buildShopifyTimelineEvents(
                    existing,
                    {
                        financialStatus: patch.financialStatus as OrderFinancialStatus,
                        fulfillmentStatus: patch.fulfillmentStatus as OrderFulfillmentStatus,
                        cancelledAt: (patch.cancelledAt as Date | null) ?? null,
                        closedAt: (patch.closedAt as Date | null) ?? null,
                    },
                    incomingUpdatedAt ?? new Date(),
                );
                if (timelineEvents.length > 0) {
                    await tx.orderTimelineEvent.createMany({
                        data: timelineEvents.map((e) => ({
                            orderId,
                            actorId: null,
                            action: e.action,
                            message: e.message,
                            metadata: { source: 'shopify' } as Prisma.InputJsonValue,
                            createdAt: e.createdAt,
                        })),
                    });
                }
            }

            await this.writeOrderChildren(tx, orderId, so, payloadLines, {
                variantByExternalId,
                productByExternalId,
            });

            // Stamp where the goods left from, when the payload says so
            // unambiguously. Done HERE rather than inside writeOrderChildren
            // because that helper is handed no orgId, and the stamp must be
            // tenant-scoped. `transformGraphqlOrder` emits no location_id, so
            // the bulk/backfill path never reaches this — by design.
            const fulfilmentLocationId = singleDistinct(
                (so.fulfillments ?? []).map((f: any) =>
                    f?.location_id != null ? String(f.location_id) : null,
                ),
            );
            if (fulfilmentLocationId) {
                await this.stampDispatchWarehouse(tx, orgId, orderId, fulfilmentLocationId);
            }
        }, { timeout: 20000 });

        // AFTER the commit, never inside it. `InvoiceService.create` opens its
        // OWN Serializable transaction wrapped in `retryOnNumberingConflict`;
        // nesting that inside this Read Committed one would both defeat the
        // numbering retry and let an invoice failure abort the order write. The
        // order landing is the thing that must not be lost.
        if (opts.live && becamePaidOrderId) {
            // Resolve the dispatch point BEFORE invoicing: the invoice
            // snapshots it, and a stamp that lands afterwards would leave the
            // document without a dispatch block for ever.
            await this.ensureDispatchWarehouseFromShopify(orgId, becamePaidOrderId);
            await this.maybeAutoInvoice(orgId, becamePaidOrderId);
        }

        // Learn the shop's currency from the order that just landed. Product
        // prices are bare decimals with no currency of their own, so this is
        // what stops a USD catalogue being rendered in rupees. Written once —
        // `currency: null` in the where clause — because a channel has exactly
        // one shop currency and later orders should not be able to flip it.
        if (so.currency) {
            await this.prisma.channel
                .updateMany({
                    where: { id: channelId, currency: null },
                    data: { currency: so.currency.toUpperCase() },
                })
                .catch(() => undefined);
        }

        // `ordersCount` / `totalSpent` are derived from the order table, so an
        // arriving order has to trigger the derivation. This was only wired to
        // the CUSTOMER sync, which meant a customer's totals only refreshed if
        // Shopify happened to resend the customer: dummy@gmail.com sat at
        // "5 orders / 6,418.36" while six orders actually referenced them,
        // short by exactly the value of order #1006.
        //
        // Soft-fail for the same reason as the customer-sync call: a loyalty
        // recompute must never cost us the order write, which has already
        // committed above.
        if (customerId) {
            await this.loyalty.recomputeForCustomer(customerId, orgId).catch((err) => {
                this.logger.warn(
                    `Loyalty recompute failed for customer ${customerId}: ${err?.message ?? err}`,
                );
            });
        }
    }

    /**
     * Point an order at the warehouse mirroring a Shopify location.
     *
     * FIRST WRITE ONLY (`dispatchWarehouseId: null` in the where): a later sync
     * must never move the dispatch point of an order that has already been
     * invoiced, or the invoice and the order would disagree about where the
     * goods left from. Silently does nothing when the location is not mirrored
     * as an active warehouse.
     */
    private async stampDispatchWarehouse(
        tx: Prisma.TransactionClient,
        orgId: string,
        orderId: string,
        shopifyLocationId: string,
    ): Promise<void> {
        const warehouse = await tx.warehouse.findFirst({
            where: { organizationId: orgId, shopifyLocationId, isActive: true },
            select: { id: true },
        });
        if (!warehouse) return;

        await tx.order.updateMany({
            where: { id: orderId, organizationId: orgId, dispatchWarehouseId: null },
            data: { dispatchWarehouseId: warehouse.id },
        });
    }

    /**
     * Ask Shopify which location an order is assigned to ship from, and stamp
     * it — the pre-step to auto-invoicing.
     *
     * Shopify assigns fulfilment orders to a location when the order is
     * created, so this is answerable at PAID time, long before anything ships.
     * Costs one lean GraphQL call, and only for orgs that actually mirror
     * Shopify locations as warehouses.
     *
     * NEVER THROWS. A dispatch address is a nicety; the invoice is not. Any
     * failure here is logged and the invoice proceeds without the block.
     */
    private async ensureDispatchWarehouseFromShopify(
        orgId: string,
        orderId: string,
    ): Promise<void> {
        try {
            const order = await this.prisma.order.findFirst({
                where: { id: orderId, organizationId: orgId },
                select: { dispatchWarehouseId: true, externalId: true, channelId: true },
            });
            if (!order || order.dispatchWarehouseId) return;

            // Legacy orgs mirror no locations; skip before spending an API call.
            const mapped = await this.prisma.warehouse.count({
                where: {
                    organizationId: orgId,
                    shopifyLocationId: { not: null },
                    isActive: true,
                },
            });
            if (mapped === 0) return;

            const { token, shopDomain } = await this.shopifyOAuth.getAccessToken(
                order.channelId,
            );
            const res = await this.graphql.request<OrderFulfillmentLocationsResponse>(
                { shopDomain, accessToken: token },
                ORDER_FULFILLMENT_LOCATIONS_QUERY,
                { id: ShopifyGraphqlClient.toGid('Order', order.externalId) },
            );

            const locationId = singleDistinct(
                (res.order?.fulfillmentOrders.nodes ?? [])
                    // A cancelled or closed fulfilment order says nothing about
                    // where this sale actually ships from.
                    .filter((fo) => fo.status !== 'CANCELLED' && fo.status !== 'CLOSED')
                    .map((fo) =>
                        fo.assignedLocation?.location?.id
                            ? ShopifyGraphqlClient.extractId(fo.assignedLocation.location.id)
                            : null,
                    ),
            );
            if (!locationId) return;

            await this.stampDispatchWarehouse(this.prisma, orgId, orderId, locationId);
        } catch (error) {
            this.logger.warn(
                `Could not resolve dispatch warehouse for order ${orderId}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }

    /**
     * Issue a GST invoice for an order that has just been paid, if the org has
     * opted in via `orderSettings.autoInvoiceOnPayment` (default off).
     *
     * Never throws. Two reasons it must not:
     *
     *   1. The webhook controller already wraps every topic in a try/catch that
     *      returns `{ received: true }`, so a throw here would be invisible to
     *      Shopify — no retry, just a lost order ingestion if it propagated far
     *      enough to skip later work.
     *   2. A missing GSTIN or `gstEnabled: false` is a tax-configuration state,
     *      not an ingestion failure. The offline path treats exactly these as a
     *      soft-fail for the same reason (see the `invoiceError` handling in
     *      `OrderService.createOfflineOrder`); breaking order sync over them
     *      would be far worse than the missing document.
     *
     * Redelivery is safe without any extra bookkeeping: `createForOrderTx`
     * rejects a second live invoice for the same order with a
     * ConflictException, and the `invoices_order_id_active_key` partial index
     * backstops the race between two concurrent webhooks.
     */
    private async maybeAutoInvoice(orgId: string, orderId: string): Promise<void> {
        // Delegated so the CRM's own Mark-as-paid and Capture actions issue
        // invoices on exactly the same terms as a webhook — see
        // `InvoiceService.autoInvoiceForPaidOrder`. It never throws.
        await this.invoiceService.autoInvoiceForPaidOrder(orgId, orderId);
    }

    /**
     * The org's GST posture, memoised briefly.
     *
     * `upsertOrder` runs once per order, so without a cache a 60-day backfill
     * would re-read the same registrations for every order on every page. The
     * TTL is short so a GSTIN edit mid-sync is picked up rather than pinned for
     * the life of the process.
     */
    private async gstContext(
        orgId: string,
    ): Promise<{ enabled: boolean; registrations: SellerRegistrations }> {
        const cached = ShopifySyncService.gstContextCache.get(orgId);
        if (cached && cached.expiresAt > Date.now()) return cached.value;
    
        const org = await this.prisma.organization.findUnique({
            where: { id: orgId },
            select: { gstEnabled: true },
        });
    
        const gstins = org?.gstEnabled
            ? await this.prisma.organizationGstin.findMany({
                where: { organizationId: orgId, isActive: true },
                select: { stateCode: true, isDefault: true },
            })
            : [];
    
        const value = {
            enabled: Boolean(org?.gstEnabled),
            registrations: {
                defaultStateCode:
                    gstins.find((g) => g.isDefault)?.stateCode ??
                    gstins[0]?.stateCode ??
                    null,
                stateCodes: gstins.map((g) => g.stateCode),
            },
        };
    
        ShopifySyncService.gstContextCache.set(orgId, {
            value,
            expiresAt: Date.now() + GST_CONTEXT_TTL_MS,
        });
        return value;
    }
    

    /**
     * Write an order's line items, fulfillments and refunds. Split out of
     * `upsertOrder` so the transaction body stays readable; every lookup it
     * needs has already been resolved into the maps it is handed, so it issues
     * writes only.
     *
     * Line items are reconciled — a line removed in Shopify is removed here —
     * under the guards documented at the delete below. Fulfillments and refunds
     * are upsert-only and must stay that way: they arrive capped at 50 with no
     * cursor to page them, so their arrays can never be treated as complete and
     * "delete what's missing" would destroy records beyond the cap. The known,
     * accepted cost is that a shipment cancelled in Shopify lingers locally.
     */
    private async writeOrderChildren(
        tx: Prisma.TransactionClient,
        orderId: string,
        so: any,
        payloadLines: any[],
        maps: {
            variantByExternalId: Map<string, { id: string; product: { vendor: string | null; vendorKey: string | null } | null }>;
            productByExternalId: Map<string, { vendor: string | null; vendorKey: string | null }>;
        },
    ): Promise<void> {
        // Current per-line statuses, read once, so `statusForShippedUnits` can
        // be given a real `previous` and never demote a line the CRM already
        // marked delivered back to merely fulfilled.
        const existingLineStatus = new Map<string, string | null>();
        if (payloadLines.length > 0) {
            const rows = await tx.orderLineItem.findMany({
                where: { orderId },
                select: { externalId: true, fulfillmentStatus: true },
            });
            for (const row of rows) existingLineStatus.set(row.externalId, row.fulfillmentStatus);
        }

        for (const li of payloadLines) {
            const variant = li.variant_id
                ? maps.variantByExternalId.get(String(li.variant_id))
                : undefined;
            // Fallback when the variant is gone, or when it carries no vendor:
            // resolve via the product's external id.
            const product = li.product_id
                ? maps.productByExternalId.get(String(li.product_id))
                : undefined;
            const variantId = variant?.id ?? null;
            const vendor =
                variant?.product?.vendorKey ??
                variant?.product?.vendor ??
                product?.vendorKey ??
                product?.vendor ??
                null;

            // What Shopify says has shipped on this line.
            //
            // Nothing used to write `fulfilledQuantity` on the Shopify path at
            // all, and the pull carries no flat per-line `fulfillment_status`,
            // so an order fulfilled in the Shopify admin landed with every line
            // reading unfulfilled and a zero count. The whole order then showed
            // as outstanding, offered no fulfilment actions, and recomputing
            // the header from those lines flipped it to UNFULFILLED.
            //
            // `fulfillable_quantity` is the units NOT yet shipped, and both
            // ingestion paths now supply it. Absent (an older payload) leaves
            // both fields untouched rather than asserting zero.
            const shipped = shippedFromPayload(li);
            const shipmentPatch =
                shipped === null
                    ? { ...(li.fulfillment_status !== undefined ? { fulfillmentStatus: li.fulfillment_status } : {}) }
                    : {
                        fulfilledQuantity: shipped,
                        fulfillmentStatus: statusForShippedUnits(
                            shipped,
                            li.quantity,
                            existingLineStatus.get(String(li.id)) ?? null,
                        ),
                    };

            await tx.orderLineItem.upsert({
                where: { orderId_externalId: { orderId, externalId: String(li.id) } },
                create: {
                    orderId, variantId, externalId: String(li.id),
                    externalProductId: li.product_id ? String(li.product_id) : null,
                    externalVariantId: li.variant_id ? String(li.variant_id) : null,
                    title: li.title || 'Unknown', variantTitle: li.variant_title, sku: li.sku, vendor,
                    quantity: li.quantity, price: li.price || '0', totalDiscount: li.total_discount || '0',
                    fulfillmentStatus: li.fulfillment_status, requiresShipping: li.requires_shipping ?? true,
                    taxable: li.taxable ?? true, properties: li.properties || null,
                    ...channelTax(li),
                    ...shipmentPatch,
                },
                update: { variantId, vendor, title: li.title || 'Unknown', quantity: li.quantity, price: li.price || '0', totalDiscount: li.total_discount || '0', ...channelTax(li), ...shipmentPatch },
            });
        }

        // H2: drop line items Shopify no longer lists. Without this an item
        // removed from an order in Shopify survives here for ever — order
        // totals stay right (they come from the header) but everything counted
        // FROM items keeps counting it: top-selling products, units sold,
        // sales by category, vendor splits.
        //
        // Three guards, each of which the naive one-liner gets wrong:
        //
        //  1. Only when the payload actually listed something. An empty array
        //     means "no information", not "this order has no items" —
        //     `transformGraphqlOrder` always emits `line_items`, `[]` included,
        //     so an unguarded delete would wipe every item on the first pull
        //     that came back empty.
        //  2. Never at or above LINE_ITEM_RECONCILE_CAP. Shopify does not
        //     document that a webhook payload carries every line of a very
        //     large order (its published tool for oversized payloads,
        //     `include_fields`, only REDUCES what you receive), so completeness
        //     is unproven up there. Below the cap the payload is trustworthy;
        //     at or above it we skip and say so.
        //  3. Deletions are logged. This is the one operation here that can
        //     destroy data, so it should never happen silently.
        //
        // Safe to delete: no foreign key references `order_line_items`, and
        // refund line snapshots are JSON rather than links.
        if (payloadLines.length > 0) {
            if (payloadLines.length >= LINE_ITEM_RECONCILE_CAP) {
                this.logger.warn(
                    `Order ${so.id} arrived with ${payloadLines.length} line items — at or above the ${LINE_ITEM_RECONCILE_CAP} reconcile cap, ` +
                    `so removed lines were NOT pruned (the payload may be truncated).`,
                );
            } else {
                const removed = await tx.orderLineItem.deleteMany({
                    where: {
                        orderId,
                        externalId: { notIn: payloadLines.map((li) => String(li.id)) },
                    },
                });
                if (removed.count > 0) {
                    this.logger.warn(
                        `Removed ${removed.count} line item(s) from order ${so.id} that Shopify no longer lists.`,
                    );
                }
            }
        }

        const incomingFulfilments: any[] = so.fulfillments || [];

        // Which local lines each shipment covers, and what that says shipped.
        //
        // `metadata.lineItemIds` is the ONLY link between a shipment and its
        // lines, and this upsert never wrote it — so on every Shopify-fulfilled
        // order per-line tracking read null and "Add tracking" was rejected
        // outright. The same pass writes back `fulfilledQuantity` /
        // `fulfillmentStatus`, which nothing populated either: the GraphQL pull
        // deliberately omits per-line fulfilment status, so a fully-shipped
        // Shopify order arrived with every line looking unfulfilled.
        //
        // REST/webhook payloads carry `line_items` on each fulfilment for free.
        // The GraphQL pull does not, and asking for it inside the paged orders
        // query would multiply its cost by up to 50x100 nodes per order — those
        // orders are reconciled instead by `resolveFulfillmentForLine`, which
        // already fetches exactly this data. So: only do the work when the
        // payload actually carried it.
        const fulfilmentsWithLines = incomingFulfilments.filter(
            (ff) => Array.isArray(ff.line_items) && ff.line_items.length > 0,
        );
        let lineIdsByFulfilment = new Map<string, string[]>();
        if (fulfilmentsWithLines.length > 0) {
            const localLines = await tx.orderLineItem.findMany({
                where: { orderId },
                select: {
                    id: true, externalId: true, quantity: true,
                    fulfillmentStatus: true, fulfilledQuantity: true,
                },
            });
            const existingRows = await tx.orderFulfillment.findMany({
                where: { orderId },
                select: { externalId: true, metadata: true },
            });
            const existing = new Map<string, string[]>();
            for (const row of existingRows) {
                const ids = (row.metadata as any)?.lineItemIds;
                if (row.externalId && Array.isArray(ids)) {
                    existing.set(row.externalId, ids.filter((x: unknown): x is string => typeof x === 'string'));
                }
            }
            const mapped = mapFulfilmentLines(
                fulfilmentsWithLines.map((ff) => ({
                    externalId: String(ff.id),
                    status: ff.status ?? null,
                    lines: (ff.line_items as any[]).map((fl) => ({
                        shopifyLineId: String(fl.id),
                        quantity: Number(fl.quantity ?? 0),
                    })),
                })),
                localLines,
                existing,
            );
            lineIdsByFulfilment = mapped.lineItemIdsByExternalId;
            for (const patch of mapped.linePatches) {
                await tx.orderLineItem.update({
                    where: { id: patch.id },
                    data: {
                        fulfilledQuantity: patch.fulfilledQuantity,
                        fulfillmentStatus: patch.fulfillmentStatus,
                    },
                });
            }
        }

        // Read the local statuses once so a shipment the CRM marked delivered
        // is not silently reverted to Shopify's `success` — Shopify has no
        // delivered state, so its value carries less information than ours.
        const localStatuses = new Map<string, string>();
        if (incomingFulfilments.length > 0) {
            const rows = await tx.orderFulfillment.findMany({
                where: { orderId },
                select: { externalId: true, status: true },
            });
            for (const row of rows) {
                if (row.externalId) localStatuses.set(row.externalId, row.status);
            }
        }

        for (const ff of incomingFulfilments) {
            const externalId = String(ff.id);
            const incomingStatus = ff.status || 'pending';
            const acceptStatus = shouldAcceptRemoteFulfilmentStatus(
                localStatuses.get(externalId),
                incomingStatus,
            );
            const lineItemIds = lineIdsByFulfilment.get(externalId);
            await tx.orderFulfillment.upsert({
                where: { orderId_externalId: { orderId, externalId } },
                create: {
                    orderId, externalId, status: incomingStatus,
                    trackingNumber: ff.tracking_number, trackingUrl: ff.tracking_url,
                    trackingCompany: ff.tracking_company,
                    shippedAt: ff.created_at ? new Date(ff.created_at) : null,
                    ...(lineItemIds ? { metadata: { lineItemIds } as Prisma.InputJsonValue } : {}),
                },
                update: {
                    ...(acceptStatus ? { status: incomingStatus } : {}),
                    trackingNumber: ff.tracking_number, trackingUrl: ff.tracking_url,
                    trackingCompany: ff.tracking_company,
                    ...(lineItemIds ? { metadata: { lineItemIds } as Prisma.InputJsonValue } : {}),
                },
            });
        }

        for (const rf of so.refunds || []) {
            // Every transaction, not just the first: a split-tender refund
            // (part card, part store credit) was silently understated by the
            // whole second leg. Tax is captured too — without it a refunded
            // sale stayed 100% in declared liability for ever.
            const refund = extractRefundTax(rf);
            const refundTaxPatch = {
                totalTax: refund.totalTax,
                shippingTax: refund.shippingTax,
                taxLines: (refund.taxLines ?? undefined) as Prisma.InputJsonValue | undefined,
                adjustments: (refund.adjustments ?? undefined) as Prisma.InputJsonValue | undefined,
            };
            await tx.orderRefund.upsert({
                where: { orderId_externalId: { orderId, externalId: String(rf.id) } },
                create: { orderId, externalId: String(rf.id), amount: refund.amount, currency: so.currency || 'USD', reason: rf.note, note: rf.note, lineItems: rf.refund_line_items || null, processedAt: rf.processed_at ? new Date(rf.processed_at) : null, ...refundTaxPatch },
                update: { amount: refund.amount, note: rf.note, lineItems: rf.refund_line_items || null, ...refundTaxPatch },
            });
        }
    }

    /**
     * Persist a standalone `refunds/create` payload.
     *
     * Refund rows could already be written, but only when refund data happened
     * to ride along inside an order payload — there was no subscription, so a
     * refund issued in Shopify admin reached us only if Shopify also sent
     * `orders/updated`. Storage only: revenue aggregates stay gross for now.
     *
     * Idempotent via the `(orderId, externalId)` unique, so a redelivery is a
     * no-op. Uses the same shape as the refund write in `writeOrderChildren`
     * so the two paths cannot drift.
     */
    async upsertRefund(channelId: string, refund: any): Promise<void> {
        const orderExternalId = refund?.order_id ? String(refund.order_id) : null;
        if (!orderExternalId || !refund?.id) {
            this.logger.warn('refunds/create payload had no order_id or id — skipping.');
            return;
        }

        const order = await this.prisma.order.findUnique({
            where: { channelId_externalId: { channelId, externalId: orderExternalId } },
            select: { id: true, currency: true },
        });
        if (!order) {
            // The parent order may simply not be synced yet; `upsertOrder`
            // picks the refund up from the order payload when it arrives.
            this.logger.warn(
                `refunds/create for order ${orderExternalId}, which is not synced on channel ${channelId} — skipping.`,
            );
            return;
        }

        // Same fix as the order-payload path: sum every settled transaction
        // and carry the tax split.
        const extracted = extractRefundTax(refund);
        const amount = extracted.amount;
        const refundTaxPatch = {
            totalTax: extracted.totalTax,
            shippingTax: extracted.shippingTax,
            taxLines: (extracted.taxLines ?? undefined) as Prisma.InputJsonValue | undefined,
            adjustments: (extracted.adjustments ?? undefined) as Prisma.InputJsonValue | undefined,
        };

        // Is this refund new to us? Decides whether a timeline entry is written.
        // `refunds/create` is redelivered on failure, and the full sync re-reads
        // every refund on every run, so writing unconditionally would append a
        // duplicate 'refunded' entry each time.
        const alreadyRecorded = await this.prisma.orderRefund.findUnique({
            where: { orderId_externalId: { orderId: order.id, externalId: String(refund.id) } },
            select: { id: true },
        });

        await this.prisma.$transaction(async (tx) => {
            await tx.orderRefund.upsert({
                where: { orderId_externalId: { orderId: order.id, externalId: String(refund.id) } },
                create: {
                    orderId: order.id, externalId: String(refund.id), amount,
                    currency: order.currency, reason: refund.note, note: refund.note,
                    lineItems: refund.refund_line_items ?? null,
                    processedAt: refund.processed_at ? new Date(refund.processed_at) : null,
                    ...refundTaxPatch,
                },
                update: { amount, note: refund.note, lineItems: refund.refund_line_items ?? null, ...refundTaxPatch },
            });

            if (!alreadyRecorded) {
                // 'refunded' is named in the OrderTimelineEvent schema comment but
                // nothing had ever written it — refunds are read-only inbound.
                await tx.orderTimelineEvent.create({
                    data: {
                        orderId: order.id,
                        actorId: null,
                        action: 'refunded',
                        message:
                            `Refund of ${amount} ${order.currency} processed in Shopify` +
                            (refund.note ? `: ${refund.note}` : ''),
                        metadata: {
                            source: 'shopify',
                            refundExternalId: String(refund.id),
                            amount,
                        } as Prisma.InputJsonValue,
                        createdAt: refund.processed_at
                            ? new Date(refund.processed_at)
                            : new Date(),
                    },
                });
            }
        });
        this.logger.log(`Recorded refund ${refund.id} on order ${orderExternalId}.`);
    }

    /**
     * Upsert a Shopify DraftOrder payload (webhook or one-shot fetch) into
     * our DraftOrder table. Idempotent — keyed by (channelId, externalId).
     * Line item snapshots are rebuilt on every upsert; the previous set is
     * deleted first.
     *
     * Only fields we read from Shopify are written; CRM-only fields
     * (placeOfSupplyCode, completedOrderId, etc.) are preserved.
     */
    async upsertDraftOrder(channelId: string, orgId: string, sd: any) {
        const externalId = String(sd.id);

        // Resolve customer (if any). Shopify drafts use the same Customer
        // resource — match by externalId on the same channel.
        let customerId: string | null = null;
        if (sd.customer?.id) {
            const customer = await this.prisma.customer.findFirst({
                where: { channelId, externalId: String(sd.customer.id) },
                select: { id: true },
            });
            customerId = customer?.id ?? null;
        }

        const tags = Array.isArray(sd.tags)
            ? sd.tags
            : sd.tags
                ? sd.tags.split(',').map((t: string) => t.trim()).filter(Boolean)
                : [];

        // Map Shopify status enum strings to ours. "open" → OPEN,
        // "invoice_sent" → INVOICE_SENT, "completed" → COMPLETED. Default to OPEN.
        const statusMap: Record<string, 'OPEN' | 'INVOICE_SENT' | 'COMPLETED'> = {
            open: 'OPEN',
            invoice_sent: 'INVOICE_SENT',
            completed: 'COMPLETED',
        };
        const status =
            (statusMap[sd.status?.toLowerCase?.() as string] ?? 'OPEN') as
                | 'OPEN'
                | 'INVOICE_SENT'
                | 'COMPLETED';

        // Find the local row (if any) so we don't reset fields the merchant
        // already filled (e.g. completedOrderId set by our completion flow).
        const existing = await this.prisma.draftOrder.findUnique({
            where: { channelId_externalId: { channelId, externalId } },
            select: { id: true },
        });

        const shared = {
            customerId,
            customerEmail: sd.email ?? null,
            name: sd.name ?? null,
            status,
            currency: sd.currency || 'USD',
            subtotalPrice: sd.subtotal_price || '0',
            totalPrice: sd.total_price || '0',
            totalTax: sd.total_tax || '0',
            totalDiscounts: sd.total_discounts || '0',
            totalShippingPrice:
                sd.shipping_line?.price ?? sd.total_shipping_price ?? '0',
            // Carried so draft completion can hand them to the real order.
            // Without these a Shopify-mirrored draft completes into an order
            // with no address, which leaves the GST invoice's buyer address
            // blank and drops the delivery state out of place-of-supply
            // resolution (so an interstate order is taxed CGST+SGST).
            shippingAddress: sd.shipping_address ?? null,
            billingAddress: sd.billing_address ?? null,
            note: sd.note ?? null,
            tags,
            invoiceUrl: sd.invoice_url ?? null,
            invoiceSentAt: sd.invoice_sent_at
                ? new Date(sd.invoice_sent_at)
                : null,
            completedAt: sd.completed_at ? new Date(sd.completed_at) : null,
            externalUpdatedAt: sd.updated_at ? new Date(sd.updated_at) : new Date(),
        };

        const draft = existing
            ? await this.prisma.draftOrder.update({
                  where: { id: existing.id },
                  data: shared,
              })
            : await this.prisma.draftOrder.create({
                  data: {
                      organizationId: orgId,
                      channelId,
                      externalId,
                      externalCreatedAt: sd.created_at
                          ? new Date(sd.created_at)
                          : new Date(),
                      ...shared,
                  },
              });

        // Rebuild line items from the webhook payload. Shopify line items
        // have stable ids per-draft, so deleting + re-creating is safe.
        await this.prisma.draftOrderLineItem.deleteMany({
            where: { draftOrderId: draft.id },
        });
        if (Array.isArray(sd.line_items) && sd.line_items.length > 0) {
            for (const li of sd.line_items) {
                let variantId: string | null = null;
                if (li.variant_id) {
                    const variant = await this.prisma.productVariant.findFirst({
                        where: {
                            externalId: String(li.variant_id),
                            product: { channelId },
                        },
                        select: { id: true },
                    });
                    variantId = variant?.id ?? null;
                }
                await this.prisma.draftOrderLineItem.create({
                    data: {
                        draftOrderId: draft.id,
                        variantId,
                        externalId: li.id ? String(li.id) : null,
                        title: li.title || 'Unknown',
                        variantTitle: li.variant_title ?? null,
                        sku: li.sku ?? null,
                        quantity: li.quantity ?? 1,
                        price: li.price || '0',
                        totalDiscount: li.total_discount || '0',
                        taxable: li.taxable ?? true,
                        requiresShipping: li.requires_shipping ?? true,
                    },
                });
            }
        }

        return draft;
    }

    async upsertCustomer(channelId: string, orgId: string, sc: any) {
        const externalId = String(sc.id);
        const tags = sc.tags ? sc.tags.split(',').map((t: string) => t.trim()).filter(Boolean) : [];

        const updateFields = {
            email: sc.email, firstName: sc.first_name, lastName: sc.last_name, phone: sc.phone,
            state: this.mapCustomerState(sc.state), verifiedEmail: sc.verified_email ?? false,
            acceptsMarketing: sc.accepts_marketing ?? false,
            tags, note: sc.note,
            addresses: sc.addresses || null, defaultAddress: sc.default_address || null,
            externalUpdatedAt: sc.updated_at ? new Date(sc.updated_at) : null,
            // NOTE: ordersCount / totalSpent are deliberately NOT written from
            // sc.orders_count / sc.total_spent. Those figures describe Shopify
            // orders only, so writing them wholesale wiped every in-store
            // purchase for a customer who shops on both channels. Both fields
            // are derived from the local order table by
            // LoyaltyService.recomputeForCustomer, called at the end of this
            // method — which also assigns vipLevel from the org thresholds.
            // internalNotes, segments are still NOT overwritten (CRM-only fields).
        };

        let customer: { id: string };
        try {
            customer = await this.prisma.customer.upsert({
                where: { channelId_externalId: { channelId, externalId } },
                create: {
                    organizationId: orgId, channelId, externalId,
                    ...updateFields,
                    externalCreatedAt: sc.created_at ? new Date(sc.created_at) : null,
                },
                update: updateFields,
                select: { id: true },
            });
        } catch (err) {
            // Customer also has a unique (organizationId, email). A row with
            // this email can already exist under a DIFFERENT (channel,
            // externalId) identity — e.g. the store was reconnected as a new
            // channel, or Shopify holds two customer records sharing an email
            // (guest checkout / merged accounts). Adopt that row: re-point it
            // to the current identity and update its fields, preserving all
            // CRM-side data attached to it.
            if (
                err instanceof Prisma.PrismaClientKnownRequestError &&
                err.code === 'P2002' &&
                sc.email
            ) {
                const existing = await this.prisma.customer.findFirst({
                    where: { organizationId: orgId, email: sc.email },
                    select: { id: true },
                });
                if (!existing) throw err;
                customer = await this.prisma.customer.update({
                    where: { id: existing.id },
                    data: { channelId, externalId, ...updateFields },
                    select: { id: true },
                });
                this.logger.log(
                    `Customer ${externalId} adopted existing row ${existing.id} by email match`,
                );
            } else {
                throw err;
            }
        }

        // Auto-tier the customer against the org's loyalty thresholds.
        // Failures here must not fail the whole customer sync.
        await this.loyalty.recomputeForCustomer(customer.id, orgId).catch((err) => {
            this.logger.warn(`Loyalty recompute failed for customer ${customer.id}: ${err?.message ?? err}`);
        });
    }

    private async upsertCollection(channelId: string, orgId: string, col: any, collectionType: string) {
        const externalId = String(col.id);
        await this.prisma.collection.upsert({
            where: { channelId_externalId: { channelId, externalId } },
            create: {
                organizationId: orgId, channelId, externalId,
                title: col.title, handle: col.handle, collectionType,
                sortOrder: col.sort_order,
                publishedAt: col.published_at ? new Date(col.published_at) : null,
            },
            update: {
                title: col.title, handle: col.handle,
                sortOrder: col.sort_order,
                publishedAt: col.published_at ? new Date(col.published_at) : null,
            },
        });
    }

    // ─── COUNT HELPER ───
    // Informational only — drives the totalEstimated progress UI. A failed
    // count must never fail the sync (some shops/plans gate count fields).
    private async updateTotalEstimated(
        logId: string,
        getAuth: ShopifyAuthResolver,
        query: string,
        field: 'productsCount' | 'customersCount' | 'ordersCount',
    ): Promise<void> {
        try {
            const res = await this.graphql.request<Record<string, { count: number } | null>>(await getAuth(), query);
            await this.prisma.syncLog.update({
                where: { id: logId },
                data: { totalEstimated: res?.[field]?.count ?? 0 },
            });
        } catch (err) {
            this.logger.warn(
                `Count query ${field} failed (non-fatal): ${err instanceof Error ? err.message : err}`,
            );
        }
    }

    // ─── VENDOR METAFIELD (multi-vendor routing) ───

    /** Per-org vendor metafield config, or null when the feature is disabled. */
    private async getVendorMetafieldConfig(
        orgId: string,
    ): Promise<{ namespace: string; key: string } | null> {
        const row = await this.prisma.organizationSettings.findUnique({
            where: { organizationId: orgId },
            select: { productSettings: true },
        });
        const ps = parseProductSettings(row?.productSettings ?? null);
        if (!ps.vendorMetafieldEnabled) return null;
        return { namespace: ps.vendorMetafieldNamespace, key: ps.vendorMetafieldKey };
    }

    /**
     * A credentials getter bound to one channel.
     *
     * Cheap on the happy path: `getAccessToken` is one indexed read plus a
     * decrypt while the token still has >2 minutes of life, and only then does
     * it hit Shopify to refresh (Redis-locked and double-checked, so concurrent
     * workers do not race the rotating refresh token). Calling it per request
     * therefore costs almost nothing and is what lets a backfill outlive the
     * one-hour token lifetime.
     */
    private authResolver(channelId: string): ShopifyAuthResolver {
        return async () => {
            const { token, shopDomain } = await this.shopifyOAuth.getAccessToken(channelId);
            return { shopDomain, accessToken: token };
        };
    }

    // ─── PER-ENTITY SYNC STATE ───
    //
    // The sync filter used to come from a single channel-level watermark
    // (`Channel.lastSyncedAt`), and only orders consulted it. Two consequences,
    // both of which showed up as rate-limit failures on large stores:
    //
    //   * products / customers / inventory / collections had NO filter, so
    //     every run refetched the entire catalogue and customer list;
    //   * `lastSyncedAt` only advanced when EVERY entity succeeded, so a
    //     failing orders sync meant orders stayed a full-history scan forever
    //     AND each of BullMQ's retries rescanned everything else from page 1.
    //
    // Each entity now owns its watermark, stamped the moment that entity
    // succeeds, so a retry costs almost nothing for the parts that already
    // finished.

    /**
     * The Shopify search filter for this entity's next pull, or null for
     * "everything".
     *
     * Incremental runs filter on `updated_at` rather than `created_at` on
     * purpose: an order edited today must arrive even if it was placed long
     * before the backfill window.
     */
    private async resolveEntityQuery(
        channelId: string,
        entityType: string,
    ): Promise<string | null> {
        // Never let missing bookkeeping fail a sync. If the table is not there
        // yet (code deployed ahead of its migration), fall through to the
        // first-backfill behaviour: more work, but never missing data.
        let state: { backfillDone: boolean; watermark: Date | null } | null = null;
        try {
            state = await this.prisma.channelSyncState.findUnique({
                where: {
                    channelId_direction_entityType: {
                        channelId,
                        direction: 'pull',
                        entityType,
                    },
                },
                select: { backfillDone: true, watermark: true },
            });
        } catch (err) {
            this.logger.error(
                `Could not read the ${entityType} sync state for channel ${channelId} - ` +
                'falling back to a full backfill for this run.',
                err instanceof Error ? err.stack : err,
            );
        }

        if (state?.backfillDone && state.watermark) {
            return `updated_at:>='${state.watermark.toISOString()}'`;
        }

        // First backfill. ONLY orders is windowed: the catalogue has to be
        // complete for products and inventory to be usable at all, and those
        // queries carry no nested fan-out so a full pull is cheap. Customers is
        // likewise unwindowed — `upsertOrder` already creates a stub row for
        // anyone on a synced order, so a merchant who finds it slow can simply
        // turn the customers pull off.
        if (entityType === 'orders') {
            const days = this.initialOrderWindowDays();
            const floor = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
            return `created_at:>='${floor.toISOString()}'`;
        }
        return null;
    }

    private initialOrderWindowDays(): number {
        const raw = this.config.get<number>('shopify.initialOrderWindowDays');
        return Number.isFinite(raw) && (raw as number) > 0 ? (raw as number) : 60;
    }

    /**
     * Record that this entity finished cleanly.
     *
     * `watermark` is the run's START time (already rewound by
     * SYNC_WATERMARK_SKEW_MS), not its end: Shopify stamps `updated_at` with
     * its own clock, and anything edited while the run was in flight must be
     * re-covered by the next one rather than silently skipped.
     */
    private async markEntitySynced(
        channelId: string,
        entityType: string,
        watermark: Date,
    ): Promise<void> {
        const windowStart =
            entityType === 'orders'
                ? new Date(Date.now() - this.initialOrderWindowDays() * 24 * 60 * 60 * 1000)
                : null;
        try {
            await this.prisma.channelSyncState.upsert({
                where: {
                    channelId_direction_entityType: {
                        channelId,
                        direction: 'pull',
                        entityType,
                    },
                },
                create: {
                    channelId,
                    direction: 'pull',
                    entityType,
                    watermark,
                    backfillDone: true,
                    windowStart,
                },
                // `windowStart` records the floor the FIRST backfill used, so
                // it is deliberately not overwritten on later runs.
                update: { watermark, backfillDone: true },
            });
        } catch (err) {
            // Never let bookkeeping fail a sync that actually succeeded — the
            // worst case is the next run redoing work, not losing data.
            this.logger.error(
                `Could not stamp the ${entityType} watermark for channel ${channelId}`,
                err instanceof Error ? err.stack : err,
            );
        }
    }

    /**
     * Entity types the merchant has NOT switched off for this direction.
     *
     * Read as "enabled unless a row says otherwise" so channels that predate
     * the toggles — and any entity a merchant has never touched — keep syncing
     * exactly as they do today without needing rows seeded for them.
     */
    private async enabledEntities(
        channelId: string,
        direction: 'pull' | 'push',
    ): Promise<Set<string>> {
        const known: readonly string[] =
            direction === 'pull' ? PULL_ENTITY_TYPES : PUSH_ENTITY_TYPES;
        try {
            const rows = await this.prisma.channelSyncState.findMany({
                where: { channelId, direction, enabled: false },
                select: { entityType: true },
            });
            const disabled = new Set(rows.map((r) => r.entityType));
            return new Set(known.filter((e) => !disabled.has(e)));
        } catch (err) {
            this.logger.error(
                `Could not read ${direction} sync toggles for channel ${channelId} — assuming all enabled`,
                err instanceof Error ? err.stack : err,
            );
            return new Set(known);
        }
    }

    // ─── SYNC LOG HELPERS ───
    /**
     * Open (or reopen) the log this sync will checkpoint into.
     *
     * Two defects used to live here, mirror images of one another:
     *
     *  - `failSyncLog` deliberately preserves the pagination cursor, but this
     *    lookup only matched `IN_PROGRESS`, so a FAILED log was invisible and
     *    its cursor unreachable. Every retry restarted at page 1 — three times
     *    per trigger, given `attempts: 3` — so a large store failing near the
     *    end could never finish.
     *  - Conversely a crashed process leaves a log pinned at `IN_PROGRESS`
     *    for ever, and that one WAS resumed, with no age check, potentially
     *    days later against a cursor Shopify has long since expired.
     *
     * So: resume only what is genuinely resumable — recent, and holding a
     * cursor — and retire anything stale instead of resurrecting it.
     */
    private async createSyncLog(channelId: string, orgId: string, entityType: string) {
        const cutoff = new Date(Date.now() - SYNC_RESUME_MAX_AGE_MS);
        const candidate = await this.prisma.syncLog.findFirst({
            where: {
                channelId,
                entityType,
                status: { in: [SyncStatus.IN_PROGRESS, SyncStatus.FAILED] },
            },
            orderBy: { createdAt: 'desc' },
        });

        if (candidate) {
            const resumable = candidate.startedAt > cutoff && !!candidate.cursor;
            if (resumable) {
                if (candidate.status === SyncStatus.FAILED) {
                    // Reopen it so progress reporting stays coherent while the
                    // retry walks on from the saved cursor.
                    const reopened = await this.prisma.syncLog.update({
                        where: { id: candidate.id },
                        data: { status: SyncStatus.IN_PROGRESS, completedAt: null, errorMessage: null },
                    });
                    this.logger.log(
                        `Resuming ${entityType} sync for channel ${channelId} from the cursor saved by its failed run.`,
                    );
                    return reopened;
                }
                return candidate;
            }

            if (candidate.status === SyncStatus.IN_PROGRESS) {
                // Stale and pinned: retire it so it stops being picked up, and
                // so the channel-level guard can tell dead from live.
                await this.prisma.syncLog.update({
                    where: { id: candidate.id },
                    data: {
                        status: SyncStatus.FAILED,
                        completedAt: new Date(),
                        errorMessage:
                            candidate.errorMessage ??
                            'Abandoned: still marked in progress when a later sync started (process likely died mid-run).',
                    },
                });
                this.logger.warn(
                    `Retired a stale IN_PROGRESS ${entityType} sync log for channel ${channelId} (started ${candidate.startedAt.toISOString()}).`,
                );
            }
        }

        return this.prisma.syncLog.create({ data: { organizationId: orgId, channelId, entityType, status: SyncStatus.IN_PROGRESS, startedAt: new Date() } });
    }

    private async completeSyncLog(logId: string, processed: number, failed: number) {
        await this.prisma.syncLog.update({ where: { id: logId }, data: { status: SyncStatus.COMPLETED, recordsProcessed: processed, recordsFailed: failed, cursor: null, completedAt: new Date() } });
    }

    private async failSyncLog(logId: string, processed: number, failed: number, error: unknown) {
        await this.prisma.syncLog.update({ where: { id: logId }, data: { status: SyncStatus.FAILED, recordsProcessed: processed, recordsFailed: failed, errorMessage: error instanceof Error ? error.message : String(error), completedAt: new Date() } });
    }

    // ─── ENUM MAPPERS ───
    private mapProductStatus(s: string): ProductStatus { return ({ active: 'ACTIVE', draft: 'DRAFT', archived: 'ARCHIVED' } as any)[s] || 'ACTIVE'; }
    private mapFinancialStatus(s: string): OrderFinancialStatus { return ({ pending: 'PENDING', authorized: 'AUTHORIZED', partially_paid: 'PARTIALLY_PAID', paid: 'PAID', partially_refunded: 'PARTIALLY_REFUNDED', refunded: 'REFUNDED', voided: 'VOIDED' } as any)[s] || 'PENDING'; }
    private mapFulfillmentStatus(s: string | null): OrderFulfillmentStatus { if (!s) return 'UNFULFILLED'; return ({ fulfilled: 'FULFILLED', partial: 'PARTIAL', restocked: 'RESTOCKED' } as any)[s] || 'UNFULFILLED'; }
    private mapCancelReason(s: string | null): OrderCancelReason | null { if (!s) return null; return ({ customer: 'CUSTOMER', fraud: 'FRAUD', inventory: 'INVENTORY', declined: 'DECLINED', other: 'OTHER' } as any)[s] || 'OTHER'; }
    private mapCustomerState(s: string): CustomerState { return ({ enabled: 'ENABLED', disabled: 'DISABLED', declined: 'DECLINED', invited: 'INVITED' } as any)[s] || 'ENABLED'; }

}