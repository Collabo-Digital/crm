import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PosCatalogService } from './pos-catalog.service';

/**
 * What the billing screen reads. The database queries themselves were run
 * against Postgres while building this; these pin the rules around them.
 */

const ORG = 'org_1';

function variant(id: string, over: Record<string, unknown> = {}) {
    return {
        id, title: 'Default Title', sku: `SKU-${id}`, barcode: null, price: new Prisma.Decimal(100), inventoryQuantity: 7,
        trackQuantity: true, continueSellingWhenOutOfStock: false, image: null,
        product: { id: `p_${id}`, title: `Product ${id}`, images: [{ src: `https://cdn/${id}.jpg` }], channel: { currency: 'INR' } },
        ...over,
    };
}

function build(opts: { warehousing?: boolean; warehouses?: any[]; variants?: any[]; rate?: number | null; posSettings?: unknown } = {}) {
    const warehouses = opts.warehouses ?? [
        { id: 'wh_mg', name: 'MG Road', code: 'MG', kind: 'STORE', isDefault: true, isActive: true, address: { stateCode: '29' }, gstin: { stateCode: '29', isActive: true } },
        { id: 'wh_ko', name: 'Kochi', code: 'KO', kind: 'STORE', isDefault: false, isActive: true, address: { stateCode: '32' }, gstin: null },
    ];
    // The where clauses the service sends: org-scoped by construction here, so
    // only the active, kind and id filters matter, default first.
    const matching = (where: any) =>
        warehouses
            .filter((w) => (where.kind === undefined || w.kind === where.kind) && (where.isActive === undefined || w.isActive === where.isActive) && (where.id === undefined || w.id === where.id))
            .sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
    const prisma: any = {
        organizationSettings: { findUnique: jest.fn().mockResolvedValue({ posSettings: opts.posSettings ?? null }), upsert: jest.fn() },
        organization: { findUnique: jest.fn().mockResolvedValue({ name: 'Acme Pvt Ltd', gstEnabled: true, currency: 'INR' }) },
        warehouse: {
            findMany: jest.fn(async ({ where }: any) => matching(where)),
            findFirst: jest.fn(async ({ where }: any) => matching(where)[0] ?? null),
        },
        productVariant: {
            findMany: jest.fn().mockResolvedValue(opts.variants ?? []),
            findFirst: jest.fn().mockResolvedValue(null),
        },
        stockLevel: { groupBy: jest.fn().mockResolvedValue([{ variantId: 'v1', _sum: { available: 3 } }]) },
        $queryRaw: jest.fn().mockResolvedValue([]),
        customer: { findMany: jest.fn().mockResolvedValue([]) },
        channelContact: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = new PosCatalogService(
        prisma,
        {
            getStoreProfileSettings: jest.fn().mockResolvedValue({ storeName: '', logoUrl: '' }),
            getProductSettings: jest.fn().mockResolvedValue({ trackQuantityGlobally: false, allowOversellGlobally: false }),
        } as any,
        { isWarehousingEnabled: jest.fn().mockResolvedValue(opts.warehousing ?? true) } as any,
        { getRate: jest.fn().mockResolvedValue(opts.rate ?? null) } as any,
        { list: jest.fn().mockResolvedValue([]) } as any,
    );
    return { service, prisma };
}

describe('PosCatalogService stores', () => {
    it('without warehouses there is one store, the org itself', async () => {
        const { service } = build({ warehousing: false });
        const setup = await service.setup(ORG);
        expect(setup.stores).toEqual([{ id: 'default', name: 'Acme Pvt Ltd', code: null, isDefault: true }]);
        expect(setup.warehousingEnabled).toBe(false);
        await expect(service.resolveStore(ORG, 'wh_mg')).rejects.toThrow("This store isn't available. Pick one from the list.");
    });

    it('a store’s GST state is its registration’s, else its address’s', async () => {
        const { service } = build();
        expect(await service.resolveStore(ORG)).toEqual({ id: 'wh_mg', warehouseId: 'wh_mg', name: 'MG Road', stateCode: '29' });
        expect((await service.resolveStore(ORG, 'wh_ko')).stateCode).toBe('32');
        await expect(service.resolveStore(ORG, 'wh_other_org')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('with no default warehouse the till still opens, on the first store', async () => {
        const { service, prisma } = build({ warehouses: [{ id: 'wh_ko', name: 'Kochi', code: 'KO', kind: 'STORE', isDefault: false, isActive: true, address: null, gstin: null }] });
        const setup = await service.setup(ORG);
        expect(setup.stores.map((s) => s.id)).toEqual(['wh_ko']);
        expect(prisma.warehouse.findFirst.mock.calls.at(-1)[0].where.id).toBe('wh_ko');
    });
});

describe('PosCatalogService stores are Store locations only', () => {
    const MAIN = { id: 'wh_main', name: 'Main warehouse', code: 'WH1', kind: 'WAREHOUSE', isDefault: true, isActive: true, address: { stateCode: '29' }, gstin: null };
    const KOCHI = { id: 'wh_ko', name: 'Kochi', code: 'KO', kind: 'STORE', isDefault: false, isActive: true, address: { stateCode: '32' }, gstin: null };

    it('lists only Store locations, and never falls back to a Warehouse — not even the default', async () => {
        const { service } = build({ warehouses: [MAIN, KOCHI] });
        const setup = await service.setup(ORG);
        expect(setup.stores.map((s) => s.id)).toEqual(['wh_ko']);
        expect((await service.resolveStore(ORG)).id).toBe('wh_ko');
        await expect(service.resolveStore(ORG, 'wh_main')).rejects.toThrow("This store isn't available. Pick one from the list.");
    });

    it('with no Store location there is nothing to bill at', async () => {
        const { service } = build({ warehouses: [MAIN], posSettings: { tileVariantIds: ['v1'] }, variants: [variant('v1')] });
        const setup = await service.setup(ORG);
        expect(setup.stores).toEqual([]);
        expect(setup.tiles).toEqual([]);
        await expect(service.resolveStore(ORG)).rejects.toThrow('Add a store location before billing.');
        // The store a till last used — the workspace itself, or what is now a
        // Warehouse — still opens it, to say so.
        expect((await service.setup(ORG, 'default')).stores).toEqual([]);
        expect((await service.setup(ORG, 'wh_main')).stores).toEqual([]);
    });
});

describe('PosCatalogService products', () => {
    it('shows stock at the store, none for an untracked product, and the variant’s own image first', async () => {
        const { service } = build({
            variants: [variant('v1'), variant('v2', { trackQuantity: false, image: { src: 'https://cdn/v2-red.jpg' }, title: 'Red' })],
        });
        const out = await service.products(ORG, { search: 'product', storeId: 'wh_mg' });
        expect(out.map((p) => [p.variantId, p.stockAtStore, p.trackQuantity, p.imageUrl, p.variantTitle])).toEqual([
            ['v1', 3, true, 'https://cdn/v1.jpg', null],
            ['v2', null, false, 'https://cdn/v2-red.jpg', 'Red'],
        ]);
    });

    it('puts an exact barcode or SKU first and lists each product once', async () => {
        const { service, prisma } = build();
        prisma.productVariant.findMany
            .mockResolvedValueOnce([variant('v2')])
            .mockResolvedValueOnce([variant('v1'), variant('v2')]);
        const out = await service.products(ORG, { search: 'SKU-v2' });
        expect(out.map((p) => p.variantId)).toEqual(['v2', 'v1']);
    });

    it('needs every word searched for to match, and only sells active products', async () => {
        const { service, prisma } = build();
        await service.products(ORG, { search: 'linen  shirt' });
        const where = prisma.productVariant.findMany.mock.calls.at(-1)[0].where;
        expect(where.AND).toHaveLength(3);
        expect(where.AND[0]).toEqual({ product: { organizationId: ORG, status: 'ACTIVE', deletedAt: null } });
    });

    it('restates a price in another currency, and shows it as it is when no rate is to be had', async () => {
        const usd = variant('v1', { product: { ...variant('v1').product, channel: { currency: 'USD' } } });
        const priced = build({ variants: [usd], rate: 83.5 });
        expect((await priced.service.products(ORG, {}))[0].price).toBe(8350);
        const unpriced = build({ variants: [usd], rate: null });
        expect((await unpriced.service.products(ORG, {}))[0].price).toBe(100);
    });

    it('a code nobody has is a 404 in a sentence', async () => {
        const { service } = build();
        await expect(service.scan(ORG, '0000')).rejects.toThrow(new NotFoundException('No product has this barcode or SKU.'));
        await expect(service.scan(ORG, '  ')).rejects.toBeInstanceOf(BadRequestException);
    });
});

describe('PosCatalogService customers', () => {
    it('needs at least 3 characters', async () => {
        const { service, prisma } = build();
        expect(await service.customers(ORG, 'as')).toEqual([]);
        expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('returns them in search order, opted in when their WhatsApp contact is', async () => {
        const { service, prisma } = build();
        prisma.$queryRaw.mockResolvedValue([{ id: 'c2' }, { id: 'c1' }]);
        prisma.customer.findMany.mockResolvedValue([
            { id: 'c1', firstName: 'Asha', lastName: null, phone: '9800000001', email: null, gstin: null, ordersCount: 1, totalSpent: new Prisma.Decimal('500'), vipLevel: 'NONE', defaultAddress: null },
            { id: 'c2', firstName: 'Ashok', lastName: 'Rao', phone: '+919800000002', email: 'a@b.c', gstin: null, ordersCount: 5, totalSpent: new Prisma.Decimal('9000.50'), vipLevel: 'GOLD', defaultAddress: null },
        ]);
        prisma.channelContact.findMany.mockResolvedValue([{ customerId: null, waId: '919800000001' }]);
        const out = await service.customers(ORG, '98000');
        expect(out).toEqual([
            { id: 'c2', name: 'Ashok Rao', phone: '+919800000002', email: 'a@b.c', gstin: null, ordersCount: 5, totalSpent: 9000.5, vipLevel: 'GOLD', whatsappOptIn: false },
            { id: 'c1', name: 'Asha', phone: '9800000001', email: null, gstin: null, ordersCount: 1, totalSpent: 500, vipLevel: 'NONE', whatsappOptIn: true },
        ]);
    });
});

describe('PosCatalogService settings', () => {
    it('merges a patch over what is saved', async () => {
        const { service, prisma } = build({ posSettings: { roundOff: false, upiId: 'shop@okicici' } });
        const next = await service.updateSettings(ORG, { requireStaffPin: true });
        expect(next).toMatchObject({ roundOff: false, upiId: 'shop@okicici', requireStaffPin: true });
        expect(prisma.organizationSettings.upsert.mock.calls[0][0].update.posSettings).toMatchObject({ roundOff: false, requireStaffPin: true });
    });
});
