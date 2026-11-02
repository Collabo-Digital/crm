import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { OrgId } from '../auth/decorators/org-id.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { JwtPayload } from '../auth/interfaces/jwt-payload.interface';
import { Roles, ORG_OPERATORS } from '../auth/decorators/roles.decorator';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { RequireSection } from '../auth/decorators/require-section.decorator';
import { locationScopeFor } from '../auth/location-scope.util';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryService } from './inventory.service';
import { SkuGeneratorService } from './sku-generator.service';
import {
  BulkAdjustmentDto,
  CreateAdjustmentDto,
} from './dto/adjustment.dto';
import { QueryLedgerDto, QueryStockDto } from './dto/query-stock.dto';
import { GenerateCodesDto } from './dto/generate-skus.dto';

/**
 * Inventory V1 — Phase A surface. EVERY route declares explicit @Roles
 * (RolesGuard is allow-by-default; new endpoints never inherit that trap) and
 * a @RequirePermissions key resolved against OrganizationMember.permissions
 * (OWNER/ADMIN/MANAGER hold every key implicitly). A store-limited Manager or
 * Agent reads and changes stock at their own locations only
 * (auth/location-scope.util).
 */
const ORG_MEMBERS: UserRole[] = [...ORG_OPERATORS, UserRole.VIEWER];

// Inventory lives under Products: the section opens the door, the
// inventory.* keys below still decide what works inside.
@RequireSection('products')
@Controller('inventory')
export class InventoryController {
  constructor(
    private readonly inventory: InventoryService,
    private readonly skuGenerator: SkuGeneratorService,
    private readonly prisma: PrismaService,
  ) {}

  // Status is intentionally permission-free (any member): the client shell
  // uses it to decide whether to show the Inventory nav item / enable CTA.
  @Get('status')
  @RequireSection()
  @Roles(...ORG_MEMBERS)
  getStatus(@OrgId() orgId: string) {
    return this.inventory.getStatus(orgId);
  }

  @Post('enable')
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  enable(@OrgId() orgId: string, @CurrentUser() user: JwtPayload) {
    return this.inventory.enable(orgId, user.sub);
  }

  @Get('stock')
  @Roles(...ORG_MEMBERS)
  @RequirePermissions('inventory.view')
  async listStock(@OrgId() orgId: string, @CurrentUser() user: JwtPayload, @Query() query: QueryStockDto) {
    return this.inventory.listStock(orgId, query, await locationScopeFor(this.prisma, user));
  }

  @Get('stock/stats')
  @Roles(...ORG_MEMBERS)
  @RequirePermissions('inventory.view')
  async getStockStats(
    @OrgId() orgId: string,
    @CurrentUser() user: JwtPayload,
    @Query('warehouseId') warehouseId?: string,
  ) {
    return this.inventory.getStockStats(orgId, warehouseId, await locationScopeFor(this.prisma, user));
  }

  // NOTE: declared after 'stock/stats' — NestJS matches routes in declaration
  // order, so the static segment must come first.
  @Get('stock/:variantId')
  @Roles(...ORG_MEMBERS)
  @RequirePermissions('inventory.view')
  async getVariantStock(
    @OrgId() orgId: string,
    @CurrentUser() user: JwtPayload,
    @Param('variantId') variantId: string,
  ) {
    return this.inventory.getVariantStock(orgId, variantId, await locationScopeFor(this.prisma, user));
  }

  @Post('adjustments')
  @Roles(...ORG_OPERATORS)
  @RequirePermissions('inventory.adjust')
  async createAdjustment(
    @OrgId() orgId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateAdjustmentDto,
  ) {
    return this.inventory.createAdjustment(orgId, user.sub, dto, await locationScopeFor(this.prisma, user));
  }

  // Saves every edited quantity on one screen at once. Atomic: see
  // InventoryService.createAdjustmentsBulk for why a failed line rolls back
  // the batch instead of leaving it half applied.
  @Post('adjustments/bulk')
  @Roles(...ORG_OPERATORS)
  @RequirePermissions('inventory.adjust')
  async createAdjustmentsBulk(
    @OrgId() orgId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: BulkAdjustmentDto,
  ) {
    return this.inventory.createAdjustmentsBulk(orgId, user.sub, dto, await locationScopeFor(this.prisma, user));
  }

  @Get('ledger')
  @Roles(...ORG_MEMBERS)
  @RequirePermissions('inventory.view')
  async listLedger(@OrgId() orgId: string, @CurrentUser() user: JwtPayload, @Query() query: QueryLedgerDto) {
    return this.inventory.listLedger(orgId, query, await locationScopeFor(this.prisma, user));
  }

  @Get('lookup')
  @Roles(...ORG_OPERATORS)
  @RequirePermissions('inventory.view')
  async lookup(@OrgId() orgId: string, @CurrentUser() user: JwtPayload, @Query('code') code: string) {
    return this.inventory.lookup(orgId, code ?? '', await locationScopeFor(this.prisma, user));
  }

  @Post('labels/generate-skus')
  @Roles(...ORG_OPERATORS)
  @RequirePermissions('inventory.labels')
  generateSkus(@OrgId() orgId: string, @Body() dto: GenerateCodesDto) {
    return this.skuGenerator.generateSkus(orgId, dto);
  }

  @Post('labels/generate-barcodes')
  @Roles(...ORG_OPERATORS)
  @RequirePermissions('inventory.labels')
  generateBarcodes(@OrgId() orgId: string, @Body() dto: GenerateCodesDto) {
    return this.skuGenerator.generateBarcodes(orgId, dto);
  }

  // Org-wide, deliberately: codes belong to the catalogue, not to a location.
  @Get('labels/code-status')
  @Roles(...ORG_MEMBERS)
  @RequirePermissions('inventory.labels')
  codeStatus(@OrgId() orgId: string) {
    return this.skuGenerator.codeStatus(orgId);
  }

  @Get('labels/duplicates')
  @Roles(...ORG_MEMBERS)
  @RequirePermissions('inventory.labels')
  findDuplicates(@OrgId() orgId: string) {
    return this.skuGenerator.findDuplicates(orgId);
  }

  // Label-print payload for the chrome-free print route. Comma-separated ids.
  @Get('labels/data')
  @Roles(...ORG_OPERATORS)
  @RequirePermissions('inventory.labels')
  getLabelData(@OrgId() orgId: string, @Query('variantIds') variantIds?: string) {
    const ids = (variantIds ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return this.inventory.getLabelData(orgId, ids);
  }
}
