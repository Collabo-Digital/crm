import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GstSupplyType, Prisma } from '@prisma/client';
import { isLineTaxable } from './taxability.util';

/** One sale line, as the batch resolver needs to see it. */
export interface BatchLineInput {
  productId: string | null;
  /**
   * `toNullableNumber(variant.gstRate)` — the variant's own override, null
   * when it inherits. Same null-vs-0 rule as the product rate: 0 is EXEMPT.
   */
  variantGstRate?: number | null;
  /** `toNullableNumber(product.gstRate)` — null (unset) and 0 (exempt) differ. */
  productGstRate: number | null;
  lineTaxable?: boolean | null;
  variantTaxable?: boolean | null;
  /**
   * Statutory classification, when the caller has resolved it. A zero-rated
   * export, or a nil-rated/exempt/non-GST supply, attracts no output tax and
   * short-circuits to 0% before the rate chain is consulted at all.
   */
  supplyType?: GstSupplyType | null;
}

/**
 * Resolves the effective GST rate for a product using the priority chain:
 *
 *   0. Variant gstRate (a single variant classified differently from its
 *      product — null on the variant means "same as the product")
 *   1. Product gstRate (highest product-level priority — explicit per-product override)
 *   2. Collection tax override (if product belongs to a collection with an override)
 *   3. Product type tax rate (default rate for the product's type, e.g. "T-Shirts" = 12%)
 *   4. State base tax rate (default rate for the place of supply state)
 *   5. 0% (exempt — no rate configured anywhere)
 *
 * If a product belongs to multiple collections with overrides,
 * the HIGHEST rate is used (conservative — avoids under-charging tax).
 */
