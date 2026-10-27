import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  ProductSettings,
  UpdateProductSettingsInput,
  parseProductSettings,
  ProductSettingsSchema,
} from './schemas/product-settings.schema';
import {
  OrderSettings,
  UpdateOrderSettingsInput,
  parseOrderSettings,
  OrderSettingsSchema,
} from './schemas/order-settings.schema';
import {
  InventorySettings,
  UpdateInventorySettingsInput,
  parseInventorySettings,
  InventorySettingsSchema,
} from './schemas/inventory-settings.schema';
import {
  TaxSettings,
  UpdateTaxSettingsInput,
  parseTaxSettings,
  TaxSettingsSchema,
} from './schemas/tax-settings.schema';
import {
  StoreProfileSettings,
  UpdateStoreProfileSettingsInput,
  parseStoreProfileSettings,
  StoreProfileSettingsSchema,
} from './schemas/store-profile-settings.schema';
import {
  InvoiceSettings,
  UpdateInvoiceSettingsInput,
  parseInvoiceSettings,
  InvoiceSettingsSchema,
} from './schemas/invoice-settings.schema';
import { generatedBarcodeProductsOutOfSyncStampSql } from '../channel/product-sync-stamp.util';
import { detectCatalogPricesIncludeTax } from '../gst/catalog-prices-include-tax.util';
import {
  IMAGE_STORAGE,
  type IImageStorage,
  type UploadedImageMeta,
} from '../product/image-storage/image-storage.interface';
import { imageTypeOf } from '../product/image-storage/image-type.util';

/** The parts of a Multer upload the logo and signature routes read. */
export interface SettingsImageUpload {
  buffer: Buffer;
  originalname: string;
  size: number;
}

/** A logo prints on every document; a signature fills one corner of one. */
const IMAGE_UPLOADS = {
  logo: { name: 'The logo', maxBytes: 1024 * 1024, max: '1 MB' },
  signature: { name: 'The signature', maxBytes: 300 * 1024, max: '300 KB' },
} as const;

/**
 * Resolves and persists per-org settings. Each domain (product, order, …)
 * is stored in its own JSONB column on `OrganizationSettings` and validated
 * by its Zod schema. Defaults come from the schemas themselves — we never
 * write a "default settings" row eagerly; the row is upserted on first
 * write, and reads always parse-through-defaults.
 */
@Injectable()
export class OrganizationSettingsService {
  private readonly logger = new Logger(OrganizationSettingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(IMAGE_STORAGE) private readonly imageStorage: IImageStorage,
  ) {}

  /**
   * Return the org's full settings, applying schema defaults to any missing
   * fields. Does NOT write — safe for hot read paths (e.g. product creation
   * checking whether auto-sync is enabled).
   */
  async get(orgId: string): Promise<{
    productSettings: ProductSettings;
    orderSettings: OrderSettings;
    inventorySettings: InventorySettings;
    taxSettings: TaxSettings;
    storeProfileSettings: StoreProfileSettings;
    invoiceSettings: InvoiceSettings;
    /**
     * How orders and drafts read a catalogue or typed price: `effective` is
     * `taxSettings.pricesIncludeTax` once chosen, else `detected` — what the
     * store's Shopify orders say, null with none — else false.
     */
    pricesIncludeTax: { effective: boolean; detected: boolean | null };
  }> {
    this.assertOrgId(orgId);
    const row = await this.prisma.organizationSettings.findUnique({
      where: { organizationId: orgId },
    });
    const taxSettings = parseTaxSettings(row?.taxSettings ?? null);
    const detected = await detectCatalogPricesIncludeTax(this.prisma, orgId);
    return {
      productSettings: parseProductSettings(row?.productSettings ?? null),
      orderSettings: parseOrderSettings(row?.orderSettings ?? null),
      inventorySettings: parseInventorySettings(row?.inventorySettings ?? null),
      taxSettings,
      storeProfileSettings: parseStoreProfileSettings(row?.storeProfileSettings ?? null),
      invoiceSettings: parseInvoiceSettings(row?.invoiceSettings ?? null),
      pricesIncludeTax: {
        effective: taxSettings.pricesIncludeTax ?? detected ?? false,
        detected,
      },
    };
  }

