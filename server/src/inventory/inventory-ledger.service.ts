import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, PrismaClient, StockBucket } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { OrganizationSettingsService } from '../organization-settings/organization-settings.service';

/** Either the root client or an open transaction — every method accepts both. */
export type Db = PrismaService | Prisma.TransactionClient;

export interface QuantityChangeArgs {
  orgId: string;
  variantId: string;
  quantityBefore: number;
  quantityAfter: number;
  reason: string;
  referenceType?: string;
  referenceId?: string;
  actorId?: string;
  sku?: string | null;
}

export interface MovementArgs {
  orgId: string;
  variantId: string;
  warehouseId: string;
  /** NULL = stock enters the system (receipt, return, migration seed). */
  fromBucket: StockBucket | null;
  /** NULL = stock leaves the system (dispatch, write-off). */
  toBucket: StockBucket | null;
  /** Units to move — always positive. */
  quantity: number;
  reason: string;
  referenceType?: string;
  referenceId?: string;
  actorId?: string;
  /**
   * Dedup key for webhook/BullMQ retries (e.g. "shopify:order:123:reserve").
   * A movement whose key was already recorded is skipped entirely.
   */
  idempotencyKey?: string;
  /**
   * Permit `available` to go negative. ONLY the Shopify order-mirror path may
   * set this — the webhook says the units sold; refusing would desync. All
   * other paths get a clean insufficient-stock ConflictException.
   */
  allowNegativeAvailable?: boolean;
}

export interface MovementResult {
  skipped: boolean;
  /** Variant sellable cache after the movement (unchanged when skipped). */
  inventoryQuantity: number;
}

const BUCKET_COLUMNS: Record<StockBucket, string> = {
  AVAILABLE: 'available',
  RESERVED: 'reserved',
  QC: 'qc',
  DAMAGED: 'damaged',
};

const FLAG_CACHE_TTL_MS = 30_000;

/**
 * The single choke point for EVERY inventory quantity write, both paths:
 *
 * Legacy orgs (warehousing off): variant.inventoryQuantity is the only stock
 * number. `auditedVariantUpdate` / `recordQuantityChange` guarantee an
 * InventoryEvent accompanies every change — closing the historical hole where
 * PATCH /products/variants/:id mutated quantity silently.
 *
 * Warehousing orgs: `applyMovement` performs one atomic bucket transition —
 * ledger insert (idempotency-keyed), conditional bucket UPDATE (no
 * read-modify-write; the WHERE clause enforces sufficiency), and the variant
 * sellable-cache sync — all inside one transaction.
 *
 * Concurrency: single-row conditional updates under Read Committed. Callers
 * moving multiple variants in one transaction MUST process them sorted by
 * variantId (deterministic lock order — deadlock-free).
 */
@Injectable()
export class InventoryLedgerService {
  private readonly logger = new Logger(InventoryLedgerService.name);
  private readonly flagCache = new Map<string, { value: boolean; expires: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: OrganizationSettingsService,
  ) {}

  // ─────────────────────────── feature flag ───────────────────────────

  /** Cached (30s TTL) read of inventorySettings.warehousingEnabled. */
  async isWarehousingEnabled(orgId: string): Promise<boolean> {
    const hit = this.flagCache.get(orgId);
    if (hit && hit.expires > Date.now()) return hit.value;
    const settings = await this.settings.getInventorySettings(orgId);
    this.flagCache.set(orgId, {
      value: settings.warehousingEnabled,
      expires: Date.now() + FLAG_CACHE_TTL_MS,
    });
    return settings.warehousingEnabled;
  }

  /** Call after the enable flow flips the flag so this instance sees it now. */
  invalidateFlagCache(orgId: string): void {
    this.flagCache.delete(orgId);
  }

