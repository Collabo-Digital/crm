import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ChannelPlatform,
  ChannelStatus,
  LocationType,
  Prisma,
  StockLocationKind,
} from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { extractStateFromAddress } from '../gst/place-of-supply.util';
import { getStateName } from '../gst/constants/indian-states';
import { extractStateCodeFromGstin, normalizeGstin } from '../gst/constants/gst-rates';
import {
  findStateGstin,
  locationGstWarning,
  warehouseGstinMismatch,
} from './warehouse-gstin.util';
import { LocationLinkService } from './location-links.service';
import {
  BulkLocationsDto,
  CreateWarehouseDto,
  LocationGstChoiceDto,
  UpdateWarehouseDto,
} from './dto/warehouse.dto';

const MAX_LOCATIONS_PER_WAREHOUSE = 10_000;

type Tx = Prisma.TransactionClient;

@Injectable()
export class WarehouseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly links: LocationLinkService,
  ) {}

  async findAll(orgId: string) {
    const [warehouses, units, gst, shopifyNames] = await Promise.all([
      this.prisma.warehouse.findMany({
        where: { organizationId: orgId },
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
        include: { _count: { select: { locations: true, stockLevels: true } } },
      }),
      // Sellable units per location, for the location picker — it shows a
      // figure beside each name so the merchant can tell which one they mean
      // before switching to it. One grouped read, not one call per location.
      this.prisma.stockLevel.groupBy({
        by: ['warehouseId'],
        where: { organizationId: orgId },
        _sum: { available: true },
      }),
      this.gstContext(orgId),
      this.shopifyLocationNames(orgId),
    ]);
    const availableByWarehouse = new Map(
      units.map((u) => [u.warehouseId, u._sum.available ?? 0]),
    );
    return warehouses.map((w) => ({
      id: w.id,
      name: w.name,
      code: w.code,
      kind: w.kind,
      shopifyLocationId: w.shopifyLocationId,
      shopifyLocation: w.shopifyLocationId
        ? {
            id: w.shopifyLocationId,
            name: shopifyNames.get(w.shopifyLocationId) ?? `Shopify location ${w.shopifyLocationId}`,
          }
        : null,
      address: w.address,
      gstinId: w.gstinId,
      gstWarning: locationGstWarning(w, gst),
      apobDeclared: w.apobDeclared,
      isDefault: w.isDefault,
      isActive: w.isActive,
      locationCount: w._count.locations,
      stockLineCount: w._count.stockLevels,
      unitsAvailable: availableByWarehouse.get(w.id) ?? 0,
      createdAt: w.createdAt,
    }));
  }

  /** One location in the shape `findAll` lists it. */
  async findOne(orgId: string, id: string) {
    const location = (await this.findAll(orgId)).find((w) => w.id === id);
    if (!location) throw new NotFoundException('Warehouse not found');
    return location;
  }

  /**
   * Resolve a GST registration the caller wants to link, scoped to the org.
   * Only ACTIVE registrations are linkable: linking to one the merchant has
   * retired would put a dead GSTIN on the dispatch block of future invoices.
   */
  private async resolveGstinLink(db: Tx | PrismaService, orgId: string, gstinId: string) {
    const gstin = await db.organizationGstin.findFirst({
      where: { id: gstinId, organizationId: orgId, isActive: true },
      select: { id: true, stateCode: true, stateName: true },
    });
    if (!gstin) throw new NotFoundException('GSTIN registration not found');
    return gstin;
  }

  async create(orgId: string, dto: CreateWarehouseDto) {
    const gst = await this.gstContext(orgId);
    const address = normalizeAddress(dto.address);
    const stateCode = extractStateFromAddress(address);
    if (gst.enabled && !stateCode) {
      throw new BadRequestException('Choose the state this location is in.');
    }
    if (!gst.enabled && dto.gstinId) {
      const gstin = await this.resolveGstinLink(this.prisma, orgId, dto.gstinId);
      const mismatch = warehouseGstinMismatch(address, gstin);
      if (mismatch) throw new BadRequestException(mismatch);
    }

    const count = await this.prisma.warehouse.count({
      where: { organizationId: orgId },
    });
    // First warehouse is always the default; explicit isDefault demotes the
    // current holder (the partial unique allows only one).
    const makeDefault = count === 0 || dto.isDefault === true;
    const created = await this.prisma.$transaction(async (tx) => {
      const gstinId = gst.enabled
        ? await this.resolveGstChoice(tx, orgId, stateCode, dto.gst ?? legacyChoice(dto.gstinId))
        : (dto.gstinId ?? null);
      if (makeDefault && count > 0) {
        await tx.warehouse.updateMany({
          where: { organizationId: orgId, isDefault: true },
          data: { isDefault: false },
        });
      }
      let warehouse: { id: string; name: string; shopifyLocationId: string | null };
      try {
        warehouse = await tx.warehouse.create({
          data: {
            organizationId: orgId,
            name: dto.name,
            code: dto.code,
            kind: dto.kind === 'STORE' ? StockLocationKind.STORE : StockLocationKind.WAREHOUSE,
            address: (address ?? undefined) as Prisma.InputJsonValue | undefined,
            gstinId,
            apobDeclared: dto.apobDeclared ?? false,
            isDefault: makeDefault,
          },
          select: { id: true, name: true, shopifyLocationId: true },
        });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          throw new ConflictException(`Warehouse code "${dto.code}" already exists.`);
        }
        throw e;
      }
      if (dto.shopifyLocationId) {
        await this.links.link(tx, orgId, warehouse, dto.shopifyLocationId);
      }
      return warehouse;
    });

    if (dto.shopifyLocationId) {
      await this.links.queueStockSync(orgId, dto.stockSource === 'collabo' ? [created.id] : []);
    }
    return this.findOne(orgId, created.id);
  }

  async update(orgId: string, id: string, dto: UpdateWarehouseDto) {
    const warehouse = await this.prisma.warehouse.findFirst({
      where: { id, organizationId: orgId },
    });
    if (!warehouse) throw new NotFoundException('Warehouse not found');

    if (dto.isActive === false && warehouse.isDefault) {
      throw new BadRequestException(
        'Deactivate is not allowed for the default warehouse — set another default first.',
      );
    }
    if (dto.isDefault === false && warehouse.isDefault) {
      throw new BadRequestException(
        'Set another warehouse as default instead of unsetting this one.',
      );
    }
    if (dto.code !== undefined && dto.code !== warehouse.code) {
      // The code prefixes every rack and bin code, which are printed on
      // labels and scanned; renaming it would orphan them.
      const bins = await this.prisma.warehouseLocation.count({ where: { warehouseId: id } });
      if (bins > 0) {
        throw new BadRequestException("The code can't change once racks and bins use it.");
      }
    }

    // Validate the EFFECTIVE pair, not just what this request carries.
    // Checking only `dto` would let an address edit slip past a registration
    // linked earlier (and vice versa), leaving a stored cross-state link that
    // no single request ever declared.
    const gst = await this.gstContext(orgId);
    const nextAddress = dto.address !== undefined ? normalizeAddress(dto.address) : warehouse.address;
    const stateCode = extractStateFromAddress(nextAddress);
    if (gst.enabled && dto.address !== undefined && !stateCode) {
      throw new BadRequestException('Choose the state this location is in.');
    }
    const choice = dto.gst ?? (dto.gstinId === undefined ? undefined : legacyChoice(dto.gstinId));
    if (choice === undefined || !gst.enabled) {
      const nextGstinId =
        !gst.enabled && dto.gstinId !== undefined ? dto.gstinId : warehouse.gstinId;
      if (nextGstinId) {
        const gstin = await this.resolveGstinLink(this.prisma, orgId, nextGstinId);
        const mismatch = warehouseGstinMismatch(nextAddress, gstin);
        if (mismatch) throw new BadRequestException(mismatch);
      }
    }

    const relink =
      dto.shopifyLocationId !== undefined && dto.shopifyLocationId !== warehouse.shopifyLocationId;

    await this.prisma.$transaction(async (tx) => {
      const gstinId =
        choice !== undefined && gst.enabled
          ? await this.resolveGstChoice(tx, orgId, stateCode, choice)
          : !gst.enabled && dto.gstinId !== undefined
            ? dto.gstinId
            : undefined;
      if (dto.isDefault === true && !warehouse.isDefault) {
        await tx.warehouse.updateMany({
          where: { organizationId: orgId, isDefault: true },
          data: { isDefault: false },
        });
      }
      if (relink) {
        await this.links.unlink(tx, orgId, warehouse);
        if (dto.shopifyLocationId) {
          await this.links.link(
            tx,
            orgId,
            { id: warehouse.id, name: dto.name ?? warehouse.name, shopifyLocationId: null },
            dto.shopifyLocationId,
          );
        }
      }
      try {
        await tx.warehouse.update({
          where: { id },
          data: {
            name: dto.name,
            code: dto.code,
            kind: dto.kind,
            address: (dto.address !== undefined ? nextAddress : undefined) as
              | Prisma.InputJsonValue
              | undefined,
            gstinId,
            apobDeclared: dto.apobDeclared,
            isDefault: dto.isDefault === true ? true : undefined,
            isActive: dto.isActive,
          },
        });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          throw new ConflictException(`Warehouse code "${dto.code}" already exists.`);
        }
        throw e;
      }
    });

    if (relink && dto.shopifyLocationId) {
      await this.links.queueStockSync(orgId, dto.stockSource === 'collabo' ? [id] : []);
    }
    return this.findOne(orgId, id);
  }

  /**
   * The GST registration a location operates under, from the merchant's
   * answer to "does this location have its own GST number?". Only asked while
   * GST is on; the location's state must be known by then.
   */
  private async resolveGstChoice(
    tx: Tx,
    orgId: string,
    stateCode: string | null,
    choice: LocationGstChoiceDto | undefined,
  ): Promise<string | null> {
    if (!choice || choice.mode === 'none') {
      return (await findStateGstin(tx, orgId, stateCode))?.id ?? null;
    }
    if (!stateCode) throw new BadRequestException('Choose the state this location is in.');

    if (choice.mode === 'existing') {
      if (!choice.gstinId) throw new BadRequestException('Choose the GSTIN this location uses.');
      const gstin = await this.resolveGstinLink(tx, orgId, choice.gstinId);
      const mismatch = warehouseGstinMismatch({ stateCode }, gstin);
      if (mismatch) throw new BadRequestException(mismatch);
      return gstin.id;
    }

    const number = normalizeGstin(choice.gstin);
    if (!number) throw new BadRequestException('Enter a valid 15-character GSTIN.');
    const gstinState = extractStateCodeFromGstin(number);
    const stateName = gstinState ? getStateName(gstinState) : undefined;
    if (!gstinState || !stateName) throw new BadRequestException('Enter a valid 15-character GSTIN.');
    const mismatch = warehouseGstinMismatch({ stateCode }, { stateCode: gstinState, stateName });
    if (mismatch) throw new BadRequestException(mismatch);
    return this.registerGstin(tx, orgId, number, gstinState, stateName, choice);
  }

  /**
   * Add a location's own GSTIN to the workspace's registrations, or reuse it
   * when it is there already. A removed one is revived rather than inserted
   * again — the unique index covers removed rows too (as GstService.create).
   */
  private async registerGstin(
    tx: Tx,
    orgId: string,
    gstin: string,
    stateCode: string,
    stateName: string,
    choice: { legalName?: string; tradeName?: string },
  ): Promise<string> {
    const existing = await tx.organizationGstin.findFirst({
      where: { organizationId: orgId, gstin },
      select: { id: true, isActive: true, legalName: true },
    });
    if (existing?.isActive) return existing.id;

    const activeCount = await tx.organizationGstin.count({
      where: { organizationId: orgId, isActive: true },
    });
    const org = await tx.organization.findUnique({ where: { id: orgId }, select: { name: true } });
    const data = {
      legalName: choice.legalName?.trim() || existing?.legalName || org?.name || gstin,
      tradeName: choice.tradeName?.trim() || undefined,
      stateCode,
      stateName,
      // Only when it is the workspace's first: adding a store's GSTIN must not
      // move invoicing off the registration the merchant chose as default.
      isDefault: activeCount === 0,
    };
    if (existing) {
      return (
        await tx.organizationGstin.update({
          where: { id: existing.id },
          data: { ...data, isActive: true },
          select: { id: true },
        })
      ).id;
    }
    return (
      await tx.organizationGstin.create({
        data: { organizationId: orgId, gstin, ...data },
        select: { id: true },
      })
    ).id;
  }

  private async gstContext(orgId: string) {
    const [org, activeGstins] = await Promise.all([
      this.prisma.organization.findUnique({ where: { id: orgId }, select: { gstEnabled: true } }),
      this.prisma.organizationGstin.findMany({
        where: { organizationId: orgId, isActive: true },
        select: { id: true, stateCode: true },
      }),
    ]);
    return { enabled: org?.gstEnabled === true, activeGstins };
  }

  /** Shopify location names by id, from the org's connected store. */
  private async shopifyLocationNames(orgId: string): Promise<Map<string, string>> {
    const rows = await this.prisma.shopifyLocationLink.findMany({
      where: {
        organizationId: orgId,
        channel: { platform: ChannelPlatform.SHOPIFY, status: { not: ChannelStatus.DISCONNECTED } },
      },
      select: { shopifyLocationId: true, name: true },
    });
    return new Map(rows.map((r) => [r.shopifyLocationId, r.name]));
  }

  async getDefault(orgId: string) {
    const warehouse = await this.prisma.warehouse.findFirst({
      where: { organizationId: orgId, isDefault: true, isActive: true },
    });
    if (!warehouse) {
      throw new BadRequestException(
        'No default warehouse. Enable warehousing first (POST /inventory/enable).',
      );
    }
    return warehouse;
  }

  async listLocations(orgId: string, warehouseId: string) {
    await this.assertOwned(orgId, warehouseId);
    return this.prisma.warehouseLocation.findMany({
      where: { warehouseId, isActive: true },
      orderBy: { fullCode: 'asc' },
      select: {
        id: true,
        parentId: true,
        type: true,
        code: true,
        fullCode: true,
      },
    });
  }

  /**
   * Generate a rack → shelf → bin grid. Codes: rack "A01"/"R01", shelf "S01",
   * bin "B01"; fullCode = "{WH}-{RACK}-{SHELF}-{BIN}". Idempotent-ish: an
   * existing fullCode fails the whole call (409) rather than silently mixing
   * grids — merchants re-run with different dimensions after clearing.
   */
  async bulkCreateLocations(orgId: string, warehouseId: string, dto: BulkLocationsDto) {
    const warehouse = await this.assertOwned(orgId, warehouseId);

    const total = dto.racks * dto.shelvesPerRack * (1 + dto.binsPerShelf) + dto.racks;
    const existing = await this.prisma.warehouseLocation.count({ where: { warehouseId } });
    if (existing + total > MAX_LOCATIONS_PER_WAREHOUSE) {
      throw new BadRequestException(
        `This grid would exceed ${MAX_LOCATIONS_PER_WAREHOUSE} locations per warehouse.`,
      );
    }

    // Rack codes match the canonical example WH1-A01-S02-B03: "A01" = rack #1
    // with the "A" prefix (letterRacks default) or "R01" when disabled.
    const pad = (n: number) => String(n).padStart(2, '0');
    const rackCode = (i: number) =>
      `${dto.letterRacks === false ? 'R' : 'A'}${pad(i + 1)}`;

    // Build the whole grid in memory with client-generated ids so the insert
    // is exactly three createMany statements (racks, shelves, bins) — a
    // per-shelf loop was thousands of round trips on a remote DB and blew the
    // interactive-transaction timeout.
    const rackRows: Prisma.WarehouseLocationCreateManyInput[] = [];
    const shelfRows: Prisma.WarehouseLocationCreateManyInput[] = [];
    const binRows: Prisma.WarehouseLocationCreateManyInput[] = [];
    for (let r = 0; r < dto.racks; r++) {
      const rCode = rackCode(r);
      const rackId = randomUUID();
      rackRows.push({
        id: rackId,
        warehouseId,
        type: LocationType.RACK,
        code: rCode,
        fullCode: `${warehouse.code}-${rCode}`,
      });
      for (let s = 0; s < dto.shelvesPerRack; s++) {
        const sCode = `S${pad(s + 1)}`;
        const shelfId = randomUUID();
        shelfRows.push({
          id: shelfId,
          warehouseId,
          parentId: rackId,
          type: LocationType.SHELF,
          code: sCode,
          fullCode: `${warehouse.code}-${rCode}-${sCode}`,
        });
        for (let b = 0; b < dto.binsPerShelf; b++) {
          const bCode = `B${pad(b + 1)}`;
          binRows.push({
            id: randomUUID(),
            warehouseId,
            parentId: shelfId,
            type: LocationType.BIN,
            code: bCode,
            fullCode: `${warehouse.code}-${rCode}-${sCode}-${bCode}`,
          });
        }
      }
    }

    try {
      return await this.prisma.$transaction(
        async (tx) => {
          await tx.warehouseLocation.createMany({ data: rackRows });
          await tx.warehouseLocation.createMany({ data: shelfRows });
          await tx.warehouseLocation.createMany({ data: binRows });
          return { ok: true, created: rackRows.length + shelfRows.length + binRows.length };
        },
        { timeout: 30_000 },
      );
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException(
          'Some of these location codes already exist in this warehouse.',
        );
      }
      throw e;
    }
  }

  private async assertOwned(orgId: string, warehouseId: string) {
    const warehouse = await this.prisma.warehouse.findFirst({
      where: { id: warehouseId, organizationId: orgId },
    });
    if (!warehouse) throw new NotFoundException('Warehouse not found');
    return warehouse;
  }
}

/** The earlier `gstinId` field as the GST answer it stands for. */
function legacyChoice(gstinId: string | null | undefined): LocationGstChoiceDto | undefined {
  if (gstinId === undefined) return undefined;
  return gstinId ? { mode: 'existing', gstinId } : { mode: 'none' };
}

/**
 * The address as stored: the state's name filled in as `province` beside its
 * code, because the client renders `province` and the GST code reads
 * `stateCode`.
 */
function normalizeAddress(
  address: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!address) return null;
  const stateCode = extractStateFromAddress(address);
  const province = stateCode ? getStateName(stateCode) : undefined;
  return {
    ...address,
    ...(stateCode ? { stateCode } : {}),
    ...(province && !address.province ? { province } : {}),
  };
}