  /**
   * Read just the store profile. Convenience for the package-slip print path,
   * which needs the From block and contact row on every render.
   */
  async getStoreProfileSettings(orgId: string): Promise<StoreProfileSettings> {
    this.assertOrgId(orgId);
    const row = await this.prisma.organizationSettings.findUnique({
      where: { organizationId: orgId },
      select: { storeProfileSettings: true },
    });
    return parseStoreProfileSettings(row?.storeProfileSettings ?? null);
  }

  /** Merge-patch the store profile; validate via Zod before write. */
  async updateStoreProfileSettings(
    orgId: string,
    patch: UpdateStoreProfileSettingsInput,
  ): Promise<StoreProfileSettings> {
    this.assertOrgId(orgId);
    const current = await this.getStoreProfileSettings(orgId);
    const next = StoreProfileSettingsSchema.parse({ ...current, ...patch });
    // A typed URL replaces an uploaded logo. The stored file no longer backs
    // `logoUrl`, so PDFs, which embed only uploaded files, print the name.
    if (next.logoUrl !== current.logoUrl) next.logoStorageKey = '';
    await this.upsert(orgId, {
      storeProfileSettings: next as Prisma.InputJsonValue,
    });
    return next;
  }

  /**
   * Store an uploaded logo and point the store profile at it. The file it
   * replaces is kept: invoices issued with it go on printing it.
   */
  async uploadLogo(
    orgId: string,
    file: SettingsImageUpload | undefined,
  ): Promise<StoreProfileSettings> {
    this.assertOrgId(orgId);
    const stored = await this.storeImage(orgId, file, IMAGE_UPLOADS.logo);
    const current = await this.getStoreProfileSettings(orgId);
    const next = StoreProfileSettingsSchema.parse({
      ...current,
      logoUrl: stored.url,
      logoStorageKey: stored.storageKey,
    });
    await this.upsert(orgId, {
      storeProfileSettings: next as Prisma.InputJsonValue,
    });
    return next;
  }

  /** Clear the logo. The file is kept: issued invoices may print it. */
  async removeLogo(orgId: string): Promise<StoreProfileSettings> {
    this.assertOrgId(orgId);
    const current = await this.getStoreProfileSettings(orgId);
    const next = StoreProfileSettingsSchema.parse({
      ...current,
      logoUrl: '',
      logoStorageKey: '',
    });
    await this.upsert(orgId, {
      storeProfileSettings: next as Prisma.InputJsonValue,
    });
    return next;
  }

  /** Read just the invoice design. Convenience for the settings page and PDFs. */
  async getInvoiceSettings(orgId: string): Promise<InvoiceSettings> {
    this.assertOrgId(orgId);
    const row = await this.prisma.organizationSettings.findUnique({
      where: { organizationId: orgId },
      select: { invoiceSettings: true },
    });
    return parseInvoiceSettings(row?.invoiceSettings ?? null);
  }

  /**
   * Merge-patch the invoice design; validate via Zod before write. The patch
   * schema has no `signature`: only its upload and delete routes change it.
   */
  async updateInvoiceSettings(
    orgId: string,
    patch: UpdateInvoiceSettingsInput,
  ): Promise<InvoiceSettings> {
    this.assertOrgId(orgId);
    const current = await this.getInvoiceSettings(orgId);
    const next = InvoiceSettingsSchema.parse({ ...current, ...patch });
    await this.upsert(orgId, {
      invoiceSettings: next as Prisma.InputJsonValue,
    });
    return next;
  }

  /** Store an uploaded signature image. The file it replaces is kept, like the logo's. */
  async uploadSignature(
    orgId: string,
    file: SettingsImageUpload | undefined,
  ): Promise<InvoiceSettings> {
    this.assertOrgId(orgId);
    const stored = await this.storeImage(orgId, file, IMAGE_UPLOADS.signature);
    const current = await this.getInvoiceSettings(orgId);
    const next = InvoiceSettingsSchema.parse({
      ...current,
      signature: { storageKey: stored.storageKey, url: stored.url },
    });
    await this.upsert(orgId, {
      invoiceSettings: next as Prisma.InputJsonValue,
    });
    return next;
  }

