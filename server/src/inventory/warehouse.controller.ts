import { Body, Controller, ForbiddenException, Get, NotFoundException, Param, Patch, Post } from '@nestjs/common';
import { OrgId } from '../auth/decorators/org-id.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { JwtPayload } from '../auth/interfaces/jwt-payload.interface';
import { Roles, ORG_MANAGERS, ORG_OPERATORS } from '../auth/decorators/roles.decorator';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import {
  assertInLocationScope,
  inLocationScope,
  locationScopeFor,
  STOCK_OUT_OF_SCOPE,
} from '../auth/location-scope.util';
import { PrismaService } from '../prisma/prisma.service';
import { WarehouseService } from './warehouse.service';
import {
  BulkLocationsDto,
  CreateWarehouseDto,
  UpdateWarehouseDto,
} from './dto/warehouse.dto';

/**
 * Warehouse + location management. Structure changes are manager-level. A
 * store-limited Manager or Agent (auth/location-scope.util) sees and sets up
 * only the locations they work at, and adds none: one they added would be
 * outside their own list.
 */
@Controller('warehouses')
export class WarehouseController {
  constructor(
    private readonly warehouses: WarehouseService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  @Roles(...ORG_OPERATORS)
  @RequirePermissions('inventory.view')
  async findAll(@OrgId() orgId: string, @CurrentUser() user: JwtPayload) {
    return this.warehouses.findAll(orgId, await locationScopeFor(this.prisma, user));
  }

  @Post()
  @Roles(...ORG_MANAGERS)
  async create(@OrgId() orgId: string, @CurrentUser() user: JwtPayload, @Body() dto: CreateWarehouseDto) {
    if (await locationScopeFor(this.prisma, user)) {
      throw new ForbiddenException('Only an owner, an admin or a manager who works at every location can add a location.');
    }
    return this.warehouses.create(orgId, dto);
  }

  @Patch(':id')
  @Roles(...ORG_MANAGERS)
  async update(
    @OrgId() orgId: string,
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: UpdateWarehouseDto,
  ) {
    assertInLocationScope(await locationScopeFor(this.prisma, user), id, STOCK_OUT_OF_SCOPE);
    return this.warehouses.update(orgId, id, dto);
  }

  @Get(':id/locations')
  @Roles(...ORG_OPERATORS)
  @RequirePermissions('inventory.view')
  async listLocations(@OrgId() orgId: string, @CurrentUser() user: JwtPayload, @Param('id') id: string) {
    // Another org's location answers the same.
    if (!inLocationScope(await locationScopeFor(this.prisma, user), id)) throw new NotFoundException('Warehouse not found');
    return this.warehouses.listLocations(orgId, id);
  }

  @Post(':id/locations/bulk')
  @Roles(...ORG_MANAGERS)
  async bulkCreateLocations(
    @OrgId() orgId: string,
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: BulkLocationsDto,
  ) {
    assertInLocationScope(await locationScopeFor(this.prisma, user), id, STOCK_OUT_OF_SCOPE);
    return this.warehouses.bulkCreateLocations(orgId, id, dto);
  }
}
