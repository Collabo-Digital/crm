// Send the CRM's variant barcodes to Shopify — barcodes only, nothing else.
//
// Why this exists: the bulk code generators wrote barcodes to the variant row
// without ever flagging the product OUT_OF_SYNC, so "Sync Now" had nothing to
// push. Found 2026-10-08 on Shrishti J: 4,308 generated barcodes, the "send
// generated barcodes" setting on, two Sync Now runs that each logged "no
// products pending", and not one barcode in Shopify. The generators now flag
// products (sku-generator.service.ts), and switching the setting on flags the
// backlog — but pushing that backlog through the normal update path would send
// ~4,000 FULL product updates (prices, options, stock) for a change that is one
// field. This sends only that field.
//
// Per product, one `productVariantsBulkUpdate` whose input is exactly
// `[{ id, barcode }]`. Shopify leaves every field the input does not name
// untouched, so prices, inventory and options are never in play.
//
// Which barcodes: the same set the push would send with the flag on —
// GENERATED (only when the org's `pushGeneratedBarcodes` is true; the script
// refuses otherwise), MANUAL, and legacy rows with no source (treated as
// manual, as `barcodeForPush` does). SHOPIFY-sourced codes came from there and
// are skipped. Empty barcodes are never sent: the CRM can set a Shopify barcode
// but never blank one.
//
// Writes nothing to the CRM database. The product's sync record is left as it
// is; the next pull or push stamps it as usual.
//
// Dry run by default, and a dry run is read-only by construction: every DB
// read runs in a READ ONLY transaction that is asserted and rolled back, and
// no Shopify mutation is sent.
//
// The Shopify token is used as stored and NEVER refreshed (a refresh writes the
// rotated token back). If it is about to expire the script stops; the app
// refreshes it on its next Shopify call (a Sync from Settings → Channels does
// it) — run again after that.
//
//   npm run db:push:barcodes -- --org=<organizationId>
//   npm run db:push:barcodes -- --org=<organizationId> --apply
//   npm run db:push:barcodes -- --org=<organizationId> --apply --limit=50

try {
  require('dotenv/config');
} catch {
  // Container: env already populated.
}

const { PrismaClient } = require('@prisma/client');
const CryptoJS = require('crypto-js');

const APPLY = process.argv.includes('--apply');
const ORG = (process.argv.find((a) => a.startsWith('--org=')) || '').slice('--org='.length);
const LIMIT = Number((process.argv.find((a) => a.startsWith('--limit=')) || '').slice('--limit='.length)) || 0;
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-01';

const prisma = new PrismaClient();

// ─── Read-only DB access ───────────────────────────────────────────────────

const ROLLBACK = new Error('__rollback__');

/** Runs `fn` in a READ ONLY transaction (asserted), always rolled back. */
async function readOnly(fn) {
  let out;
  try {
    await prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
        const [row] = await tx.$queryRawUnsafe('SHOW transaction_read_only');
        if (!row || row.transaction_read_only !== 'on') {
          throw new Error('Refusing to continue: transaction is not read-only.');
        }
        out = await fn(tx);
        throw ROLLBACK;
      },
      { timeout: 120000, maxWait: 20000 },
    );
  } catch (err) {
    if (err !== ROLLBACK) throw err;
  }
  return out;
}

// ─── Shopify ───────────────────────────────────────────────────────────────

const BULK_UPDATE = `
  mutation PushBarcodes($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id barcode }
      userErrors { field message }
    }
  }`;

