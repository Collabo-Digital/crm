import { Prisma } from '@prisma/client';

/** The push record the orders LIST hands the page, read off `Order.metadata`. */
export interface OrderShopifySyncSummary {
  status: 'PENDING' | 'SYNCED' | 'FAILED';
  shopifyOrderId?: string;
  shopifyOrderName?: string;
  error?: string;
  syncedAt?: string;
  /** When the PENDING claim was stamped; lets the page spot an abandoned one. */
  queuedAt?: string;
  attempts?: number;
}

/**
 * Pull `metadata.shopifySync` out for the list response. The list used to omit
 * metadata entirely, so the Orders table could never tell a pushed Collabo
 * order from one never pushed — every one of them showed "Sync to Shopify",
 * and clicking it on a synced order only earned an "already synced" toast.
 * Mirrors `ProductService.extractShopifySync`.
 */
export function extractOrderShopifySync(
  metadata: Prisma.JsonValue | null | undefined,
): OrderShopifySyncSummary | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const sync = (metadata as Record<string, unknown>).shopifySync;
  if (!sync || typeof sync !== 'object' || Array.isArray(sync)) return null;
  const { status, shopifyOrderId, shopifyOrderName, error, syncedAt, queuedAt, attempts } =
    sync as Record<string, unknown>;
  if (status !== 'PENDING' && status !== 'SYNCED' && status !== 'FAILED') return null;
  return {
    status,
    ...(typeof shopifyOrderId === 'string' && { shopifyOrderId }),
    ...(typeof shopifyOrderName === 'string' && { shopifyOrderName }),
    ...(typeof error === 'string' && { error }),
    ...(typeof syncedAt === 'string' && { syncedAt }),
    ...(typeof queuedAt === 'string' && { queuedAt }),
    ...(typeof attempts === 'number' && { attempts }),
  };
}
