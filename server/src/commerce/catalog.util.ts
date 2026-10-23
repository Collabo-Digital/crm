import { createHash } from 'node:crypto';

/**
 * One product variant as a Meta catalog item (Catalog Batch API, item type
 * PRODUCT_ITEM). The item `id` — WhatsApp's product_retailer_id — is our
 * variant id, so carts and product messages map straight back. Pure.
 */

export interface VariantForCatalog {
    id: string;
    title: string;
    price: string;
    compareAtPrice: string | null;
    inventoryQuantity: number;
    trackQuantity: boolean;
    continueSellingWhenOutOfStock: boolean;
    imageSrc: string | null;
    product: {
        id: string;
        title: string;
        handle: string | null;
        bodyHtml: string | null;
        vendor: string | null;
        firstImageSrc: string | null;
        variantCount: number;
        storeUrl: string | null;
    };
}

export type CatalogItemData = Record<string, unknown>;

export type BuildResult = { ok: true; data: CatalogItemData; hash: string } | { ok: false; reason: string };

const strip = (html: string) =>
    html
        .replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim();

export function productUrl(storeUrl: string | null, handle: string | null): string | null {
    if (!storeUrl || !handle) return null;
    return `${storeUrl.replace(/\/+$/, '')}/products/${encodeURIComponent(handle)}`;
}

export function buildCatalogItem(v: VariantForCatalog, currency: string, brandFallback: string): BuildResult {
    const link = productUrl(v.product.storeUrl, v.product.handle);
    if (!link) return { ok: false, reason: 'No product page link (products synced from Shopify have one).' };
    const image = v.imageSrc ?? v.product.firstImageSrc;
    if (!image) return { ok: false, reason: 'Add a product image.' };
    const price = Number(v.price);
    if (!Number.isFinite(price) || price <= 0) return { ok: false, reason: 'Set a price above zero.' };

    const variantName = v.product.variantCount > 1 && v.title && v.title !== 'Default Title' ? ` – ${v.title}` : '';
    const compare = v.compareAtPrice ? Number(v.compareAtPrice) : NaN;
    const onSale = Number.isFinite(compare) && compare > price;
    const money = (n: number) => `${n.toFixed(2)} ${currency}`;
    const inStock = !v.trackQuantity || v.continueSellingWhenOutOfStock || v.inventoryQuantity > 0;
    const data: CatalogItemData = {
        id: v.id,
        item_group_id: v.product.id,
        title: `${v.product.title}${variantName}`.slice(0, 100),
        description: (strip(v.product.bodyHtml ?? '') || v.product.title).slice(0, 5000),
        availability: inStock ? 'in stock' : 'out of stock',
        condition: 'new',
        // The full price is `price`; a lower selling price is `sale_price`.
        price: money(onSale ? compare : price),
        ...(onSale ? { sale_price: money(price) } : {}),
        link,
        image: [{ url: image }],
        brand: (v.product.vendor || brandFallback).slice(0, 100),
    };
    return { ok: true, data, hash: createHash('sha1').update(JSON.stringify(data)).digest('hex') };
}
