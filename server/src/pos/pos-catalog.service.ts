import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ChannelPlatform, Prisma, ProductStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { OrganizationSettingsService } from '../organization-settings/organization-settings.service';
import { InventoryLedgerService } from '../inventory/inventory-ledger.service';
import { FxRateService } from '../common/fx/fx-rate.service';
import { countryCodeOf, normalizePhone } from '../common/phone.util';
import { extractStateFromAddress } from '../gst/place-of-supply.util';
import { displayVariantTitle } from '../product/variant-title.util';
import { PosSettings, PosSettingsSchema, UpdatePosSettingsInput, parsePosSettings } from './pos-settings.schema';
import { PosStaffService } from './pos-staff.service';
import { round2 } from './pos-pricing';

export type PosStore = { id: string; name: string; code: string | null; isDefault: boolean };
export type PosProduct = {
    variantId: string;
    productId: string;
    title: string;
    variantTitle: string | null;
    sku: string | null;
    barcode: string | null;
    price: number;
    imageUrl: string | null;
    stockAtStore: number | null;
    trackQuantity: boolean;
    allowOversell: boolean;
};

/** The store a bill is rung up at: a warehouse, or the org itself when it has no warehouses. */
export interface PosStoreContext {
    id: string;
    /** Null for the org without warehousing: stock is one number per variant. */
    warehouseId: string | null;
    name: string;
    /** The store's GST state, the place of supply of an over-the-counter sale. */
    stateCode: string | null;
}

export const DEFAULT_STORE_ID = 'default';

const variantSelect = {
    id: true,
    title: true,
    sku: true,
    barcode: true,
    price: true,
    inventoryQuantity: true,
    trackQuantity: true,
    continueSellingWhenOutOfStock: true,
    image: { select: { src: true } },
    product: {
        select: {
            id: true,
            title: true,
            images: { orderBy: { position: 'asc' as const }, take: 1, select: { src: true } },
            channel: { select: { currency: true } },
        },
    },
} satisfies Prisma.ProductVariantSelect;
export type PosVariantRow = Prisma.ProductVariantGetPayload<{ select: typeof variantSelect }>;

/** What the counter may sell: active products of the org, never the hidden custom-item product. */
const sellable = (orgId: string): Prisma.ProductVariantWhereInput => ({
    product: { organizationId: orgId, status: ProductStatus.ACTIVE, deletedAt: null },
});

/**
 * What the billing screen reads: its settings, the stores it can bill from,
 * products by search or scan, and customers.
 */