async function shopify(auth, query, variables) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const res = await fetch(`https://${auth.shopDomain}/admin/api/${API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': auth.token },
      body: JSON.stringify({ query, variables: variables || {} }),
      signal: AbortSignal.timeout(60000),
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401 || res.status === 403) {
      throw new Error(`Shopify ${res.status} — token rejected. Run again after the app has refreshed it.`);
    }
    const throttled = (body.errors || []).some((e) => e.extensions && e.extensions.code === 'THROTTLED');
    if (throttled || res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      continue;
    }
    if (!body.data) throw new Error(`Shopify error: ${JSON.stringify(body.errors).slice(0, 300)}`);
    // Stay under the cost bucket rather than bouncing off it: a bulk update
    // costs ~10 points of a 1000-point bucket that refills at 50-100/s.
    const t = body.extensions && body.extensions.cost && body.extensions.cost.throttleStatus;
    if (t && t.currentlyAvailable < t.maximumAvailable * 0.3) {
      await new Promise((r) => setTimeout(r, 3000));
    }
    return body.data;
  }
  throw new Error('Shopify: gave up after retries.');
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

async function main() {
  if (!ORG) {
    console.error('Usage: --org=<organizationId> [--apply] [--limit=N]');
    process.exit(1);
  }
  if (!process.env.ENCRYPTION_KEY) {
    console.error('ENCRYPTION_KEY is not set — cannot read the Shopify token.');
    process.exit(1);
  }

  console.log(`\n  Target DB : ${hostOf(process.env.DATABASE_URL)}`);
  console.log(`  Org       : ${ORG}`);
  console.log(`  Mode      : ${APPLY ? 'APPLY — barcodes WILL be written to Shopify' : 'DRY RUN — nothing will be sent'}`);
  if (LIMIT) console.log(`  Limit     : first ${LIMIT} product(s)`);
  console.log('');

  const { org, settings, channel, rows } = await readOnly(async (tx) => {
    const [org] = await tx.$queryRawUnsafe(`SELECT id, name FROM organizations WHERE id = $1`, ORG);
    const [settings] = await tx.$queryRawUnsafe(
      `SELECT inventory_settings AS s FROM organization_settings WHERE organization_id = $1`,
      ORG,
    );
    const [channel] = await tx.$queryRawUnsafe(
      `SELECT id, name, credentials::jsonb AS c FROM channels
        WHERE organization_id = $1 AND platform = 'SHOPIFY' AND status = 'CONNECTED'`,
      ORG,
    );
    const rows = channel
      ? await tx.$queryRawUnsafe(
          `SELECT p.id AS product_id, p.external_id AS product_ext, p.title,
                  v.id AS variant_id, v.external_id AS variant_ext, v.sku, v.barcode, v.barcode_source
             FROM products p JOIN product_variants v ON v.product_id = p.id
            WHERE p.organization_id = $1 AND p.channel_id = $2 AND p.deleted_at IS NULL
              AND p.external_id ~ '^[0-9]+$' AND v.external_id ~ '^[0-9]+$'
              AND v.barcode IS NOT NULL AND v.barcode <> ''
              AND (v.barcode_source IS NULL OR v.barcode_source IN ('GENERATED', 'MANUAL'))
            ORDER BY p.created_at, p.id, v.position`,
          ORG,
          channel.id,
        )
      : [];
    return { org, settings, channel, rows };
  });

  if (!org) throw new Error(`No organization ${ORG}.`);
  if (!channel) throw new Error(`${org.name} has no connected Shopify channel.`);
  console.log(`  Org name  : ${org.name}`);
  console.log(`  Channel   : ${channel.name} (${(channel.c || {}).shopDomain})`);

  const pushGenerated = !!(settings && settings.s && settings.s.pushGeneratedBarcodes === true);
  console.log(`  Setting   : pushGeneratedBarcodes = ${pushGenerated}`);
  const generatedCount = rows.filter((r) => r.barcode_source === 'GENERATED').length;
  if (generatedCount > 0 && !pushGenerated) {
    throw new Error(
      `${generatedCount} GENERATED barcode(s) found but the org does not send generated barcodes to Shopify. ` +
        'Switch "Send generated barcodes to Shopify" on in Settings → Sync first; the app withholds them otherwise.',
    );
  }

  // Group by product; one mutation per product.
  const byProduct = new Map();
  for (const r of rows) {
    if (!byProduct.has(r.product_id)) {
      byProduct.set(r.product_id, { ext: r.product_ext, title: r.title, variants: [] });
    }
    byProduct.get(r.product_id).variants.push(r);
  }
  let products = [...byProduct.values()];
  const bySource = {};
  for (const r of rows) bySource[r.barcode_source || 'NULL'] = (bySource[r.barcode_source || 'NULL'] || 0) + 1;
  console.log(`\n  Variants  : ${rows.length} with a barcode to send (${JSON.stringify(bySource)})`);
  console.log(`  Products  : ${products.length}`);
  if (LIMIT) products = products.slice(0, LIMIT);

  if (products.length === 0) {
    console.log('\n  Nothing to send.\n');
    return;
  }

  console.log('\n  Sample payloads:');
  for (const p of products.slice(0, 5)) {
    console.log(
      `    ${p.ext}  ${p.title.slice(0, 40).padEnd(40)}  ` +
        p.variants.map((v) => `${v.variant_ext}=${v.barcode}`).join(', '),
    );
  }

  if (!APPLY) {
    console.log(`\n  DRY RUN — would send ${products.length} mutation(s). Re-run with --apply.\n`);
    return;
  }

  const c = channel.c || {};
  if (c.accessTokenExpiresAt) {
    const minsLeft = (new Date(c.accessTokenExpiresAt).getTime() - Date.now()) / 60000;
    // The whole run must fit; ~4k products at Shopify's cost limits is ~10 min.
    if (minsLeft < 15) {
      throw new Error(
        `Shopify token expires in ${minsLeft.toFixed(1)} min. Not refreshing it (that would write). ` +
          'Trigger a Sync from Settings → Channels so the app refreshes it, then run again.',
      );
    }
  }
  const auth = {
    shopDomain: c.shopDomain,
    token: CryptoJS.AES.decrypt(c.accessToken, process.env.ENCRYPTION_KEY).toString(CryptoJS.enc.Utf8),
  };
  if (!auth.shopDomain || !auth.token) throw new Error('Could not read the channel credentials.');

  const totals = { products: 0, variants: 0, failed: 0 };
  const failures = [];
  const started = Date.now();
  for (const [i, p] of products.entries()) {
    const variables = {
      productId: `gid://shopify/Product/${p.ext}`,
      variants: p.variants.map((v) => ({
        id: `gid://shopify/ProductVariant/${v.variant_ext}`,
        barcode: v.barcode,
      })),
    };
    try {
      const data = await shopify(auth, BULK_UPDATE, variables);
      const errors = (data.productVariantsBulkUpdate && data.productVariantsBulkUpdate.userErrors) || [];
      if (errors.length > 0) {
        totals.failed++;
        failures.push({ product: p.ext, title: p.title, errors: errors.map((e) => e.message) });
      } else {
        totals.products++;
        totals.variants += p.variants.length;
      }
    } catch (err) {
      totals.failed++;
      failures.push({ product: p.ext, title: p.title, errors: [err.message] });
      // A rejected token or a dead network will fail every remaining product
      // the same way; stop rather than log 4,000 identical errors.
      if (/token rejected|gave up/.test(err.message)) {
        console.error(`\n  Stopping at product ${i + 1}/${products.length}: ${err.message}`);
        break;
      }
    }
    if ((i + 1) % 100 === 0 || i + 1 === products.length) {
      const secs = ((Date.now() - started) / 1000).toFixed(0);
      console.log(`  ${i + 1}/${products.length} products — ${totals.variants} variant barcodes sent, ${totals.failed} failed (${secs}s)`);
    }
  }

  console.log(`\n  Done. Products updated: ${totals.products}, variant barcodes sent: ${totals.variants}, failed: ${totals.failed}`);
  if (failures.length > 0) {
    console.log('\n  Failures:');
    for (const f of failures.slice(0, 50)) {
      console.log(`    ${f.product}  ${f.title.slice(0, 40).padEnd(40)}  ${f.errors.join(' | ')}`);
    }
    if (failures.length > 50) console.log(`    … and ${failures.length - 50} more`);
  }
  console.log('');
}

main()
  .catch((err) => {
    console.error(`\n  ${err.message}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
