import { Injectable, Logger } from '@nestjs/common';
import { Prisma, StockBucket, SyncStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryLedgerService } from '../inventory/inventory-ledger.service';
import { ShopifyGraphqlClient , ShopifyAuthResolver } from './shopify-graphql.client';
import { ShopifyOAuthService } from './shopify-oauth.service';
import { extractStateFromAddress } from '../gst/place-of-supply.util';
import { toWarehouseAddress } from './shopify-location-address.util';
import {
  LOCATIONS_QUERY,
  LocationsResponse,
  ShopifyLocationNode,
  VARIANT_INVENTORY_LEVELS_QUERY,
  VariantInventoryLevelsResponse,
} from './shopify-graphql.types';

/** Locations per page. Shops have tens, not thousands. */
const LOCATION_PAGE_SIZE = 50;

/**
 * Variants per page for the inventory pull. Deliberately below the 50 used by
 * the other syncs: each node drags in a nested inventoryLevels connection, so
 * 50 × 50 is a materially heavier query-cost point than 50 flat nodes and is
 * the shape most likely to hit Shopify's calculated-cost throttle.
 */
const VARIANT_PAGE_SIZE = 25;

/** Inventory levels per variant. A variant is stocked at ≤ this many locations. */
const LEVELS_PER_VARIANT = 50;

/**
 * Mirrors Shopify locations as CRM warehouses, and reconciles per-location
 * stock into each mapped warehouse's AVAILABLE bucket.
 *
 * Why this exists: every location-aware path in the app used to collapse the
 * shop's locations to a single cached primary id. Shopify's
 * `variant.inventoryQuantity` is the SUM across locations, so the split never
 * reached us; the `inventory_levels/update` webhook was handed a `location_id`
 * it never read and assigned one location's quantity as the variant's whole
 * stock, making the number flip to whichever location changed last.
 *
 * The mapping is `Warehouse.shopifyLocationId`, re-resolved on every run and
 * protected by a partial unique on (organization_id, shopify_location_id).
 *
 * Direction of truth (a locked product decision): **Shopify wins on pull.**
 * Per-location quantities overwrite the mapped warehouse's AVAILABLE, with a
 * ledger row per delta. CRM-origin adjustments still push back out.
 *
 * Warehousing-only: legacy orgs keep one number per variant and physically
 * cannot hold a per-location split, so nothing here runs for them.
 */
@Injectable()
export class ShopifyLocationSyncService {
  private readonly logger = new Logger(ShopifyLocationSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly graphql: ShopifyGraphqlClient,
    private readonly shopifyOAuth: ShopifyOAuthService,
    private readonly ledger: InventoryLedgerService,
  ) {}

  // ─────────────────────────── entry points ───────────────────────────

  /**
   * Both passes for an org, resolving the channel and token itself. This is
   * what the `sync-locations` queue job calls — the enable flow reaches us
   * through that queue rather than by injection, because InventoryModule must
   * not import ChannelModule (ChannelModule already imports it).
   *
   * A no-op, not an error, when the org has no Shopify channel or has not
   * enabled warehousing: both are ordinary states, and the job fires
   * unconditionally after every enable.
   */
  async runForOrganization(orgId: string): Promise<void> {
    if (!(await this.ledger.isWarehousingEnabled(orgId))) {
      this.logger.debug(`Location sync skipped: warehousing off for org ${orgId}`);
      return;
    }

    const channel = await this.prisma.channel.findFirst({
      where: { organizationId: orgId, platform: 'SHOPIFY' },
      select: { id: true, status: true },
    });
    if (!channel) {
      this.logger.debug(`Location sync skipped: org ${orgId} has no Shopify channel`);
      return;
    }

    // A resolver, not a captured token: `pullLocationInventory` pages every
    // variant and can easily outlive the one-hour access token.
    const getAuth: ShopifyAuthResolver = async () => {
      const { token, shopDomain } = await this.shopifyOAuth.getAccessToken(channel.id);
      return { shopDomain, accessToken: token };
    };
    await this.syncLocations(channel.id, orgId, getAuth);
    await this.pullLocationInventory(channel.id, orgId, getAuth);
  }

