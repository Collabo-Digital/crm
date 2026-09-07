// Backfill orders.exchange_rate / orders.base_currency.
//
// Orders are stored in the currency the channel sold in. Reporting happens in
// the organisation's own currency. Until 20260908090000_order_exchange_rate
// there was nothing linking the two, so every total simply added them: an INR
// workspace with a USD Shopify store reported "₹12,235.20" for
// ₹1,911.50 + $10,323.70 summed at 1:1.
//
// The rate is pinned to each order's OWN date rather than fetched live. A
// converted total is an accounting figure — last July's revenue has to come
// back the same every time it is asked for, and has to keep agreeing with a
// GST return already filed on it. USD/INR moved 95.39 → 94.49 between
// 31 Jul and 4 Sep 2026, so "today's rate" would rewrite roughly 1% of every
// dollar order, every day.
//
// Rates come from the ECB via Frankfurter (free, no key, serves historical
// dates). An order whose rate cannot be resolved is LEFT NULL — never
// defaulted to 1, which is a real and very wrong answer.
//
// Dry run by default. Nothing is written without --apply.
//
//   npm run db:fix:backfill-fx-rates -- --apply

try {
  require('dotenv/config');
} catch {
  // Container: env already populated.
}

const { PrismaClient } = require('@prisma/client');

const APPLY = process.argv.includes('--apply');
const ENDPOINT = 'https://api.frankfurter.dev/v1';

const prisma = new PrismaClient();

/** UTC calendar day — the rate provider keys on a date, not an instant. */
function isoDay(date) {
  return new Date(date).toISOString().slice(0, 10);
}

const rateCache = new Map();

async function rateFor(base, quote, day) {
  if (base === quote) return 1;

  const key = `${base}:${quote}:${day}`;
  if (rateCache.has(key)) return rateCache.get(key);

  const url = `${ENDPOINT}/${day}?base=${base}&symbols=${quote}`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`  ! ${base}->${quote} @ ${day}: HTTP ${res.status}`);
      rateCache.set(key, null);
      return null;
    }
    const body = await res.json();
    const rate = body && body.rates ? body.rates[quote] : undefined;
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
      console.warn(`  ! ${base}->${quote} @ ${day}: no usable rate`);
      rateCache.set(key, null);
      return null;
    }
    rateCache.set(key, rate);
    return rate;
  } catch (err) {
    console.warn(`  ! ${base}->${quote} @ ${day}: ${err.message}`);
    rateCache.set(key, null);
    return null;
  }
}

(async () => {
  const orgs = await prisma.organization.findMany({
    select: { id: true, name: true, currency: true },
  });
  const orgCurrency = new Map(orgs.map((o) => [o.id, (o.currency || 'USD').toUpperCase()]));

  const orders = await prisma.order.findMany({
    where: { exchangeRate: null, deletedAt: null },
    select: {
      id: true,
      name: true,
      organizationId: true,
      currency: true,
      externalCreatedAt: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'asc' },
  });

  if (orders.length === 0) {
    console.log('\n  Every order already carries an exchange rate. Nothing to do.\n');
    await prisma.$disconnect();
    return;
  }

  console.log(`\n  ${orders.length} order(s) without a rate.${APPLY ? '' : '  (dry run)'}\n`);

  let resolved = 0;
  let unresolved = 0;
  const updates = [];

  for (const order of orders) {
    const base = (order.currency || '').toUpperCase();
    const quote = orgCurrency.get(order.organizationId);
    if (!base || !quote) {
      unresolved += 1;
      continue;
    }

    // The order's own date, not today's.
    const day = isoDay(order.externalCreatedAt ?? order.createdAt);
    const rate = await rateFor(base, quote, day);

    if (rate == null) {
      unresolved += 1;
      console.log(`  ${order.name.padEnd(10)} ${base}->${quote} @ ${day}  UNRESOLVED — left NULL`);
      continue;
    }

    resolved += 1;
    console.log(
      `  ${order.name.padEnd(10)} ${base}->${quote} @ ${day}  ${rate}`,
    );
    updates.push({ id: order.id, rate, quote });
  }

  if (APPLY && updates.length > 0) {
    // One transaction: a half-converted org reports figures that are neither
    // the old wrong total nor the new right one.
    await prisma.$transaction(
      updates.map((u) =>
        prisma.order.update({
          where: { id: u.id },
          data: { exchangeRate: u.rate, baseCurrency: u.quote },
        }),
      ),
    );
  }

  console.log(
    `\n  resolved ${resolved}, unresolved ${unresolved}. ${
      APPLY ? 'Written.' : 'Dry run — re-run with --apply to write.'
    }\n`,
  );

  await prisma.$disconnect();
})().catch(async (err) => {
  console.error('\n  FAILED:', err.message, '\n');
  await prisma.$disconnect();
  process.exit(1);
});
