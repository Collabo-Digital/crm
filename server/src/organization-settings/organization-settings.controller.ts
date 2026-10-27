import {
  Body,
  Controller,
  Delete,
  Get,
  Patch,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ZodValidationPipe } from './zod-validation.pipe';
import type { JwtPayload } from '../auth/interfaces/jwt-payload.interface';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { OrganizationSettingsService } from './organization-settings.service';
import type { SettingsImageUpload } from './organization-settings.service';
import { UpdateProductSettingsSchema } from './schemas/product-settings.schema';
import type { UpdateProductSettingsInput } from './schemas/product-settings.schema';
import { UpdateOrderSettingsSchema } from './schemas/order-settings.schema';
import type { UpdateOrderSettingsInput } from './schemas/order-settings.schema';
import { UpdateInventorySettingsSchema } from './schemas/inventory-settings.schema';
import { UpdateTaxSettingsSchema } from './schemas/tax-settings.schema';
import type { UpdateTaxSettingsInput } from './schemas/tax-settings.schema';
import type { UpdateInventorySettingsInput } from './schemas/inventory-settings.schema';
import { UpdateStoreProfileSettingsSchema } from './schemas/store-profile-settings.schema';
import type { UpdateStoreProfileSettingsInput } from './schemas/store-profile-settings.schema';
import { UpdateInvoiceSettingsSchema } from './schemas/invoice-settings.schema';
import type { UpdateInvoiceSettingsInput } from './schemas/invoice-settings.schema';
import { Roles, ORG_MANAGERS } from '../auth/decorators/roles.decorator';

// Multer buffers the whole file in memory before the service sees it, so this
// cap bounds that. The service holds the logo (1 MB) and the signature
// (300 KB) to their own limits, with a message that names them.
const IMAGE_UPLOAD_LIMIT = 5 * 1024 * 1024;

/**
 * Org-scoped settings, organized by domain. All endpoints implicitly target
 * the caller's org (via JWT) — there is no `/orgs/:id/settings` to keep the
 * surface small.
 *
 * IMPORTANT: pipes here are attached at the @Body() parameter level, NOT via
 * @UsePipes at the method level. @UsePipes runs the pipe on every parameter
 * including @CurrentUser() — Zod's default `strip` mode would silently drop
 * unknown fields on the JwtPayload, leaving `user.orgId` undefined and
 * tripping the service's assertOrgId. The parameter-level form keeps the
 * pipe scoped to the body where it belongs.
 */
@Controller('organization/settings')
export class OrganizationSettingsController {
  constructor(private readonly service: OrganizationSettingsService) {}

  // GET /api/v1/organization/settings
  // Returns all domain settings (productSettings, orderSettings) with defaults.
  @Get()
  getAll(@CurrentUser() user: JwtPayload) {
    return this.service.get(user.orgId!);
  }

  // PATCH /api/v1/organization/settings/products
  // Role-gated like orders: autoSyncToShopify pushes CRM products into the live
  // store, allowOversellGlobally changes what can be sold, and the vendor
  // metafield decides which products and orders each Vendor member sees.
  @Patch('products')
  @Roles(...ORG_MANAGERS)
  updateProducts(
    @CurrentUser() user: JwtPayload,
    @Body(new ZodValidationPipe(UpdateProductSettingsSchema))
    body: UpdateProductSettingsInput,
  ) {
    return this.service.updateProductSettings(user.orgId!, body);
  }

  // PATCH /api/v1/organization/settings/orders
  // Role-gated as of autoInvoiceOnPayment: flipping that on makes the system
  // issue statutory GST invoices by itself, which is squarely what ORG_MANAGERS
  // covers ("issuing or cancelling a GST invoice, editing tax setup") and what
  // every invoice write route already requires. This also newly gates
  // autoSyncToShopify on the same route — deliberate, since pushing orders into
  // the merchant's real Shopify admin is not an AGENT/VIEWER-level action
  // either, and a Shopify order cannot be un-created.
  @Patch('orders')
  @Roles(...ORG_MANAGERS)
  updateOrders(
    @CurrentUser() user: JwtPayload,
    @Body(new ZodValidationPipe(UpdateOrderSettingsSchema))
    body: UpdateOrderSettingsInput,
  ) {
    return this.service.updateOrderSettings(user.orgId!, body);
  }

