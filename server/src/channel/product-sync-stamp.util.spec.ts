import {
  generatedBarcodeProductsOutOfSyncStampSql,
  productsOutOfSyncStampSql,
} from './product-sync-stamp.util';

/**
 * Each stamp is one SQL statement, so what can be pinned is its shape: the
 * values it binds and the guards it carries. The behaviour those guards buy
 * is described on the functions themselves.
 */
describe('productsOutOfSyncStampSql', () => {
  const sql = productsOutOfSyncStampSql(['prod_1', 'prod_2']);
  const text = sql.sql.replace(/\s+/g, ' ');

  it('binds the ids as one array parameter, nothing inlined', () => {
    expect(sql.values).toEqual([['prod_1', 'prod_2']]);
    expect(text).toContain('"id" = ANY(');
    expect(text).not.toContain('prod_1');
  });

  it('marks the row OUT_OF_SYNC while keeping the rest of the record', () => {
    expect(text).toContain(`|| '{"status": "OUT_OF_SYNC"}'::jsonb`);
    expect(text).toContain(`coalesce("metadata" -> 'shopifySync', '{}'::jsonb)`);
  });

  it('bumps updated_at, as the Prisma update it replaced did', () => {
    expect(text).toContain(`"updated_at" = NOW()`);
  });

  it('touches only a SYNCED row, never an unstamped, PENDING, FAILED or OUT_OF_SYNC one', () => {
    // An unstamped row is a never-pushed MANUAL product: the push sweep finds
    // it by the missing record, and stamping it would disguise it as a
    // rebadged Shopify product. The other states belong to the push job or
    // the merchant.
    expect(text).toContain(`"metadata" -> 'shopifySync' ->> 'status' = 'SYNCED'`);
  });
});

describe('generatedBarcodeProductsOutOfSyncStampSql', () => {
  const sql = generatedBarcodeProductsOutOfSyncStampSql('org_1');
  const text = sql.sql.replace(/\s+/g, ' ');

  it('binds the org id, nothing inlined', () => {
    expect(sql.values).toEqual(['org_1']);
    expect(text).not.toContain('org_1');
  });

  it('is scoped to live, SYNCED products of that org', () => {
    expect(text).toContain(`p."organization_id" = ?`);
    expect(text).toContain(`p."deleted_at" IS NULL`);
    expect(text).toContain(`p."metadata" -> 'shopifySync' ->> 'status' = 'SYNCED'`);
  });

  it('qualifies a product only through a variant with a non-empty GENERATED barcode', () => {
    // MANUAL and SHOPIFY codes are pushed regardless of the flag, so the
    // toggle changes nothing for them; an empty code has nothing to send.
    expect(text).toContain(`v."barcode_source" = 'GENERATED'`);
    expect(text).toContain(`v."barcode" IS NOT NULL`);
    expect(text).toContain(`v."barcode" <> ''`);
    expect(text).not.toContain(`'MANUAL'`);
  });

  it('marks the row OUT_OF_SYNC while keeping the rest of the record', () => {
    expect(text).toContain(`|| '{"status": "OUT_OF_SYNC"}'::jsonb`);
  });
});
