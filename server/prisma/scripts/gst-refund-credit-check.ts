/**
 * Does the "refund needs a credit note" warning survive a PARTIAL credit?
 *
 * The warning was first built as "this order has an issued invoice and no credit
 * note". That predicate is wrong the moment a merchant credits part of a refund:
 * the order leaves the warning permanently, even when money is still uncredited.
 * It also lived in two places — a Prisma `count` for the banner headline and a
 * separate `findMany` for the list beneath it — so the two could disagree.
 *
 * This drives the whole lifecycle through the REAL service against a real
 * database and asserts the count and the list agree at every step:
 *
 *   refund the full invoice   ->  warned, whole amount uncredited
 *   credit a third of it      ->  STILL warned, remainder uncredited  <- was broken
 *   credit the remainder      ->  not warned
 *
 * Run:  npm run gst:refund-check
 * Creates nothing permanent — every row it writes is removed at the end, on
 * failure as well as success.
 */
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { InvoiceStatus, Prisma } from '@prisma/client';
import { AppModule } from '../../src/app.module';
import { InvoiceService } from '../../src/invoice/invoice.service';
import { PrismaService } from '../../src/prisma/prisma.service';

// Deliberately NOT a second `new PrismaClient()`. The Nest context already
// holds a pool, and the DO connection pool is only 15 backends wide — a second
// client races the service's own `Promise.all` fan-out in getStats and the run
// dies with EMAXCONNSESSION. Borrow the app's.
let prisma: PrismaService;

const fmt = (v: unknown) =>
  Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2 });

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = String(actual) === String(expected);
  if (!ok) failures++;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(50)} ${String(actual).padStart(12)}` +
      (ok ? '' : `   expected ${expected}`),
  );
}

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error'],
  });
  Logger.overrideLogger(['error']);
  const invoices = app.get(InvoiceService);
  prisma = app.get(PrismaService);

  const org = await prisma.organization.findFirst({
    where: { slug: 'gst-fixtures' },
    select: { id: true, name: true },
  });
  if (!org) {
    console.error('Run `npm run gst:fixtures` first — no "gst-fixtures" org.');
    process.exit(1);
  }

  // An issued invoice whose order has no refund and no credit note, so the run
  // starts from a known-clean baseline.
  const invoice = await prisma.invoice.findFirst({
    where: {
      organizationId: org.id,
      status: InvoiceStatus.ISSUED,
      order: {
        refunds: { none: {} },
        invoices: { none: { status: InvoiceStatus.CREDIT_NOTE } },
      },
    },
    select: {
      id: true,
      invoiceNumber: true,
      orderId: true,
      grandTotal: true,
      totalTax: true,
      order: { select: { name: true, currency: true } },
    },
    orderBy: { invoiceNumber: 'asc' },
  });
  if (!invoice) {
    console.error('No clean issued invoice to work with.');
    process.exit(1);
  }

  const refundAmount = new Prisma.Decimal(invoice.grandTotal);
  const firstCredit = refundAmount.dividedBy(3).toDecimalPlaces(2);
  const remainder = refundAmount.minus(firstCredit);

  console.log(`\nOrg      : ${org.name}`);
  console.log(`Invoice  : ${invoice.invoiceNumber}  (${invoice.order.name})`);
  console.log(
    `Refunding: ${fmt(refundAmount)}   then crediting ${fmt(firstCredit)} + ${fmt(remainder)}\n`,
  );

  const stats0 = await invoices.getStats(org.id, {} as never);
  const baseline = stats0.refundsNeedingCreditNote;

  const createdCreditNoteIds: string[] = [];
  let refundId: string | null = null;

  try {
    // ── Step 1: a refund arrives, nothing credited yet ───────────────────────
    const refund = await prisma.orderRefund.create({
      data: {
        orderId: invoice.orderId,
        externalId: 'partial-credit-check',
        amount: refundAmount,
        currency: invoice.order.currency,
        totalTax: invoice.totalTax,
        reason: 'Returned by customer',
        processedAt: new Date(),
      },
      select: { id: true },
    });
    refundId = refund.id;

    let stats = await invoices.getStats(org.id, {} as never);
    let list = await invoices.listRefundsNeedingCreditNote(org.id);
    let mine = list.find((r) => r.orderId === invoice.orderId);

    check('after refund: warning count', stats.refundsNeedingCreditNote, baseline + 1);
    check('after refund: list agrees with count', list.length, stats.refundsNeedingCreditNote);
    check('after refund: uncredited', Number(mine?.pendingAmount).toFixed(2), refundAmount.toFixed(2));

    // ── Step 2: credit PART of it — the case that used to go silent ──────────
    const cn1 = await invoices.createCreditNote(org.id, invoice.id, {
      reason: 'Partial return',
      amount: Number(firstCredit),
    });
    createdCreditNoteIds.push(cn1.id);

    stats = await invoices.getStats(org.id, {} as never);
    list = await invoices.listRefundsNeedingCreditNote(org.id);
    mine = list.find((r) => r.orderId === invoice.orderId);

    // THE REGRESSION. The old predicate excluded any order carrying a credit
    // note, so this read 0 and the remaining balance was never surfaced again.
    check('after PARTIAL credit: still warned', stats.refundsNeedingCreditNote, baseline + 1);
    check('after PARTIAL credit: list agrees with count', list.length, stats.refundsNeedingCreditNote);
    check('after PARTIAL credit: uncredited', Number(mine?.pendingAmount).toFixed(2), remainder.toFixed(2));
    check('after PARTIAL credit: credited so far', Number(mine?.creditedAmount).toFixed(2), firstCredit.toFixed(2));
    // The prefill must offer the remainder — offering the gross refund would be
    // refused by createCreditNote as over-crediting.
    check(
      'after PARTIAL credit: prefill <= remaining',
      Number(mine?.pendingAmount) <= Number(remainder),
      true,
    );

    // ── Step 3: credit the remainder — the order settles ─────────────────────
    const cn2 = await invoices.createCreditNote(org.id, invoice.id, {
      reason: 'Balance of return',
      amount: Number(remainder),
    });
    createdCreditNoteIds.push(cn2.id);

    stats = await invoices.getStats(org.id, {} as never);
    list = await invoices.listRefundsNeedingCreditNote(org.id);

    check('after FULL credit: warning clears', stats.refundsNeedingCreditNote, baseline);
    check('after FULL credit: list agrees with count', list.length, stats.refundsNeedingCreditNote);
    check(
      'after FULL credit: order gone from list',
      list.some((r) => r.orderId === invoice.orderId),
      false,
    );
  } finally {
    if (createdCreditNoteIds.length) {
      await prisma.invoiceLineItem.deleteMany({
        where: { invoiceId: { in: createdCreditNoteIds } },
      });
      await prisma.invoice.deleteMany({
        where: { id: { in: createdCreditNoteIds } },
      });
    }
    if (refundId) await prisma.orderRefund.delete({ where: { id: refundId } });
    console.log('\nCleaned up: refund and check credit notes removed.');
    await app.close();
  }

  const stats1 = await invoices.getStats(org.id, {} as never);
  check('cleanup restored the baseline', stats1.refundsNeedingCreditNote, baseline);

  console.log(
    failures === 0
      ? '\nAll checks passed — count and list agree through a partial credit.\n'
      : `\n${failures} CHECK(S) FAILED\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
