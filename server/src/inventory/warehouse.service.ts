import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { LocationType, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { warehouseGstinMismatch } from './warehouse-gstin.util';
import {
  BulkLocationsDto,
  CreateWarehouseDto,
  UpdateWarehouseDto,
} from './dto/warehouse.dto';

const MAX_LOCATIONS_PER_WAREHOUSE = 10_000;

@Injectable()
export class WarehouseService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(orgId: string) {
    const [warehouses, units] = await Promise.all([
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
    ]);
    const availableByWarehouse = new Map(
      units.map((u) => [u.warehouseId, u._sum.available ?? 0]),
    );
    return warehouses.map((w) => ({
      id: w.id,
      name: w.name,
      code: w.code,
      shopifyLocationId: w.shopifyLocationId,
      address: w.address,
      gstinId: w.gstinId,
      apobDeclared: w.apobDeclared,
      isDefault: w.isDefault,
      isActive: w.isActive,
      locationCount: w._count.locations,
      stockLineCount: w._count.stockLevels,
      unitsAvailable: availableByWarehouse.get(w.id) ?? 0,
      createdAt: w.createdAt,
    }));
  }

  /**
   * Resolve a GST registration the caller wants to link, scoped to the org.
   * Only ACTIVE registrations are linkable: linking to one the merchant has
   * retired would put a dead GSTIN on the dispatch block of future invoices.
   */
  private async resolveGstinLink(orgId: string, gstinId: string) {
    const gstin = await this.prisma.organizationGstin.findFirst({
      where: { id: gstinId, organizationId: orgId, isActive: true },
      select: { id: true, stateCode: true, stateName: true },
    });
    if (!gstin) throw new NotFoundException('GSTIN registration not found');
    return gstin;
  }

  async create(orgId: string, dto: CreateWarehouseDto) {
    if (dto.gstinId) {
      const gstin = await this.resolveGstinLink(orgId, dto.gstinId);
      const mismatch = warehouseGstinMismatch(dto.address, gstin);
      if (mismatch) throw new BadRequestException(mismatch);
    }

    const count = await this.prisma.warehouse.count({
      where: { organizationId: orgId },
    });
    // First warehouse is always the default; explicit isDefault demotes the
    // current holder (the partial unique allows only one).
    const makeDefault = count === 0 || dto.isDefault === true;
    return this.prisma.$transaction(async (tx) => {
      if (makeDefault && count > 0) {
        await tx.warehouse.updateMany({
          where: { organizationId: orgId, isDefault: true },
          data: { isDefault: false },
        });
      }
      try {
        return await tx.warehouse.create({
          data: {
            organizationId: orgId,
            name: dto.name,
            code: dto.code,
            address: (dto.address ?? undefined) as Prisma.InputJsonValue | undefined,
            gstinId: dto.gstinId ?? null,
            apobDeclared: dto.apobDeclared ?? false,
            isDefault: makeDefault,
          },
        });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          throw new ConflictException(`Warehouse code "${dto.code}" already exists.`);
        }
        throw e;
      }
    });
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

    // Validate the EFFECTIVE pair, not just what this request carries.
    // Checking only `dto` would let an address edit slip past a registration
    // linked earlier (and vice versa), leaving a stored cross-state link that
    // no single request ever declared.
    const nextAddress = dto.address ?? warehouse.address;
    const nextGstinId =
      dto.gstinId === undefined ? warehouse.gstinId : dto.gstinId;
    if (nextGstinId) {
      const gstin = await this.resolveGstinLink(orgId, nextGstinId);
      const mismatch = warehouseGstinMismatch(nextAddress, gstin);
      if (mismatch) throw new BadRequestException(mismatch);
    }

    return this.prisma.$transaction(async (tx) => {
      if (dto.isDefault === true && !warehouse.isDefault) {
        await tx.warehouse.updateMany({
          where: { organizationId: orgId, isDefault: true },
          data: { isDefault: false },
        });
      }
      return tx.warehouse.update({
        where: { id },
        data: {
          name: dto.name,
          address: (dto.address ?? undefined) as Prisma.InputJsonValue | undefined,
          gstinId: dto.gstinId === undefined ? undefined : dto.gstinId,
          apobDeclared: dto.apobDeclared,
          isDefault: dto.isDefault === true ? true : undefined,
          isActive: dto.isActive,
        },
      });
    });
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
