import { Injectable, Logger } from '@nestjs/common';
import {
    ChannelPlatform,
    ChannelStatus,
    SyncStatus,
    ProductStatus,
    OrderFinancialStatus,
    OrderFulfillmentStatus,
    OrderCancelReason,
    CustomerState,
} from '@prisma/client';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { ShopifyOAuthService } from './shopify-oauth.service';
import { LoyaltyService } from '../loyalty/loyalty.service';
import { ShopifyGraphqlClient } from './shopify-graphql.client';
import { ShopifyPushEnqueuer } from './shopify-push.enqueuer';
import {
    DRAFT_MIRROR_QUEUE,
    DraftMirrorJobData,
} from '../draft-order/draft-mirror.queue';
import {
    MailingAddress,
    OrdersListResponse,
    OrdersListVariables,
    OrderNode,
    ORDERS_LIST_QUERY,
} from './shopify-graphql.types';
import { parseProductSettings } from '../organization-settings/schemas/product-settings.schema';

const PAGE_LIMIT = 250;
const GRAPHQL_PAGE_SIZE = 50;

@Injectable()
export class ShopifySyncService {
    private readonly logger = new Logger(ShopifySyncService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly shopifyOAuth: ShopifyOAuthService,
        private readonly loyalty: LoyaltyService,
        private readonly graphql: ShopifyGraphqlClient,
        private readonly pushEnqueuer: ShopifyPushEnqueuer,
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
            try {
                await this.pushEnqueuer.enqueueBulkProductPush({
                    type: 'bulk-products',
                    organizationId: orgId,
                });
                await this.pushEnqueuer.enqueueBulkOrderPush({
                    type: 'bulk-orders',
                    organizationId: orgId,
                });
                await this.enqueueDraftBulkMirror(orgId);
            } catch (err) {
                this.logger.warn(
                    `Failed to enqueue bulk push for org ${orgId}: ${err}`,
                );
            }
            return;
        }

        // Mark as syncing
        await this.prisma.channel.update({
            where: { id: channelId },
            data: { syncStatus: SyncStatus.IN_PROGRESS, status: ChannelStatus.SYNCING },
        });