  // ─────────────────────────── locations → warehouses ───────────────────────────

  /**
   * Create/refresh one warehouse per Shopify location.
   *
   * Deliberately conservative about existing rows: only `isActive` and the
   * default flag are ever written back. Names are authored once, on create —
   * an org that enabled warehousing before multi-location has a hand-named
   * "Main Warehouse" already mapped to the primary location, and silently
   * renaming it out from under them would be a surprise, not a sync.
   *
   * The address and the GSTIN link follow the same rule with one relaxation:
   * they are FILLED WHEN ABSENT and never overwritten. Fill-if-null rather
   * than fill-on-create because `InventoryService.enable()` creates "Main
   * Warehouse" with no address at all — it is matched or adopted here, never
   * created, so create-only would permanently strand the single warehouse most
   * merchants actually have.
   */
  async syncLocations(
    channelId: string,
    orgId: string,
    getAuth: ShopifyAuthResolver,
  ): Promise<void> {
    // Authoritative guard, deliberately here and not only in
    // runForOrganization: `runSync` reaches this directly through the
    // 'locations' entity type (it is first in PULL_ENTITY_TYPES), for EVERY
    // org. Without it a legacy org's sync invents a warehouse per Shopify
    // location — warehouses the merchant never asked for, and whose mere
    // existence used to flip the availability push into per-warehouse mode.
    // A legacy org has no stock_levels at all, so that push then found zero
    // rows and sent nothing: stock sync would stop, silently, with no
    // mutation and therefore no error to notice.
    //
    // Above openSyncLog so a legacy org does not accrue empty log rows either.
    if (!(await this.ledger.isWarehousingEnabled(orgId))) {
      this.logger.debug(`Locations sync skipped: warehousing off for org ${orgId}`);
      return;
    }

    const syncLog = await this.openSyncLog(channelId, orgId, 'locations');
    let processed = 0;

    try {
      const nodes = await this.fetchAllLocations(getAuth);
      if (nodes.length === 0) {
        this.logger.warn(`Channel ${channelId} returned no locations`);
        await this.completeSyncLog(syncLog.id, 0, 0);
        return;
      }

      const existing = await this.prisma.warehouse.findMany({
        where: { organizationId: orgId },
        select: {
          id: true,
          name: true,
          code: true,
          shopifyLocationId: true,
          isDefault: true,
          address: true,
          gstinId: true,
        },
      });

      // Auto-link only when there is exactly ONE active registration and the
      // location's state matches it. With several registrations the choice is
      // the merchant's — a wrong guess would put the wrong GSTIN on a dispatch
      // block, which is worse than leaving it unlinked.
      const activeGstins = await this.prisma.organizationGstin.findMany({
        where: { organizationId: orgId, isActive: true },
        select: { id: true, stateCode: true },
      });
      const soleGstin = activeGstins.length === 1 ? activeGstins[0] : null;

      /** Fields to fill on a warehouse that is missing them; never overwrites. */
      const enrichment = (
        node: ShopifyLocationNode,
        current?: { address: unknown; gstinId: string | null },
      ): { address?: Prisma.InputJsonValue; gstinId?: string } => {
        const patch: { address?: Prisma.InputJsonValue; gstinId?: string } = {};
        const address = toWarehouseAddress(node.address);
        if (address && current?.address == null) {
          patch.address = address as Prisma.InputJsonValue;
        }
        const effectiveAddress = current?.address ?? address;
        if (
          soleGstin &&
          current?.gstinId == null &&
          extractStateFromAddress(effectiveAddress) === soleGstin.stateCode
        ) {
          patch.gstinId = soleGstin.id;
        }
        return patch;
      };
      const byLocation = new Map(
        existing
          .filter((w) => w.shopifyLocationId)
          .map((w) => [w.shopifyLocationId as string, w]),
      );
      const usedCodes = new Set(existing.map((w) => w.code));

      // Resolve the intended default before writing anything: the demote and
      // the promote have to land in one transaction, and `update` refuses to
      // un-default the incumbent, so we drive both flags ourselves.
      const primary =
        nodes.find((n) => n.isPrimary && n.isActive) ??
        nodes.find((n) => n.isActive) ??
        nodes[0];
      const primaryLocationId = this.numericId(primary.id);

      // `enable()` reads shopifyLocationId from Channel.metadata, which is only
      // populated once resolveLocationId has run during some push. An org that
      // enabled warehousing BEFORE ever pushing to Shopify (or before
      // connecting it) therefore has a default warehouse with a NULL mapping.
      //
      // byLocation only contains warehouses that already carry a location id,
      // so that one never matches — the primary location would create a SECOND
      // warehouse beside it. The new one becomes default and receives
      // Shopify's quantities while the original keeps all the real stock,
      // unmapped and unsynced; and because the variant cache is SUM(available)
      // across ALL warehouses, the reported total roughly doubles.
      //
      // Claim it instead. Only the DEFAULT unmapped warehouse is adoptable and
      // only by the PRIMARY location — claiming a hand-created "Overflow
      // Store" for a Shopify location would be silently wrong.
      const adoptable = existing.find((w) => !w.shopifyLocationId && w.isDefault);

      const seenLocationIds = new Set<string>();

      for (const node of nodes) {
        const locationId = this.numericId(node.id);
        seenLocationIds.add(locationId);
        const match = byLocation.get(locationId);

        if (match) {
          await this.prisma.warehouse.update({
            where: { id: match.id },
            data: {
              isActive: node.isActive,
              ...this.adoptLocationName(node, match),
              ...enrichment(node, match),
            },
          });
        } else if (locationId === primaryLocationId && adoptable) {
          // Link the org's pre-existing warehouse to the primary location
          // rather than stranding it. Name and stock are untouched; it simply
          // gains the mapping it should have had at enable time.
          await this.prisma.warehouse.update({
            where: { id: adoptable.id },
            data: {
              shopifyLocationId: locationId,
              isActive: node.isActive,
              ...this.adoptLocationName(node, adoptable),
              ...enrichment(node, adoptable),
            },
          });
          // Seed the lookup so the default-settle pass below resolves it.
          byLocation.set(locationId, { ...adoptable, shopifyLocationId: locationId });
          this.logger.log(
            `Adopted existing warehouse ${adoptable.code} for Shopify location ${locationId} (org ${orgId})`,
          );
        } else {
          const code = this.deriveCode(node.name, usedCodes);
          usedCodes.add(code);
          try {
            await this.prisma.warehouse.create({
              data: {
                organizationId: orgId,
                name: node.name.trim(),
                code,
                shopifyLocationId: locationId,
                isActive: node.isActive,
                ...enrichment(node),
                // Default is settled in one pass below — creating with false
                // keeps the one-default partial unique satisfied throughout.
                isDefault: false,
              },
            });
          } catch (e) {
            // Lost a create race against the (org, shopify_location_id)
            // partial unique — a concurrent sync already mapped it. Same
            // recovery shape as InventoryLedgerService.ensureLevel.
            if (
              e instanceof Prisma.PrismaClientKnownRequestError &&
              e.code === 'P2002'
            ) {
              this.logger.debug(
                `Warehouse for location ${locationId} was created concurrently; adopting it.`,
              );
            } else {
              throw e;
            }
          }
        }
        processed++;
      }

      // A location that vanished from Shopify: deactivate, never delete —
      // stock_levels and inventory_events reference warehouses with
      // ON DELETE RESTRICT, and the ledger has to outlive the mapping.
      const stale = existing.filter(
        (w) => w.shopifyLocationId && !seenLocationIds.has(w.shopifyLocationId),
      );

      await this.settleDefaultAndDeactivate(orgId, primaryLocationId, stale.map((w) => w.id));

      // Order fulfillment still resolves a single location from here, and the
      // channel UI wants the count. Refreshing it also un-sticks the previous
      // behaviour, where this id was cached once and never revisited even if
      // the merchant changed their primary location.
      await this.refreshChannelMetadata(channelId, primaryLocationId, nodes.length);

      this.logger.log(
        `Locations synced for org ${orgId}: ${nodes.length} location(s), ${stale.length} deactivated`,
      );
      await this.completeSyncLog(syncLog.id, processed, 0);
    } catch (error) {
      await this.failSyncLog(syncLog.id, processed, 0, error);
      throw error;
    }
  }

