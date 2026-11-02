import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
} from '@nestjs/common';
import { OrgId } from '../auth/decorators/org-id.decorator';
import { GstService } from './gst.service';
import { CreateGstinDto } from './dto/create-gstin.dto';
import { UpdateGstinDto } from './dto/update-gstin.dto';
import { CreateStateTaxRateDto } from './dto/create-state-tax-rate.dto';
import { UpdateStateTaxRateDto } from './dto/update-state-tax-rate.dto';
import { CreateCollectionOverrideDto } from './dto/create-collection-override.dto';
import { UpdateCollectionOverrideDto } from './dto/update-collection-override.dto';
import { CreateProductTypeTaxRateDto } from './dto/create-product-type-tax-rate.dto';
import { UpdateProductTypeTaxRateDto } from './dto/update-product-type-tax-rate.dto';
import { INDIAN_STATES } from './constants/indian-states';
import { ORG_MANAGERS, Roles } from '../auth/decorators/roles.decorator';
import { RequireSection } from '../auth/decorators/require-section.decorator';

// The registrations and tax rates are read by the order form, invoices,
// package slips, warehouses and Settings › Tax & GST — not by Chat or
// Campaigns, whose members are kept out of them.
@Controller('gst')
@RequireSection('orders', 'products', 'invoices')
export class GstController {
  constructor(private readonly gstService: GstService) {}

  // ─── STATES ───

  // A fixed list every address form uses.
  @Get('states')
  @RequireSection()
  getStates() {
    return INDIAN_STATES;
  }

  // ─── GSTIN MANAGEMENT ───

  @Get('gstins')
  findAllGstins(@OrgId() orgId: string) {
    return this.gstService.findAll(orgId);
  }

  @Post('gstins')
  @Roles(...ORG_MANAGERS)
  createGstin(@OrgId() orgId: string, @Body() dto: CreateGstinDto) {
    return this.gstService.create(orgId, dto);
  }

  @Patch('gstins/:id')
  @Roles(...ORG_MANAGERS)
  updateGstin(
    @Param('id') id: string,
    @OrgId() orgId: string,
    @Body() dto: UpdateGstinDto,
  ) {
    return this.gstService.update(id, orgId, dto);
  }

  @Delete('gstins/:id')
  @Roles(...ORG_MANAGERS)
  deactivateGstin(@Param('id') id: string, @OrgId() orgId: string) {
    return this.gstService.deactivate(id, orgId);
  }

  // ─── STATE TAX RATES ───

  @Get('state-tax-rates')
  findAllStateTaxRates(@OrgId() orgId: string) {
    return this.gstService.findAllStateTaxRates(orgId);
  }

  @Post('state-tax-rates')
  @Roles(...ORG_MANAGERS)
  createStateTaxRate(@OrgId() orgId: string, @Body() dto: CreateStateTaxRateDto) {
    return this.gstService.createStateTaxRate(orgId, dto);
  }

  @Patch('state-tax-rates/:id')
  @Roles(...ORG_MANAGERS)
  updateStateTaxRate(
    @Param('id') id: string,
    @OrgId() orgId: string,
    @Body() dto: UpdateStateTaxRateDto,
  ) {
    return this.gstService.updateStateTaxRate(id, orgId, dto);
  }

  @Delete('state-tax-rates/:id')
  @Roles(...ORG_MANAGERS)
  deleteStateTaxRate(@Param('id') id: string, @OrgId() orgId: string) {
    return this.gstService.deleteStateTaxRate(id, orgId);
  }

  // ─── COLLECTIONS ───

  @Get('collections')
  findAllCollections(@OrgId() orgId: string) {
    return this.gstService.findAllCollections(orgId);
  }

  // ─── COLLECTION TAX OVERRIDES ───

  @Get('collection-overrides')
  findAllCollectionOverrides(@OrgId() orgId: string) {
    return this.gstService.findAllCollectionOverrides(orgId);
  }

  @Post('collection-overrides')
  @Roles(...ORG_MANAGERS)
  createCollectionOverride(@OrgId() orgId: string, @Body() dto: CreateCollectionOverrideDto) {
    return this.gstService.createCollectionOverride(orgId, dto);
  }

  @Patch('collection-overrides/:id')
  @Roles(...ORG_MANAGERS)
  updateCollectionOverride(
    @Param('id') id: string,
    @OrgId() orgId: string,
    @Body() dto: UpdateCollectionOverrideDto,
  ) {
    return this.gstService.updateCollectionOverride(id, orgId, dto);
  }

  @Delete('collection-overrides/:id')
  @Roles(...ORG_MANAGERS)
  deleteCollectionOverride(@Param('id') id: string, @OrgId() orgId: string) {
    return this.gstService.deleteCollectionOverride(id, orgId);
  }

  // ─── PRODUCT TYPE TAX RATES ───

  @Get('product-type-tax-rates')
  findAllProductTypeTaxRates(@OrgId() orgId: string) {
    return this.gstService.findAllProductTypeTaxRates(orgId);
  }

  @Post('product-type-tax-rates')
  @Roles(...ORG_MANAGERS)
  createProductTypeTaxRate(@OrgId() orgId: string, @Body() dto: CreateProductTypeTaxRateDto) {
    return this.gstService.createProductTypeTaxRate(orgId, dto);
  }

  @Patch('product-type-tax-rates/:id')
  @Roles(...ORG_MANAGERS)
  updateProductTypeTaxRate(
    @Param('id') id: string,
    @OrgId() orgId: string,
    @Body() dto: UpdateProductTypeTaxRateDto,
  ) {
    return this.gstService.updateProductTypeTaxRate(id, orgId, dto);
  }

  @Delete('product-type-tax-rates/:id')
  @Roles(...ORG_MANAGERS)
  deleteProductTypeTaxRate(@Param('id') id: string, @OrgId() orgId: string) {
    return this.gstService.deleteProductTypeTaxRate(id, orgId);
  }
}
