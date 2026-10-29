import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  ChannelPlatform,
  Prisma,
  ShopifyLocationAction,
  StockLocationKind,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryLedgerService } from '../inventory/inventory-ledger.service';
import { LocationLinkService, deriveLocationCode } from '../inventory/location-links.service';
import { findStateGstin } from '../inventory/warehouse-gstin.util';
import { extractStateFromAddress } from '../gst/place-of-supply.util';
import { ShopifyLocationSyncService } from './shopify-location-sync.service';
import { ApplyShopifyLocationDecisionsDto } from './dto/shopify-location-decisions.dto';

type LocationDecision =
  | { action: 'link' | 'create'; warehouseId: string; warehouseName: string }
  | { action: 'ignore' }
  | null;

export interface ShopifyLocationsView {
  status: 'PENDING' | 'DONE';
  locations: Array<{
    id: string;
    name: string;
    isPrimary: boolean;
    isActive: boolean;
    address: { city: string | null; stateCode: string | null } | null;
    decision: LocationDecision;
  }>;
  warehouses: Array<{
    id: string;
    name: string;
    kind: StockLocationKind;
    isDefault: boolean;
    hasStock: boolean;
    shopifyLocationId: string | null;
  }>;
}

/**
 * The merchant's decisions about a connected store's Shopify locations: what
 * the screen shows (`view`), applying what they chose (`apply`), and recording
 * the locations when the store connects (`onConnect`).
 */
@Injectable()
export class ShopifyLocationDecisionService {
  private readonly logger = new Logger(ShopifyLocationDecisionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly locationSync: ShopifyLocationSyncService,
    private readonly links: LocationLinkService,
    private readonly ledger: InventoryLedgerService,
  ) {}

  /**
   * Record a just-connected store's locations, each waiting for a decision
   * unless it is linked already (a reconnect). Never throws: a store that
   * connected must not report a failed connect because its locations could
   * not be read — `recorded: false` tells the caller to have the queued sync
   * read them instead.
   */
  async onConnect(
    channelId: string,
    orgId: string,
  ): Promise<{ warehousing: boolean; recorded: boolean; pending: boolean; linked: boolean }> {
    if (!(await this.ledger.isWarehousingEnabled(orgId))) {
      return { warehousing: false, recorded: false, pending: false, linked: false };
    }
    try {
      await this.locationSync.syncLocations(channelId, orgId, this.locationSync.authFor(channelId));
      const view = await this.view(channelId, orgId);
      return {
        warehousing: true,
        recorded: true,
        pending: view.status === 'PENDING',
        linked: view.locations.some((l) => l.decision && l.decision.action !== 'ignore'),
      };
    } catch (err) {
      this.logger.warn(
        `Could not read the Shopify locations of channel ${channelId} on connect; the first sync reads them: ${err instanceof Error ? err.message : err}`,
      );
      return { warehousing: true, recorded: false, pending: false, linked: false };
    }
  }

  async view(channelId: string, orgId: string): Promise<ShopifyLocationsView> {
    await this.assertShopifyChannel(channelId, orgId);
    const [records, warehouses, stocked] = await Promise.all([
      this.prisma.shopifyLocationLink.findMany({
        where: { channelId },
        orderBy: [{ isPrimary: 'desc' }, { name: 'asc' }],
      }),
      this.prisma.warehouse.findMany({
        where: { organizationId: orgId },
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
        select: { id: true, name: true, kind: true, shopifyLocationId: true, isActive: true, isDefault: true },
      }),
      this.prisma.stockLevel.groupBy({
        by: ['warehouseId'],
        where: {
          organizationId: orgId,
          OR: [
            { available: { not: 0 } },
            { reserved: { not: 0 } },
            { qc: { not: 0 } },
            { damaged: { not: 0 } },
          ],
        },
      }),
    ]);
    const hasStock = new Set(stocked.map((s) => s.warehouseId));
    const linkedTo = new Map(
      warehouses.filter((w) => w.shopifyLocationId).map((w) => [w.shopifyLocationId as string, w]),
    );

    const locations = records.map((record) => {
      // What actually shares stock is the location's link; the record only
      // says how it came about.
      const linked = linkedTo.get(record.shopifyLocationId);
      const decision: LocationDecision = linked
        ? {
            action:
              record.action === ShopifyLocationAction.CREATE && record.warehouseId === linked.id
                ? 'create'
                : 'link',
            warehouseId: linked.id,
            warehouseName: linked.name,
          }
        : record.action === ShopifyLocationAction.IGNORE
          ? { action: 'ignore' }
          : null;
      const address = record.address as { city?: unknown } | null;
      return {
        id: record.shopifyLocationId,
        name: record.name,
        isPrimary: record.isPrimary,
        isActive: record.isActive,
        address: address
          ? {
              city: typeof address.city === 'string' ? address.city : null,
              stateCode: extractStateFromAddress(address),
            }
          : null,
        decision,
      };
    });

    // Every store has at least one location, so none recorded means they
    // have not been read yet (the screen polls) — unless the workspace is
    // still on a single stock quantity, where there is nothing to decide.
    const notReadYet = records.length === 0 && (await this.ledger.isWarehousingEnabled(orgId));
    return {
      // An inactive Shopify location holds nothing to sell, so it never keeps
      // the store waiting — it can still be decided.
      status: notReadYet || locations.some((l) => l.isActive && l.decision === null) ? 'PENDING' : 'DONE',
      locations,
      warehouses: warehouses
        .filter((w) => w.isActive)
        .map((w) => ({
          id: w.id,
          name: w.name,
          kind: w.kind,
          isDefault: w.isDefault,
          hasStock: hasStock.has(w.id),
          shopifyLocationId: w.shopifyLocationId,
        })),
    };
  }

