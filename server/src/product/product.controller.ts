import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Patch,
  Post,
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
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AllowVendor } from '../auth/decorators/allow-vendor.decorator';
import { vendorScopeFor } from '../auth/vendor-scope.util';
import { ProductService } from './product.service';
import { QueryProductsDto } from './dto/query-products.dto';
import { UpdateProductGstDto } from './dto/update-product-gst.dto';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import {
  CreateVariantDto,
  ReorderVariantsDto,
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

@Controller('products')
export class ProductController {
  constructor(private readonly productService: ProductService) { }

  // ── COLLECTION-LEVEL ROUTES ─────────────────────────────────────────────

  @Get()
  @AllowVendor()
  findAll(@CurrentUser() user: JwtPayload, @Query() query: QueryProductsDto) {
    return this.productService.findAll(user.orgId!, query, vendorScopeFor(user));
  }

  @Post()
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateProductDto) {
    return this.productService.create(user.orgId!, user.sub, dto);
  }

  @Get('vendors')
  @AllowVendor()
  getVendors(@CurrentUser() user: JwtPayload) {
    return this.productService.getVendors(user.orgId!, vendorScopeFor(user));
  }

  @Get('types')
  getProductTypes(@CurrentUser() user: JwtPayload) {
    return this.productService.getProductTypes(user.orgId!);
  }

  @Get('stats')
  getStats(@CurrentUser() user: JwtPayload, @Query('channelId') channelId?: string) {
    return this.productService.getStats(user.orgId!, channelId);
  }

  // ── VARIANT-LEVEL ROUTES (must register BEFORE :id wildcards) ──────────
  // These don't take a parent productId in the URL because the variant id is
  // globally unique and the service joins back to product → org for auth.

  @Patch('variants/:variantId')
  @AllowVendor()
  updateVariant(
    @Param('variantId') variantId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateVariantDto,
  ) {
    return this.productService.updateVariant(variantId, user.orgId!, dto, vendorScopeFor(user));
  }

  @Delete('variants/:variantId')
  @AllowVendor()
  deleteVariant(
    @Param('variantId') variantId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.productService.deleteVariant(variantId, user.orgId!, vendorScopeFor(user));
  }

  @Post('variants/:variantId/image')
  setVariantImage(
    @Param('variantId') variantId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: SetVariantImageDto,
  ) {
    return this.productService.setVariantImage(variantId, user.orgId!, dto);
  }

  // ── IMAGE-LEVEL ROUTES (must register BEFORE :id wildcards) ────────────

  @Patch('images/:imageId')
  updateImage(
    @Param('imageId') imageId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateImageDto,
  ) {
    return this.productService.updateImage(imageId, user.orgId!, dto);
  }

  @Delete('images/:imageId')
  removeImage(
    @Param('imageId') imageId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.productService.removeImage(imageId, user.orgId!);
  }

  // ── PRODUCT-NESTED ROUTES (variants/images for a given product) ────────

  @Post(':id/variants')
  @AllowVendor()
  createVariant(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVariantDto,
  ) {
    return this.productService.createVariant(id, user.orgId!, dto, vendorScopeFor(user));
  }

  @Post(':id/variants/reorder')
  reorderVariants(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: ReorderVariantsDto,
  ) {
    return this.productService.reorderVariants(id, user.orgId!, dto);
  }

  @Post(':id/variants/generate')
  @AllowVendor()
  generateVariants(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.productService.generateVariantsFromOptions(id, user.orgId!, vendorScopeFor(user));
  }

  @Patch(':id/options')
  @AllowVendor()
  updateOptions(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateOptionsDto,
  ) {
    return this.productService.updateOptions(id, user.orgId!, dto.options, vendorScopeFor(user));
  }

  @Post(':id/images')
  @UseInterceptors(FileInterceptor('file'))
  addImage(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @UploadedFile() file: MulterFile,
  ) {
    return this.productService.addImage(id, user.orgId!, file);
  }

  @Post(':id/images/reorder')
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
  bulkSetStatus(@CurrentUser() user: JwtPayload, @Body() dto: BulkSetStatusDto) {
    return this.productService.bulkSetStatus(user.orgId!, dto.productIds, dto.status);
  }

  @Post('bulk/archive')
  bulkArchive(@CurrentUser() user: JwtPayload, @Body() dto: BulkProductIdsDto) {
    return this.productService.bulkArchive(user.orgId!, dto.productIds);
  }

  @Delete('bulk')
  bulkDelete(@CurrentUser() user: JwtPayload, @Body() dto: BulkProductIdsDto) {
    return this.productService.bulkDelete(user.orgId!, dto.productIds);
  }

  @Post('bulk/tags/add')
  bulkAddTags(@CurrentUser() user: JwtPayload, @Body() dto: BulkTagsDto) {
    return this.productService.bulkAddTags(user.orgId!, dto.productIds, dto.tags);
  }

  @Post('bulk/tags/remove')
  bulkRemoveTags(@CurrentUser() user: JwtPayload, @Body() dto: BulkTagsDto) {
    return this.productService.bulkRemoveTags(user.orgId!, dto.productIds, dto.tags);
  }

  @Post('bulk/sync')
  @AllowVendor()
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
  @UseInterceptors(FileInterceptor('file'))
  startImport(
    @CurrentUser() user: JwtPayload,
    @UploadedFile() file: MulterFile & { originalname: string },
  ) {
    return this.productService.startImportPreview(user.orgId!, user.sub, file);
  }

  /** Confirm a PREVIEW job — re-uploads the original CSV, kicks off ingest. */
  @Post('import/:jobId/confirm')
  @UseInterceptors(FileInterceptor('file'))
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
  duplicate(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.productService.duplicate(id, user.orgId!);
  }

  @Get(':id')
  @AllowVendor()
  findOne(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.productService.findOne(id, user.orgId!, vendorScopeFor(user));
  }

  @Patch(':id/gst')
  updateGst(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateProductGstDto,
  ) {
    return this.productService.updateGst(id, user.orgId!, dto);
  }

  @Patch(':id')
  @AllowVendor()
  update(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateProductDto,
  ) {
    return this.productService.update(id, user.orgId!, dto, vendorScopeFor(user));
  }

  @Delete(':id')
  softDelete(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.productService.softDelete(id, user.orgId!);
  }

  @Post(':id/sync')
  @AllowVendor()
  syncToShopify(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.productService.syncToShopify(id, user.orgId!, vendorScopeFor(user));
  }
}
