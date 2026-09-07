// Give stranded variants a stock row in their org's default warehouse.
//
// For a warehousing org the Inventory screen lists StockLevel rows, not
// variants. A tracked variant with no row is therefore invisible there, has no
// "Adjust" control, and can never be given stock — and the order builder then
// disables it as out of stock. The product is unsellable for ever.
//
// Rows were only ever created by the one-time `runEnableSeed` backfill, so
// every product created through the UI AFTER inventory was switched on landed
// in that state. Product creation now seeds its own rows
// (InventoryLedgerService.ensureStockRows); this repairs the ones created in
// between.
//
// Deliberately narrow:
//   - warehousing orgs only (a legacy org keeps quantity on the variant, and
//     "repairing" it would invent a bucket the app does not read)
//   - tracked variants only (an untracked variant has no managed quantity)
//   - variants with NO row in the default warehouse; per-location rows written
//     by the Shopify location sync are left completely alone
//
// The row is seeded AT the variant's own quantity, not zero — a product
// created with opening stock must not silently lose it.
//
// Dry run by default. Nothing is written without --apply.
//
//   npm run db:fix:seed-missing-stock-rows -- --apply

try {
  require('dotenv/config');
} catch {
  // Container: env already populated.
}

const { PrismaClient } = require('@prisma/client');

const APPLY = process.argv.includes('--apply');
const prisma = new PrismaClient();

(async () => {
  // `warehousingEnabled` lives inside the organizationSettings.inventorySettings
  // JSON blob, not a column — read the rows and filter in JS rather than
  // relying on a JSON path predicate for a handful of orgs.
  const settingsRows = await prisma.organizationSettings.findMany({
    select: { organizationId: true, inventorySettings: true },
  });
  const orgIds = settingsRows
    .filter((r) => r.inventorySettings?.warehousingEnabled === true)
    .map((r) => r.organizationId);

  if (orgIds.length === 0) {
    console.log('\n  No warehousing organizations. Nothing to do.\n');
    await prisma.$disconnect();
    return;
  }

  let totalSeeded = 0;

  for (const orgId of orgIds) {
    const warehouse = await prisma.warehouse.findFirst({
      where: { organizationId: orgId, isDefault: true },
      select: { id: true, name: true },
    });
    if (!warehouse) {
      console.log(`  org ${orgId}: no default warehouse — skipped`);
      continue;
    }

    // Variants with NO stock row anywhere — the actually-stranded ones.
    //
    // Deliberately NOT "no row in the DEFAULT warehouse": a Shopify variant
    // stocked at another warehouse (or at a Shopify location) already appears
    // in Inventory and is already adjustable, so it is not stranded. Seeding a
    // default-warehouse row for it at `inventoryQuantity` — which is the cached
    // total ACROSS warehouses — would add its whole stock a second time. The
    // narrower predicate flagged 55 variants here, most of them already
    // stocked; this one flags only those with nowhere to live.
    const stranded = await prisma.productVariant.findMany({
      where: {
        organizationId: orgId,
        trackQuantity: true,
        product: { deletedAt: null },
        stockLevels: { none: {} },
      },
      select: {
        id: true,
        sku: true,
        inventoryQuantity: true,
        product: { select: { title: true } },
      },
      orderBy: { id: 'asc' },
    });

    if (stranded.length === 0) {
      console.log(`  org ${orgId}: nothing stranded`);
      continue;
    }

    console.log(`\n  org ${orgId} → ${warehouse.name}: ${stranded.length} stranded variant(s)`);
    for (const v of stranded.slice(0, 20)) {
      console.log(
        `    ${(v.product?.title ?? '?').slice(0, 40).padEnd(42)} ${(v.sku ?? 'no SKU').padEnd(18)} qty ${v.inventoryQuantity}`,
      );
    }
    if (stranded.length > 20) console.log(`    …and ${stranded.length - 20} more`);

    if (APPLY) {
      await prisma.stockLevel.createMany({
        data: stranded.map((v) => ({
          organizationId: orgId,
          variantId: v.id,
          warehouseId: warehouse.id,
          available: v.inventoryQuantity ?? 0,
        })),
        skipDuplicates: true,
      });
    }
    totalSeeded += stranded.length;
  }

  console.log(
    `\n  ${totalSeeded} variant(s) ${APPLY ? 'seeded.' : 'would be seeded — re-run with --apply.'}\n`,
  );

  await prisma.$disconnect();
})().catch(async (err) => {
  console.error('\n  FAILED:', err.message, '\n');
  await prisma.$disconnect();
  process.exit(1);
});
