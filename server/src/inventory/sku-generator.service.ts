import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { OrganizationSettingsService } from '../organization-settings/organization-settings.service';
import { GenerateCodesDto } from './dto/generate-skus.dto';

/**
 * SKU / barcode generation.
 *
 * SKU shape: {PREFIX}-{PRODUCTCODE}-{SEQ}-{OPTIONS}, e.g. 9TH-SAR-001-BLK-FS.
 *   PREFIX      org-level (settings.skuPrefix, else derived from the slug)
 *   PRODUCTCODE first 3 alphanumerics of the product title (fallback PRD)
 *   SEQ         org-scoped sequence, zero-padded to 3, claimed atomically
 *   OPTIONS     up to 3 option values, 2-3 chars each, uppercased
 * Charset is uppercase alnum + dashes only — keyboard-wedge scanners emit
 * layout-dependent keystrokes and this set survives every layout.
 *
 * Barcode = the SKU itself, rendered as Code 128 client-side. We NEVER invent
 * EAN/UPC numbers: a fabricated check-digit-valid EAN collides with real
 * GS1-assigned retail products. Existing barcodes (synced from Shopify) are
 * left alone unless `overwrite` is explicitly set.
 *
 * Uniqueness: no DB unique on sku/barcode (Shopify legally syncs duplicates
 * in). Generated codes are unique by construction (sequence) plus a
 * skip-and-increment probe against the org-scoped index; the duplicates
 * report covers imported data.
 */