  /** Clear the signature image. The file is kept: issued documents may print it. */
  async removeSignature(orgId: string): Promise<InvoiceSettings> {
    this.assertOrgId(orgId);
    const current = await this.getInvoiceSettings(orgId);
    const next = InvoiceSettingsSchema.parse({ ...current, signature: null });
    await this.upsert(orgId, {
      invoiceSettings: next as Prisma.InputJsonValue,
    });
    return next;
  }

  /** Read just product settings. Convenience for the product-creation hot path. */
  async getProductSettings(orgId: string): Promise<ProductSettings> {
    this.assertOrgId(orgId);
    const row = await this.prisma.organizationSettings.findUnique({
      where: { organizationId: orgId },
      select: { productSettings: true },
    });
    return parseProductSettings(row?.productSettings ?? null);
  }

  /** Read just order settings. Convenience for the offline-order creation hot path. */
  async getOrderSettings(orgId: string): Promise<OrderSettings> {
    this.assertOrgId(orgId);
    const row = await this.prisma.organizationSettings.findUnique({
      where: { organizationId: orgId },
      select: { orderSettings: true },
    });
    return parseOrderSettings(row?.orderSettings ?? null);
  }

  /** Read just inventory settings. Convenience for ledger/scan hot paths. */
  async getInventorySettings(orgId: string): Promise<InventorySettings> {
    this.assertOrgId(orgId);
    const row = await this.prisma.organizationSettings.findUnique({
      where: { organizationId: orgId },
      select: { inventorySettings: true },
    });
    return parseInventorySettings(row?.inventorySettings ?? null);
  }

  /**
   * Merge-patch inventory settings; validate via Zod before write. The patch
   * schema cannot express `warehousingEnabled` or `skuSequence` — those flip
   * through `setWarehousingEnabled` / the atomic sequence claim only.
   */
  async updateInventorySettings(
    orgId: string,
    patch: UpdateInventorySettingsInput,
  ): Promise<InventorySettings> {
    this.assertOrgId(orgId);
    const current = await this.getInventorySettings(orgId);
    const next = InventorySettingsSchema.parse({ ...current, ...patch });
    const data = { inventorySettings: next as Prisma.InputJsonValue };

    // Switching "send generated barcodes" on changes what a future push
    // sends, but nothing re-flags the products whose codes were minted while
    // it was off — and Sync Now's pull step re-stamps them SYNCED anyway. So
    // the toggle itself marks every synced product with a generated barcode
    // out of sync; the next Sync Now then carries the codes across. Off→on
    // only: switching off has nothing to send, and the push gate already
    // withholds the codes.
    //
    // Same transaction as the settings write: if the sweep failed after the
    // flag had committed, nothing would ever re-run it (the next PATCH sees
    // on→on) and the caller would get a 500 for a change that stuck.
    if (!current.pushGeneratedBarcodes && next.pushGeneratedBarcodes) {
      const flagged = await this.prisma.$transaction(async (tx) => {
        await this.upsert(orgId, data, tx);
        return tx.$executeRaw(generatedBarcodeProductsOutOfSyncStampSql(orgId));
      });
      this.logger.log(
        `pushGeneratedBarcodes switched on for org ${orgId}: ${flagged} synced product(s) ` +
          'with generated barcodes marked OUT_OF_SYNC for the next push.',
      );
    } else {
      await this.upsert(orgId, data);
    }
    return next;
  }

  /**
   * Flip the warehousing master switch. Called ONLY by the inventory enable
   * flow, at the very end of the seed job (so legacy and bucket paths never
   * overlap for an org).
   */
  async setWarehousingEnabled(
    orgId: string,
    enabled: boolean,
    extra: Partial<Pick<InventorySettings, 'linkShopifyLocations'>> = {},
  ): Promise<InventorySettings> {
    this.assertOrgId(orgId);
    const current = await this.getInventorySettings(orgId);
    const next = InventorySettingsSchema.parse({
      ...current,
      ...extra,
      warehousingEnabled: enabled,
    });
    await this.upsert(orgId, {
      inventorySettings: next as Prisma.InputJsonValue,
    });
    return next;
  }