  async apply(
    channelId: string,
    orgId: string,
    dto: ApplyShopifyLocationDecisionsDto,
  ): Promise<ShopifyLocationsView> {
    await this.assertShopifyChannel(channelId, orgId);
    if (!(await this.ledger.isWarehousingEnabled(orgId))) {
      throw new BadRequestException('Switch on stock locations before linking Shopify locations.');
    }

    const seen = new Set<string>();
    for (const d of dto.decisions) {
      if (seen.has(d.shopifyLocationId)) {
        throw new BadRequestException('Each Shopify location takes one decision.');
      }
      seen.add(d.shopifyLocationId);
      if (d.action === 'link' && !d.warehouseId) {
        throw new BadRequestException('Choose the location to share stock with.');
      }
      if (d.action === 'link' && !d.stockSource) {
        throw new BadRequestException('Choose whose stock counts to keep.');
      }
    }

    const gstEnabled =
      (await this.prisma.organization.findUnique({ where: { id: orgId }, select: { gstEnabled: true } }))
        ?.gstEnabled === true;
    const keepCollaboCounts: string[] = [];
    let linkedAny = false;

    await this.prisma.$transaction(async (tx) => {
      const linkedHere = new Set<string>();
      for (const d of dto.decisions) {
        const record = await tx.shopifyLocationLink.findFirst({
          where: { channelId, shopifyLocationId: d.shopifyLocationId },
        });
        if (!record) {
          throw new BadRequestException(
            "That Shopify location wasn't found. Refresh the list and try again.",
          );
        }

        if (d.action === 'ignore') {
          await this.links.ignore(tx, orgId, d.shopifyLocationId);
          continue;
        }

        if (d.action === 'link') {
          const warehouse = await tx.warehouse.findFirst({
            where: { id: d.warehouseId, organizationId: orgId, isActive: true },
            select: { id: true, name: true, shopifyLocationId: true },
          });
          if (!warehouse) throw new NotFoundException("That location wasn't found.");
          if (linkedHere.has(warehouse.id)) {
            throw new BadRequestException(
              `${warehouse.name} can share stock with one Shopify location only.`,
            );
          }
          linkedHere.add(warehouse.id);
          await this.links.link(tx, orgId, warehouse, d.shopifyLocationId);
          if (d.stockSource === 'collabo') keepCollaboCounts.push(warehouse.id);
          linkedAny = true;
          continue;
        }

        const created = await this.createFor(tx, orgId, record, d, gstEnabled);
        await this.links.link(tx, orgId, created, d.shopifyLocationId, ShopifyLocationAction.CREATE);
        linkedAny = true;
      }
    });

    // Stock moves only after every decision committed: the counts kept are
    // sent first, then the linked locations are pulled from Shopify.
    if (linkedAny) await this.links.queueStockSync(orgId, keepCollaboCounts);
    return this.view(channelId, orgId);
  }

  /** A new location for a Shopify location: its name, address and state's GSTIN. */
  private async createFor(
    tx: Prisma.TransactionClient,
    orgId: string,
    record: { name: string; address: Prisma.JsonValue; isActive: boolean },
    d: { name?: string; kind?: 'STORE' | 'WAREHOUSE' },
    gstEnabled: boolean,
  ) {
    const name = d.name?.trim() || record.name;
    const used = new Set(
      (await tx.warehouse.findMany({ where: { organizationId: orgId }, select: { code: true } })).map(
        (w) => w.code,
      ),
    );
    const gstin = gstEnabled
      ? await findStateGstin(tx, orgId, extractStateFromAddress(record.address))
      : null;
    return tx.warehouse.create({
      data: {
        organizationId: orgId,
        name,
        code: deriveLocationCode(name, used),
        kind: d.kind === 'STORE' ? StockLocationKind.STORE : StockLocationKind.WAREHOUSE,
        address: (record.address ?? undefined) as Prisma.InputJsonValue | undefined,
        gstinId: gstin?.id ?? null,
        isActive: record.isActive,
        isDefault: false,
      },
      select: { id: true, name: true, shopifyLocationId: true },
    });
  }

  private async assertShopifyChannel(channelId: string, orgId: string): Promise<void> {
    const channel = await this.prisma.channel.findFirst({
      where: { id: channelId, organizationId: orgId, platform: ChannelPlatform.SHOPIFY },
      select: { id: true },
    });
    if (!channel) throw new NotFoundException('Shopify store not found.');
  }
}