  // PATCH /api/v1/organization/settings/tax
  // Role-gated for the same reason as the orders route: both values here change
  // STATUTORY OUTPUT. The B2CL threshold moves invoices between GSTR-1 Table 5
  // and Table 7, and the default UQC appears on every Table 12 row — neither is
  // an AGENT/VIEWER-level change.
  //
  // Note the pipe is on the @Body() parameter, never @UsePipes: a
  // controller-level Zod pipe runs against every argument and its strip mode
  // would destroy @CurrentUser()'s orgId.
  @Patch('tax')
  @Roles(...ORG_MANAGERS)
  updateTax(
    @CurrentUser() user: JwtPayload,
    @Body(new ZodValidationPipe(UpdateTaxSettingsSchema))
    body: UpdateTaxSettingsInput,
  ) {
    return this.service.updateTaxSettings(user.orgId!, body);
  }

  // PATCH /api/v1/organization/settings/inventory
  // Explicitly role-gated (unlike the older sibling routes): QC/scan policy
  // changes alter warehouse-floor behavior. warehousingEnabled cannot be set
  // here at all — it flips only via the inventory enable flow.
  @Patch('inventory')
  @Roles(...ORG_MANAGERS)
  updateInventory(
    @CurrentUser() user: JwtPayload,
    @Body(new ZodValidationPipe(UpdateInventorySettingsSchema))
    body: UpdateInventorySettingsInput,
  ) {
    return this.service.updateInventorySettings(user.orgId!, body);
  }

  // PATCH /api/v1/organization/settings/store-profile
  // Role-gated: this is the business identity printed on outgoing paperwork —
  // the return address on every parcel, and the support contacts a customer is
  // told to use. Letting an AGENT/VIEWER rewrite it would let them redirect
  // returns or support traffic, which is squarely an ORG_MANAGERS concern.
  @Patch('store-profile')
  @Roles(...ORG_MANAGERS)
  updateStoreProfile(
    @CurrentUser() user: JwtPayload,
    @Body(new ZodValidationPipe(UpdateStoreProfileSettingsSchema))
    body: UpdateStoreProfileSettingsInput,
  ) {
    return this.service.updateStoreProfileSettings(user.orgId!, body);
  }

  // POST /api/v1/organization/settings/store-profile/logo
  // Multipart `file`, PNG or JPEG. Role-gated with the store profile it
  // writes: the logo prints on every invoice, receipt and packing slip.
  @Post('store-profile/logo')
  @Roles(...ORG_MANAGERS)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: IMAGE_UPLOAD_LIMIT } }))
  uploadLogo(
    @CurrentUser() user: JwtPayload,
    @UploadedFile() file: SettingsImageUpload | undefined,
  ) {
    return this.service.uploadLogo(user.orgId!, file);
  }

  // DELETE /api/v1/organization/settings/store-profile/logo
  @Delete('store-profile/logo')
  @Roles(...ORG_MANAGERS)
  removeLogo(@CurrentUser() user: JwtPayload) {
    return this.service.removeLogo(user.orgId!);
  }

  // PATCH /api/v1/organization/settings/invoice
  // Role-gated like the store profile: this decides what every customer's
  // invoice, bill and receipt prints.
  @Patch('invoice')
  @Roles(...ORG_MANAGERS)
  updateInvoice(
    @CurrentUser() user: JwtPayload,
    @Body(new ZodValidationPipe(UpdateInvoiceSettingsSchema))
    body: UpdateInvoiceSettingsInput,
  ) {
    return this.service.updateInvoiceSettings(user.orgId!, body);
  }

  // POST /api/v1/organization/settings/invoice/signature
  // Multipart `file`, PNG or JPEG: the image printed above "Authorised
  // Signatory" on credit notes, and on invoices in the `image` mode.
  @Post('invoice/signature')
  @Roles(...ORG_MANAGERS)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: IMAGE_UPLOAD_LIMIT } }))
  uploadSignature(
    @CurrentUser() user: JwtPayload,
    @UploadedFile() file: SettingsImageUpload | undefined,
  ) {
    return this.service.uploadSignature(user.orgId!, file);
  }

  // DELETE /api/v1/organization/settings/invoice/signature
  @Delete('invoice/signature')
  @Roles(...ORG_MANAGERS)
  removeSignature(@CurrentUser() user: JwtPayload) {
    return this.service.removeSignature(user.orgId!);
  }
}
