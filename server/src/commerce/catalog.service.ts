import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ChannelPlatform, Prisma, ProductStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MetaGraphClient } from '../channel/meta-graph.client';
import { MetaGraphError } from '../channel/meta-graph.types';
import { patchChannelMetadataSql } from '../channel/channel-metadata.util';
import { Priority } from '../rate-limit/rate-limit.types';
import { ChannelAccessService } from '../messaging/channel-access.service';
import { buildCatalogItem, collectionUrl, productUrl } from './catalog.util';
import type { OutboundPayload } from '../messaging/outbound';

/** Meta accepts up to 5,000 records a call and suggests staying under 3,000. */
const BATCH_SIZE = 1000;
/// Variants the inbox's product panel lists at once; search or a collection narrows it.
const PRODUCTS_SHOWN = 100;

export interface CatalogState {
    catalogId: string;
    name: string | null;
    productCount: number | null;
    connectedAt: string;
    lastSync?: { at: string; sent: number; removed: number; skipped: number; errors: number; handles: string[] };
}

type BatchRequest = { method: 'UPDATE' | 'DELETE'; data: Record<string, unknown> };

/**
 * The WhatsApp number's Meta catalog. The business connects a catalog to its
 * WhatsApp account in WhatsApp Manager or Commerce Manager (Meta documents no
 * API for that) and gives Collabo its id; Collabo then keeps the store's
 * products in it with the Catalog Batch API. Numbers shared with the WhatsApp
 * Business app cannot send catalog messages through the API.
 */
