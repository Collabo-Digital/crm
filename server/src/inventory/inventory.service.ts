import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Prisma, StockBucket } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { OrganizationSettingsService } from '../organization-settings/organization-settings.service';
import { InventoryLedgerService } from './inventory-ledger.service';
import { WarehouseService } from './warehouse.service';
import { INVENTORY_QUEUE, InventoryJobData } from './inventory.queue';
import {
  PUSH_JOB_OPTS,
  SHOPIFY_PUSH_QUEUE,
  ShopifyPushJobData,
  pushJobId,
} from '../channel/shopify-push.queue';
import { Priority } from '../rate-limit/rate-limit.types';
import { CreateAdjustmentDto } from './dto/adjustment.dto';
import { QueryLedgerDto, QueryStockDto } from './dto/query-stock.dto';

@Injectable()
export class InventoryService {
  private readonly logger = new Logger(InventoryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: OrganizationSettingsService,
    private readonly ledger: InventoryLedgerService,
    private readonly warehouses: WarehouseService,
    @InjectQueue(INVENTORY_QUEUE)
    private readonly inventoryQueue: Queue<InventoryJobData>,
    // The shopify-push queue is registered by name here too (BullMQ
    // multi-registers share the Redis queue) so availability pushes need no
    // ChannelModule import — ChannelModule imports US for the ledger.
    @InjectQueue(SHOPIFY_PUSH_QUEUE)
    private readonly shopifyPushQueue: Queue<ShopifyPushJobData>,
  ) {}

  // ─────────────────────────── status / enable ───────────────────────────

  async getStatus(orgId: string) {
    const [settings, org, warehouseCount] = await Promise.all([
      this.settings.getInventorySettings(orgId),
      this.prisma.organization.findUnique({
        where: { id: orgId },
        select: { lowStockThreshold: true },
      }),
      this.prisma.warehouse.count({ where: { organizationId: orgId } }),
    ]);
    return {
      warehousingEnabled: settings.warehousingEnabled,
      // Warehouse exists but flag not flipped = the seed job is still running.
      seeding: !settings.warehousingEnabled && warehouseCount > 0,
      qcOnReceiving: settings.qcOnReceiving,
      requireScanToPick: settings.requireScanToPick,
      skuPrefix: settings.skuPrefix,
      lowStockThreshold: org?.lowStockThreshold ?? 10,
      warehouseCount,
    };
  }

