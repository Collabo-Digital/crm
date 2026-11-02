import { Injectable, Logger } from '@nestjs/common';
import {
  Prisma,
  ShopifyLocationAction,
  ShopifyLocationLink,
  StockBucket,
  StockLocationKind,
  SyncStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryLedgerService } from '../inventory/inventory-ledger.service';
import { deriveLocationCode } from '../inventory/location-links.service';
import { findStateGstin } from '../inventory/warehouse-gstin.util';
import {
  InventorySettingsSchema,
  parseInventorySettings,
} from '../organization-settings/schemas/inventory-settings.schema';
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

export interface LocationSyncOptions {
  /**
   * Link every undecided Shopify location as the sync did before decisions
   * existed — the primary to the default location, each other one to a new
   * warehouse — and record those links as decided. The enable flow only.
   */
  autoLink?: boolean;
}

/**
 * Keeps a store's Shopify locations recorded (ShopifyLocationLink) and the
 * stock locations linked to them up to date, and reconciles per-location stock
 * into each linked location's AVAILABLE bucket.
 *
 * Why this exists: every location-aware path in the app used to collapse the
 * shop's locations to a single cached primary id. Shopify's
 * `variant.inventoryQuantity` is the SUM across locations, so the split never
 * reached us; the `inventory_levels/update` webhook was handed a `location_id`
 * it never read and assigned one location's quantity as the variant's whole
 * stock, making the number flip to whichever location changed last.
 *
 * WHICH location shares stock with which is the merchant's decision
 * (`Warehouse.shopifyLocationId`, protected by a partial unique on
 * (organization_id, shopify_location_id)). A sync never makes one on its own:
 * a Shopify location it has not seen before is recorded with no decision and
 * waits for the merchant. The one exception is the enable flow
 * (`autoLink`), which links an existing store as it always was.
 *
 * Direction of truth (a locked product decision): **Shopify wins on pull.**
 * Per-location quantities overwrite the linked location's AVAILABLE, with a
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
  async runForOrganization(orgId: string, options: LocationSyncOptions = {}): Promise<void> {
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
    const getAuth = this.authFor(channel.id);
    await this.syncLocations(channel.id, orgId, getAuth, options);
    await this.pullLocationInventory(channel.id, orgId, getAuth);
  }

  /** A per-request token resolver for one channel. */
  authFor(channelId: string): ShopifyAuthResolver {
    return async () => {
      const { token, shopDomain } = await this.shopifyOAuth.getAccessToken(channelId);
      return { shopDomain, accessToken: token };
    };
  }

  // ─────────────────────────── Shopify locations ───────────────────────────

  /**
   * Record the store's Shopify locations and bring the stock locations linked
   * to them up to date.
   *
   *  - A linked location mirrors its Shopify location's active flag (never
   *    switching off the default, which every adjustment needs), and takes its
   *    name only when it was created from Shopify — a location the merchant
   *    named and then linked keeps their name.
   *  - A Shopify location seen for the first time is recorded with no decision:
   *    it "needs linking", and nothing syncs for it until the merchant decides.
   *  - A Shopify location that disappeared deactivates the location linked to
   *    it (not the default) and its record goes.
   *  - The default location is never moved: it is the merchant's choice.
   *
   * The address and the GSTIN link are FILLED WHEN ABSENT and never
   * overwritten, so the "Main warehouse" a workspace starts with picks up its
   * Shopify location's address once linked.
   */
  async syncLocations(
    channelId: string,
    orgId: string,
    getAuth: ShopifyAuthResolver,
    options: LocationSyncOptions = {},
  ): Promise<void> {
    // Authoritative guard, deliberately here and not only in
    // runForOrganization: `runSync` reaches this directly through the
    // 'locations' entity type (it is first in PULL_ENTITY_TYPES), for EVERY
    // org. A legacy org holds one quantity per variant and has nowhere to put
    // a per-location split.
    //
    // Above openSyncLog so a legacy org does not accrue empty log rows either.
    if (!(await this.ledger.isWarehousingEnabled(orgId))) {
      this.logger.debug(`Locations sync skipped: warehousing off for org ${orgId}`);
      return;
    }

    const syncLog = await this.openSyncLog(channelId, orgId, 'locations');
    let processed = 0;
    const linkPending = await this.autoLinkPending(orgId);
    const autoLink = options.autoLink === true || linkPending;

    try {
      const nodes = await this.fetchAllLocations(getAuth);
      if (nodes.length === 0) {
        this.logger.warn(`Channel ${channelId} returned no locations`);
        await this.completeSyncLog(syncLog.id, 0, 0);
        return;
      }

      const records = await this.recordLocations(channelId, orgId, nodes);
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
      const gstEnabled =
        (
          await this.prisma.organization.findUnique({
            where: { id: orgId },
            select: { gstEnabled: true },
          })
        )?.gstEnabled === true;

      /** Fields to fill on a location that is missing them; never overwrites. */
      const enrichment = async (
        node: ShopifyLocationNode,
        current?: { address: unknown; gstinId: string | null },
      ): Promise<{ address?: Prisma.InputJsonValue; gstinId?: string }> => {
        const patch: { address?: Prisma.InputJsonValue; gstinId?: string } = {};
        const address = toWarehouseAddress(node.address);
        if (address && current?.address == null) {
          patch.address = address as Prisma.InputJsonValue;
        }
        if (gstEnabled && current?.gstinId == null) {
          // The workspace's registration for the location's state, as a
          // location with no GSTIN of its own gets when created by hand.
          const gstin = await findStateGstin(
            this.prisma,
            orgId,
            extractStateFromAddress(current?.address ?? address),
          );
          if (gstin) patch.gstinId = gstin.id;
        }
        return patch;
      };
      const byLocation = new Map(
        existing
          .filter((w) => w.shopifyLocationId)
          .map((w) => [w.shopifyLocationId as string, w]),
      );
      const usedCodes = new Set(existing.map((w) => w.code));

      const primary =
        nodes.find((n) => n.isPrimary && n.isActive) ??
        nodes.find((n) => n.isActive) ??
        nodes[0];
      const primaryLocationId = this.numericId(primary.id);

      // The enable flow only. `enable()` maps the default warehouse from the
      // primary id cached in Channel.metadata, which is only populated once a
      // push has run — so an org that enabled before ever pushing has a
      // default with no link, and the primary location must claim it rather
      // than create a second warehouse beside it (which would then receive
      // Shopify's quantities while the original kept the real stock, roughly
      // doubling the reported total). Only the DEFAULT unlinked location is
      // claimable, and only by the PRIMARY Shopify location.
      const adoptable = autoLink
        ? existing.find((w) => !w.shopifyLocationId && w.isDefault)
        : undefined;

      const seenLocationIds = new Set<string>();

      for (const node of nodes) {
        const locationId = this.numericId(node.id);
        seenLocationIds.add(locationId);
        const record = records.get(locationId)!;
        const match = byLocation.get(locationId);

        if (match) {
          const createdFromShopify =
            record.action === ShopifyLocationAction.CREATE && record.warehouseId === match.id;
          // The enable flow names a location it links as it always did: a
          // default pre-linked from the cached primary would otherwise keep
          // the placeholder "Main warehouse" (see adoptLocationName).
          const takesShopifyName = createdFromShopify || (autoLink && record.action === null);
          await this.prisma.warehouse.update({
            where: { id: match.id },
            data: {
              ...(match.isDefault ? {} : { isActive: node.isActive }),
              ...(takesShopifyName ? this.adoptLocationName(node, match) : {}),
              ...(await enrichment(node, match)),
            },
          });
          // Linked before decisions were recorded, or relinked by hand since:
          // the link IS the decision.
          if (!createdFromShopify && (record.action !== ShopifyLocationAction.LINK || record.warehouseId !== match.id)) {
            await this.recordDecision(record.id, ShopifyLocationAction.LINK, match.id);
          }
        } else if (autoLink && record.action !== ShopifyLocationAction.IGNORE) {
          await this.autoLink(orgId, node, locationId, {
            adopt: locationId === primaryLocationId ? adoptable : undefined,
            usedCodes,
            recordId: record.id,
            enrichment,
          });
        } else if (record.action === ShopifyLocationAction.LINK || record.action === ShopifyLocationAction.CREATE) {
          // Its location was unlinked since: it waits for a decision again.
          await this.prisma.shopifyLocationLink.update({
            where: { id: record.id },
            data: { action: null, warehouseId: null, decidedAt: null },
          });
        }
        processed++;
      }

      // A location that vanished from Shopify: deactivate, never delete —
      // stock_levels and inventory_events reference warehouses with
      // ON DELETE RESTRICT, and the ledger has to outlive the link. The
      // default is left alone: every adjustment needs it active.
      const stale = existing.filter(
        (w) => w.shopifyLocationId && !seenLocationIds.has(w.shopifyLocationId) && !w.isDefault,
      );
      if (stale.length > 0) {
        await this.prisma.warehouse.updateMany({
          where: { id: { in: stale.map((w) => w.id) } },
          data: { isActive: false },
        });
      }
      await this.prisma.shopifyLocationLink.deleteMany({
        where: { channelId, shopifyLocationId: { notIn: [...seenLocationIds] } },
      });

      // Order fulfillment still resolves a single location from here, and the
      // channel UI wants the count. Refreshing it also un-sticks the previous
      // behaviour, where this id was cached once and never revisited even if
      // the merchant changed their primary location.
      await this.refreshChannelMetadata(channelId, primaryLocationId, nodes.length);
      if (linkPending) await this.clearAutoLink(orgId);

      this.logger.log(
        `Locations synced for org ${orgId}: ${nodes.length} location(s), ${stale.length} deactivated`,
      );
      await this.completeSyncLog(syncLog.id, processed, 0);
    } catch (error) {
      await this.failSyncLog(syncLog.id, processed, 0, error);
      throw error;
    }
  }

  /** Whether the enable flow's linking of this org's store is still to be done. */
  async autoLinkPending(orgId: string): Promise<boolean> {
    const row = await this.prisma.organizationSettings.findUnique({
      where: { organizationId: orgId },
      select: { inventorySettings: true },
    });
    return parseInventorySettings(row?.inventorySettings ?? null).linkShopifyLocations;
  }

  private async clearAutoLink(orgId: string): Promise<void> {
    const row = await this.prisma.organizationSettings.findUnique({
      where: { organizationId: orgId },
      select: { inventorySettings: true },
    });
    const inventorySettings = InventorySettingsSchema.parse({
      ...parseInventorySettings(row?.inventorySettings ?? null),
      linkShopifyLocations: false,
    }) as Prisma.InputJsonValue;
    await this.prisma.organizationSettings.update({
      where: { organizationId: orgId },
      data: { inventorySettings },
    });
  }

  /**
   * Upsert one record per Shopify location with what Shopify says about it.
   * The decision columns are never written here: a location seen for the
   * first time starts undecided.
   */
  private async recordLocations(
    channelId: string,
    orgId: string,
    nodes: ShopifyLocationNode[],
  ): Promise<Map<string, ShopifyLocationLink>> {
    const records = new Map<string, ShopifyLocationLink>();
    for (const node of nodes) {
      const shopifyLocationId = this.numericId(node.id);
      const fields = {
        name: node.name?.trim() || `Location ${shopifyLocationId}`,
        isPrimary: node.isPrimary === true,
        isActive: node.isActive !== false,
        address: (toWarehouseAddress(node.address) ?? Prisma.DbNull) as Prisma.InputJsonValue,
      };
      const record = await this.prisma.shopifyLocationLink.upsert({
        where: { channelId_shopifyLocationId: { channelId, shopifyLocationId } },
        create: { organizationId: orgId, channelId, shopifyLocationId, ...fields },
        update: fields,
      });
      records.set(shopifyLocationId, record);
    }
    return records;
  }

  private async recordDecision(
    recordId: string,
    action: ShopifyLocationAction,
    warehouseId: string | null,
  ): Promise<void> {
    await this.prisma.shopifyLocationLink.update({
      where: { id: recordId },
      data: { action, warehouseId, decidedAt: new Date() },
    });
  }

  /**
   * The enable flow's link for one undecided Shopify location: claim the
   * default location for the primary, otherwise a new warehouse of its own.
   */
  private async autoLink(
    orgId: string,
    node: ShopifyLocationNode,
    locationId: string,
    ctx: {
      adopt?: { id: string; name: string; address: unknown; gstinId: string | null };
      usedCodes: Set<string>;
      recordId: string;
      enrichment: (
        node: ShopifyLocationNode,
        current?: { address: unknown; gstinId: string | null },
      ) => Promise<{ address?: Prisma.InputJsonValue; gstinId?: string }>;
    },
  ): Promise<void> {
    if (ctx.adopt) {
      // Name and stock are untouched apart from the Shopify name; it simply
      // gains the link it should have had at enable time.
      await this.prisma.warehouse.update({
        where: { id: ctx.adopt.id },
        data: {
          shopifyLocationId: locationId,
          ...this.adoptLocationName(node, ctx.adopt),
          ...(await ctx.enrichment(node, ctx.adopt)),
        },
      });
      await this.recordDecision(ctx.recordId, ShopifyLocationAction.LINK, ctx.adopt.id);
      this.logger.log(
        `Linked the default location ${ctx.adopt.id} to Shopify location ${locationId} (org ${orgId})`,
      );
      return;
    }

    const code = deriveLocationCode(node.name, ctx.usedCodes);
    ctx.usedCodes.add(code);
    try {
      const created = await this.prisma.warehouse.create({
        data: {
          organizationId: orgId,
          name: node.name.trim(),
          code,
          kind: StockLocationKind.WAREHOUSE,
          shopifyLocationId: locationId,
          isActive: node.isActive,
          ...(await ctx.enrichment(node)),
          isDefault: false,
        },
        select: { id: true },
      });
      await this.recordDecision(ctx.recordId, ShopifyLocationAction.CREATE, created.id);
    } catch (e) {
      // Lost a create race against the (org, shopify_location_id) partial
      // unique — a concurrent sync already linked it, and recorded it.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        this.logger.debug(`Location for Shopify location ${locationId} was created concurrently.`);
      } else {
        throw e;
      }
    }
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
        // Nothing linked yet — a sync triggered for `inventory` alone, or the
        // store's locations never recorded. Record them (each then waits for
        // the merchant's decision) rather than making this a dead end, then
        // re-read. syncLocations never calls back into here, so there is no
        // recursion.
        this.logger.log(
          `No Shopify-linked locations for org ${orgId}; running the locations pass first.`,
        );
        await this.syncLocations(channelId, orgId, getAuth);
        warehouses = await this.loadMappedWarehouses(orgId);
      }
      if (warehouses.length === 0) {
        this.logger.log(
          `Org ${orgId} has no location linked to Shopify; skipping the per-location reconcile.`,
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
        this.logger.log(
          `${unmappedLevels} inventory level(s) sat at Shopify locations not linked to a location for org ${orgId}.`,
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
   * Mirror Shopify's location name onto a location created from Shopify (or
   * claimed by the enable flow), verbatim.
   *
   * Shopify owns those names the same way it owns per-location quantities —
   * the module’s "Shopify wins on pull" rule — so a rename upstream lands here
   * on the next sync. A location the merchant named themselves and then linked
   * keeps their name. Before this, `syncLocations` wrote only isActive and the
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