  /**
   * Promote the primary location's warehouse to default and deactivate stale
   * ones, in a single transaction.
   *
   * Order matters and is the reason this is not two `WarehouseService.update`
   * calls: the incumbent default must be demoted before the new one is
   * promoted (one-default partial unique), and a stale warehouse that still
   * holds the default flag cannot be deactivated until it has been demoted.
   */
  private async settleDefaultAndDeactivate(
    orgId: string,
    primaryLocationId: string,
    staleWarehouseIds: string[],
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const target = await tx.warehouse.findFirst({
        where: { organizationId: orgId, shopifyLocationId: primaryLocationId },
        select: { id: true, isDefault: true },
      });

      if (target) {
        if (!target.isDefault) {
          await tx.warehouse.updateMany({
            where: { organizationId: orgId, isDefault: true },
            data: { isDefault: false },
          });
        }
        // `isActive: true` is re-asserted even when this warehouse was already
        // the default. The loop above mirrors each location's active state,
        // so a primary location deactivated in Shopify would otherwise leave
        // the org's default warehouse inactive — and WarehouseService.getDefault
        // requires isActive, so every adjustment would start throwing
        // "No default warehouse".
        await tx.warehouse.update({
          where: { id: target.id },
          data: { isDefault: true, isActive: true },
        });
      }

      if (staleWarehouseIds.length > 0) {
        // The `isDefault: false` guard is what stops the org being stranded
        // without a default. By this point the promote above has already
        // demoted the incumbent whenever a replacement exists, so a stale
        // warehouse still holding the flag means nothing replaced it — and
        // deactivating that one would leave WarehouseService.getDefault()
        // throwing on every adjustment.
        await tx.warehouse.updateMany({
          where: { id: { in: staleWarehouseIds }, isDefault: false },
          data: { isActive: false },
        });
      }
    });
  }

  private async refreshChannelMetadata(
    channelId: string,
    primaryLocationId: string,
    locationCount: number,
  ): Promise<void> {
    const channel = await this.prisma.channel.findUnique({
      where: { id: channelId },
      select: { metadata: true },
    });
    const meta = (channel?.metadata as Prisma.JsonObject) ?? {};
    await this.prisma.channel.update({
      where: { id: channelId },
      data: {
        metadata: {
          ...meta,
          shopifyLocationId: Number(primaryLocationId),
          shopifyLocationCount: locationCount,
        } as Prisma.InputJsonObject,
      },
    });
  }

  private async fetchAllLocations(
    getAuth: ShopifyAuthResolver,
  ): Promise<ShopifyLocationNode[]> {
    const all: ShopifyLocationNode[] = [];
    let cursor: string | null = null;

    do {
      const res: LocationsResponse = await this.graphql.request<LocationsResponse>(
        await getAuth(),
        LOCATIONS_QUERY,
        { first: LOCATION_PAGE_SIZE, after: cursor },
      );
      all.push(...(res.locations?.nodes ?? []));
      cursor = res.locations?.pageInfo?.hasNextPage
        ? res.locations.pageInfo.endCursor
        : null;
    } while (cursor);

    return all;
  }

  // ─────────────────────────── per-location stock ───────────────────────────

  /**
   * Reconcile every mapped warehouse's AVAILABLE bucket against Shopify's
   * per-location quantities.
   *
   * Idempotency is structural: each level is compared against what we already
   * hold and a zero delta writes nothing. That is also the echo suppression —
   * after a CRM push, Shopify's returning webhook carries the value we just
   * wrote, so the diff is zero and no ledger row appears. For the same reason
   * NO `idempotencyKey` is passed to applyMovement: a stable key would make
   * every run after the first a permanent no-op.
   */
  async pullLocationInventory(
    channelId: string,
    orgId: string,
    getAuth: ShopifyAuthResolver,
  ): Promise<void> {
    // Deliberately NOT the 'inventory' entity type used by the legacy pull.
    // Both resume from a saved cursor, but they page different connections
    // (`products` there, `productVariants` here) — sharing the label would let
    // an org that switched to warehousing resume this query from a cursor
    // minted by the other one, which Shopify rejects outright.
    const syncLog = await this.openSyncLog(channelId, orgId, 'location-inventory');
    let processed = 0;
    let failed = 0;
    let unmappedLevels = 0;
    let truncatedVariants = 0;
    // Rows materialised for levels Shopify stocks at zero. Not movements, so
    // they are reported separately and excluded from the sync log counts.
    let created = 0;

    try {
      let warehouses = await this.loadMappedWarehouses(orgId);
      if (warehouses.length === 0) {
        // Nothing mapped yet — a sync triggered for `inventory` alone, or the
        // first run after enabling warehousing. Build the mapping rather than
        // making this a dead end, then re-read. syncLocations never calls
        // back into here, so there is no recursion.
        this.logger.log(
          `No Shopify-mapped warehouses for org ${orgId}; running the locations pass first.`,
        );
        await this.syncLocations(channelId, orgId, getAuth);
        warehouses = await this.loadMappedWarehouses(orgId);
      }
      if (warehouses.length === 0) {
        this.logger.warn(
          `Org ${orgId} still has no Shopify-mapped warehouses; skipping the per-location reconcile.`,
        );
        await this.completeSyncLog(syncLog.id, 0, 0);
        return;
      }
      const warehouseByLocation = new Map(
        warehouses.map((w) => [w.shopifyLocationId as string, w.id]),
      );


      let cursor: string | null = syncLog.cursor ?? null;

      do {
        const res: VariantInventoryLevelsResponse =
          await this.graphql.request<VariantInventoryLevelsResponse>(
            // Per page: this walks every variant in the catalogue and is the
            // single longest-running Shopify read in the codebase.
            await getAuth(),
            VARIANT_INVENTORY_LEVELS_QUERY,
            {
              first: VARIANT_PAGE_SIZE,
              after: cursor,
              levelsFirst: LEVELS_PER_VARIANT,
            },
          );

        // One lookup for the page rather than per variant: resolve our
        // variants by inventory item id (indexed), scoped to the org.
        const itemIds = res.productVariants.nodes
          .map((n) => n.inventoryItem?.id)
          .filter((id): id is string => !!id)
          .map((gid) => ShopifyGraphqlClient.extractId(gid));

        const ours = itemIds.length
          ? await this.prisma.productVariant.findMany({
              where: {
                inventoryItemId: { in: itemIds },
                product: { organizationId: orgId, deletedAt: null },
              },
              select: { id: true, inventoryItemId: true },
            })
          : [];
        const variantByItemId = new Map(
          ours.map((v) => [v.inventoryItemId as string, v.id]),
        );

        // Current buckets for the whole page, keyed variant:warehouse.
        // `existing` distinguishes "no row" from "row holding zero" — the two
        // are indistinguishable by quantity alone, and conflating them is what
        // left zero-stock variants with no row and therefore invisible to
        // InventoryService.listStock, which reads stock_levels only.
        const {
          available: currentAvailable,
          reserved: currentReserved,
          existing,
        } = await this.loadAvailable(
          [...variantByItemId.values()],
        );
        // (variant, warehouse) pairs Shopify stocks but we hold no row for.
        // Collected across the page and inserted in one statement below.
        const missingRows: {
          organizationId: string;
          variantId: string;
          warehouseId: string;
        }[] = [];

        for (const node of res.productVariants.nodes) {
          const itemGid = node.inventoryItem?.id;
          if (!itemGid) continue;
          const variantId = variantByItemId.get(
            ShopifyGraphqlClient.extractId(itemGid),
          );
          // Not a product we hold (unsynced, deleted, or another org's) —
          // the product sync owns creating it, not us.
          if (!variantId) continue;

          const levels = node.inventoryItem?.inventoryLevels;
          if (levels?.pageInfo?.hasNextPage) truncatedVariants++;

          for (const level of levels?.nodes ?? []) {
            const locationId = this.numericId(level.location.id);
            const warehouseId = warehouseByLocation.get(locationId);
            if (!warehouseId) {
              unmappedLevels++;
              continue;
            }

            const available = level.quantities.find(
              (q) => q.name === 'available',
            )?.quantity;
            if (typeof available !== 'number') continue;

            const key = `${variantId}:${warehouseId}`;

            // Shopify's COMMITTED — units promised to placed-but-unfulfilled
            // orders. They are still physically on the shelf, so mirroring
            // them into RESERVED is what makes our on-hand (a generated sum of
            // the buckets) agree with Shopify's. Without it we understate on
            // hand by exactly the committed quantity, and a merchant counting
            // the shelf finds us wrong whenever an order is open.
            //
            // Shopify owns this number outright — the Admin API cannot even
            // write it — so it is mirrored, never computed locally.
            const committed = level.quantities.find(
              (q) => q.name === 'committed',
            )?.quantity;
            if (typeof committed === 'number') {
              const reservedDelta = committed - (currentReserved.get(key) ?? 0);
              if (reservedDelta !== 0) {
                try {
                  await this.ledger.applyMovement({
                    orgId,
                    variantId,
                    warehouseId,
                    // In and out of the system rather than to/from AVAILABLE:
                    // Shopify has already taken these units out of its own
                    // available, and the available reconcile below writes that
                    // figure verbatim. Moving them between our buckets as well
                    // would deduct them twice.
                    fromBucket: reservedDelta < 0 ? StockBucket.RESERVED : null,
                    toBucket: reservedDelta > 0 ? StockBucket.RESERVED : null,
                    quantity: Math.abs(reservedDelta),
                    reason: 'sync',
                    referenceType: 'shopify_location_sync',
                    referenceId: locationId,
                  });
                } catch (error) {
                  this.logger.warn(
                    `Failed to mirror committed for variant ${variantId} at location ${locationId}: ${error instanceof Error ? error.message : error}`,
                  );
                }
              }
            }
            const current = currentAvailable.get(key) ?? 0;
            const delta = available - current;
            if (delta === 0) {
              // Shopify stocks this item here. Nothing moved, but if we hold no
              // row the variant never appears on the inventory screen at all —
              // materialise it at zero. Deliberately no inventory_events row:
              // creating an empty bucket is not a stock movement.
              if (!existing.has(key)) {
                missingRows.push({ organizationId: orgId, variantId, warehouseId });
              }
              continue;
            }

            try {
              await this.ledger.applyMovement({
                orgId,
                variantId,
                warehouseId,
                fromBucket: delta < 0 ? StockBucket.AVAILABLE : null,
                toBucket: delta > 0 ? StockBucket.AVAILABLE : null,
                quantity: Math.abs(delta),
                reason: 'sync',
                referenceType: 'shopify_location_sync',
                referenceId: locationId,
                // Shopify is authoritative here. Refusing a decrease that
                // would cross zero would leave the two systems permanently
                // out of step; oversold is surfaced as an alert instead.
                allowNegativeAvailable: true,
              });
              processed++;
            } catch (error) {
              failed++;
              this.logger.warn(
                `Failed to reconcile variant ${variantId} at location ${locationId}: ${error instanceof Error ? error.message : error}`,
              );
            }
          }
        }

        // One statement per page rather than a round trip per variant.
        // skipDuplicates emits ON CONFLICT DO NOTHING with no conflict target,
        // so it is safe against the partial unique index on
        // (variant_id, warehouse_id) WHERE location_id IS NULL — an upsert,
        // which must name a target, would not be.
        if (missingRows.length > 0) {
          await this.prisma.stockLevel.createMany({
            data: missingRows,
            skipDuplicates: true,
          });
          created += missingRows.length;
        }

        cursor = res.productVariants.pageInfo.hasNextPage
          ? res.productVariants.pageInfo.endCursor
          : null;
        // Persist the cursor so a crashed run resumes rather than re-walking
        // the catalogue — the same resume contract the other syncs use.
        await this.prisma.syncLog.update({
          where: { id: syncLog.id },
          data: { cursor },
        });
      } while (cursor);

      if (unmappedLevels > 0) {
        this.logger.warn(
          `${unmappedLevels} inventory level(s) sat at locations with no mapped warehouse for org ${orgId} — re-run the locations sync.`,
        );
      }
      if (truncatedVariants > 0) {
        this.logger.warn(
          `${truncatedVariants} variant(s) are stocked at more than ${LEVELS_PER_VARIANT} locations; the remainder was not read.`,
        );
      }
      this.logger.log(
        `Per-location inventory reconciled for org ${orgId}: ${processed} movement(s), ${created} row(s) created, ${failed} failed`,
      );
      await this.completeSyncLog(syncLog.id, processed, failed);
    } catch (error) {
      await this.failSyncLog(syncLog.id, processed, failed, error);
      throw error;
    }
  }

  /** Active warehouses carrying a Shopify location mapping. */
  private async loadMappedWarehouses(orgId: string) {
    return this.prisma.warehouse.findMany({
      where: {
        organizationId: orgId,
        shopifyLocationId: { not: null },
        isActive: true,
      },
      select: { id: true, shopifyLocationId: true },
    });
  }

  /**
   * Warehouse-level AVAILABLE per variant, keyed `variantId:warehouseId`.
   *
   * `existing` carries which keys actually have a row. A caller cannot infer
   * that from `available` alone — an absent row and a row holding 0 both read
   * as 0 — and the two need different handling.
   */
  private async loadAvailable(variantIds: string[]): Promise<{
    available: Map<string, number>;
    reserved: Map<string, number>;
    existing: Set<string>;
  }> {
    if (variantIds.length === 0) {
      return { available: new Map(), reserved: new Map(), existing: new Set() };
    }
    const rows = await this.prisma.stockLevel.findMany({
      where: { variantId: { in: variantIds }, locationId: null },
      select: {
        variantId: true,
        warehouseId: true,
        available: true,
        reserved: true,
      },
    });
    const available = new Map<string, number>();
    const reserved = new Map<string, number>();
    const existing = new Set<string>();
    for (const r of rows) {
      const key = `${r.variantId}:${r.warehouseId}`;
      available.set(key, r.available);
      reserved.set(key, r.reserved);
      existing.add(key);
    }
    return { available, reserved, existing };
  }

  // ─────────────────────────── helpers ───────────────────────────

  /**
   * Mirror Shopify's location name onto the warehouse, verbatim.
   *
   * Shopify owns location names the same way it owns per-location quantities —
   * the module’s "Shopify wins on pull" rule — so a rename upstream lands here
   * on the next sync. Before this, `syncLocations` wrote only isActive and the
   * address/GSTIN enrichment onto an existing warehouse, so the name set at
   * create time was permanent. Shrishti Jewels on 2026-09-04: the primary
   * location "Shrishti Jewels 12 Stadium Bypass Road Selvapalayam" had been
   * adopted into the warehouse `enable()` seeds as "Main Warehouse"/"WH1" and
   * stayed on screen under that placeholder, so it read as a location that had
   * never synced at all.
   *
   * Consequence worth knowing: a warehouse renamed in the CRM reverts to the
   * Shopify name on the next sync. Rename it in Shopify instead.
   *
   * The `code` is deliberately never touched — it prefixes bin fullCodes and is
   * printed on pick lists, so rewriting it would break scanning.
   */
  private adoptLocationName(
    node: ShopifyLocationNode,
    current: { name: string },
  ): { name?: string } {
    const name = node.name?.trim();
    if (!name || name === current.name) return {};
    // Stored verbatim, at any length. Merchants must see the location name
    // exactly as Shopify shows it, so nothing is truncated here — the column is
    // TEXT and CreateWarehouseDto's cap is sized to match (warehouse.dto.ts).
    return { name };
  }

  /** `gid://shopify/Location/123` → `"123"`. Stored as text on Warehouse. */
  private numericId(gid: string): string {
    return ShopifyGraphqlClient.extractId(gid);
  }

  /**
   * A scanner-safe warehouse code from a location name, unique within the org.
   * "Kochi Store" → "KOCHIS"; on collision "KOCHIS2", "KOCHIS3"…
   *
   * Must satisfy CreateWarehouseDto's ^[A-Z0-9]{1,8}$ so a code minted here is
   * still valid if a merchant later edits that warehouse through the API.
   */
  private deriveCode(name: string, used: Set<string>): string {
    const base = name.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || 'WH';
    if (!used.has(base)) return base;
    for (let n = 2; n < 1000; n++) {
      const suffix = String(n);
      const candidate = base.slice(0, 8 - suffix.length) + suffix;
      if (!used.has(candidate)) return candidate;
    }
    // 999 warehouses sharing a six-character stem is not a real shop, but a
    // silent duplicate would trip the (org, code) unique — fail loudly.
    throw new Error(`Could not derive a unique warehouse code from "${name}"`);
  }

  // Sync-log lifecycle. Intentionally thinner than ShopifySyncService's
  // (whose helpers are private to it): the location pass is a handful of rows,
  // and the inventory pass is a diff-based reconcile, so an abandoned run is
  // safe to restart from its cursor or from scratch.
  private async openSyncLog(channelId: string, orgId: string, entityType: string) {
    const resumable = await this.prisma.syncLog.findFirst({
      where: {
        channelId,
        entityType,
        status: SyncStatus.IN_PROGRESS,
        cursor: { not: null },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (resumable) return resumable;

    return this.prisma.syncLog.create({
      data: {
        organizationId: orgId,
        channelId,
        entityType,
        status: SyncStatus.IN_PROGRESS,
        startedAt: new Date(),
      },
    });
  }

  private async completeSyncLog(logId: string, processed: number, failed: number) {
    await this.prisma.syncLog.update({
      where: { id: logId },
      data: {
        status: SyncStatus.COMPLETED,
        recordsProcessed: processed,
        recordsFailed: failed,
        cursor: null,
        completedAt: new Date(),
      },
    });
  }

  private async failSyncLog(
    logId: string,
    processed: number,
    failed: number,
    error: unknown,
  ) {
    await this.prisma.syncLog.update({
      where: { id: logId },
      data: {
        status: SyncStatus.FAILED,
        recordsProcessed: processed,
        recordsFailed: failed,
        errorMessage: error instanceof Error ? error.message : String(error),
        completedAt: new Date(),
      },
    });
  }
}