  /**
   * Start warehousing for an org: create the default warehouse (mapping the
   * cached primary Shopify location when present), then enqueue the seed job.
   * The `warehousingEnabled` flag flips at the END of the seed — until then
   * every code path stays on the legacy single-quantity behavior, so there is
   * no dual-write window. Available on every billing plan.
   */
  async enable(orgId: string, userId: string) {
    const settings = await this.settings.getInventorySettings(orgId);
    if (settings.warehousingEnabled) {
      return { status: 'ALREADY_ENABLED' as const };
    }

    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
      select: { name: true },
    });
    if (!org) throw new NotFoundException('Organization not found');

    // Default warehouse — idempotent: reuse one if a previous enable attempt
    // got this far before the seed job failed.
    let warehouse = await this.prisma.warehouse.findFirst({
      where: { organizationId: orgId, isDefault: true },
    });
    if (!warehouse) {
      const shopify = await this.prisma.channel.findFirst({
        where: { organizationId: orgId, platform: 'SHOPIFY' },
        select: { metadata: true },
      });
      const shopifyLocationId =
        (shopify?.metadata as { shopifyLocationId?: string } | null)
          ?.shopifyLocationId ?? null;
      warehouse = await this.prisma.warehouse.create({
        data: {
          organizationId: orgId,
          name: 'Main Warehouse',
          code: 'WH1',
          isDefault: true,
          shopifyLocationId: shopifyLocationId ? String(shopifyLocationId) : null,
        },
      });
    }

    await this.inventoryQueue.add(
      'enable-seed',
      { type: 'enable-seed', organizationId: orgId, userId },
      { attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
    );
    return { status: 'SEEDING' as const, warehouseId: warehouse.id };
  }

  /**
   * The seed job body (runs in the processor). Batched; idempotent: existing
   * StockLevel rows are skipped, ledger rows are idempotency-keyed. The flag
   * flip is the LAST statement.
   */
  async runEnableSeed(orgId: string, userId?: string): Promise<void> {
    const warehouse = await this.prisma.warehouse.findFirst({
      where: { organizationId: orgId, isDefault: true },
    });
    if (!warehouse) {
      throw new Error(`enable-seed: org ${orgId} has no default warehouse`);
    }

    // Set-based batches: 3 statements per 500 variants. The per-variant
    // find/create loop this replaces made ~1500 round trips per batch, which
    // blew Prisma's 5s interactive-transaction default against a remote DB.
    const BATCH = 500;
    let cursor: string | undefined;
    let seeded = 0;
    for (;;) {
      const variants = await this.prisma.productVariant.findMany({
        where: {
          organizationId: orgId,
          trackQuantity: true,
          product: { deletedAt: null },
        },
        orderBy: { id: 'asc' },
        take: BATCH,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        select: { id: true, sku: true, inventoryQuantity: true },
      });
      if (variants.length === 0) break;

      await this.prisma.$transaction(
        async (tx) => {
          // Retried/resumed job: skip variants whose warehouse-level row was
          // already committed (level + event commit atomically below, so a
          // present row implies its event is present too).
          const existing = await tx.stockLevel.findMany({
            where: {
              warehouseId: warehouse.id,
              locationId: null,
              variantId: { in: variants.map((v) => v.id) },
            },
            select: { variantId: true },
          });
          const have = new Set(existing.map((e) => e.variantId));
          const toSeed = variants.filter((v) => !have.has(v.id));
          if (toSeed.length === 0) return;

          await tx.stockLevel.createMany({
            data: toSeed.map((v) => ({
              organizationId: orgId,
              variantId: v.id,
              warehouseId: warehouse.id,
              available: v.inventoryQuantity,
            })),
            skipDuplicates: true,
          });

          // Reclassification, not a quantity change: sellable stays the same
          // number, it just now lives in a bucket. changeAmount 0.
          // skipDuplicates → replays of the idempotency key are no-ops.
          await tx.inventoryEvent.createMany({
            data: toSeed
              .filter((v) => v.inventoryQuantity !== 0)
              .map((v) => ({
                organizationId: orgId,
                variantId: v.id,
                quantityBefore: v.inventoryQuantity,
                quantityAfter: v.inventoryQuantity,
                changeAmount: 0,
                movedQty: Math.abs(v.inventoryQuantity),
                reason: 'migration',
                referenceType: 'enable_seed',
                referenceId: warehouse.id,
                warehouseId: warehouse.id,
                fromBucket: null,
                toBucket: StockBucket.AVAILABLE,
                skuSnapshot: v.sku,
                actorId: userId ?? null,
                idempotencyKey: `enable:${orgId}:${v.id}`,
              })),
            skipDuplicates: true,
          });
          seeded += toSeed.length;
        },
        { timeout: 60_000 },
      );
      cursor = variants[variants.length - 1].id;
    }

    // Flip LAST — from this moment the bucket path owns the org.
    await this.settings.setWarehousingEnabled(orgId, true);
    this.ledger.invalidateFlagCache(orgId);
    this.logger.log(`enable-seed: org ${orgId} seeded ${seeded} stock lines`);

    // Everything above put the org-wide quantity into the single default
    // warehouse, which is right for an org with no Shopify store and only an
    // approximation for one with several locations. This job mirrors the rest
    // of the locations as warehouses and reconciles each against Shopify's
    // per-location quantities — correcting the default warehouse down to its
    // real number and distributing the remainder.
    //
    // Deliberately AFTER the flag flip: the reconcile writes through
    // applyMovement, which only owns the org once warehousing is on. It is
    // also why this is a queued job rather than a call — InventoryModule must
    // not import ChannelModule (see the queue-name seam in the constructor).
    await this.enqueueLocationSync(orgId);
  }

  /** Fire-and-forget: a missed location sync is recovered by the next channel sync. */
  private async enqueueLocationSync(orgId: string) {
    try {
      await this.shopifyPushQueue.add(
        'sync-locations',
        { type: 'sync-locations', organizationId: orgId, priority: Priority.NORMAL },
        {
          attempts: 3,
          backoff: { type: 'exponential', delay: 10_000 },
          jobId: pushJobId.locations(orgId),
          priority: Priority.NORMAL,
        },
      );
    } catch (err) {
      this.logger.warn(`Failed to enqueue location sync for org ${orgId}: ${err}`);
    }
  }

  // ─────────────────────────── stock reads ───────────────────────────

  async listStock(orgId: string, query: QueryStockDto) {
    await this.assertWarehousing(orgId);
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    // A product deleted in Shopify is soft-deleted, not removed, so its stock
    // rows outlive it. Without this the inventory screen keeps listing items
    // the merchant can no longer sell.
    const where: Prisma.StockLevelWhereInput = {
      organizationId: orgId,
      variant: { product: { deletedAt: null } },
    };
    if (query.warehouseId) where.warehouseId = query.warehouseId;
    if (query.q) {
      where.variant = {
        product: { deletedAt: null },
        OR: [
          { sku: { contains: query.q, mode: 'insensitive' } },
          { barcode: { contains: query.q, mode: 'insensitive' } },
          { title: { contains: query.q, mode: 'insensitive' } },
          { product: { title: { contains: query.q, mode: 'insensitive' } } },
        ],
      };
    }
    if (query.stockFilter === 'out') where.available = { lte: 0 };
    if (query.stockFilter === 'oversold') where.available = { lt: 0 };
    if (query.stockFilter === 'low') {
      const org = await this.prisma.organization.findUnique({
        where: { id: orgId },
        select: { lowStockThreshold: true },
      });
      where.available = { gt: 0, lte: org?.lowStockThreshold ?? 10 };
    }

    const orderBy: Prisma.StockLevelOrderByWithRelationInput =
      query.sortBy === 'sku'
        ? { variant: { sku: query.sortOrder ?? 'asc' } }
        : query.sortBy === 'updatedAt'
          ? { updatedAt: query.sortOrder ?? 'desc' }
          : { available: query.sortOrder ?? 'asc' };

    const [rows, total] = await Promise.all([
      this.prisma.stockLevel.findMany({
        where,
        orderBy,
        skip: (page - 1) * limit,
        take: limit,
        include: {
          warehouse: { select: { id: true, name: true, code: true } },
          defaultLocation: { select: { id: true, fullCode: true } },
          variant: {
            select: {
              id: true,
              title: true,
              sku: true,
              barcode: true,
              cost: true,
              price: true,
              product: {
                select: {
                  id: true,
                  title: true,
                  images: { orderBy: { position: 'asc' }, take: 1, select: { src: true } },
                },
              },
            },
          },
        },
      }),
      this.prisma.stockLevel.count({ where }),
    ]);

    return {
      data: rows.map((r) => ({
        id: r.id,
        variantId: r.variantId,
        productId: r.variant.product.id,
        productTitle: r.variant.product.title,
        variantTitle: r.variant.title,
        imageUrl: r.variant.product.images[0]?.src ?? null,
        sku: r.variant.sku,
        barcode: r.variant.barcode,
        cost: r.variant.cost,
        price: r.variant.price,
        warehouse: r.warehouse,
        defaultLocation: r.defaultLocation?.fullCode ?? null,
        available: r.available,
        reserved: r.reserved,
        qc: r.qc,
        damaged: r.damaged,
        onHand: r.available + r.reserved + r.qc + r.damaged,
        updatedAt: r.updatedAt,
      })),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  // `warehouseId` scopes every figure to a single warehouse; omitted means
  // org-wide. The stat tiles follow the warehouse selector ONLY — the search
  // box and stock filter narrow the table beneath them, not these numbers, so
  // "low stock lines" keeps meaning "lines low in this warehouse" instead of
  // collapsing to the row count whenever the table is filtered to low stock.
  async getStockStats(orgId: string, warehouseId?: string) {
    await this.assertWarehousing(orgId);
    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
      select: { lowStockThreshold: true },
    });
    const threshold = org?.lowStockThreshold ?? 10;

    // organizationId stays in every clause, so a warehouseId belonging to
    // another org yields zeros rather than leaking — the same property
    // listStock leans on instead of a separate ownership lookup.
    const scope: Prisma.StockLevelWhereInput = {
      organizationId: orgId,
      // Matches listStock: deleted products must not inflate the stat tiles.
      variant: { product: { deletedAt: null } },
      ...(warehouseId ? { warehouseId } : {}),
    };
    const warehouseFilter = warehouseId
      ? Prisma.sql`AND sl."warehouse_id" = ${warehouseId}`
      : Prisma.empty;

    const [sums, low, oversold, valueRows] = await Promise.all([
      this.prisma.stockLevel.aggregate({
        where: scope,
        _sum: { available: true, reserved: true, qc: true, damaged: true },
      }),
      this.prisma.stockLevel.count({
        where: { ...scope, available: { gt: 0, lte: threshold } },
      }),
      this.prisma.stockLevel.count({
        where: { ...scope, available: { lt: 0 } },
      }),
      // Stock value = SUM(onHand × variant.cost) — cost is nullable, so this
      // is a floor, not gospel; the UI labels it "known cost value".
      this.prisma.$queryRaw<Array<{ value: number | null }>>`
        SELECT SUM(("available" + "reserved" + "qc" + "damaged") * COALESCE(pv."cost", 0))::float AS value
        FROM "stock_levels" sl
        JOIN "product_variants" pv ON pv."id" = sl."variant_id"
        JOIN "products" p ON p."id" = pv."product_id"
        WHERE sl."organization_id" = ${orgId} AND p."deleted_at" IS NULL ${warehouseFilter}
      `,
    ]);

    const s = sums._sum;
    return {
      unitsAvailable: s.available ?? 0,
      unitsReserved: s.reserved ?? 0,
      unitsQc: s.qc ?? 0,
      unitsDamaged: s.damaged ?? 0,
      unitsOnHand: (s.available ?? 0) + (s.reserved ?? 0) + (s.qc ?? 0) + (s.damaged ?? 0),
      lowStockLines: low,
      oversoldLines: oversold,
      stockValue: valueRows[0]?.value ?? 0,
      lowStockThreshold: threshold,
    };
  }

  async getVariantStock(orgId: string, variantId: string) {
    const variant = await this.prisma.productVariant.findFirst({
      where: { id: variantId, product: { organizationId: orgId } },
      select: {
        id: true,
        title: true,
        sku: true,
        barcode: true,
        inventoryQuantity: true,
        product: { select: { id: true, title: true } },
      },
    });
    if (!variant) throw new NotFoundException('Variant not found');

    const [levels, reservations, events] = await Promise.all([
      this.prisma.stockLevel.findMany({
        where: { variantId },
        include: {
          warehouse: { select: { id: true, name: true, code: true } },
          defaultLocation: { select: { fullCode: true } },
        },
      }),
      this.prisma.stockReservation.findMany({
        where: { variantId, status: 'ACTIVE' },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      this.prisma.inventoryEvent.findMany({
        where: { organizationId: orgId, variantId },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
    ]);

    return { variant, levels, reservations, recentEvents: events };
  }

  // ─────────────────────────── adjustments ───────────────────────────

  async createAdjustment(orgId: string, userId: string, dto: CreateAdjustmentDto) {
    await this.assertWarehousing(orgId);
    if ((dto.delta === undefined) === (dto.setTo === undefined)) {
      throw new BadRequestException('Provide exactly one of `delta` or `setTo`.');
    }

    const variant = await this.prisma.productVariant.findFirst({
      where: { id: dto.variantId, product: { organizationId: orgId, deletedAt: null } },
      select: { id: true },
    });
    if (!variant) throw new NotFoundException('Variant not found');

    const warehouse = dto.warehouseId
      ? await this.prisma.warehouse.findFirst({
          where: { id: dto.warehouseId, organizationId: orgId, isActive: true },
        })
      : await this.warehouses.getDefault(orgId);
    if (!warehouse) throw new NotFoundException('Warehouse not found');

    let delta = dto.delta ?? 0;
    if (dto.setTo !== undefined) {
      const level = await this.prisma.stockLevel.findFirst({
        where: { variantId: dto.variantId, warehouseId: warehouse.id, locationId: null },
      });
      const current = level ? level[dto.bucket.toLowerCase() as 'available'] : 0;
      delta = dto.setTo - current;
      if (delta === 0) {
        return { ok: true, changed: false, inventoryQuantity: undefined };
      }
    }

    const reason = dto.reason ?? 'adjustment';
    const result = await this.ledger.applyMovement({
      orgId,
      variantId: dto.variantId,
      warehouseId: warehouse.id,
      fromBucket: delta < 0 ? dto.bucket : null,
      toBucket: delta > 0 ? dto.bucket : null,
      quantity: Math.abs(delta),
      reason,
      referenceType: 'manual_adjustment',
      referenceId: dto.note ?? undefined,
      actorId: userId,
    });

    // CRM-origin stock op touching the sellable bucket → push to Shopify.
    if (dto.bucket === StockBucket.AVAILABLE) {
      await this.enqueueAvailabilityPush(orgId, [dto.variantId]);
    }
    return { ok: true, changed: !result.skipped, inventoryQuantity: result.inventoryQuantity };
  }

  // ─────────────────────────── ledger + lookup ───────────────────────────

  async listLedger(orgId: string, query: QueryLedgerDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 25;
    const where: Prisma.InventoryEventWhereInput = { organizationId: orgId };
    if (query.variantId) where.variantId = query.variantId;
    if (query.warehouseId) where.warehouseId = query.warehouseId;
    if (query.reason) where.reason = query.reason;
    if (query.dateFrom || query.dateTo) {
      where.createdAt = {
        ...(query.dateFrom ? { gte: new Date(query.dateFrom) } : {}),
        ...(query.dateTo ? { lte: new Date(query.dateTo) } : {}),
      };
    }

    const [rows, total] = await Promise.all([
      this.prisma.inventoryEvent.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.inventoryEvent.count({ where }),
    ]);

    // Enrich with current variant identity (the ledger itself only snapshots
    // the SKU — titles come from the live variant when it still exists).
    const variantIds = [...new Set(rows.map((r) => r.variantId))];
    const variants = await this.prisma.productVariant.findMany({
      where: { id: { in: variantIds } },
      select: {
        id: true,
        title: true,
        sku: true,
        product: { select: { title: true } },
      },
    });
    const byId = new Map(variants.map((v) => [v.id, v]));

    return {
      data: rows.map((r) => {
        const v = byId.get(r.variantId);
        return {
          ...r,
          variantTitle: v?.title ?? null,
          productTitle: v?.product.title ?? null,
          sku: r.skuSnapshot ?? v?.sku ?? null,
        };
      }),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  /**
   * Scan resolve: barcode first, then SKU, org-scoped (the pick/receive hot
   * path — served by the (organization_id, barcode|sku) indexes). Multiple
   * matches are returned for the operator to disambiguate (duplicate SKUs are
   * legal — Shopify allows them).
   */
  async lookup(orgId: string, code: string) {
    const trimmed = code.trim();
    if (!trimmed) throw new BadRequestException('Scan code is empty.');

    const select = {
      id: true,
      title: true,
      sku: true,
      barcode: true,
      price: true,
      inventoryQuantity: true,
      product: {
        select: {
          id: true,
          title: true,
          images: { orderBy: { position: 'asc' as const }, take: 1, select: { src: true } },
        },
      },
      stockLevels: {
        select: {
          warehouseId: true,
          available: true,
          reserved: true,
          qc: true,
          damaged: true,
          defaultLocation: { select: { fullCode: true } },
        },
      },
    };

    let matches = await this.prisma.productVariant.findMany({
      where: { organizationId: orgId, barcode: trimmed, product: { deletedAt: null } },
      select,
      take: 10,
    });
    let matchedBy: 'barcode' | 'sku' = 'barcode';
    if (matches.length === 0) {
      matches = await this.prisma.productVariant.findMany({
        where: { organizationId: orgId, sku: trimmed, product: { deletedAt: null } },
        select,
        take: 10,
      });
      matchedBy = 'sku';
    }
    return { code: trimmed, matchedBy: matches.length > 0 ? matchedBy : null, matches };
  }

  /**
   * Label-print data for a set of variants. Deliberately NOT gated on
   * warehousing — legacy orgs print barcode labels too. Quantity defaults to
   * the sellable cache (the "20 identical labels for 20 units" flow).
   */
  async getLabelData(orgId: string, variantIds: string[]) {
    if (variantIds.length === 0) return [];
    const variants = await this.prisma.productVariant.findMany({
      where: {
        id: { in: variantIds.slice(0, 200) },
        product: { organizationId: orgId, deletedAt: null },
      },
      select: {
        id: true,
        title: true,
        sku: true,
        barcode: true,
        price: true,
        inventoryQuantity: true,
        product: { select: { title: true } },
      },
    });
    return variants.map((v) => ({
      variantId: v.id,
      productTitle: v.product.title,
      variantTitle: v.title,
      sku: v.sku,
      barcode: v.barcode ?? v.sku,
      price: v.price,
      defaultQty: Math.max(0, v.inventoryQuantity),
    }));
  }

  // ─────────────────────────── helpers ───────────────────────────

  async enqueueAvailabilityPush(orgId: string, variantIds: string[]) {
    try {
      const ids = [...new Set(variantIds)];
      await this.shopifyPushQueue.add(
        'push-availability',
        { type: 'push-availability', organizationId: orgId, variantIds: ids, priority: Priority.NORMAL },
        {
          ...PUSH_JOB_OPTS,
          jobId: pushJobId.availability(orgId, ids),
          priority: Priority.NORMAL,
        },
      );
    } catch (err) {
      this.logger.warn(`Failed to enqueue availability push: ${err}`);
    }
  }

  private async assertWarehousing(orgId: string) {
    if (!(await this.ledger.isWarehousingEnabled(orgId))) {
      throw new BadRequestException(
        'Warehousing is not enabled for this organization.',
      );
    }
  }
}
