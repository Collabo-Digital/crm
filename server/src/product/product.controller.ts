import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import type { JwtPayload } from '../auth/interfaces/jwt-payload.interface';

/**
 * Minimal multer file shape — defined locally so we don't have to depend on
 * `@types/multer` for the controller-level type annotation. Multer always
 * provides these fields at runtime regardless of types.
 */
type MulterFile = {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
};

// Multer buffers the whole file in memory before the service sees it, so the
// cap has to be enforced here. Images match ProductService's 5 MB rule; CSVs
// match Shopify's own 15 MB product-import limit.
const IMAGE_UPLOAD_LIMIT = 5 * 1024 * 1024;
const CSV_UPLOAD_LIMIT = 15 * 1024 * 1024;
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AllowVendor } from '../auth/decorators/allow-vendor.decorator';
import { RequireSection } from '../auth/decorators/require-section.decorator';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import {
  Roles,
  ORG_MANAGERS,
  ORG_OPERATORS,
  ORG_OPERATORS_AND_VENDORS,
} from '../auth/decorators/roles.decorator';
import { vendorScopeFor } from '../auth/vendor-scope.util';
import { ProductService } from './product.service';
import { QueryProductsDto } from './dto/query-products.dto';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import {
  BulkUpdateVariantsDto,
  CreateVariantDto,
  ReorderVariantsDto,
  SetVariantLocationsDto,
  UpdateVariantDto,
} from './dto/variant.dto';
import {
  ReorderImagesDto,
  SetVariantImageDto,
  UpdateImageDto,
} from './dto/image.dto';
import { UpdateOptionsDto } from './dto/option.dto';
import {
  BulkProductIdsDto,
  BulkSetStatusDto,
  BulkTagsDto,
} from './dto/bulk.dto';

@RequireSection('products')
@Controller('products')
export class ProductController {
  constructor(private readonly productService: ProductService) { }

  // ── COLLECTION-LEVEL ROUTES ─────────────────────────────────────────────

  // Also read by the order form's product picker and the chat catalog.
  @Get()
  @RequireSection('products', 'orders', 'chat')
  @AllowVendor()
  findAll(@CurrentUser() user: JwtPayload, @Query() query: QueryProductsDto) {
    return this.productService.findAll(user.orgId!, query, vendorScopeFor(user));
  }