@Injectable()
export class TaxResolverService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Effective GST rate for EVERY line of one order, in a fixed number of queries.
   *
   * WHY THIS REPLACES A LOOP OVER `resolveLineGstRate`. That loop issued up to
   * FOUR queries per line, sequentially, and — worse — it issued them on
   * `this.prisma` rather than the caller's transaction. Three consequences, in
   * increasing severity:
   *
   *   1. A 20-line invoice made ~80 sequential round trips inside a 10-second
   *      Serializable transaction, re-paid in full on every numbering retry.
   *   2. Each of those reads took a SECOND pooled connection while the
   *      transaction still held the first — N times per sale. Under concurrency
   *      that is pool exhaustion, and it presents as an unexplained hang on
   *      invoice creation rather than as a slow page.
   *   3. The rates were read OUTSIDE the Serializable snapshot, so an invoice
   *      could be priced with rates its own transaction could not see.
   *
   * This issues at most FOUR queries total regardless of line count, and runs
   * them on `client` — pass the caller's `tx` and all three problems go away.
   *
   * The priority chain and its null-vs-zero semantics are unchanged; only the
   * fetching is. `resolveGstRate` remains for the settings-side single lookup.
   */
  async resolveLineGstRates(
    orgId: string,
    placeOfSupplyCode: string,
    lines: BatchLineInput[],
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<number[]> {
    const rates = new Array<number>(lines.length).fill(0);

    // Lines still needing a lookup after the decisions that need no query:
    // a non-taxable line is 0%, and an explicit variant or product rate wins
    // outright (`>= 0`, so a variant or product configured at 0% is EXEMPT
    // and stops here). The variant is checked first — it is the narrower
    // classification, set only when that variant differs from its product.
    const pending: number[] = [];

    lines.forEach((line, i) => {
      if (!isLineTaxable(line)) {
        rates[i] = 0;
        return;
      }
      if (line.variantGstRate != null && line.variantGstRate >= 0) {
        rates[i] = line.variantGstRate;
        return;
      }
      if (line.productGstRate !== null && line.productGstRate >= 0) {
        rates[i] = line.productGstRate;
        return;
      }
      pending.push(i);
    });

    if (pending.length === 0) return rates;

    const productIds = [
      ...new Set(
        pending
          .map((i) => lines[i].productId)
          .filter((id): id is string => !!id),
      ),
    ];

    // One query per rung of the chain, for ALL products at once. The state rate
    // in particular used to be re-read per line with identical arguments.
    const [collectionRows, productRows, stateTaxRate] = await Promise.all([
      productIds.length
        ? client.productCollection.findMany({
            where: { productId: { in: productIds }, collection: { organizationId: orgId } },
            select: {
              productId: true,
              collection: {
                select: { taxOverride: { where: { organizationId: orgId }, select: { gstRate: true } } },
              },
            },
          })
        : Promise.resolve([]),
      productIds.length
        ? client.product.findMany({
            where: { id: { in: productIds }, organizationId: orgId },
            select: { id: true, productType: true },
          })
        : Promise.resolve([]),
      client.stateTaxRate.findFirst({
        where: { organizationId: orgId, stateCode: placeOfSupplyCode },
        select: { gstRate: true },
      }),
    ]);

    // Highest override wins when a product sits in several overridden
    // collections — conservative, so we never under-charge.
    const overrideByProduct = new Map<string, number>();
    for (const row of collectionRows) {
      const override = row.collection?.taxOverride;
      if (!override) continue;
      const rate = parseFloat(override.gstRate.toString());
      const current = overrideByProduct.get(row.productId);
      if (current === undefined || rate > current) {
        overrideByProduct.set(row.productId, rate);
      }
    }

    const typeByProduct = new Map<string, string | null>(
      productRows.map((p) => [p.id, p.productType] as const),
    );

    const productTypes = [
      ...new Set(
        [...typeByProduct.values()].filter((t): t is string => !!t),
      ),
    ];

    const typeRates = productTypes.length
      ? await client.productTypeTaxRate.findMany({
          where: { organizationId: orgId, productType: { in: productTypes } },
          select: { productType: true, gstRate: true },
        })
      : [];

    const rateByType = new Map<string, number>(
      typeRates.map((r) => [r.productType, parseFloat(r.gstRate.toString())] as const),
    );

    const stateRate = stateTaxRate
      ? parseFloat(stateTaxRate.gstRate.toString())
      : null;

    for (const i of pending) {
      const productId = lines[i].productId;

      if (productId) {
        const override = overrideByProduct.get(productId);
        if (override !== undefined) {
          rates[i] = override;
          continue;
        }

        const productType = typeByProduct.get(productId);
        if (productType) {
          const typeRate = rateByType.get(productType);
          if (typeRate !== undefined) {
            rates[i] = typeRate;
            continue;
          }
        }
      }

      rates[i] = stateRate ?? 0;
    }

    return rates;
  }

  /**
   * Effective GST rate for one SALE LINE, honouring its taxable flags.
   *
   * A single-line convenience over `resolveLineGstRates`, which is what every
   * order, invoice and draft path now calls. It DELEGATES rather than keeping
   * its own copy of the priority chain: two copies would drift, and — since no
   * production caller reaches this one any more — the spec suite that pins the
   * chain would have been pinning dead code while the batch resolver priced
   * every real invoice unobserved.
   *
   * The exemption check stays in front of the chain so it cannot be forgotten:
   * `OrderLineItem.taxable` and `ProductVariant.taxable` were both stored and
   * ignored by every tax path until this remediation.
   */
  async resolveLineGstRate(
    orgId: string,
    input: {
      productId: string | null;
      productGstRate: number | null;
      placeOfSupplyCode: string;
      lineTaxable?: boolean | null;
      variantTaxable?: boolean | null;
    },
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<number> {
    const [rate] = await this.resolveLineGstRates(
      orgId,
      input.placeOfSupplyCode,
      [
        {
          productId: input.productId,
          productGstRate: input.productGstRate,
          lineTaxable: input.lineTaxable,
          variantTaxable: input.variantTaxable,
        },
      ],
      client,
    );

    return rate;
  }

  /**
   * Rate for a product irrespective of any line's taxable flag.
   *
   * Kept public for the settings-side rate preview. Sale lines must go through
   * `resolveLineGstRate`/`resolveLineGstRates` instead, or a non-taxable line
   * gets taxed.
   */
  async resolveGstRate(
    orgId: string,
    productId: string | null,
    productGstRate: number | null,
    placeOfSupplyCode: string,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<number> {
    const [rate] = await this.resolveLineGstRates(
      orgId,
      placeOfSupplyCode,
      [{ productId, productGstRate }],
      client,
    );

    return rate;
  }
}
