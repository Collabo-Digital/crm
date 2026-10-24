import { Controller, Post, Req, Headers, HttpCode, Logger, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { SkipThrottle } from '@nestjs/throttler';
import { createHmac, timingSafeEqual } from 'crypto';
import { ChannelPlatform, ChannelStatus, Prisma, StockBucket } from '@prisma/client';
import { Public } from '../auth/decorators/public.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { EncryptionService } from './encryption.service';
import { ShopifySyncService } from './shopify-sync.service';
import { CheckoutService } from '../commerce/checkout.service';
import { InventoryLedgerService } from '../inventory/inventory-ledger.service';
import { describeAccount } from './channel-connection.util';
import { isTransientWebhookError } from './webhook-retry.util';

/** Address fields that identify a person. City, state and country stay. */
const ADDRESS_PII_KEYS = [
    'name', 'first_name', 'last_name', 'firstName', 'lastName', 'company',
    'address1', 'address2', 'phone', 'zip', 'latitude', 'longitude',
];

/** Top-level keys of a stored order, checkout or cart payload that identify a person. */
const PAYLOAD_PII_KEYS = [
    'customer', 'email', 'contact_email', 'phone', 'sms_marketing_phone',
    'billing_address', 'shipping_address', 'note', 'note_attributes',
    'browser_ip', 'client_details',
];

/**
 * Exempt from the global 60 req/min throttler.
 *
 * That limit exists for user-facing API callers. Webhooks are HMAC-
 * authenticated machine traffic, arrive from Shopify's shared egress IPs (so
 * the default per-IP bucket is shared across EVERY tenant), and cover 19
 * topics including the chatty `carts/*` and `checkouts/*`. A busy store bursts
 * past 60/min easily; Shopify counts each 429 as a failed delivery and
 * eventually DELETES the webhook subscription — silently stopping sync.
 */
@SkipThrottle()
@Controller('webhooks')
export class ShopifyWebhookController {
    private readonly logger = new Logger(ShopifyWebhookController.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly encryption: EncryptionService,
        private readonly syncService: ShopifySyncService,
        private readonly checkouts: CheckoutService,
        private readonly config: ConfigService,
        private readonly inventoryLedger: InventoryLedgerService,
    ) { }

    @Public()
    @Post('shopify')
    @HttpCode(200)
    async handleWebhook(
        @Req() req: RawBodyRequest<Request>,
        @Headers('x-shopify-hmac-sha256') hmac: string,
        @Headers('x-shopify-topic') topic: string,
        @Headers('x-shopify-shop-domain') shopDomain: string,
    ) {
        const rawBody = req.rawBody;
        if (!rawBody || !hmac) {
            // Shopify's automated compliance checks require 401 (not 200)
            // for unauthenticated webhook requests.
            this.logger.warn('Webhook missing body or HMAC');
            throw new UnauthorizedException('Missing HMAC or body');
        }

        // 1. Find the channel by shop domain (may be null for lifecycle /
        // compliance topics arriving after disconnect — those are still
        // acknowledged below).
        //
        // findMany + explicit preference, NOT findFirst: `findFirst` with no
        // `orderBy` returns whichever row Postgres hands back first, so if a
        // store were ever claimed twice the tenant receiving the data would be
        // arbitrary — and HMAC cannot disambiguate, because it is verified
        // against the APP-level secret that is valid for every store installed
        // on the app. A live, usable connection wins, so a stale or
        // disconnected duplicate never steals traffic from the org actually
        // using the store.
        const candidates = await this.prisma.channel.findMany({
            where: {
                platform: ChannelPlatform.SHOPIFY,
                externalStoreUrl: `https://${shopDomain}`,
            },
            orderBy: { updatedAt: 'desc' },
        });

        const channel =
            candidates.find(
                (c) => c.status === ChannelStatus.CONNECTED && c.isEnabled,
            ) ??
            candidates.find((c) => c.status === ChannelStatus.CONNECTED) ??
            candidates[0] ??
            null;

        if (candidates.length > 1) {
            this.logger.error(
                `Shop ${shopDomain} resolves to ${candidates.length} channels ` +
                `across orgs [${candidates.map((c) => c.organizationId).join(', ')}]; ` +
                `routing to ${channel?.organizationId}. This is a tenant-isolation ` +
                `hazard — investigate immediately.`,
            );
        }

        // 2a. Primary HMAC verification: the public app's client secret is
        // the signing key for every webhook Shopify sends on its behalf.
        const appSecret = this.config.get<string>('shopify.clientSecret');
        let verified = appSecret ? this.hmacMatches(rawBody, hmac, appSecret) : false;

        // 2b. Legacy fallback: channels connected via the old custom-app
        // flow receive webhooks signed with the merchant's own app secret
        // (stored encrypted in credentials.apiSecret). Keeps existing
        // stores working without forcing a reconnect.
        const legacySecret = (channel?.credentials as { apiSecret?: string } | null)?.apiSecret;
        if (!verified && legacySecret) {
            try {
                verified = this.hmacMatches(rawBody, hmac, this.encryption.decrypt(legacySecret));
            } catch {
                // undecryptable secret → treat as unverified
            }
        }

        if (!verified) {
            this.logger.warn(`Invalid webhook HMAC from ${shopDomain} (topic: ${topic})`);
            throw new UnauthorizedException('Invalid HMAC signature');
        }

        // 3. Parse body and process by topic
        const body = JSON.parse(rawBody.toString());
        this.logger.log(`Webhook received: ${topic} from ${shopDomain}`);

        // ─── Lifecycle + GDPR compliance topics ────────────────────────
        // Handled before the channel guard: they must be acknowledged with
        // 200 even when the channel row is already gone.
        switch (topic) {
            case 'app/uninstalled':
                // Merchant removed the app — the access token is already
                // revoked. Don't call unregisterWebhooks (it would 401);
                // Shopify removed the subscriptions with the install.
                //
                // The store claim is released exactly as ChannelService.disconnect
                // does it: otherwise the store stays "linked to another
                // organization" for ever and no other workspace can connect it.
                // The id moves to metadata so a reinstall revives this row and
                // later redact webhooks can still find it.
                if (channel) {
                    const meta =
                        channel.metadata && typeof channel.metadata === 'object' && !Array.isArray(channel.metadata)
                            ? (channel.metadata as Record<string, unknown>)
                            : {};
                    await this.prisma.channel.update({
                        where: { id: channel.id },
                        data: {
                            status: ChannelStatus.DISCONNECTED,
                            credentials: Prisma.JsonNull,
                            isEnabled: false,
                            externalStoreId: null,
                            externalStoreUrl: null,
                            metadata: {
                                ...meta,
                                externalAccountId: channel.externalStoreId,
                                lastAccount: describeAccount(channel.platform, channel.credentials, channel.metadata),
                                disconnectedAt: new Date().toISOString(),
                            } as Prisma.InputJsonValue,
                        },
                    });
                    this.logger.warn(
                        `App uninstalled from ${shopDomain} — channel ${channel.id} disconnected, credentials cleared, store released`,
                    );
                }
                return { received: true };

            case 'customers/data_request':
                // The merchant must be provided the customer's data within
                // 30 days. Logged for operational follow-up; the payload
                // identifies the customer and the orders requested.
                this.logger.warn(
                    `GDPR data request from ${shopDomain}: customer ${(body as { customer?: { id?: number } }).customer?.id}, ` +
                    `orders ${JSON.stringify((body as { orders_requested?: number[] }).orders_requested ?? [])}`,
                );
                return { received: true };

            case 'customers/redact': {
                const redact = body as {
                    shop_id?: number | string;
                    customer?: { id?: number | string; email?: string | null; phone?: string | null };
                    orders_to_redact?: Array<number | string>;
                };
                const externalId = redact.customer?.id != null ? String(redact.customer.id) : null;
                for (const ch of await this.channelsForShop(shopDomain, redact.shop_id)) {
                    await this.redactPersonalData(ch, {
                        customerExternalId: externalId,
                        email: redact.customer?.email ?? null,
                        phone: redact.customer?.phone ?? null,
                        orderExternalIds: (redact.orders_to_redact ?? []).map(String),
                    });
                }
                this.logger.warn(`GDPR customer redact from ${shopDomain}: customer ${externalId}`);
                return { received: true };
            }

            case 'shop/redact':
                // Arrives ~48h after uninstall, usually after the channel was
                // disconnected — hence the lookup by shop id as well as URL.
                // Orders and products are kept as business records with the
                // personal fields removed.
                for (const ch of await this.channelsForShop(shopDomain, (body as { shop_id?: number | string }).shop_id)) {
                    await this.redactPersonalData(ch, null);
                }
                this.logger.warn(`GDPR shop redact completed for ${shopDomain}`);
                return { received: true };
        }

        if (!channel) {
            this.logger.warn(`No channel found for shop domain: ${shopDomain}`);
            return { received: true };
        }

        try {
            switch (topic) {
                case 'products/create':
                case 'products/update':
                    await this.syncService.upsertProduct(
                        channel.id,
                        channel.organizationId,
                        body,
                    );
                    break;

                case 'products/delete':
                    await this.handleProductDelete(channel.id, body);
                    break;

                case 'orders/create':
                case 'orders/updated':
                case 'orders/cancelled':
                case 'orders/fulfilled':
                case 'orders/partially_fulfilled':
                    // `upsertOrder` already reads `cancel_reason` / `cancelled_at`
                    // and the `fulfillments` array from the payload, so a
                    // cancellation/fulfillment webhook reconciles the local row
                    // by going through the same code path. Optimistic local
                    // updates from the service actions run before this webhook
                    // arrives — this is the authoritative reconcile.
                    // `live: true` marks this as a real-time webhook rather than
                    // a backfill page, which is what lets `upsertOrder`
                    // auto-issue a GST invoice when the order becomes paid. The
                    // bulk sync deliberately omits it — see the flag's docblock.
                    //
                    // An order completes its checkout, so it is never
                    // "recovered". Done FIRST and on every order topic: it
                    // needs nothing from the order row, and a buyer who has
                    // paid must not get an abandoned-cart message because the
                    // order write below failed.
                    await this.checkouts.markCompleted(channel, body);
                    await this.syncService.upsertOrder(
                        channel.id,
                        channel.organizationId,
                        body,
                        { live: true },
                    );
                    // Order messages now come from automations: upsertOrder
                    // raises the store events they listen for.
                    if (topic === 'orders/create') {
                        // Also record the order as an analytics event so
                        // the cart aggregator can compute
                        // checkout→order conversion using consistent
                        // sources (webhook-only counts on both sides of
                        // the ratio). The local Order table still drives
                        // the overall revenue / conversionRate stats —
                        // this row is just for funnel math.
                        await this.recordAnalyticsEvent(
                            channel.id,
                            channel.organizationId,
                            topic,
                            body,
                        );
                    }
                    break;

                case 'customers/create':
                case 'customers/update':
                    await this.syncService.upsertCustomer(
                        channel.id,
                        channel.organizationId,
                        body,
                    );
                    break;

                case 'inventory_levels/update':
                    await this.handleInventoryUpdate(
                        channel.id,
                        channel.organizationId,
                        body,
                    );
                    break;

                case 'refunds/create':
                    // Storage only, by design: revenue aggregates stay gross
                    // for now, so refund history accumulates and turning it
                    // into net reporting later is a reporting change rather
                    // than a "we never captured the data" problem.
                    await this.syncService.upsertRefund(channel.id, body);
                    break;

                // REMOVED: `fulfillments/create` / `fulfillments/update` cases.
                // They were unreachable — those are not valid Shopify webhook
                // topics (Shopify rejects them, see WEBHOOK_TOPICS in
                // shopify-oauth.service.ts) so we correctly never subscribed,
                // yet the comment beside them claimed we did. Fulfilment data
                // arrives via orders/fulfilled and orders/updated, both of
                // which flow through `upsertOrder`.

                case 'draft_orders/create':
                case 'draft_orders/update':
                    // Mirrors changes made on the Shopify side back into our
                    // DraftOrder row. Local optimistic updates (from our own
                    // service paths) usually arrive first; this is the
                    // authoritative reconcile if the merchant edited the draft
                    // in Shopify admin directly.
                    await this.syncService.upsertDraftOrder(
                        channel.id,
                        channel.organizationId,
                        body,
                    );
                    break;

                // ─── Analytics: cart + checkout events ─────────────────
                // Stored verbatim in `RawAnalyticsEvent`. The hourly
                // `CartEventsAggregator` dedupes by cart/checkout token and
                // rolls them into `AnalyticsSnapshot.metrics.byProduct`.
                // We don't process them inline — webhooks can fire dozens
                // of times for a single shopper session, so we want the
                // aggregator to dedupe instead of doing read-modify-write
                // on every event.
                case 'checkouts/create':
                case 'checkouts/update':
                case 'checkouts/delete':
                    // Also kept as a checkout for abandoned-cart recovery.
                    if (topic === 'checkouts/delete') await this.checkouts.remove(channel.id, body);
                    else await this.checkouts.upsertFromWebhook(channel, body);
                    await this.recordAnalyticsEvent(
                        channel.id,
                        channel.organizationId,
                        topic,
                        body,
                    );
                    break;
                case 'carts/create':
                case 'carts/update':
                    await this.recordAnalyticsEvent(
                        channel.id,
                        channel.organizationId,
                        topic,
                        body,
                    );
                    break;

                default:
                    this.logger.log(`Unhandled webhook topic: ${topic}`);
            }
        } catch (error) {
            this.logger.error(
                `Failed to process webhook ${topic} from ${shopDomain}`,
                error instanceof Error ? error.stack : error,
            );
            // A 200 here told Shopify the delivery succeeded, so an order,
            // stock change or deletion lost to a brief database outage was
            // gone until someone ran a manual sync. A 503 makes Shopify
            // deliver it again later (see isTransientWebhookError for why
            // only these).
            if (isTransientWebhookError(error)) {
                throw new ServiceUnavailableException('Temporary failure; please retry.');
            }
        }

        return { received: true };
    }

    // Constant-time base64 HMAC comparison against a given signing secret.
    private hmacMatches(rawBody: Buffer, hmac: string, secret: string): boolean {
        const generated = createHmac('sha256', secret).update(rawBody).digest('base64');
        const a = Buffer.from(hmac, 'base64');
        const b = Buffer.from(generated, 'base64');
        return a.length === b.length && timingSafeEqual(a, b);
    }

    /**
     * Every channel row that holds, or held, this shop. A disconnect or an
     * uninstall clears `externalStoreUrl` and keeps the shop id in
     * `metadata.externalAccountId`, and redact webhooks arrive after both.
     */
    private async channelsForShop(
        shopDomain: string,
        shopId: number | string | undefined,
    ): Promise<Array<{ id: string; organizationId: string }>> {
        return this.prisma.channel.findMany({
            where: {
                platform: ChannelPlatform.SHOPIFY,
                OR: [
                    { externalStoreUrl: `https://${shopDomain}` },
                    ...(shopId != null
                        ? [
                            { externalStoreId: String(shopId) },
                            { metadata: { path: ['externalAccountId'], equals: String(shopId) } },
                        ]
                        : []),
                ],
            },
            select: { id: true, organizationId: true },
        });
    }

    /**
     * GDPR redaction of what this shop sent us about people.
     *
     * `who` null is shop/redact: everyone synced from the channel. Otherwise
     * one customer (customers/redact): their customer rows, the orders Shopify
     * lists plus that customer's own orders, their checkouts and their stored
     * webhook payloads.
     *
     * Customers keep non-personal commerce data (counts, totals, tags). Order
     * addresses keep city, state and country, which the order's GST place of
     * supply rests on; issued invoices are statutory records and are not
     * touched. Stored payloads lose their personal top-level keys but keep the
     * line items the cart analytics read.
     */
    private async redactPersonalData(
        channel: { id: string; organizationId: string },
        who: {
            customerExternalId: string | null;
            email: string | null;
            phone: string | null;
            orderExternalIds: string[];
        } | null,
    ) {
        const orgId = channel.organizationId;

        const customers = who
            ? who.customerExternalId
                ? await this.prisma.customer.findMany({
                    where: { organizationId: orgId, channelId: channel.id, externalId: who.customerExternalId },
                    select: { id: true },
                })
                : []
            : await this.prisma.customer.findMany({
                where: { organizationId: orgId, channelId: channel.id },
                select: { id: true },
            });
        const customerIds = customers.map((c) => c.id);

        if (customerIds.length > 0) {
            await this.prisma.customer.updateMany({
                where: { id: { in: customerIds } },
                data: {
                    email: null,
                    firstName: 'Redacted',
                    lastName: null,
                    phone: null,
                    addresses: Prisma.JsonNull,
                    defaultAddress: Prisma.JsonNull,
                    note: null,
                    gstin: null,
                    verifiedEmail: false,
                },
            });
        }

        const orderScope = who
            ? Prisma.sql`(customer_id = ANY(${customerIds}::text[]) OR (channel_id = ${channel.id} AND external_id = ANY(${who.orderExternalIds}::text[])))`
            : Prisma.sql`channel_id = ${channel.id}`;
        await this.prisma.$executeRaw`
            UPDATE orders SET
                shipping_address = CASE WHEN jsonb_typeof(shipping_address) = 'object'
                    THEN shipping_address - ${ADDRESS_PII_KEYS}::text[] ELSE shipping_address END,
                billing_address = CASE WHEN jsonb_typeof(billing_address) = 'object'
                    THEN billing_address - ${ADDRESS_PII_KEYS}::text[] ELSE billing_address END
            WHERE organization_id = ${orgId} AND ${orderScope}
        `;

        const checkoutMatch: Prisma.CheckoutWhereInput[] = who
            ? [
                ...(who.customerExternalId ? [{ customerExternalId: who.customerExternalId }] : []),
                ...(who.email ? [{ email: who.email }] : []),
                ...(who.phone ? [{ phone: who.phone }] : []),
            ]
            : [];
        if (!who || checkoutMatch.length > 0) {
            await this.prisma.checkout.updateMany({
                where: { channelId: channel.id, ...(who ? { OR: checkoutMatch } : {}) },
                data: { email: null, phone: null, firstName: null, recoveryUrl: null },
            });
        }

        if (!who || who.customerExternalId) {
            const eventScope = who
                ? Prisma.sql`AND external_customer_id = ${who.customerExternalId}`
                : Prisma.empty;
            await this.prisma.$executeRaw`
                UPDATE raw_analytics_events
                SET payload = payload - ${PAYLOAD_PII_KEYS}::text[]
                WHERE channel_id = ${channel.id} AND jsonb_typeof(payload) = 'object' ${eventScope}
            `;
        }
    }

    /**
     * A product removed from Shopify is soft-deleted here, NOT marked ARCHIVED.
     *
     * ARCHIVED is one of Shopify's own three product statuses and arrives
     * through the normal product sync, so writing it on delete made a deleted
     * product indistinguishable from a genuinely archived one — and, because
     * catalogue listings filter on deletedAt rather than status, kept it in
     * the catalogue forever. Found on 2026-09-04: the store held 0 archived
     * products while the CRM held 128, every one of them deleted in Shopify.
     */
    private async handleProductDelete(channelId: string, body: { id: number }) {
        const externalId = String(body.id);
        const product = await this.prisma.product.findFirst({
            where: { channelId, externalId, deletedAt: null },
        });

        if (product) {
            await this.prisma.product.update({
                where: { id: product.id },
                data: { deletedAt: new Date() },
            });
            this.logger.log(`Product ${externalId} soft-deleted (removed in Shopify)`);
        }
    }

    /**
     * Persist a webhook payload as a `RawAnalyticsEvent` row. The
     * `sessionId` field carries the right token for each topic so the
     * aggregator can deduplicate / link funnel stages:
     *   - cart events     → cart `token`
     *   - checkout events → checkout `token` (falls back to `cart_token`
     *                       so a checkout can be matched back to its cart)
     *   - order events    → `checkout_token` (links the order to its
     *                       checkout for funnel math); falls back to
     *                       order id if checkout_token is absent.
     */
    private async recordAnalyticsEvent(
        channelId: string,
        orgId: string,
        topic: string,
        body: Record<string, unknown>,
    ) {
        const occurredAt = this.parseEventTimestamp(body) ?? new Date();
        const sessionId = this.extractSessionToken(topic, body);
        const externalCustomerId =
            ((body as { customer?: { id?: string | number } }).customer?.id ??
                null) === null
                ? null
                : String(
                      (body as { customer: { id: string | number } }).customer
                          .id,
                  );

        try {
            await this.prisma.rawAnalyticsEvent.create({
                data: {
                    organizationId: orgId,
                    channelId,
                    eventName: topic.replace('/', '_'),
                    occurredAt,
                    visitorId: null,
                    sessionId,
                    externalCustomerId,
                    payload: body as object,
                },
            });
        } catch (err) {
            this.logger.warn(
                `Failed to record analytics event for ${topic}: ${err instanceof Error ? err.message : err}`,
            );
        }
    }

    private extractSessionToken(
        topic: string,
        body: Record<string, unknown>,
    ): string | null {
        if (topic.startsWith('orders/')) {
            // Order webhooks don't have a plain `token` field; we prefer
            // `checkout_token` so the order rolls up under the same
            // funnel slot as its preceding checkout. Falls back to the
            // order id (always present) so the count of distinct orders
            // is never wrong.
            const checkoutToken = (body as { checkout_token?: string })
                .checkout_token;
            if (typeof checkoutToken === 'string') return checkoutToken;
            const id = (body as { id?: string | number }).id;
            return id ? String(id) : null;
        }
        // Cart + checkout webhooks both expose `token` directly.
        return (
            (body as { token?: string }).token ??
            (body as { cart_token?: string }).cart_token ??
            null
        );
    }

    private parseEventTimestamp(body: Record<string, unknown>): Date | null {
        const raw =
            (body as { updated_at?: string }).updated_at ??
            (body as { created_at?: string }).created_at;
        if (typeof raw !== 'string') return null;
        const parsed = new Date(raw);
        return Number.isNaN(parsed.getTime()) ? null : parsed;
    }

    private async handleInventoryUpdate(
        channelId: string,
        orgId: string,
        body: { inventory_item_id: number; available: number; location_id: number },
    ) {
        const variant = await this.prisma.productVariant.findFirst({
            where: {
                product: { channelId },
                inventoryItemId: String(body.inventory_item_id),
            },
        });

        if (!variant) return;

        // Warehousing orgs hold stock per warehouse, so `body.available` — the
        // quantity at ONE location — is routed to the warehouse mapped to
        // `body.location_id` rather than being assigned as the variant's whole
        // stock. That assignment is what made the number flip to whichever
        // location changed last on a multi-location store.
        if (await this.inventoryLedger.isWarehousingEnabled(orgId)) {
            await this.applyWarehousedInventoryUpdate(orgId, variant.id, body);
            return;
        }

        // Legacy (single-number) orgs are deliberately unchanged, INCLUDING
        // the multi-location flip described above: they have one quantity per
        // variant and nowhere to put a per-location split, so fixing it means
        // moving them to warehousing, not patching this branch.
        const newQuantity = body.available;
        // Locked and re-read so the ledger's before/after match what was
        // actually replaced when two updates for one variant arrive together.
        const before = await this.prisma.$transaction(async (tx) => {
            const rows = await tx.$queryRaw<Array<{ inventory_quantity: number }>>`
                SELECT "inventory_quantity" FROM "product_variants" WHERE "id" = ${variant.id} FOR UPDATE`;
            const current = rows[0]?.inventory_quantity ?? variant.inventoryQuantity;
            if (current === newQuantity) return null;
            await tx.productVariant.update({
                where: { id: variant.id },
                data: { inventoryQuantity: newQuantity },
            });
            await tx.inventoryEvent.create({
                data: {
                    organizationId: orgId,
                    variantId: variant.id,
                    quantityBefore: current,
                    quantityAfter: newQuantity,
                    changeAmount: newQuantity - current,
                    reason: 'webhook',
                    referenceType: 'webhook',
                },
            });
            return current;
        });
        if (before === null) return;

        this.logger.log(
            `Inventory updated via webhook: variant ${variant.id}, ${before} → ${newQuantity}`,
        );
    }

    /**
     * Route a single location's quantity into the warehouse mirroring it.
     *
     * Compare-and-skip is what makes this safe to receive repeatedly, and it
     * doubles as echo suppression: a CRM-origin push comes straight back as
     * this webhook carrying the value we just wrote, the delta is zero, and no
     * ledger row is written.
     */
    private async applyWarehousedInventoryUpdate(
        orgId: string,
        variantId: string,
        body: { available: number; location_id: number },
    ) {
        const locationId = String(body.location_id);
        const warehouse = await this.prisma.warehouse.findFirst({
            where: { organizationId: orgId, shopifyLocationId: locationId, isActive: true },
            select: { id: true },
        });
        if (!warehouse) {
            // A location added in Shopify since the last locations sync. Doing
            // nothing is correct: the next sync creates the warehouse and the
            // reconcile picks up the current quantity anyway.
            this.logger.debug(
                `inventory_levels/update for unmapped Shopify location ${locationId} (org ${orgId})`,
            );
            return;
        }

        // The read and the movement share one transaction behind the variant
        // lock applyMovement itself takes. Reading outside it let two webhooks
        // for one variant (two quick sales: available 9, then 8) both read 10
        // and apply -1 and -2, leaving 7 against Shopify's 8 for good.
        const delta = await this.prisma.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT 1 FROM "product_variants" WHERE "id" = ${variantId} FOR UPDATE`;
            const level = await tx.stockLevel.findFirst({
                where: { variantId, warehouseId: warehouse.id, locationId: null },
                select: { available: true },
            });
            const change = body.available - (level?.available ?? 0);
            if (change === 0) return 0;

            await this.inventoryLedger.applyMovement({
                orgId,
                variantId,
                warehouseId: warehouse.id,
                fromBucket: change < 0 ? StockBucket.AVAILABLE : null,
                toBucket: change > 0 ? StockBucket.AVAILABLE : null,
                quantity: Math.abs(change),
                reason: 'webhook',
                referenceType: 'webhook',
                referenceId: locationId,
                // Shopify is authoritative on what was sold. Refusing a decrease
                // that crosses zero would desync the two systems permanently;
                // oversold surfaces as an alert on the stock screen instead.
                allowNegativeAvailable: true,
            }, tx);
            return change;
        });
        if (delta === 0) return;

        this.logger.log(
            `Inventory updated via webhook: variant ${variantId} at warehouse ${warehouse.id}, ${delta > 0 ? '+' : ''}${delta} → ${body.available}`,
        );
    }
}