@Injectable()
export class PosCatalogService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly orgSettings: OrganizationSettingsService,
        private readonly ledger: InventoryLedgerService,
        private readonly fx: FxRateService,
        private readonly staff: PosStaffService,
    ) { }

    async settings(orgId: string): Promise<PosSettings> {
        const row = await this.prisma.organizationSettings.findUnique({ where: { organizationId: orgId }, select: { posSettings: true } });
        return parsePosSettings(row?.posSettings ?? null);
    }

    async updateSettings(orgId: string, patch: UpdatePosSettingsInput): Promise<PosSettings> {
        const next = PosSettingsSchema.parse({ ...(await this.settings(orgId)), ...patch });
        const json = next as unknown as Prisma.InputJsonObject;
        await this.prisma.organizationSettings.upsert({
            where: { organizationId: orgId },
            create: { organizationId: orgId, posSettings: json },
            update: { posSettings: json },
        });
        return next;
    }

    async setup(orgId: string, storeId?: string) {
        const [settings, org, profile, warehousing, staff] = await Promise.all([
            this.settings(orgId),
            this.prisma.organization.findUnique({ where: { id: orgId }, select: { name: true, gstEnabled: true, currency: true } }),
            this.orgSettings.getStoreProfileSettings(orgId),
            this.ledger.isWarehousingEnabled(orgId),
            this.staff.list(orgId, false),
        ]);
        if (!org) throw new NotFoundException('Organization not found');
        const storeName = profile.storeName.trim() || org.name;
        const stores: PosStore[] = warehousing
            ? (
                await this.prisma.warehouse.findMany({
                    where: { organizationId: orgId, isActive: true },
                    orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
                    select: { id: true, name: true, code: true, isDefault: true },
                })
            ).map((w) => ({ id: w.id, name: w.name, code: w.code, isDefault: w.isDefault }))
            : [{ id: DEFAULT_STORE_ID, name: storeName, code: null, isDefault: true }];
        // With no default warehouse the first store stands in, so the till still opens.
        const store = await this.resolveStore(orgId, storeId ?? stores[0]?.id);

        const tileRows = settings.tileVariantIds.length
            ? await this.prisma.productVariant.findMany({ where: { ...sellable(orgId), id: { in: settings.tileVariantIds } }, select: variantSelect })
            : [];
        const tiles = await this.toPosProducts(orgId, tileRows, store);
        const order = new Map(settings.tileVariantIds.map((id, i) => [id, i]));
        tiles.sort((a, b) => order.get(a.variantId)! - order.get(b.variantId)!);

        return {
            settings,
            stores,
            warehousingEnabled: warehousing,
            staff,
            tiles,
            gstEnabled: org.gstEnabled,
            storeName,
            currency: (org.currency || 'INR').toUpperCase(),
        };
    }

    /** The store a request names, or the default one; refuses a store that is not this org's or is switched off. */
    async resolveStore(orgId: string, storeId?: string | null): Promise<PosStoreContext> {
        const warehousing = await this.ledger.isWarehousingEnabled(orgId);
        const wanted = storeId && storeId !== DEFAULT_STORE_ID ? storeId : null;
        if (!warehousing) {
            if (wanted) throw new BadRequestException("This store isn't available. Pick one from the list.");
            const [org, profile] = await Promise.all([
                this.prisma.organization.findUnique({ where: { id: orgId }, select: { name: true } }),
                this.orgSettings.getStoreProfileSettings(orgId),
            ]);
            return { id: DEFAULT_STORE_ID, warehouseId: null, name: profile.storeName.trim() || org?.name || '', stateCode: null };
        }
        const warehouse = await this.prisma.warehouse.findFirst({
            where: { organizationId: orgId, isActive: true, ...(wanted ? { id: wanted } : { isDefault: true }) },
            select: { id: true, name: true, address: true, gstin: { select: { stateCode: true, isActive: true } } },
        });
        if (!warehouse) {
            throw new BadRequestException(
                wanted ? "This store isn't available. Pick one from the list." : 'Set a default warehouse under Products → Inventory → Warehouses, or pick a store.',
            );
        }
        const stateCode = (warehouse.gstin?.isActive ? warehouse.gstin.stateCode : null) ?? extractStateFromAddress(warehouse.address);
        return { id: warehouse.id, warehouseId: warehouse.id, name: warehouse.name, stateCode };
    }

    /**
     * Active products whose title, variant title, SKU or barcode contain every
     * word searched for; an exact barcode or SKU comes first.
     */
    async products(orgId: string, query: { search?: string; storeId?: string; limit?: number }): Promise<PosProduct[]> {
        const store = await this.resolveStore(orgId, query.storeId);
        const limit = Math.min(Math.max(Number(query.limit) || 20, 1), 50);
        const term = (query.search ?? '').trim();
        const words = term.split(/\s+/).filter(Boolean).slice(0, 6);
        const exact = term
            ? await this.prisma.productVariant.findMany({ where: { ...sellable(orgId), OR: [{ barcode: term }, { sku: term }] }, select: variantSelect, take: limit })
            : [];
        const rest = await this.prisma.productVariant.findMany({
            where: {
                AND: [
                    sellable(orgId),
                    ...words.map((w) => {
                        const like = { contains: w, mode: 'insensitive' as const };
                        return { OR: [{ product: { title: like } }, { title: like }, { sku: like }, { barcode: like }] };
                    }),
                ],
            },
            select: variantSelect,
            orderBy: [{ product: { title: 'asc' } }, { position: 'asc' }],
            take: limit + exact.length,
        });
        const seen = new Set<string>();
        const rows = [...exact, ...rest].filter((v) => !seen.has(v.id) && seen.add(v.id)).slice(0, limit);
        return this.toPosProducts(orgId, rows, store);
    }

    /** The product with this exact barcode, else this SKU. */
    async scan(orgId: string, code: string | undefined, storeId?: string): Promise<PosProduct> {
        const trimmed = (code ?? '').trim();
        if (!trimmed) throw new BadRequestException('Scan or type a barcode or SKU.');
        const store = await this.resolveStore(orgId, storeId);
        const find = (where: Prisma.ProductVariantWhereInput) =>
            this.prisma.productVariant.findFirst({ where: { ...sellable(orgId), ...where }, select: variantSelect, orderBy: { createdAt: 'asc' } });
        const variant =
            (await find({ barcode: trimmed })) ??
            (await find({ sku: trimmed })) ??
            (await find({ sku: { equals: trimmed, mode: 'insensitive' } }));
        if (!variant) throw new NotFoundException('No product has this barcode or SKU.');
        return (await this.toPosProducts(orgId, [variant], store))[0];
    }

    /** Up to 8 customers by phone digits, or by name or email. */
    async customers(orgId: string, search: string | undefined) {
        const term = (search ?? '').trim();
        if (term.length < 3) return [];
        const digits = term.replace(/\D/g, '');
        const byPhone = digits.length >= 3 && !/\p{L}/u.test(term);
        // The last ten digits find a number saved with or without its country code.
        const phoneDigits = byPhone && digits.length > 10 ? digits.slice(-10) : digits;
        const like = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        const ids = await this.prisma.$queryRaw<Array<{ id: string }>>`
            SELECT "id" FROM "customers"
            WHERE "organization_id" = ${orgId}
              AND "deleted_at" IS NULL
              AND ${byPhone
                ? Prisma.sql`regexp_replace(coalesce("phone", ''), '\\D', '', 'g') LIKE ${`%${phoneDigits}%`}`
                : Prisma.sql`(concat_ws(' ', "first_name", "last_name") ILIKE ${like} OR "email" ILIKE ${like})`}
            ORDER BY "orders_count" DESC, "updated_at" DESC
            LIMIT 8
        `;
        if (!ids.length) return [];
        const rows = await this.prisma.customer.findMany({
            where: { id: { in: ids.map((r) => r.id) } },
            select: {
                id: true, firstName: true, lastName: true, phone: true, email: true, gstin: true,
                ordersCount: true, totalSpent: true, vipLevel: true, defaultAddress: true,
            },
        });
        const optedIn = await this.whatsappOptedIn(orgId, rows);
        const rank = new Map(ids.map((r, i) => [r.id, i]));
        return rows
            .sort((a, b) => rank.get(a.id)! - rank.get(b.id)!)
            .map((c) => ({
                id: c.id,
                name: [c.firstName, c.lastName].filter(Boolean).join(' ') || null,
                phone: c.phone,
                email: c.email,
                gstin: c.gstin,
                ordersCount: c.ordersCount,
                totalSpent: Number(c.totalSpent),
                vipLevel: c.vipLevel,
                whatsappOptIn: optedIn.has(c.id),
            }));
    }

    /** The PosProduct shape: catalogue price in the org's currency, stock at the store. */
    async toPosProducts(orgId: string, variants: PosVariantRow[], store: PosStoreContext): Promise<PosProduct[]> {
        if (!variants.length) return [];
        const [productSettings, org] = await Promise.all([
            this.orgSettings.getProductSettings(orgId),
            this.prisma.organization.findUnique({ where: { id: orgId }, select: { currency: true } }),
        ]);
        // Shown unconverted when no rate is to be had, as the product list does.
        const prices = await this.cataloguePrices((org?.currency || 'INR').toUpperCase(), variants);
        const trackGlobally = productSettings.trackQuantityGlobally === true;
        const oversellGlobally = productSettings.allowOversellGlobally === true;
        const stockAt = new Map<string, number>();
        if (store.warehouseId) {
            const levels = await this.prisma.stockLevel.groupBy({
                by: ['variantId'],
                where: { warehouseId: store.warehouseId, variantId: { in: variants.map((v) => v.id) } },
                _sum: { available: true },
            });
            for (const l of levels) stockAt.set(l.variantId, l._sum.available ?? 0);
        }
        return variants.map((v, i) => {
            const tracked = trackGlobally || v.trackQuantity !== false;
            return {
                variantId: v.id,
                productId: v.product.id,
                title: v.product.title,
                variantTitle: displayVariantTitle(v.title),
                sku: v.sku,
                barcode: v.barcode,
                price: prices[i] ?? round2(Number(v.price)),
                imageUrl: v.image?.src ?? v.product.images[0]?.src ?? null,
                stockAtStore: !tracked ? null : store.warehouseId ? (stockAt.get(v.id) ?? 0) : v.inventoryQuantity,
                trackQuantity: tracked,
                allowOversell: oversellGlobally || v.continueSellingWhenOutOfStock === true,
            };
        });
    }

    /**
     * Catalogue prices restated in the org's currency at today's rate, as the
     * offline order form prices them; null where no rate is to be had.
     */
    async cataloguePrices(
        orgCurrency: string,
        variants: Array<{ price: Prisma.Decimal | number; product: { channel: { currency: string | null } | null } }>,
    ): Promise<Array<number | null>> {
        const rates = new Map<string, number | null>([[orgCurrency, 1]]);
        const sourceOf = (v: (typeof variants)[number]) => (v.product.channel?.currency ?? orgCurrency).toUpperCase();
        for (const v of variants) {
            const source = sourceOf(v);
            if (!rates.has(source)) rates.set(source, await this.fx.getRate(source, orgCurrency, new Date()));
        }
        return variants.map((v) => {
            const rate = rates.get(sourceOf(v));
            return rate == null ? null : round2(Number(v.price) * rate);
        });
    }

    /** The customers among these with a WhatsApp opt-in on record that they have not withdrawn. */
    private async whatsappOptedIn(
        orgId: string,
        customers: Array<{ id: string; phone: string | null; defaultAddress: Prisma.JsonValue | null }>,
    ): Promise<Set<string>> {
        const byDigits = new Map<string, string>();
        for (const c of customers) {
            const e164 = normalizePhone(c.phone, countryCodeOf(c.defaultAddress) ?? 'IN');
            if (e164) byDigits.set(e164.replace(/^\+/, ''), c.id);
        }
        const contacts = await this.prisma.channelContact.findMany({
            where: {
                organizationId: orgId,
                platform: ChannelPlatform.WHATSAPP,
                optInAt: { not: null },
                optedOutAt: null,
                blockedAt: null,
                OR: [{ customerId: { in: customers.map((c) => c.id) } }, { waId: { in: [...byDigits.keys()] } }],
            },
            select: { customerId: true, waId: true },
        });
        const ids = new Set<string>();
        for (const contact of contacts) {
            if (contact.customerId) ids.add(contact.customerId);
            const viaPhone = contact.waId ? byDigits.get(contact.waId) : undefined;
            if (viaPhone) ids.add(viaPhone);
        }
        return ids;
    }
}