@Injectable()
export class SkuGeneratorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: OrganizationSettingsService,
  ) {}

  async generateSkus(orgId: string, dto: GenerateCodesDto) {
    const variants = await this.loadTargets(orgId, dto, 'sku');
    if (variants.length === 0) return { generated: 0, skipped: 0, conflicts: [] };

    const prefix = await this.resolvePrefix(orgId);
    const startSeq = await this.claimSequence(orgId, variants.length);

    // Existing SKUs in the org — the collision probe set. One indexed query;
    // org SKU counts are bounded (≤ low tens of thousands) so an in-memory
    // set beats N probe queries.
    const existing = new Set(
      (
        await this.prisma.productVariant.findMany({
          where: { organizationId: orgId, sku: { not: null } },
          select: { sku: true },
        })
      ).map((v) => v.sku as string),
    );

    let seq = startSeq;
    let generated = 0;
    const conflicts: Array<{ variantId: string; reason: string }> = [];

    for (const v of variants) {
      const productCode = this.mnemonic(v.product.title);
      const optionPart = [v.option1, v.option2, v.option3]
        .filter((o): o is string => !!o && o !== 'Default Title')
        .map((o) => this.mnemonic(o, 2))
        .join('-');

      // Skip-and-increment: hand-typed SKUs may already occupy a code the
      // sequence reaches. The set probe is O(1); the sequence was claimed
      // beyond our batch size, so running over is fine — sequence gaps are
      // harmless.
      let candidate: string;
      do {
        candidate = [prefix, productCode, String(seq).padStart(3, '0'), optionPart]
          .filter(Boolean)
          .join('-');
        seq++;
      } while (existing.has(candidate));
      existing.add(candidate);

      await this.prisma.productVariant.update({
        where: { id: v.id },
        data: { sku: candidate },
      });
      generated++;
    }

    // Sequence may have run past the claim (collision skips) — re-claim the
    // overrun so the next batch starts clean.
    const overrun = seq - startSeq - variants.length;
    if (overrun > 0) await this.claimSequence(orgId, overrun);

    return { generated, skipped: variants.length - generated, conflicts };
  }

  /**
   * Barcodes. Defaults to SHORT numeric codes.
   *
   * The default flipped because copying the SKU into `barcode` was the root
   * defect behind "doesn't fit 30 × 20 mm": the SKU shape
   * ({PREFIX}-{PRODUCTCODE}-{SEQ}-{OPTIONS}, 18 chars) needs ~48 mm of label at
   * a scannable module width, so it cannot print on small or jewellery stock at
   * any printer resolution. A SKU is built to be read by people and should stay
   * long; a barcode is read only by a scanner and should be short. `format:
   * 'sku'` keeps the old behaviour for merchants who want the SKU scannable.
   */
  async generateBarcodes(orgId: string, dto: GenerateCodesDto) {
    if ((dto.format ?? 'short') === 'short') return this.generateShortBarcodes(orgId, dto);

    const variants = await this.loadTargets(orgId, dto, 'barcode');
    let generated = 0;
    const conflicts: Array<{ variantId: string; reason: string }> = [];

    for (const v of variants) {
      if (!v.sku) {
        conflicts.push({ variantId: v.id, reason: 'No SKU — generate SKUs first.' });
        continue;
      }
      await this.prisma.productVariant.update({
        where: { id: v.id },
        data: { barcode: v.sku, barcodeSource: 'GENERATED' },
      });
      generated++;
    }
    return { generated, skipped: conflicts.length, conflicts };
  }

  /**
   * 6-digit numeric barcodes, for label stock the SKU cannot fit.
   *
   * WHY EXACTLY SIX DIGITS — this is load-bearing, do not "improve" it to 8:
   *
   * 1. The label renderer auto-detects retail symbologies by GTIN check digit
   *    (client/app/lib/barcode.ts `detectSymbology`). An 8-digit numeric code
   *    with a valid check digit renders as **EAN-8**, and 12/13 digits as
   *    UPC-A/EAN-13 — an internal code would then masquerade as a GS1-assigned
   *    retail barcode. Six digits is not a GTIN length, so it always renders as
   *    Code 128 and can never be mistaken for one. This is the same
   *    never-invent-a-GTIN rule that governs the rest of this file.
   * 2. Code 128 subset C packs two digits per symbol, but only in pairs: six
   *    digits encode as start-C + 3 data + check + stop = 68 modules, while
   *    seven costs 90 because the odd digit forces a subset switch. Even
   *    lengths are strictly better, and six is the smallest that gives a
   *    sensible range.
   *
   * Six digits = 1,000,000 codes per org, and ~17 mm of printed width, which
   * fits every preset down to 25 × 15 mm.
   *
   * Shares the org sequence with SKU generation (`claimSequence`), so numbers
   * are never reused across the two. Sequence gaps are harmless.
   */
  private async generateShortBarcodes(orgId: string, dto: GenerateCodesDto) {
    const variants = await this.loadTargets(orgId, dto, 'barcode');
    if (variants.length === 0) return { generated: 0, skipped: 0, conflicts: [] };

    const startSeq = await this.claimSequence(orgId, variants.length);

    // Probe against BOTH columns: a 6-digit string could already exist as
    // someone's hand-typed SKU, and assertCodeFree treats the two as one
    // namespace.
    const existing = new Set<string>();
    for (const v of await this.prisma.productVariant.findMany({
      where: { organizationId: orgId },
      select: { sku: true, barcode: true },
    })) {
      if (v.sku) existing.add(v.sku);
      if (v.barcode) existing.add(v.barcode);
    }

    let seq = startSeq;
    let generated = 0;
    const conflicts: Array<{ variantId: string; reason: string }> = [];

    for (const v of variants) {
      // Skip-and-increment, same as generateSkus.
      let candidate: string;
      do {
        candidate = String(seq).padStart(6, '0');
        seq++;
      } while (existing.has(candidate));

      // Past 999999 the code would gain a seventh digit — still valid Code 128,
      // but it silently breaks the width guarantee the whole feature rests on.
      // Refuse rather than print something that no longer fits the stock.
      if (candidate.length > 6) {
        conflicts.push({
          variantId: v.id,
          reason: 'Short-code range exhausted (999999). Reset the sequence or use SKU barcodes.',
        });
        continue;
      }

      existing.add(candidate);

      // Re-check at write time, not just against the batch-start snapshot.
      // `existing` is built once and held in memory, so two concurrent runs —
      // or a run racing a CSV import or a product duplicate — could otherwise
      // mint the same code. There is deliberately no DB unique constraint
      // (Shopify legally syncs duplicate barcodes in), and the scan resolver
      // uses findFirst, so a duplicate would silently resolve to whichever row
      // Postgres returned. Losing a code to a race is recoverable; an
      // ambiguous scan is not.
      const taken = await this.prisma.productVariant.findFirst({
        where: {
          organizationId: orgId,
          OR: [{ sku: candidate }, { barcode: candidate }],
          id: { not: v.id },
        },
        select: { id: true },
      });
      if (taken) {
        conflicts.push({
          variantId: v.id,
          reason: `Code ${candidate} was claimed concurrently — re-run to assign a fresh one.`,
        });
        continue;
      }

      await this.prisma.productVariant.update({
        where: { id: v.id },
        data: { barcode: candidate, barcodeSource: 'GENERATED' },
      });
      generated++;
    }

    const overrun = seq - startSeq - variants.length;
    if (overrun > 0) await this.claimSequence(orgId, overrun);

    return { generated, skipped: variants.length - generated, conflicts };
  }

  /**
   * Org-wide counts behind the merchant-facing "Product codes" dialog.
   *
   * Deliberately computed here rather than on the client. The Inventory table
   * is paginated AND scoped to one location, so a count taken from its rows
   * described a different set from the one the generate call then changed —
   * the button could claim "12" and rewrite 300.
   *
   * Each figure is the exact target set of one action, so a zero means the
   * action has nothing to do and its row is not offered at all.
   */
  async codeStatus(orgId: string) {
    const [row] = await this.prisma.$queryRaw<
      Array<{
        total: bigint;
        missing_sku: bigint;
        missing_barcode: bigint;
        long_barcode: bigint;
      }>
    >(Prisma.sql`
      SELECT COUNT(*) AS total,
             COUNT(*) FILTER (WHERE v."sku" IS NULL OR v."sku" = '')
               AS missing_sku,
             COUNT(*) FILTER (WHERE v."barcode" IS NULL OR v."barcode" = '')
               AS missing_barcode,
             -- Exactly what filter 'missing-or-generated' + format 'short'
             -- rewrites, minus the gaps counted above. GENERATED is the only
             -- source we may replace: SHOPIFY is a real GTIN and MANUAL was
             -- typed by a person. The 6-digit test excludes codes this
             -- generator already shortened, so the count falls to zero once
             -- the catalogue is clean and the action stops being offered.
             COUNT(*) FILTER (WHERE v."barcode_source" = 'GENERATED'
                                AND v."barcode" !~ '^[0-9]{6}$')
               AS long_barcode
      FROM "product_variants" v
      JOIN "products" p ON p."id" = v."product_id"
      WHERE v."organization_id" = ${orgId}
        AND p."deleted_at" IS NULL
    `);
    // The RESOLVED prefix, not the configured one. Most orgs leave the setting
    // empty and fall back to a mnemonic of their name, so returning the raw
    // setting made the dialog preview a generated SKU as "———-SAR-001". The
    // client must not re-derive this: the fallback rule lives in resolvePrefix
    // and would drift.
    const skuPrefix = await this.resolvePrefix(orgId);

    return {
      totalVariants: Number(row?.total ?? 0),
      missingSku: Number(row?.missing_sku ?? 0),
      missingBarcode: Number(row?.missing_barcode ?? 0),
      longBarcode: Number(row?.long_barcode ?? 0),
      skuPrefix,
    };
  }

  /** Duplicate SKU/barcode report — surfaces imported collisions for cleanup. */
  async findDuplicates(orgId: string) {
    const dupes = async (column: 'sku' | 'barcode') => {
      const rows = await this.prisma.$queryRaw<
        Array<{ code: string; count: bigint; variant_ids: string[] }>
      >(Prisma.sql`
        SELECT pv.${Prisma.raw(`"${column}"`)} AS code,
               COUNT(*) AS count,
               array_agg(pv."id") AS variant_ids
        FROM "product_variants" pv
        WHERE pv."organization_id" = ${orgId}
          AND pv.${Prisma.raw(`"${column}"`)} IS NOT NULL
          AND pv.${Prisma.raw(`"${column}"`)} <> ''
        GROUP BY pv.${Prisma.raw(`"${column}"`)}
        HAVING COUNT(*) > 1
        ORDER BY COUNT(*) DESC
        LIMIT 200
      `);
      return rows.map((r) => ({
        code: r.code,
        count: Number(r.count),
        variantIds: r.variant_ids,
      }));
    };
    const [skus, barcodes] = await Promise.all([dupes('sku'), dupes('barcode')]);
    return { duplicateSkus: skus, duplicateBarcodes: barcodes };
  }

  /** Validate a manual SKU/barcode edit (called by the products UI): 409 on collision. */
  async assertCodeFree(orgId: string, code: string, excludeVariantId?: string) {
    const clash = await this.prisma.productVariant.findFirst({
      where: {
        organizationId: orgId,
        OR: [{ sku: code }, { barcode: code }],
        ...(excludeVariantId ? { id: { not: excludeVariantId } } : {}),
      },
      select: { id: true, sku: true },
    });
    if (clash) {
      throw new ConflictException(`Code "${code}" is already used by another variant.`);
    }
  }

  // ─────────────────────────── internals ───────────────────────────

  private async loadTargets(
    orgId: string,
    dto: GenerateCodesDto,
    target: 'sku' | 'barcode',
  ) {
    const filter = dto.filter ?? (target === 'sku' ? 'missing-sku' : 'missing-barcode');
    const where: Prisma.ProductVariantWhereInput = {
      organizationId: orgId,
      product: { deletedAt: null },
    };
    if (dto.variantIds && dto.variantIds.length > 0) where.id = { in: dto.variantIds };
    if (!dto.overwrite) {
      if (filter === 'missing-sku') where.OR = [{ sku: null }, { sku: '' }];
      else if (filter === 'missing-barcode') where.OR = [{ barcode: null }, { barcode: '' }];
      else if (filter === 'missing-or-generated') {
        // Gaps plus our own codes. A GENERATED barcode is one this service
        // minted, so replacing it is safe; SHOPIFY (a real GTIN) and MANUAL (a
        // human typed it) are never in scope. NULL barcodeSource means a legacy
        // row the backfill could not classify — deliberately excluded, because
        // "unsure" must not mean "overwrite".
        where.OR = [{ barcode: null }, { barcode: '' }, { barcodeSource: 'GENERATED' }];
      } else {
        // 'all' without overwrite still only fills gaps in the target column.
        where.OR =
          target === 'sku'
            ? [{ sku: null }, { sku: '' }]
            : [{ barcode: null }, { barcode: '' }];
      }
    }
    return this.prisma.productVariant.findMany({
      where,
      take: 2000,
      orderBy: { id: 'asc' },
      select: {
        id: true,
        sku: true,
        barcode: true,
        option1: true,
        option2: true,
        option3: true,
        product: { select: { title: true } },
      },
    });
  }

  private async resolvePrefix(orgId: string): Promise<string> {
    const settings = await this.settings.getInventorySettings(orgId);
    // Sanitised the same way as the slug fallback below, not merely
    // uppercased. The PATCH schema rejects punctuation, but a value stored
    // before that rule existed would otherwise put a space or a hyphen inside
    // a code whose own parts are joined with "-".
    const configured = this.mnemonic(settings.skuPrefix, 10);
    if (settings.skuPrefix && configured !== 'PRD') return configured;
    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
      select: { slug: true, name: true },
    });
    if (!org) throw new NotFoundException('Organization not found');
    return this.mnemonic(org.slug || org.name);
  }

  /** First `len` alphanumerics, uppercased. "9thara sarees" → "9TH". */
  private mnemonic(text: string, len = 3): string {
    const cleaned = text.toUpperCase().replace(/[^A-Z0-9]/g, '');
    return cleaned.slice(0, len) || 'PRD';
  }

  /**
   * Atomically claim `count` sequence numbers; returns the first claimed
   * value. Raw JSONB arithmetic — two concurrent claims serialize on the row
   * lock, so ranges never overlap.
   */
  private async claimSequence(orgId: string, count: number): Promise<number> {
    // The settings row is created lazily elsewhere — make sure it exists.
    await this.prisma.$executeRaw`
      INSERT INTO "organization_settings" ("id", "organization_id", "created_at", "updated_at")
      VALUES (${`invseq_${orgId}`}, ${orgId}, NOW(), NOW())
      ON CONFLICT ("organization_id") DO NOTHING
    `;
    // `next_seq` arrives as a BigInt, not a number. `${count}` is a bind
    // parameter and Prisma sends integer JS numbers to Postgres as int8, so
    // `int4 - int8` resolves to the bigint operator and the column comes back
    // as int8 — the `::int` on the left operand does not stop the promotion.
    // The old `number` annotation was a lie the compiler could not catch
    // ($queryRaw type params are an unchecked assertion), so the caller's
    // `seq - startSeq - variants.length` threw "Cannot mix BigInt and other
    // types". Converting here keeps every caller on plain numbers.
    const rows = await this.prisma.$queryRaw<Array<{ next_seq: number | bigint }>>`
      UPDATE "organization_settings"
      SET "inventory_settings" = jsonb_set(
        COALESCE("inventory_settings", '{}'::jsonb),
        '{skuSequence}',
        to_jsonb(COALESCE(("inventory_settings"->>'skuSequence')::int, 1) + ${count})
      ),
      "updated_at" = NOW()
      WHERE "organization_id" = ${orgId}
      RETURNING ("inventory_settings"->>'skuSequence')::int - ${count} AS next_seq
    `;
    return Number(rows[0]?.next_seq ?? 1);
  }
}
