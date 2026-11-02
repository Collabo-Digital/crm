import { ChannelPlatform, Prisma, PrismaClient } from '@prisma/client';
import { CRM_SOURCE_NAME } from '../channel/order-rebadge.util';
import { parseTaxSettings } from '../organization-settings/schemas/tax-settings.schema';

/**
 * Anything that can run a Prisma query: the root client, the injected
 * `PrismaService`, or a `$transaction` callback client.
 */
type Db = Pick<PrismaClient, 'order' | 'organizationSettings'> | Prisma.TransactionClient;

/**
 * Whether this store's catalogue prices already include GST, as its own
 * Shopify orders say (`taxes_included`). Orders the CRM pushed are left out:
 * they carry the basis of the counter sale, not the store's setting. Null
 * when no Shopify order says either way.
 */
export async function detectCatalogPricesIncludeTax(
  db: Db,
  orgId: string,
): Promise<boolean | null> {
  const latest = await db.order.findFirst({
    where: {
      organizationId: orgId,
      deletedAt: null,
      taxesIncluded: { not: null },
      channel: { platform: ChannelPlatform.SHOPIFY },
      OR: [{ sourceName: null }, { sourceName: { not: CRM_SOURCE_NAME } }],
    },
    orderBy: { createdAt: 'desc' },
    select: { taxesIncluded: true },
  });
  return latest?.taxesIncluded ?? null;
}

/**
 * Whether a price taken from the catalogue, or typed into an order, already
 * includes GST: the org's "Catalogue prices include GST" setting once chosen,
 * until then what its Shopify orders say, and with neither, no.
 */
export async function catalogPricesIncludeTax(db: Db, orgId: string): Promise<boolean> {
  const row = await db.organizationSettings.findUnique({
    where: { organizationId: orgId },
    select: { taxSettings: true },
  });
  const chosen = parseTaxSettings(row?.taxSettings ?? null).pricesIncludeTax;
  return chosen ?? (await detectCatalogPricesIncludeTax(db, orgId)) ?? false;
}
