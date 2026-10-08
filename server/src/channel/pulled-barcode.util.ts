import type { BarcodeSource } from '@prisma/client';

export interface PriorBarcode {
  barcode: string | null;
  barcodeSource: BarcodeSource | null;
}

/**
 * What a Shopify pull may write to a variant's `barcode` / `barcodeSource`.
 * `{}` means "leave both columns alone" (Prisma's `undefined` idiom).
 *
 * Barcode is the one variant field Shopify is NOT unconditionally
 * authoritative for, because the CRM mints codes of its own for labels:
 *
 *   - Incoming empty, local GENERATED → keep ours. A Shopify variant with no
 *     barcode used to null the local value, and labels already stuck on
 *     stock stopped resolving. Only GENERATED is protected: a merchant who
 *     clears a Shopify-sourced barcode still has that respected.
 *   - Incoming equals what we hold → keep ours, provenance included. This is
 *     the round-trip case: the push sent our GENERATED (or MANUAL) code,
 *     Shopify echoed it back on `products/update`, and the value has not
 *     changed. Rewriting the source to SHOPIFY here would, on the first
 *     successful push, reclassify an entire catalogue of generated codes as
 *     real GTINs — after which "Shorten long barcodes" stops seeing them, the
 *     `pushGeneratedBarcodes` gate stops applying, and the setting's backlog
 *     sweep no longer matches them.
 *   - Anything else → Shopify wins: a different code arriving from there is
 *     the merchant's (or a GTIN's) and outranks an internal one.
 */
export function pulledBarcodePatch(
  incomingRaw: string | null | undefined,
  prior: PriorBarcode | undefined,
): { barcode?: string | null; barcodeSource?: BarcodeSource | null } {
  const incoming = incomingRaw || null;
  if (incoming === null && prior?.barcodeSource === 'GENERATED') return {};
  if (incoming !== null && prior && (prior.barcode || null) === incoming) return {};
  return { barcode: incoming, barcodeSource: incoming ? 'SHOPIFY' : null };
}