  /**
   * Read just tax settings. Convenience for the GST return hot path, which
   * needs the B2CL threshold and the default UQC on every request.
   */
  async getTaxSettings(orgId: string): Promise<TaxSettings> {
    this.assertOrgId(orgId);
    const row = await this.prisma.organizationSettings.findUnique({
      where: { organizationId: orgId },
      select: { taxSettings: true },
    });
    return parseTaxSettings(row?.taxSettings ?? null);
  }

  /**
   * Merge-patch tax settings; validate via Zod before write.
   *
   * Shallow spread, like its siblings — TaxSettings is deliberately flat so a
   * partial patch cannot drop sibling keys.
   *
   * Checked on the merged result, so turning one of composition and
   * e-invoicing on while the other is saved on is refused too.
   */
  async updateTaxSettings(orgId: string, patch: UpdateTaxSettingsInput): Promise<TaxSettings> {
    this.assertOrgId(orgId);
    const current = await this.getTaxSettings(orgId);
    const next = TaxSettingsSchema.parse({ ...current, ...patch });
    if (next.composition && next.eInvoicing) {
      throw new BadRequestException(
        "Composition and e-invoicing can't both be on: the composition scheme ends far below the e-invoicing limit.",
      );
    }
    await this.upsert(orgId, {
      taxSettings: next as Prisma.InputJsonValue,
    });
    return next;
  }

  /** Merge-patch product settings; validate via Zod before write. */
  async updateProductSettings(
    orgId: string,
    patch: UpdateProductSettingsInput,
  ): Promise<ProductSettings> {
    this.assertOrgId(orgId);
    const current = await this.getProductSettings(orgId);
    const next = ProductSettingsSchema.parse({ ...current, ...patch });
    await this.upsert(orgId, {
      productSettings: next as Prisma.InputJsonValue,
    });
    return next;
  }

  /** Merge-patch order settings; validate via Zod before write. */
  async updateOrderSettings(
    orgId: string,
    patch: UpdateOrderSettingsInput,
  ): Promise<OrderSettings> {
    this.assertOrgId(orgId);
    const current = await this.getOrderSettings(orgId);
    const next = OrderSettingsSchema.parse({ ...current, ...patch });
    await this.upsert(orgId, {
      orderSettings: next as Prisma.InputJsonValue,
    });
    return next;
  }

  /**
   * Defense-in-depth: callers from a NestJS controller should never reach
   * this point with a falsy orgId because `OrgRequiredGuard` includes the
   * settings controller in its whitelist. But internal callers (e.g.
   * ProductService.create reading auto-sync settings) might still pass a
   * stale value, and Prisma silently returns null rows when given
   * `where: { organizationId: undefined }` — so throw a clear error here
   * instead of producing garbage downstream.
   */
  private assertOrgId(orgId: string | undefined | null): asserts orgId is string {
    if (!orgId) {
      throw new BadRequestException('Organization context required to read or write settings.');
    }
  }

  /**
   * Check an uploaded image and store it. The type comes from the file's
   * first bytes, never the client's MIME type or name, and is what the
   * stored file's extension follows.
   */
  private async storeImage(
    orgId: string,
    file: SettingsImageUpload | undefined,
    rule: (typeof IMAGE_UPLOADS)[keyof typeof IMAGE_UPLOADS],
  ): Promise<UploadedImageMeta> {
    if (!file?.buffer?.length) {
      throw new BadRequestException('Choose an image to upload.');
    }
    const mimeType = imageTypeOf(file.buffer);
    if (!mimeType) {
      throw new BadRequestException(`${rule.name} must be a PNG or JPEG image.`);
    }
    if (file.size > rule.maxBytes) {
      throw new BadRequestException(`${rule.name} can be at most ${rule.max}.`);
    }
    return this.imageStorage.upload({
      orgId,
      buffer: file.buffer,
      originalName: file.originalname,
      mimeType,
      size: file.size,
    });
  }

  private async upsert(
    orgId: string,
    data: Prisma.OrganizationSettingsUncheckedUpdateInput,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<void> {
    await client.organizationSettings.upsert({
      where: { organizationId: orgId },
      create: {
        ...(data as Prisma.OrganizationSettingsUncheckedCreateInput),
        organizationId: orgId,
      },
      update: data,
    });
  }
}