  /**
   * Give each new variant a stock row in the default warehouse.
   *
   * For a warehousing org the Inventory screen lists StockLevel rows, not
   * variants — so a variant with no row is invisible there, has no "Adjust"
   * control, and can never be given stock. The order builder then disables it
   * as out of stock, and the product is unsellable for ever. Rows were only
   * ever created by the one-time `runEnableSeed` backfill, so EVERY product
   * created after inventory was switched on landed in that state.
   *
   * Runs in the caller's transaction so a variant and its stock row commit
   * together: a variant that exists without a row is precisely the bug.
   *
   * `skipDuplicates` makes it idempotent, so callers may call it freely on
   * paths that sometimes create and sometimes update.
   */
  async ensureStockRows(
    db: Db,
    orgId: string,
    variants: Array<{
      id: string;
      inventoryQuantity?: number | null;
      trackQuantity?: boolean | null;
    }>,
  ): Promise<void> {
    if (variants.length === 0) return;
    if (!(await this.isWarehousingEnabled(orgId))) return;

    // Matches `runEnableSeed`: an untracked variant deliberately has no stock
    // row, because its quantity is not managed. `trackQuantity` is optional
    // here so callers that did not select it are not silently skipped —
    // undefined means "not told", which the schema default treats as tracked.
    const tracked = variants.filter((v) => v.trackQuantity !== false);
    if (tracked.length === 0) return;

    const warehouse = await db.warehouse.findFirst({
      where: { organizationId: orgId, isDefault: true },
      select: { id: true },
    });
    // No default warehouse means warehousing was never finished being set up.
    // Nothing to attach a row to, and inventing one here would race the enable
    // flow that creates it.
    if (!warehouse) return;

    await db.stockLevel.createMany({
      data: tracked.map((v) => ({
        organizationId: orgId,
        variantId: v.id,
        warehouseId: warehouse.id,
        // Seeded AT the variant's own quantity, not zero: a product created
        // with an opening stock figure must not silently lose it. Matches what
        // runEnableSeed does for pre-existing variants.
        available: v.inventoryQuantity ?? 0,
      })),
      skipDuplicates: true,
    });
  }

  // ─────────────────────────── legacy path ───────────────────────────

  /**
   * Record a quantity change the caller has already applied (or is applying in
   * the same transaction). No-op when nothing changed.
   */
  async recordQuantityChange(db: Db, args: QuantityChangeArgs): Promise<void> {
    if (args.quantityBefore === args.quantityAfter) return;
    await db.inventoryEvent.create({
      data: {
        organizationId: args.orgId,
        variantId: args.variantId,
        quantityBefore: args.quantityBefore,
        quantityAfter: args.quantityAfter,
        changeAmount: args.quantityAfter - args.quantityBefore,
        reason: args.reason,
        referenceType: args.referenceType ?? null,
        referenceId: args.referenceId ?? null,
        skuSnapshot: args.sku ?? null,
        actorId: args.actorId ?? null,
      },
    });
  }

  /**
   * Record "initial stock" events for freshly created variants (product
   * create, variant create, generate-from-options, duplicate, CSV import,
   * Shopify sync inserts). Zero-quantity variants produce no event.
   */
  async recordInitialQuantities(
    db: Db,
    orgId: string,
    variants: Array<{ id: string; sku?: string | null; inventoryQuantity: number }>,
    reason: string,
    referenceType?: string,
    referenceId?: string,
    actorId?: string,
  ): Promise<void> {
    const rows = variants
      .filter((v) => v.inventoryQuantity !== 0)
      .map((v) => ({
        organizationId: orgId,
        variantId: v.id,
        quantityBefore: 0,
        quantityAfter: v.inventoryQuantity,
        changeAmount: v.inventoryQuantity,
        reason,
        referenceType: referenceType ?? null,
        referenceId: referenceId ?? null,
        skuSnapshot: v.sku ?? null,
        actorId: actorId ?? null,
      }));
    if (rows.length === 0) return;
    await db.inventoryEvent.createMany({ data: rows });
  }

