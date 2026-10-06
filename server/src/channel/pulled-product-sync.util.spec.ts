import { pulledProductSyncedStampSql } from './pulled-product-sync.util';

/**
 * The stamp is one SQL statement, so what can be pinned is its shape: the
 * values it binds and the guards it carries. The behaviour those guards buy
 * is described on the function itself.
 */
describe('pulledProductSyncedStampSql', () => {
  const now = new Date('2026-10-06T10:00:00.000Z');
  const sql = pulledProductSyncedStampSql('prod_1', '8944825139252', now);
  const text = sql.sql.replace(/\s+/g, ' ');

  it('binds the product, the Shopify id and the pull time, nothing inlined', () => {
    expect(sql.values).toEqual(['8944825139252', '2026-10-06T10:00:00.000Z', 'prod_1']);
    expect(text).not.toContain('prod_1');
    expect(text).not.toContain('8944825139252');
  });

  it('marks the row SYNCED', () => {
    expect(text).toContain(`'status', 'SYNCED'`);
  });

  it('touches only an unstamped or already-SYNCED row, never PENDING, FAILED or OUT_OF_SYNC', () => {
    // A missing record reads as 'NONE'; any other state belongs to the push
    // job or the merchant and is left for their own Push / Retry to resolve.
    expect(text).toContain(
      `coalesce("metadata" -> 'shopifySync' ->> 'status', 'NONE') IN ('NONE', 'SYNCED')`,
    );
    expect(text).not.toContain(`- 'error'`);
  });

  it('keeps the attempt count rather than resetting it', () => {
    expect(text).toContain(`coalesce(("metadata" -> 'shopifySync' ->> 'attempts')::int, 0)`);
  });

  it('starts from an empty object when the row has no metadata at all', () => {
    expect(text).toContain(`coalesce("metadata", '{}'::jsonb)`);
    expect(text).toContain(`coalesce("metadata" -> 'shopifySync', '{}'::jsonb)`);
  });
});