  @Post()
  @Roles(...ORG_OPERATORS)
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateProductDto) {
    return this.productService.create(user.orgId!, user.sub, dto);
  }

  // Reference lists (invite form, settings) — open to every section.
  @Get('vendors')
  @RequireSection()
  @AllowVendor()
  getVendors(@CurrentUser() user: JwtPayload) {
    return this.productService.getVendors(user.orgId!, vendorScopeFor(user));
  }

  @Get('types')
  @RequireSection()
  @AllowVendor()
  getProductTypes(@CurrentUser() user: JwtPayload) {
    return this.productService.getProductTypes(user.orgId!, vendorScopeFor(user));
  }

  @Get('stats')
  @AllowVendor()
  getStats(@CurrentUser() user: JwtPayload, @Query('channelId') channelId?: string) {
    return this.productService.getStats(
      user.orgId!,
      channelId,
      vendorScopeFor(user),
    );
  }

  // ── VARIANT-LEVEL ROUTES (must register BEFORE :id wildcards) ──────────
  // These don't take a parent productId in the URL because the variant id is
  // globally unique and the service joins back to product → org for auth.

  @Patch('variants/:variantId')
  @AllowVendor()
  @Roles(...ORG_OPERATORS_AND_VENDORS)
  updateVariant(
    @Param('variantId') variantId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateVariantDto,
  ) {
    return this.productService.updateVariant(variantId, user.orgId!, dto, vendorScopeFor(user));
  }

  // Which locations the variant is stocked at. It moves no quantity, but it
  // creates and removes stock rows, so it sits behind the same permission as a
  // stock adjustment — and is not open to vendors, who do not manage locations.
  @Put('variants/:variantId/locations')
  @Roles(...ORG_OPERATORS)
  @RequirePermissions('inventory.adjust')
  setVariantLocations(
    @Param('variantId') variantId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: SetVariantLocationsDto,
  ) {
    return this.productService.setVariantLocations(variantId, user.orgId!, dto);
  }

  @Delete('variants/:variantId')
  @AllowVendor()
  @Roles(...ORG_OPERATORS_AND_VENDORS)
  deleteVariant(
    @Param('variantId') variantId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.productService.deleteVariant(variantId, user.orgId!, vendorScopeFor(user));
  }

  @Post('variants/:variantId/image')
  @Roles(...ORG_OPERATORS)
  setVariantImage(
    @Param('variantId') variantId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: SetVariantImageDto,
  ) {
    return this.productService.setVariantImage(variantId, user.orgId!, dto);
  }

  // ── IMAGE-LEVEL ROUTES (must register BEFORE :id wildcards) ────────────

  @Patch('images/:imageId')
  @Roles(...ORG_OPERATORS)
  updateImage(
    @Param('imageId') imageId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateImageDto,
  ) {
    return this.productService.updateImage(imageId, user.orgId!, dto);
  }

  @Delete('images/:imageId')
  @Roles(...ORG_OPERATORS)
  removeImage(
    @Param('imageId') imageId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.productService.removeImage(imageId, user.orgId!);
  }

  // ── PRODUCT-NESTED ROUTES (variants/images for a given product) ────────

  @Post(':id/variants')
  @AllowVendor()
  @Roles(...ORG_OPERATORS_AND_VENDORS)
  createVariant(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVariantDto,
  ) {
    return this.productService.createVariant(id, user.orgId!, dto, vendorScopeFor(user));
  }

  @Post(':id/variants/reorder')
  @Roles(...ORG_OPERATORS)
  reorderVariants(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: ReorderVariantsDto,
  ) {
    return this.productService.reorderVariants(id, user.orgId!, dto);
  }

  @Patch(':id/variants/bulk')
  @AllowVendor()
  @Roles(...ORG_OPERATORS_AND_VENDORS)
  bulkUpdateVariants(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: BulkUpdateVariantsDto,
  ) {
    return this.productService.bulkUpdateVariants(
      id,
      user.orgId!,
      dto,
      vendorScopeFor(user),
    );
  }

  @Post(':id/variants/generate')
  @AllowVendor()
  @Roles(...ORG_OPERATORS_AND_VENDORS)
  generateVariants(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.productService.generateVariantsFromOptions(id, user.orgId!, vendorScopeFor(user));
  }

  @Patch(':id/options')
  @AllowVendor()
  @Roles(...ORG_OPERATORS_AND_VENDORS)
  updateOptions(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateOptionsDto,
  ) {
    return this.productService.updateOptions(id, user.orgId!, dto.options, vendorScopeFor(user));
  }

  @Post(':id/images')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: IMAGE_UPLOAD_LIMIT } }))
  @Roles(...ORG_OPERATORS)
  addImage(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @UploadedFile() file: MulterFile,
  ) {
    return this.productService.addImage(id, user.orgId!, file);
  }

  @Post(':id/images/reorder')
  @Roles(...ORG_OPERATORS)
  reorderImages(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: ReorderImagesDto,
  ) {
    return this.productService.reorderImages(id, user.orgId!, dto);
  }

  // ── PHASE 3: BULK + CSV + DUPLICATE ────────────────────────────────────
  // All registered BEFORE :id so they don't get swallowed by /products/:id.

  @Post('bulk/status')
  @Roles(...ORG_OPERATORS)
  bulkSetStatus(@CurrentUser() user: JwtPayload, @Body() dto: BulkSetStatusDto) {
    return this.productService.bulkSetStatus(user.orgId!, dto.productIds, dto.status);
  }

  @Post('bulk/archive')
  @Roles(...ORG_OPERATORS)
  bulkArchive(@CurrentUser() user: JwtPayload, @Body() dto: BulkProductIdsDto) {
    return this.productService.bulkArchive(user.orgId!, dto.productIds);
  }

  @Delete('bulk')
  @Roles(...ORG_MANAGERS)
  bulkDelete(@CurrentUser() user: JwtPayload, @Body() dto: BulkProductIdsDto) {
    return this.productService.bulkDelete(user.orgId!, dto.productIds);
  }

  @Post('bulk/tags/add')
  @Roles(...ORG_OPERATORS)
  bulkAddTags(@CurrentUser() user: JwtPayload, @Body() dto: BulkTagsDto) {
    return this.productService.bulkAddTags(user.orgId!, dto.productIds, dto.tags);
  }

  @Post('bulk/tags/remove')
  @Roles(...ORG_OPERATORS)
  bulkRemoveTags(@CurrentUser() user: JwtPayload, @Body() dto: BulkTagsDto) {
    return this.productService.bulkRemoveTags(user.orgId!, dto.productIds, dto.tags);
  }

  @Post('bulk/sync')
  @AllowVendor()
  @Roles(...ORG_OPERATORS_AND_VENDORS)
  bulkSync(@CurrentUser() user: JwtPayload, @Body() dto: BulkProductIdsDto) {
    return this.productService.bulkSync(user.orgId!, dto.productIds, vendorScopeFor(user));
  }

  /** Stream a Shopify-format CSV export. Supports the same query filters
   *  as the list endpoint (status/vendor/productType/search). */
  @Get('export.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="products.csv"')
  async exportCsv(
    @CurrentUser() user: JwtPayload,
    @Query() query: QueryProductsDto,
    @Res() res: Response,
  ) {
    const csv = await this.productService.exportCsv(user.orgId!, query);
    res.send(csv);
  }

  /** Multipart CSV upload — Stage 1: returns a PREVIEW job. */
  @Post('import')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: CSV_UPLOAD_LIMIT } }))
  @Roles(...ORG_MANAGERS)
  startImport(
    @CurrentUser() user: JwtPayload,
    @UploadedFile() file: MulterFile & { originalname: string },
  ) {
    return this.productService.startImportPreview(user.orgId!, user.sub, file);
  }

  /** Confirm a PREVIEW job — re-uploads the original CSV, kicks off ingest. */
  @Post('import/:jobId/confirm')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: CSV_UPLOAD_LIMIT } }))
  @Roles(...ORG_MANAGERS)
  confirmImport(
    @Param('jobId') jobId: string,
    @CurrentUser() user: JwtPayload,
    @UploadedFile() file: MulterFile,
  ) {
    return this.productService.confirmImport(
      user.orgId!,
      user.sub,
      jobId,
      file.buffer.toString('utf-8'),
    );
  }

  @Get('import/:jobId')
  getImportJob(@Param('jobId') jobId: string, @CurrentUser() user: JwtPayload) {
    return this.productService.getImportJob(user.orgId!, jobId);
  }

  // ── ITEM-LEVEL ROUTES (existing) ───────────────────────────────────────

  @Post(':id/duplicate')
  @Roles(...ORG_OPERATORS)
  duplicate(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.productService.duplicate(id, user.orgId!);
  }

  @Get(':id')
  @AllowVendor()
  findOne(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.productService.findOne(id, user.orgId!, vendorScopeFor(user));
  }

  // NOTE: there is no `PATCH :id/gst`. It existed, accepted only hsnCode and
  // gstRate, was never called by any client, and drifted to a different
  // validation set than the route the UI actually uses. `PATCH :id` writes all
  // four GST fields (hsnCode, gstRate, unitOfMeasure, supplyType) under one
  // set of rules.
  @Patch(':id')
  @AllowVendor()
  @Roles(...ORG_OPERATORS_AND_VENDORS)
  update(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateProductDto,
  ) {
    return this.productService.update(id, user.orgId!, dto, vendorScopeFor(user));
  }

  @Delete(':id')
  @Roles(...ORG_MANAGERS)
  softDelete(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.productService.softDelete(id, user.orgId!);
  }

  @Post(':id/sync')
  @AllowVendor()
  @Roles(...ORG_OPERATORS_AND_VENDORS)
  syncToShopify(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.productService.syncToShopify(id, user.orgId!, vendorScopeFor(user));
  }
}