@Injectable()
export class CatalogService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly access: ChannelAccessService,
        private readonly metaGraph: MetaGraphClient,
    ) { }

    async view(orgId: string, channelId: string) {
        const channel = await this.channel(orgId, channelId);
        const catalog = this.state(channel.metadata);
        const counts = await this.prisma.catalogItem.groupBy({ by: ['status'], where: { channelId }, _count: { _all: true } });
        const errors = await this.prisma.catalogItem.findMany({
            where: { channelId, status: { in: ['ERROR', 'SKIPPED'] } },
            include: { variant: { select: { title: true, product: { select: { title: true } } } } },
            orderBy: { updatedAt: 'desc' },
            take: 50,
        });
        let commerce: { cartEnabled: boolean; catalogVisible: boolean } | null = null;
        let commerceError: string | null = null;
        try {
            commerce = await this.readCommerceSettings(channelId);
        } catch (err) {
            commerceError = err instanceof Error ? err.message : String(err);
        }
        return {
            channelId,
            onBusinessApp: (channel.credentials as { isOnBizApp?: boolean } | null)?.isOnBizApp === true,
            catalog,
            commerce,
            commerceError,
            items: Object.fromEntries(counts.map((c) => [c.status, c._count._all])),
            problems: errors.map((e) => ({
                variantId: e.variantId,
                name: `${e.variant.product.title}${e.variant.title && e.variant.title !== 'Default Title' ? ` – ${e.variant.title}` : ''}`,
                status: e.status,
                error: e.error,
            })),
        };
    }

    /** Check the id with Meta and remember it. */
    async connect(orgId: string, channelId: string, catalogId: string) {
        await this.channel(orgId, channelId);
        const id = catalogId.trim();
        if (!/^\d{5,25}$/.test(id)) throw new BadRequestException('A catalog id is the number shown in Commerce Manager.');
        const a = await this.access.get(channelId);
        let info: { id?: string; name?: string; product_count?: number };
        try {
            info = (
                await this.metaGraph.request<{ id?: string; name?: string; product_count?: number }>({
                    method: 'GET',
                    path: `/${id}`,
                    query: { fields: 'id,name,product_count' },
                    accessToken: a.token,
                    scopes: a.scopes,
                    priority: Priority.INTERACTIVE,
                    channelId,
                })
            ).data;
        } catch (err) {
            throw new BadRequestException(
                `Meta did not let this account read catalog ${id}: ${err instanceof Error ? err.message : err}. Connect the catalog to this WhatsApp account and give Collabo’s system user access to it in Business Settings.`,
            );
        }
        const state: CatalogState = { catalogId: id, name: info.name ?? null, productCount: info.product_count ?? null, connectedAt: new Date().toISOString() };
        await this.prisma.$executeRaw(patchChannelMetadataSql(channelId, 'catalog', state as unknown as Record<string, unknown>));
        return this.view(orgId, channelId);
    }

    async disconnect(orgId: string, channelId: string) {
        await this.channel(orgId, channelId);
        await this.prisma.$executeRaw(Prisma.sql`UPDATE "channels" SET "metadata" = "metadata" - 'catalog', "updated_at" = now() WHERE "id" = ${channelId}`);
        await this.prisma.catalogItem.deleteMany({ where: { channelId } });
        return this.view(orgId, channelId);
    }

    /** `POST /{phone_number_id}/whatsapp_commerce_settings`: the catalog icon in the chat header, and the cart. */
    async setCommerce(orgId: string, channelId: string, patch: { catalogVisible?: boolean; cartEnabled?: boolean }) {
        await this.channel(orgId, channelId);
        const a = await this.access.get(channelId);
        const query: Record<string, string> = {};
        if (patch.catalogVisible !== undefined) query.is_catalog_visible = String(patch.catalogVisible);
        if (patch.cartEnabled !== undefined) query.is_cart_enabled = String(patch.cartEnabled);
        if (!Object.keys(query).length) return this.view(orgId, channelId);
        await this.metaGraph.request({ method: 'POST', path: `/${a.address}/whatsapp_commerce_settings`, query, accessToken: a.token, scopes: a.scopes, priority: Priority.INTERACTIVE, channelId });
        return this.view(orgId, channelId);
    }

    /**
     * Push the store's active products to the catalog: changed items are
     * updated (Meta creates missing ones), products no longer for sale are
     * deleted, and anything Meta cannot list is reported with the reason.
     */
    async sync(orgId: string, channelId: string) {
        const channel = await this.channel(orgId, channelId);
        const catalog = this.state(channel.metadata);
        if (!catalog) throw new BadRequestException('Connect a catalog first.');
        const a = await this.access.get(channelId);

        const org = await this.prisma.organization.findUniqueOrThrow({
            where: { id: orgId },
            select: { name: true, currency: true, website: true, settings: { select: { storeProfileSettings: true } } },
        });
        const profileSite = ((org.settings?.storeProfileSettings ?? {}) as { website?: string }).website || org.website || null;
        const variants = await this.prisma.productVariant.findMany({
            where: { product: { organizationId: orgId, status: ProductStatus.ACTIVE } },
            include: {
                image: { select: { src: true } },
                product: {
                    include: {
                        channel: { select: { platform: true, externalStoreUrl: true, currency: true } },
                        images: { select: { src: true }, orderBy: { position: 'asc' }, take: 1 },
                        _count: { select: { variants: true } },
                    },
                },
            },
        });
        const existing = new Map((await this.prisma.catalogItem.findMany({ where: { channelId } })).map((i) => [i.variantId, i]));

        const requests: BatchRequest[] = [];
        const hashes = new Map<string, string>();
        const skipped: Array<{ variantId: string; reason: string }> = [];
        for (const v of variants) {
            const p = v.product;
            const storeUrl = p.channel.platform === ChannelPlatform.SHOPIFY ? (profileSite ?? p.channel.externalStoreUrl) : profileSite;
            const built = buildCatalogItem(
                {
                    id: v.id,
                    title: v.title,
                    price: v.price.toString(),
                    compareAtPrice: v.compareAtPrice?.toString() ?? null,
                    inventoryQuantity: v.inventoryQuantity,
                    trackQuantity: v.trackQuantity,
                    continueSellingWhenOutOfStock: v.continueSellingWhenOutOfStock,
                    imageSrc: v.image?.src ?? null,
                    product: {
                        id: p.id,
                        title: p.title,
                        handle: p.handle,
                        bodyHtml: p.bodyHtml,
                        vendor: p.vendor,
                        firstImageSrc: p.images[0]?.src ?? null,
                        variantCount: p._count.variants,
                        storeUrl,
                    },
                },
                p.channel.currency || org.currency,
                org.name,
            );
            if (!built.ok) {
                skipped.push({ variantId: v.id, reason: built.reason });
                continue;
            }
            const prior = existing.get(v.id);
            if (prior?.status === 'SYNCED' && prior.contentHash === built.hash) continue;
            requests.push({ method: 'UPDATE', data: built.data });
            hashes.set(v.id, built.hash);
        }
        const live = new Set(variants.map((v) => v.id));
        const removals = [...existing.values()].filter((i) => i.status === 'SYNCED' && (!live.has(i.variantId) || skipped.some((s) => s.variantId === i.variantId)));
        for (const r of removals) requests.push({ method: 'DELETE', data: { id: r.variantId } });

        const handles: string[] = [];
        const failed = new Map<string, string>();
        for (let i = 0; i < requests.length; i += BATCH_SIZE) {
            const chunk = requests.slice(i, i + BATCH_SIZE);
            let res: { handles?: string[]; validation_status?: Array<{ retailer_id?: string; errors?: Array<{ message?: string }> }> };
            try {
                res = (
                    await this.metaGraph.request<typeof res>({
                        method: 'POST',
                        path: `/${catalog.catalogId}/items_batch`,
                        body: { item_type: 'PRODUCT_ITEM', allow_upsert: true, requests: chunk },
                        accessToken: a.token,
                        scopes: a.scopes,
                        priority: Priority.NORMAL,
                        channelId,
                        timeoutMs: 60_000,
                    })
                ).data;
            } catch (err) {
                const message = err instanceof MetaGraphError ? err.message : String(err);
                throw new BadRequestException(`Meta refused the catalog update: ${message}`);
            }
            handles.push(...(res.handles ?? []));
            for (const v of res.validation_status ?? []) {
                const errors = (v.errors ?? []).map((e) => e.message).filter(Boolean);
                if (v.retailer_id && errors.length) failed.set(v.retailer_id, errors.join('; ').slice(0, 500));
            }
        }

        const now = new Date();
        await this.prisma.$transaction([
            ...[...hashes.entries()].map(([variantId, hash]) =>
                this.prisma.catalogItem.upsert({
                    where: { channelId_variantId: { channelId, variantId } },
                    create: { organizationId: orgId, channelId, variantId, status: failed.has(variantId) ? 'ERROR' : 'SYNCED', error: failed.get(variantId) ?? null, contentHash: failed.has(variantId) ? null : hash, syncedAt: now },
                    update: { status: failed.has(variantId) ? 'ERROR' : 'SYNCED', error: failed.get(variantId) ?? null, contentHash: failed.has(variantId) ? null : hash, syncedAt: now },
                }),
            ),
            ...skipped.map((s) =>
                this.prisma.catalogItem.upsert({
                    where: { channelId_variantId: { channelId, variantId: s.variantId } },
                    create: { organizationId: orgId, channelId, variantId: s.variantId, status: 'SKIPPED', error: s.reason },
                    update: { status: 'SKIPPED', error: s.reason, contentHash: null },
                }),
            ),
            ...removals
                .filter((r) => !skipped.some((s) => s.variantId === r.variantId))
                .map((r) => this.prisma.catalogItem.update({ where: { id: r.id }, data: { status: 'REMOVED', contentHash: null, syncedAt: now } })),
        ]);
        const lastSync = { at: now.toISOString(), sent: hashes.size, removed: removals.length, skipped: skipped.length, errors: failed.size, handles };
        await this.prisma.$executeRaw(patchChannelMetadataSql(channelId, 'catalog', { lastSync }));
        return { ...lastSync, view: await this.view(orgId, channelId) };
    }

    /**
     * Products for the inbox's product panel and tray, with what can be sent
     * where: one collection's in its Shopify order, or all of them by title.
     */
    async products(orgId: string, channelId: string | null, search: string | undefined, collectionId?: string) {
        const channel = channelId ? await this.prisma.channel.findFirst({ where: { id: channelId, organizationId: orgId }, select: { id: true, platform: true, metadata: true, credentials: true } }) : null;
        const catalog = channel?.platform === ChannelPlatform.WHATSAPP ? this.state(channel.metadata) : null;
        const term = search?.trim();
        const org = await this.prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { currency: true, website: true, settings: { select: { storeProfileSettings: true } } } });
        const profileSite = ((org.settings?.storeProfileSettings ?? {}) as { website?: string }).website || org.website || null;
        const matching: Prisma.ProductWhereInput = {
            organizationId: orgId,
            status: ProductStatus.ACTIVE,
            ...(term ? { OR: [{ title: { contains: term, mode: 'insensitive' } }, { vendor: { contains: term, mode: 'insensitive' } }] } : {}),
        };
        const place = collectionId
            ? new Map(
                (await this.prisma.productCollection.findMany({
                    where: { collectionId, collection: { organizationId: orgId }, product: matching },
                    orderBy: { position: 'asc' },
                    select: { productId: true },
                    take: PRODUCTS_SHOWN + 1,
                })).map((l, i) => [l.productId, i]),
            )
            : null;
        const found = await this.prisma.productVariant.findMany({
            where: { product: place ? { ...matching, id: { in: [...place.keys()] } } : matching },
            include: {
                image: { select: { src: true } },
                product: {
                    select: {
                        id: true,
                        title: true,
                        handle: true,
                        images: { select: { src: true }, orderBy: { position: 'asc' }, take: 1 },
                        channel: { select: { platform: true, externalStoreUrl: true, currency: true } },
                    },
                },
                ...(channel ? { catalogItems: { where: { channelId: channel.id }, select: { status: true } } } : {}),
            },
            orderBy: [{ product: { title: 'asc' } }, { position: 'asc' }],
            // A collection's products are already capped; their order is the collection's, sorted below.
            ...(place ? {} : { take: PRODUCTS_SHOWN + 1 }),
        });
        if (place) found.sort((a, b) => place.get(a.productId)! - place.get(b.productId)! || a.position - b.position);
        const rows = found.slice(0, PRODUCTS_SHOWN);
        const collections = await this.prisma.collection.findMany({
            where: { organizationId: orgId, products: { some: { product: { status: ProductStatus.ACTIVE } } } },
            select: {
                id: true,
                title: true,
                handle: true,
                channel: { select: { externalStoreUrl: true } },
                _count: { select: { products: { where: { product: { status: ProductStatus.ACTIVE } } } } },
            },
            orderBy: { title: 'asc' },
            take: 100,
        });
        const onBusinessApp = (channel?.credentials as { isOnBizApp?: boolean } | null)?.isOnBizApp === true;
        return {
            catalog: catalog ? { catalogId: catalog.catalogId, name: catalog.name } : null,
            canSendProducts: !!catalog && !onBusinessApp,
            collections: collections.map((c) => ({
                id: c.id,
                title: c.title,
                productCount: c._count.products,
                url: collectionUrl(profileSite ?? c.channel.externalStoreUrl, c.handle),
            })),
            more: found.length > PRODUCTS_SHOWN || (place?.size ?? 0) > PRODUCTS_SHOWN,
            products: rows.map((v) => {
                const storeUrl = v.product.channel.platform === ChannelPlatform.SHOPIFY ? (profileSite ?? v.product.channel.externalStoreUrl) : profileSite;
                const inCatalog = ((v as { catalogItems?: Array<{ status: string }> }).catalogItems ?? [])[0]?.status === 'SYNCED';
                return {
                    variantId: v.id,
                    productId: v.product.id,
                    title: v.product.title,
                    variantTitle: v.title && v.title !== 'Default Title' ? v.title : null,
                    price: v.price.toString(),
                    currency: v.product.channel.currency || org.currency,
                    image: v.image?.src ?? v.product.images[0]?.src ?? null,
                    url: productUrl(storeUrl, v.product.handle),
                    inStock: !v.trackQuantity || v.continueSellingWhenOutOfStock || v.inventoryQuantity > 0,
                    inCatalog,
                };
            }),
        };
    }

    /**
     * A product or product-list message for these variants, from the number's
     * catalog. Only items already synced can be sent: Meta drops ids it does
     * not know.
     */
    async productPayload(
        orgId: string,
        channelId: string,
        input: { variantIds: string[]; header?: string; text?: string; format?: 'list' | 'cards' },
    ): Promise<OutboundPayload> {
        const channel = await this.prisma.channel.findFirst({ where: { id: channelId, organizationId: orgId }, select: { platform: true, metadata: true } });
        if (channel?.platform !== ChannelPlatform.WHATSAPP) throw new BadRequestException('Products from the catalog can be sent on WhatsApp only. Share a link instead.');
        const catalog = this.state(channel.metadata);
        if (!catalog) throw new BadRequestException('Connect a catalog to this number first (Campaigns → Catalog).');
        const ids = [...new Set(input.variantIds)];
        const items = await this.prisma.catalogItem.findMany({
            where: { channelId, variantId: { in: ids }, status: 'SYNCED', variant: { product: { organizationId: orgId } } },
            select: { variantId: true, variant: { select: { title: true, product: { select: { title: true } } } } },
        });
        const synced = new Map(items.map((i) => [i.variantId, i]));
        const missing = ids.filter((id) => !synced.has(id));
        if (missing.length) throw new BadRequestException(`${missing.length === 1 ? 'A product is' : `${missing.length} products are`} not in the catalog yet. Sync the catalog first.`);
        if (ids.length === 1) {
            const one = synced.get(ids[0])!;
            return { type: 'product', catalogId: catalog.catalogId, productRetailerId: ids[0], text: input.text?.trim() || undefined, name: one.variant.product.title };
        }
        if (input.format === 'cards' && ids.length <= 10) {
            return { type: 'product_carousel', catalogId: catalog.catalogId, text: input.text?.trim() || 'Have a look at these.', productRetailerIds: ids };
        }
        const header = input.header?.trim() || 'Picked for you';
        return {
            type: 'product_list',
            catalogId: catalog.catalogId,
            header,
            text: input.text?.trim() || 'Tap to see the products.',
            // Meta: a section title is at most 24 characters.
            sections: [{ title: (input.header?.trim() || 'Products').slice(0, 24).trim(), productRetailerIds: ids }],
        };
    }

    private async readCommerceSettings(channelId: string) {
        const a = await this.access.get(channelId);
        const res = await this.metaGraph.request<{ data?: Array<{ is_cart_enabled?: boolean; is_catalog_visible?: boolean }> }>({
            method: 'GET',
            path: `/${a.address}/whatsapp_commerce_settings`,
            accessToken: a.token,
            scopes: a.scopes,
            priority: Priority.INTERACTIVE,
            channelId,
        });
        const row = res.data.data?.[0] ?? {};
        return { cartEnabled: row.is_cart_enabled ?? true, catalogVisible: row.is_catalog_visible ?? false };
    }

    private state(metadata: Prisma.JsonValue | null): CatalogState | null {
        const c = (metadata as { catalog?: CatalogState } | null)?.catalog;
        return c?.catalogId ? c : null;
    }

    private async channel(orgId: string, channelId: string) {
        const channel = await this.prisma.channel.findFirst({
            where: { id: channelId, organizationId: orgId, platform: ChannelPlatform.WHATSAPP },
            select: { id: true, metadata: true, credentials: true },
        });
        if (!channel) throw new NotFoundException('WhatsApp number not found');
        return channel;
    }
}
