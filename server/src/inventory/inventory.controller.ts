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
 * (OWNER/ADMIN/MANAGER hold every key implicitly).
 */
const ORG_MEMBERS: UserRole[] = [...ORG_OPERATORS, UserRole.VIEWER];

@Controller('inventory')
export class InventoryController {
  constructor(
    private readonly inventory: InventoryService,
    private readonly skuGenerator: SkuGeneratorService,
  ) {}

  // Status is intentionally permission-free (any member): the client shell
  // uses it to decide whether to show the Inventory nav item / enable CTA.
  @Get('status')
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
  listStock(@OrgId() orgId: string, @Query() query: QueryStockDto) {
    return this.inventory.listStock(orgId, query);
  }

  @Get('stock/stats')
  @Roles(...ORG_MEMBERS)
  @RequirePermissions('inventory.view')
  getStockStats(
    @OrgId() orgId: string,
    @Query('warehouseId') warehouseId?: string,
  ) {
    return this.inventory.getStockStats(orgId, warehouseId);
  }

  // NOTE: declared after 'stock/stats' — NestJS matches routes in declaration
  // order, so the static segment must come first.
  @Get('stock/:variantId')
  @Roles(...ORG_MEMBERS)
  @RequirePermissions('inventory.view')
  getVariantStock(@OrgId() orgId: string, @Param('variantId') variantId: string) {
    return this.inventory.getVariantStock(orgId, variantId);
  }

  @Post('adjustments')
  @Roles(...ORG_OPERATORS)
  @RequirePermissions('inventory.adjust')
  createAdjustment(
    @OrgId() orgId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateAdjustmentDto,
  ) {
    return this.inventory.createAdjustment(orgId, user.sub, dto);
  }

  // Saves every edited quantity on one screen at once. Atomic: see
  // InventoryService.createAdjustmentsBulk for why a failed line rolls back
  // the batch instead of leaving it half applied.
  @Post('adjustments/bulk')
  @Roles(...ORG_OPERATORS)
  @RequirePermissions('inventory.adjust')
  createAdjustmentsBulk(
    @OrgId() orgId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: BulkAdjustmentDto,
  ) {
    return this.inventory.createAdjustmentsBulk(orgId, user.sub, dto);
  }

  @Get('ledger')
  @Roles(...ORG_MEMBERS)
  @RequirePermissions('inventory.view')
  listLedger(@OrgId() orgId: string, @Query() query: QueryLedgerDto) {
    return this.inventory.listLedger(orgId, query);
  }

  @Get('lookup')
  @Roles(...ORG_OPERATORS)
  @RequirePermissions('inventory.view')
  lookup(@OrgId() orgId: string, @Query('code') code: string) {
    return this.inventory.lookup(orgId, code ?? '');
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