        let allSucceeded = true;
        let initError: Error | null = null;
        let token: string | null = null;
        let shopDomain: string | null = null;

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
                for (const entityType of entityTypes) {
                    try {
                        switch (entityType) {
                            case 'products':
                                await this.syncProducts(channelId, orgId, shopDomain, token);
                                break;
                            case 'orders':
                                await this.syncOrders(channelId, orgId, shopDomain, token);
                                break;
                            case 'customers':
                                await this.syncCustomers(channelId, orgId, shopDomain, token);
                                break;
                            case 'inventory':
                                await this.syncInventory(channelId, orgId, shopDomain, token);
                                break;
                            case 'collections':
                                await this.syncCollections(channelId, orgId, shopDomain, token);
                                break;
                        }
                    } catch (error) {
                        allSucceeded = false;
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
                    status: allSucceeded ? ChannelStatus.CONNECTED : ChannelStatus.ERROR,
                    lastSyncedAt: allSucceeded ? new Date() : undefined,
                },
            }).catch((err) => {
                this.logger.error(
                    `Failed to clear syncStatus for channel ${channelId} (manual unstick may be needed)`,
                    err,
                );
            });
        }

        // After the pull completes (regardless of partial failures), kick off
        // bulk-push jobs for any locally-unsynced products and offline orders.
        // This is what makes the channels-page Sync button "sync everything in
        // both directions" with one click. Jobs are queued asynchronously —
        // failures here don't fail the user's sync request.
        try {
            await this.pushEnqueuer.enqueueBulkProductPush({
                type: 'bulk-products',
                organizationId: orgId,
            });
            await this.pushEnqueuer.enqueueBulkOrderPush({
                type: 'bulk-orders',
                organizationId: orgId,
            });
            await this.enqueueDraftBulkMirror(orgId);
        } catch (err) {
            this.logger.warn(
                `Failed to enqueue post-sync bulk push for org ${orgId}: ${err}`,
            );
        }

        // Surface the initial-credential error preferentially so the BullMQ
        // failure log shows the underlying cause, not a generic "syncs failed".
        if (initError) throw initError;
        if (!allSucceeded) throw new Error('One or more entity syncs failed');
    }

    // ─── SYNC PRODUCTS ───
    private async syncProducts(channelId: string, orgId: string, shopDomain: string, token: string) {
        const syncLog = await this.createSyncLog(channelId, orgId, 'products');
        let processed = 0;
        let failed = 0;

        try {
            const countRes = await this.shopifyFetch(shopDomain, token, '/products/count.json');
            await this.prisma.syncLog.update({ where: { id: syncLog.id }, data: { totalEstimated: countRes?.count ?? 0 } });

            const vendorMetafield = await this.getVendorMetafieldConfig(orgId);
            for await (const page of this.paginatedFetch(shopDomain, token, '/products.json', 'products', syncLog.cursor)) {
                for (const sp of page.data) {
                    try {
                        const vendorKey = await this.resolveVendorKey(sp, vendorMetafield, shopDomain, token);
                        await this.upsertProduct(channelId, orgId, sp, vendorKey);
                        processed++;
                    } catch (error) {
                        failed++;
                        this.logger.error(`Failed product ${sp.id}`, error);
                    }
                }
                await this.prisma.syncLog.update({
                    where: { id: syncLog.id },
                    data: { recordsProcessed: processed, recordsFailed: failed, cursor: page.nextCursor },
                });
            }
            await this.completeSyncLog(syncLog.id, processed, failed);
        } catch (error) {
            await this.failSyncLog(syncLog.id, processed, failed, error);
            throw error;
        }
    }

    // ─── SYNC ORDERS ───
    // Reads orders via the Shopify Admin GraphQL API (Phase 0 migration).
    // The downstream `upsertOrder` still consumes the REST snake_case shape, so
    // `transformGraphqlOrder` bridges the two — one place to maintain.
    // Note: if an existing syncLog has a REST `page_info` cursor from before
    // this migration, the next run will re-start that entity from the
    // beginning. Cursors are opaque per-API so we can't translate.
    private async syncOrders(channelId: string, orgId: string, shopDomain: string, token: string) {
        const syncLog = await this.createSyncLog(channelId, orgId, 'orders');
        let processed = 0;
        let failed = 0;

        try {
            // Count remains REST — GraphQL has no equivalent cheap count call.
            // This is informational only (drives the totalEstimated progress UI).
            const countRes = await this.shopifyFetch(shopDomain, token, '/orders/count.json?status=any');
            await this.prisma.syncLog.update({ where: { id: syncLog.id }, data: { totalEstimated: countRes?.count ?? 0 } });

            const channel = await this.prisma.channel.findUnique({ where: { id: channelId } });
            const filters: string[] = [];
            if (channel?.lastSyncedAt) {
                filters.push(`updated_at:>='${channel.lastSyncedAt.toISOString()}'`);
            }
            const queryString = filters.length > 0 ? filters.join(' ') : null;

            const auth = { shopDomain, accessToken: token };
            for await (const page of this.paginateOrdersGraphql(auth, syncLog.cursor, queryString)) {
                for (const node of page.orders) {
                    try {
                        const so = this.transformGraphqlOrder(node);
                        await this.upsertOrder(channelId, orgId, so);
                        processed++;
                    } catch (error) {
                        failed++;
                        this.logger.error(`Failed order ${node.id}`, error);
                    }
                }
                await this.prisma.syncLog.update({
                    where: { id: syncLog.id },
                    data: { recordsProcessed: processed, recordsFailed: failed, cursor: page.nextCursor },
                });
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
        auth: { shopDomain: string; accessToken: string },
        startCursor: string | null,
        queryString: string | null,
    ): AsyncGenerator<{ orders: OrderNode[]; nextCursor: string | null }> {
        let cursor: string | null = startCursor ?? null;
        do {
            const variables: OrdersListVariables = {
                first: GRAPHQL_PAGE_SIZE,
                after: cursor,
                query: queryString,
                sortKey: 'UPDATED_AT',
                reverse: false,
            };
            const res = await this.graphql.request<OrdersListResponse, OrdersListVariables>(
                auth,
                ORDERS_LIST_QUERY,
                variables,
            );
            const nextCursor = res.orders.pageInfo.hasNextPage
                ? res.orders.pageInfo.endCursor
                : null;
            yield { orders: res.orders.nodes, nextCursor };
            cursor = nextCursor;
        } while (cursor);
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
            // `fulfillment_status` is intentionally omitted — GraphQL OrderLineItem
            // has no flat equivalent; leaving it `undefined` means the upsert
            // preserves any prior value rather than overwriting with null.
            requires_shipping: li.requiresShipping,
            taxable: li.taxable,
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

        const refunds = node.refunds.map((rf) => ({
            id: ShopifyGraphqlClient.extractId(rf.id),
            note: rf.note,
            processed_at: rf.createdAt,
            refund_line_items: rf.refundLineItems?.nodes?.map((rli) => ({
                id: ShopifyGraphqlClient.extractId(rli.id),
                quantity: rli.quantity,
                line_item_id: ShopifyGraphqlClient.extractId(rli.lineItem.id),
                restock_type: rli.restockType,
            })) ?? null,
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
            total_discounts: node.totalDiscountsSet?.shopMoney?.amount ?? '0',
            total_shipping_price_set: {
                shop_money: {
                    amount: node.totalShippingPriceSet?.shopMoney?.amount ?? '0',
                    currency_code:
                        node.totalShippingPriceSet?.shopMoney?.currencyCode ?? node.currencyCode,
                },
            },
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
    private async syncCustomers(channelId: string, orgId: string, shopDomain: string, token: string) {
        const syncLog = await this.createSyncLog(channelId, orgId, 'customers');
        let processed = 0;
        let failed = 0;

        try {
            const countRes = await this.shopifyFetch(shopDomain, token, '/customers/count.json');
            await this.prisma.syncLog.update({ where: { id: syncLog.id }, data: { totalEstimated: countRes?.count ?? 0 } });

            for await (const page of this.paginatedFetch(shopDomain, token, '/customers.json', 'customers', syncLog.cursor)) {
                for (const sc of page.data) {
                    try {
                        await this.upsertCustomer(channelId, orgId, sc);
                        processed++;
                    } catch (error) {
                        failed++;
                        this.logger.error(`Failed customer ${sc.id}`, error);
                    }
                }
                await this.prisma.syncLog.update({
                    where: { id: syncLog.id },
                    data: { recordsProcessed: processed, recordsFailed: failed, cursor: page.nextCursor },
                });
            }
            await this.completeSyncLog(syncLog.id, processed, failed);
        } catch (error) {
            await this.failSyncLog(syncLog.id, processed, failed, error);
            throw error;
        }
    }

    // ─── SYNC INVENTORY ───
    private async syncInventory(channelId: string, orgId: string, shopDomain: string, token: string) {
        const syncLog = await this.createSyncLog(channelId, orgId, 'inventory');
        let processed = 0;
        let failed = 0;

        try {
            for await (const page of this.paginatedFetch(shopDomain, token, '/products.json', 'products', syncLog.cursor, { fields: 'id,variants' })) {
                for (const product of page.data) {
                    for (const variant of product.variants || []) {
                        try {
                            const existing = await this.prisma.productVariant.findFirst({
                                where: { externalId: String(variant.id), product: { channelId } },
                            });
                            if (existing && existing.inventoryQuantity !== variant.inventory_quantity) {
                                await this.prisma.$transaction([
                                    this.prisma.productVariant.update({
                                        where: { id: existing.id },
                                        data: { inventoryQuantity: variant.inventory_quantity },
                                    }),
                                    this.prisma.inventoryEvent.create({
                                        data: {
                                            organizationId: orgId, variantId: existing.id,
                                            quantityBefore: existing.inventoryQuantity,
                                            quantityAfter: variant.inventory_quantity,
                                            changeAmount: variant.inventory_quantity - existing.inventoryQuantity,
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
                await this.prisma.syncLog.update({
                    where: { id: syncLog.id },
                    data: { recordsProcessed: processed, recordsFailed: failed, cursor: page.nextCursor },
                });
            }
            await this.completeSyncLog(syncLog.id, processed, failed);
        } catch (error) {
            await this.failSyncLog(syncLog.id, processed, failed, error);
            throw error;
        }
    }

    // ─── SYNC COLLECTIONS ───
    private async syncCollections(channelId: string, orgId: string, shopDomain: string, token: string) {
        const syncLog = await this.createSyncLog(channelId, orgId, 'collections');
        let processed = 0;
        let failed = 0;

        try {
            // 1. Sync custom collections
            for await (const page of this.paginatedFetch(shopDomain, token, '/custom_collections.json', 'custom_collections', syncLog.cursor)) {
                for (const col of page.data) {
                    try {
                        await this.upsertCollection(channelId, orgId, col, 'custom');
                        processed++;
                    } catch (error) {
                        failed++;
                        this.logger.error(`Failed custom collection ${col.id}`, error);
                    }
                }
            }

            // 2. Sync smart collections
            for await (const page of this.paginatedFetch(shopDomain, token, '/smart_collections.json', 'smart_collections', null)) {
                for (const col of page.data) {
                    try {
                        await this.upsertCollection(channelId, orgId, col, 'smart');
                        processed++;
                    } catch (error) {
                        failed++;
                        this.logger.error(`Failed smart collection ${col.id}`, error);
                    }
                }
            }

            // 3. Sync collects (product-collection links)
            for await (const page of this.paginatedFetch(shopDomain, token, '/collects.json', 'collects', null)) {
                for (const collect of page.data) {
                    try {
                        const product = await this.prisma.product.findFirst({
                            where: { channelId, externalId: String(collect.product_id) },
                        });
                        const collection = await this.prisma.collection.findFirst({
                            where: { channelId, externalId: String(collect.collection_id) },
                        });
                        if (product && collection) {
                            await this.prisma.productCollection.upsert({
                                where: { productId_collectionId: { productId: product.id, collectionId: collection.id } },
                                create: { productId: product.id, collectionId: collection.id, position: collect.position ?? 0 },
                                update: { position: collect.position ?? 0 },
                            });
                        }
                    } catch (error) {
                        this.logger.error(`Failed collect ${collect.id}`, error);
                    }
                }
            }

            await this.completeSyncLog(syncLog.id, processed, failed);
        } catch (error) {
            await this.failSyncLog(syncLog.id, processed, failed, error);
            throw error;
        }
    }

    // ─── UPSERT HELPERS ───

    async upsertProduct(channelId: string, orgId: string, sp: any, vendorKey?: string | null) {
        const externalId = String(sp.id);
        const tags = sp.tags ? sp.tags.split(',').map((t: string) => t.trim()).filter(Boolean) : [];
        // Only touch vendor_key when a value was resolved (string|null). undefined = leave as-is.
        const vendorKeyUpdate = vendorKey === undefined ? {} : { vendorKey };

        const product = await this.prisma.product.upsert({
            where: { channelId_externalId: { channelId, externalId } },
            create: {
                organizationId: orgId, channelId, externalId,
                title: sp.title, bodyHtml: sp.body_html, vendor: sp.vendor, vendorKey: vendorKey ?? null,
                productType: sp.product_type, status: this.mapProductStatus(sp.status),
                tags, options: sp.options || null,
                publishedAt: sp.published_at ? new Date(sp.published_at) : null,
                externalCreatedAt: sp.created_at ? new Date(sp.created_at) : null,
                externalUpdatedAt: sp.updated_at ? new Date(sp.updated_at) : null,
            },
            update: {
                title: sp.title, bodyHtml: sp.body_html, vendor: sp.vendor, ...vendorKeyUpdate,
                productType: sp.product_type, status: this.mapProductStatus(sp.status),
                tags, options: sp.options || null,
                publishedAt: sp.published_at ? new Date(sp.published_at) : null,
                externalUpdatedAt: sp.updated_at ? new Date(sp.updated_at) : null,
            },
        });

        for (const sv of sp.variants || []) {
            await this.prisma.productVariant.upsert({
                where: { productId_externalId: { productId: product.id, externalId: String(sv.id) } },
                create: {
                    productId: product.id, externalId: String(sv.id), title: sv.title || 'Default',
                    sku: sv.sku, barcode: sv.barcode, price: sv.price,
                    compareAtPrice: sv.compare_at_price, inventoryQuantity: sv.inventory_quantity ?? 0,
                    inventoryItemId: sv.inventory_item_id ? String(sv.inventory_item_id) : null,
                    weight: sv.weight ? String(sv.weight) : null, weightUnit: sv.weight_unit,
                    option1: sv.option1, option2: sv.option2, option3: sv.option3,
                    position: sv.position ?? 1, requiresShipping: sv.requires_shipping ?? true,
                    taxable: sv.taxable ?? true,
                },
                update: {
                    title: sv.title || 'Default', sku: sv.sku, barcode: sv.barcode,
                    price: sv.price, compareAtPrice: sv.compare_at_price,
                    inventoryQuantity: sv.inventory_quantity ?? 0,
                    inventoryItemId: sv.inventory_item_id ? String(sv.inventory_item_id) : undefined,
                    weight: sv.weight ? String(sv.weight) : null, weightUnit: sv.weight_unit,
                    option1: sv.option1, option2: sv.option2, option3: sv.option3, position: sv.position ?? 1,
                },
            });
        }

        for (const si of sp.images || []) {
            await this.prisma.productImage.upsert({
                where: { productId_externalId: { productId: product.id, externalId: String(si.id) } },
                create: { productId: product.id, externalId: String(si.id), src: si.src, alt: si.alt, position: si.position ?? 1 },
                update: { src: si.src, alt: si.alt, position: si.position ?? 1 },
            });
        }
    }

    async upsertOrder(channelId: string, orgId: string, so: any) {
        const externalId = String(so.id);

        let customerId: string | null = null;
        if (so.customer?.id) {
            const customer = await this.prisma.customer.findFirst({ where: { channelId, externalId: String(so.customer.id) } });
            if (customer) {
                customerId = customer.id;
            } else {
                try {
                    const stub = await this.prisma.customer.create({
                        data: { organizationId: orgId, channelId, externalId: String(so.customer.id), email: so.customer.email, firstName: so.customer.first_name, lastName: so.customer.last_name },
                    });
                    customerId = stub.id;
                } catch {
                    const existing = await this.prisma.customer.findFirst({ where: { channelId, externalId: String(so.customer.id) } });
                    customerId = existing?.id ?? null;
                }
            }
        }

        const tags = so.tags ? so.tags.split(',').map((t: string) => t.trim()).filter(Boolean) : [];
        const shippingPrice = so.total_shipping_price_set?.shop_money?.amount ?? so.total_shipping_price ?? '0';

        const order = await this.prisma.order.upsert({
            where: { channelId_externalId: { channelId, externalId } },
            create: {
                organizationId: orgId, channelId, customerId, externalId,
                orderNumber: so.order_number, name: so.name || `#${so.order_number}`,
                financialStatus: this.mapFinancialStatus(so.financial_status),
                fulfillmentStatus: this.mapFulfillmentStatus(so.fulfillment_status),
                currency: so.currency || 'USD', subtotalPrice: so.subtotal_price || '0',
                totalPrice: so.total_price || '0', totalTax: so.total_tax || '0',
                totalDiscounts: so.total_discounts || '0', totalShippingPrice: shippingPrice,
                shippingAddress: so.shipping_address || null, billingAddress: so.billing_address || null,
                note: so.note, tags,
                cancelReason: this.mapCancelReason(so.cancel_reason),
                cancelledAt: so.cancelled_at ? new Date(so.cancelled_at) : null,
                closedAt: so.closed_at ? new Date(so.closed_at) : null,
                externalCreatedAt: so.created_at ? new Date(so.created_at) : null,
                externalUpdatedAt: so.updated_at ? new Date(so.updated_at) : null,
            },
            update: {
                customerId,
                financialStatus: this.mapFinancialStatus(so.financial_status),
                fulfillmentStatus: this.mapFulfillmentStatus(so.fulfillment_status),
                totalPrice: so.total_price || '0', totalTax: so.total_tax || '0',
                totalDiscounts: so.total_discounts || '0', totalShippingPrice: shippingPrice,
                shippingAddress: so.shipping_address || null, billingAddress: so.billing_address || null,
                note: so.note, tags,
                cancelReason: this.mapCancelReason(so.cancel_reason),
                cancelledAt: so.cancelled_at ? new Date(so.cancelled_at) : null,
                closedAt: so.closed_at ? new Date(so.closed_at) : null,
                externalUpdatedAt: so.updated_at ? new Date(so.updated_at) : null,
            },
        });

        for (const li of so.line_items || []) {
            let variantId: string | null = null;
            let vendor: string | null = null;
            if (li.variant_id) {
                const variant = await this.prisma.productVariant.findFirst({
                    where: { externalId: String(li.variant_id), product: { channelId } },
                    include: { product: { select: { vendor: true, vendorKey: true } } },
                });
                variantId = variant?.id ?? null;
                vendor = variant?.product?.vendorKey ?? variant?.product?.vendor ?? null;
            }
            // Fallback when the variant is gone: resolve the vendor via the product's external id.
            if (!vendor && li.product_id) {
                const product = await this.prisma.product.findFirst({
                    where: { channelId, externalId: String(li.product_id) },
                    select: { vendor: true, vendorKey: true },
                });
                vendor = product?.vendorKey ?? product?.vendor ?? null;
            }
            await this.prisma.orderLineItem.upsert({
                where: { orderId_externalId: { orderId: order.id, externalId: String(li.id) } },
                create: {
                    orderId: order.id, variantId, externalId: String(li.id),
                    externalProductId: li.product_id ? String(li.product_id) : null,
                    externalVariantId: li.variant_id ? String(li.variant_id) : null,
                    title: li.title || 'Unknown', variantTitle: li.variant_title, sku: li.sku, vendor,
                    quantity: li.quantity, price: li.price || '0', totalDiscount: li.total_discount || '0',
                    fulfillmentStatus: li.fulfillment_status, requiresShipping: li.requires_shipping ?? true,
                    taxable: li.taxable ?? true, properties: li.properties || null,
                },
                update: { variantId, vendor, title: li.title || 'Unknown', quantity: li.quantity, price: li.price || '0', totalDiscount: li.total_discount || '0', fulfillmentStatus: li.fulfillment_status },
            });
        }

        for (const ff of so.fulfillments || []) {
            await this.prisma.orderFulfillment.upsert({
                where: { orderId_externalId: { orderId: order.id, externalId: String(ff.id) } },
                create: { orderId: order.id, externalId: String(ff.id), status: ff.status || 'pending', trackingNumber: ff.tracking_number, trackingUrl: ff.tracking_url, trackingCompany: ff.tracking_company, shippedAt: ff.created_at ? new Date(ff.created_at) : null },
                update: { status: ff.status || 'pending', trackingNumber: ff.tracking_number, trackingUrl: ff.tracking_url, trackingCompany: ff.tracking_company },
            });
        }

        for (const rf of so.refunds || []) {
            const refundAmount = rf.transactions?.[0]?.amount || '0';
            await this.prisma.orderRefund.upsert({
                where: { orderId_externalId: { orderId: order.id, externalId: String(rf.id) } },
                create: { orderId: order.id, externalId: String(rf.id), amount: refundAmount, currency: so.currency || 'USD', reason: rf.note, note: rf.note, lineItems: rf.refund_line_items || null, processedAt: rf.processed_at ? new Date(rf.processed_at) : null },
                update: { amount: refundAmount, note: rf.note, lineItems: rf.refund_line_items || null },
            });
        }
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

        const customer = await this.prisma.customer.upsert({
            where: { channelId_externalId: { channelId, externalId } },
            create: {
                organizationId: orgId, channelId, externalId,
                email: sc.email, firstName: sc.first_name, lastName: sc.last_name, phone: sc.phone,
                state: this.mapCustomerState(sc.state), verifiedEmail: sc.verified_email ?? false,
                acceptsMarketing: sc.accepts_marketing ?? false, ordersCount: sc.orders_count ?? 0,
                totalSpent: sc.total_spent || '0', tags, note: sc.note,
                addresses: sc.addresses || null, defaultAddress: sc.default_address || null,
                externalCreatedAt: sc.created_at ? new Date(sc.created_at) : null,
                externalUpdatedAt: sc.updated_at ? new Date(sc.updated_at) : null,
            },
            update: {
                email: sc.email, firstName: sc.first_name, lastName: sc.last_name, phone: sc.phone,
                state: this.mapCustomerState(sc.state), verifiedEmail: sc.verified_email ?? false,
                acceptsMarketing: sc.accepts_marketing ?? false, ordersCount: sc.orders_count ?? 0,
                totalSpent: sc.total_spent || '0', tags, note: sc.note,
                addresses: sc.addresses || null, defaultAddress: sc.default_address || null,
                externalUpdatedAt: sc.updated_at ? new Date(sc.updated_at) : null,
                // NOTE: vipLevel is auto-assigned by LoyaltyService below (based on org thresholds).
                // internalNotes, segments are still NOT overwritten (CRM-only fields).
            },
            select: { id: true },
        });

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

    // ─── PAGINATED FETCH ───
    private async *paginatedFetch(
        shopDomain: string, token: string, endpoint: string,
        resourceKey: string, startCursor?: string | null,
        extraParams?: Record<string, string>,
    ): AsyncGenerator<{ data: any[]; nextCursor: string | null }> {
        const apiVersion = this.graphql.getApiVersion();
        let url: string;
        if (startCursor) {
            url = `https://${shopDomain}/admin/api/${apiVersion}${endpoint}?limit=${PAGE_LIMIT}&page_info=${startCursor}`;
        } else {
            const params = new URLSearchParams({ limit: String(PAGE_LIMIT), ...extraParams });
            url = `https://${shopDomain}/admin/api/${apiVersion}${endpoint}?${params.toString()}`;
        }

        while (url) {
            const res = await this.fetchWithRateLimit(url, token);
            const data = await res.json();
            const items = data[resourceKey] || [];
            const linkHeader = res.headers.get('link');
            const nextCursor = this.parseNextCursor(linkHeader);

            yield { data: items, nextCursor };

            url = nextCursor
                ? `https://${shopDomain}/admin/api/${apiVersion}${endpoint}?limit=${PAGE_LIMIT}&page_info=${nextCursor}`
                : '';
        }
    }

    private async fetchWithRateLimit(url: string, token: string): Promise<Response> {
        while (true) {
            const res = await fetch(url, { headers: { 'X-Shopify-Access-Token': token } });
            if (res.status === 429) {
                const retryAfter = parseInt(res.headers.get('Retry-After') || '2', 10);
                this.logger.warn(`Rate limited, waiting ${retryAfter}s`);
                await this.sleep(retryAfter * 1000);
                continue;
            }
            if (res.status === 403) {
                const errorBody = await res.text();
                this.logger.warn(`Shopify 403 Forbidden: ${errorBody}. Enable "Protected customer data access" in your Shopify Partner Dashboard → App → API access.`);
                throw new Error(`Shopify access denied (403). Your app needs "Protected customer data access" enabled in the Shopify Partner Dashboard. Details: ${errorBody}`);
            }
            if (!res.ok) throw new Error(`Shopify API ${res.status}: ${await res.text()}`);
            const callLimit = res.headers.get('X-Shopify-Shop-Api-Call-Limit');
            if (callLimit) {
                const [used, max] = callLimit.split('/').map(Number);
                if (used / max > 0.8) await this.sleep(500);
            }
            return res;
        }
    }

    private async shopifyFetch(shopDomain: string, token: string, endpoint: string): Promise<any> {
        const apiVersion = this.graphql.getApiVersion();
        const res = await fetch(`https://${shopDomain}/admin/api/${apiVersion}${endpoint}`, { headers: { 'X-Shopify-Access-Token': token } });
        return res.ok ? res.json() : null;
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
     * Resolve a product's vendor metafield value (→ Product.vendorKey). Returns:
     *   • undefined → leave the column untouched (no config, or fetch failed),
     *   • string    → the metafield value,
     *   • null      → configured, but the product has no such metafield.
     * Prefers inline `sp.metafields` (zero-cost); otherwise fetches the product's
     * metafields. Gated entirely by `config` (null when the feature is off).
     */
    private async resolveVendorKey(
        sp: any,
        config: { namespace: string; key: string } | null,
        shopDomain: string,
        token: string,
    ): Promise<string | null | undefined> {
        if (!config) return undefined;
        if (Array.isArray(sp.metafields)) {
            const m = sp.metafields.find(
                (x: any) => x?.namespace === config.namespace && x?.key === config.key,
            );
            return m?.value != null ? String(m.value) : null;
        }
        try {
            const res = await this.shopifyFetch(
                shopDomain,
                token,
                `/products/${sp.id}/metafields.json?namespace=${encodeURIComponent(config.namespace)}`,
            );
            const m = (res?.metafields ?? []).find((x: any) => x?.key === config.key);
            return m?.value != null ? String(m.value) : null;
        } catch (e) {
            this.logger.warn(
                `Vendor metafield fetch failed for product ${sp.id}: ${e instanceof Error ? e.message : e}`,
            );
            return undefined;
        }
    }

    // ─── SYNC LOG HELPERS ───
    private async createSyncLog(channelId: string, orgId: string, entityType: string) {
        const existing = await this.prisma.syncLog.findFirst({
            where: { channelId, entityType, status: SyncStatus.IN_PROGRESS },
            orderBy: { createdAt: 'desc' },
        });
        if (existing) return existing;
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

    private parseNextCursor(link: string | null): string | null {
        if (!link) return null;
        const match = link.match(/<[^>]*page_info=([^&>]+)[^>]*>;\s*rel="next"/);
        return match ? match[1] : null;
    }

    private sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
}