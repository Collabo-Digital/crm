import { buildCatalogItem, productUrl, type VariantForCatalog } from './catalog.util';

const variant = (over: Partial<VariantForCatalog> = {}, product: Partial<VariantForCatalog['product']> = {}): VariantForCatalog => ({
    id: 'var_1',
    title: 'M / Blue',
    price: '1199.00',
    compareAtPrice: '1499.00',
    inventoryQuantity: 0,
    trackQuantity: true,
    continueSellingWhenOutOfStock: false,
    imageSrc: null,
    product: {
        id: 'prod_1',
        title: 'Linen shirt',
        handle: 'linen-shirt',
        bodyHtml: '<p>Breathable &amp; soft</p>',
        vendor: null,
        firstImageSrc: 'https://cdn.example/shirt.jpg',
        variantCount: 3,
        storeUrl: 'https://acme.myshopify.com/',
        ...product,
    },
    ...over,
});

describe('buildCatalogItem', () => {
    it('maps a variant to Meta’s catalog fields, with the variant id as retailer id', () => {
        const r = buildCatalogItem(variant(), 'INR', 'Acme Store');
        expect(r.ok && r.data).toEqual({
            id: 'var_1',
            item_group_id: 'prod_1',
            title: 'Linen shirt – M / Blue',
            description: 'Breathable & soft',
            availability: 'out of stock',
            condition: 'new',
            price: '1499.00 INR',
            sale_price: '1199.00 INR',
            link: 'https://acme.myshopify.com/products/linen-shirt',
            image: [{ url: 'https://cdn.example/shirt.jpg' }],
            brand: 'Acme Store',
        });
    });

    it('says why a variant cannot be listed', () => {
        expect(buildCatalogItem(variant({}, { handle: null }), 'INR', 'x')).toMatchObject({ ok: false, reason: expect.stringContaining('link') });
        expect(buildCatalogItem(variant({}, { firstImageSrc: null }), 'INR', 'x')).toMatchObject({ ok: false, reason: 'Add a product image.' });
        expect(buildCatalogItem(variant({ price: '0' }), 'INR', 'x')).toMatchObject({ ok: false });
    });

    it('treats untracked or oversellable stock as available, and hashes the content', () => {
        const a = buildCatalogItem(variant({ trackQuantity: false }), 'INR', 'x');
        const b = buildCatalogItem(variant({ trackQuantity: false }), 'INR', 'x');
        expect(a.ok && a.data.availability).toBe('in stock');
        expect(a.ok && b.ok && a.hash === b.hash).toBe(true);
        expect(productUrl('https://shop.example', 'a b')).toBe('https://shop.example/products/a%20b');
    });
});