  /**
   * Update a variant, guaranteeing a ledger event when inventoryQuantity
   * changes. THE fix for the historical silent-edit hole. Runs in its own
   * transaction unless the caller passes one.
   */
  /**
   * Patch a variant, guaranteeing an InventoryEvent for any quantity change.
   *
   * **Warehousing orgs must pass `warehouseId` whenever `data` carries
   * `inventoryQuantity`.** For them the quantity is not a field — it is a
   * derived cache over stock_levels, and writing it directly is silent data
   * loss: the units enter no bucket, are attributed to no location, never
   * reach Shopify, and are erased by the next applyMovement, which recomputes
   * the cache from stock_levels. Production on 2026-09-04: SJ00376 was edited
   * +1 then +2 from the product screen and all three units vanished when a
   * Kochi adjustment landed 13 minutes later.
   *
   * The incoming number is the desired AVAILABLE at that ONE warehouse, and
   * the difference is applied as a movement. Legacy orgs are untouched — for
   * them inventoryQuantity IS the truth and there are no buckets to move.
   */
  async auditedVariantUpdate(
    args: {
      orgId: string;
      variantId: string;
      data: Prisma.ProductVariantUpdateInput;
      reason: string;
      referenceType?: string;
      referenceId?: string;
      actorId?: string;
      warehouseId?: string;
    },
    tx?: Prisma.TransactionClient,
  ) {
    const warehousing = await this.isWarehousingEnabled(args.orgId);
    const movesStock = warehousing && args.data.inventoryQuantity !== undefined;

    // The movement owns that column for warehousing orgs — never write it here.
    const data = { ...args.data };
    let desiredAvailable = 0;
    if (movesStock) {
      const raw = args.data.inventoryQuantity;
      const value = typeof raw === 'number' ? raw : (raw as { set?: number })?.set;
      delete data.inventoryQuantity;
      if (typeof value !== 'number') {
        throw new ConflictException(
          'Unsupported inventoryQuantity update for a warehousing organisation.',
        );
      }
      if (!args.warehouseId) {
        // Refusing beats guessing: with two warehouses, applying a bare number
        // to a default silently rewrites one location and leaves the other.
        throw new ConflictException(
          'This organisation tracks stock per warehouse. Send warehouseId alongside inventoryQuantity, or adjust stock from the inventory screen.',
        );
      }
      desiredAvailable = value;
    }

    const run = async (db: Prisma.TransactionClient) => {
      const before = await db.productVariant.findUnique({
        where: { id: args.variantId },
        select: { inventoryQuantity: true, sku: true },
      });
      if (!before) throw new NotFoundException('Variant not found');
      const updated = await db.productVariant.update({
        where: { id: args.variantId },
        data,
      });
      if (movesStock) {
        // Set-to semantics against THIS warehouse's available bucket.
        const level = await db.stockLevel.findFirst({
          where: {
            variantId: args.variantId,
            warehouseId: args.warehouseId,
            locationId: null,
          },
          select: { available: true },
        });
        const delta = desiredAvailable - (level?.available ?? 0);
        if (delta !== 0) {
          // Recomputes the sellable cache from stock_levels as its last step,
          // so `updated.inventoryQuantity` above is already stale — re-read it
          // for the caller rather than returning the pre-movement value.
          await this.applyMovement(
            {
              orgId: args.orgId,
              variantId: args.variantId,
              warehouseId: args.warehouseId as string,
              fromBucket: delta < 0 ? StockBucket.AVAILABLE : null,
              toBucket: delta > 0 ? StockBucket.AVAILABLE : null,
              quantity: Math.abs(delta),
              reason: args.reason,
              referenceType: args.referenceType,
              referenceId: args.referenceId,
              actorId: args.actorId,
            },
            db,
          );
          return db.productVariant.findUniqueOrThrow({
            where: { id: args.variantId },
          });
        }
        // No movement, so no ledger row — nothing changed at this warehouse.
        return updated;
      }

      await this.recordQuantityChange(db, {
        orgId: args.orgId,
        variantId: args.variantId,
        quantityBefore: before.inventoryQuantity,
        quantityAfter: updated.inventoryQuantity,
        reason: args.reason,
        referenceType: args.referenceType,
        referenceId: args.referenceId,
        actorId: args.actorId,
        sku: updated.sku ?? before.sku,
      });
      return updated;
    };
    if (tx) return run(tx);
    return this.prisma.$transaction(run);
  }

  // ───────────────────────── warehousing path ─────────────────────────

  /**
   * One atomic bucket transition. Inside a single transaction:
   *   1. idempotency-keyed ledger insert (dup key → whole movement skipped)
   *   2. conditional bucket UPDATE (0 rows → insufficient stock, tx aborts)
   *   3. variant sellable-cache sync (inventoryQuantity = SUM(available))
   */
  async applyMovement(args: MovementArgs, tx?: Prisma.TransactionClient): Promise<MovementResult> {
    if (!Number.isInteger(args.quantity) || args.quantity <= 0) {
      throw new ConflictException('Movement quantity must be a positive integer.');
    }
    if (args.fromBucket === null && args.toBucket === null) {
      throw new ConflictException('Movement must have a source or a target bucket.');
    }
    if (args.fromBucket !== null && args.fromBucket === args.toBucket) {
      throw new ConflictException('Source and target buckets are identical.');
    }

    const run = async (db: Prisma.TransactionClient): Promise<MovementResult> => {
      // Serialise concurrent movements for this variant BEFORE touching any
      // row, so every caller takes the same lock in the same order.
      //
      // Two movements for one variant at DIFFERENT warehouses write different
      // stock_levels rows, so nothing else makes them block each other — and
      // each would then compute step 3 from a snapshot missing the other, with
      // the last commit overwriting the cache with a stale total. Observed in
      // production on 2026-09-04: SJ965 took +2 at Kochi and -2 at Main 55ms
      // apart and kept inventoryQuantity 22 against a true SUM of 20.
      await db.$queryRaw`SELECT 1 FROM "product_variants" WHERE "id" = ${args.variantId} FOR UPDATE`;

      const level = await this.ensureLevel(db, args.orgId, args.variantId, args.warehouseId);

      // Effect of this movement on the sellable (available) quantity.
      const availableDelta =
        (args.toBucket === StockBucket.AVAILABLE ? args.quantity : 0) -
        (args.fromBucket === StockBucket.AVAILABLE ? args.quantity : 0);

      const variant = await db.productVariant.findUnique({
        where: { id: args.variantId },
        select: { inventoryQuantity: true, sku: true },
      });
      if (!variant) throw new NotFoundException('Variant not found');

      // 1. Ledger first — the idempotency insert doubles as the dedup gate.
      //    On a duplicate key nothing else has run yet, so skipping is safe.
      try {
        await db.inventoryEvent.create({
          data: {
            organizationId: args.orgId,
            variantId: args.variantId,
            quantityBefore: variant.inventoryQuantity,
            quantityAfter: variant.inventoryQuantity + availableDelta,
            changeAmount: availableDelta,
            movedQty: args.quantity,
            reason: args.reason,
            referenceType: args.referenceType ?? null,
            referenceId: args.referenceId ?? null,
            warehouseId: args.warehouseId,
            fromBucket: args.fromBucket,
            toBucket: args.toBucket,
            skuSnapshot: variant.sku,
            actorId: args.actorId ?? null,
            idempotencyKey: args.idempotencyKey ?? null,
          },
        });
      } catch (e) {
        if (
          args.idempotencyKey &&
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === 'P2002'
        ) {
          this.logger.debug(
            `Movement skipped (idempotency ${args.idempotencyKey}) for variant ${args.variantId}`,
          );
          return { skipped: true, inventoryQuantity: variant.inventoryQuantity };
        }
        throw e;
      }

      // 2. Conditional bucket update — no read-modify-write. The guard makes
      //    insufficient stock a 0-row update, which aborts the transaction
      //    (rolling the ledger insert back with it).
      const sets: string[] = [];
      const guards: string[] = [`"id" = $1`];
      if (args.fromBucket) {
        const col = BUCKET_COLUMNS[args.fromBucket];
        sets.push(`"${col}" = "${col}" - $2`);
        const guardNegative =
          args.fromBucket === StockBucket.AVAILABLE && args.allowNegativeAvailable;
        if (!guardNegative) guards.push(`"${col}" >= $2`);
      }
      if (args.toBucket) {
        const col = BUCKET_COLUMNS[args.toBucket];
        sets.push(`"${col}" = "${col}" + $2`);
      }
      const updated = await db.$executeRawUnsafe(
        `UPDATE "stock_levels" SET ${sets.join(', ')}, "updated_at" = NOW() WHERE ${guards.join(' AND ')}`,
        level.id,
        args.quantity,
      );
      if (updated === 0) {
        throw new ConflictException(
          `Insufficient ${args.fromBucket?.toLowerCase() ?? ''} stock for this movement.`,
        );
      }

      // 3. Sellable cache: variant.inventoryQuantity = SUM(available) across
      //    warehouses — every existing UI keeps reading the number it always
      //    read.
      let cache = variant.inventoryQuantity;
      if (availableDelta !== 0) {
        const agg = await db.stockLevel.aggregate({
          where: { variantId: args.variantId },
          _sum: { available: true },
        });
        cache = agg._sum.available ?? 0;
        await db.productVariant.update({
          where: { id: args.variantId },
          data: { inventoryQuantity: cache },
        });
      }
      return { skipped: false, inventoryQuantity: cache };
    };

    if (tx) return run(tx);
    return this.prisma.$transaction(run);
  }

  /**
   * Variant-deletion support: a variant with any non-zero bucket must not be
   * deleted (throws 409); all-zero StockLevel rows are removed so the
   * ON DELETE RESTRICT FK doesn't block the delete.
   */
  async releaseStockRowsForDelete(db: Db, variantId: string): Promise<void> {
    const nonZero = await db.stockLevel.findFirst({
      where: {
        variantId,
        OR: [
          { available: { not: 0 } },
          { reserved: { not: 0 } },
          { qc: { not: 0 } },
          { damaged: { not: 0 } },
        ],
      },
      select: { id: true },
    });
    if (nonZero) {
      throw new ConflictException(
        'This variant still has stock. Zero it out (adjust or dispatch) before deleting.',
      );
    }
    await db.stockLevel.deleteMany({ where: { variantId } });
  }

  /** Find-or-create the warehouse-level StockLevel row (locationId NULL). */
  private async ensureLevel(
    db: Prisma.TransactionClient,
    orgId: string,
    variantId: string,
    warehouseId: string,
  ) {
    const existing = await db.stockLevel.findFirst({
      where: { variantId, warehouseId, locationId: null },
      select: { id: true },
    });
    if (existing) return existing;
    try {
      return await db.stockLevel.create({
        data: { organizationId: orgId, variantId, warehouseId },
        select: { id: true },
      });
    } catch (e) {
      // Lost a create race against the partial unique — the row exists now.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const row = await db.stockLevel.findFirst({
          where: { variantId, warehouseId, locationId: null },
          select: { id: true },
        });
        if (row) return row;
      }
      throw e;
    }
  }
}
