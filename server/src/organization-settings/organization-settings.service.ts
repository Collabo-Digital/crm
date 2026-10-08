import { BadRequestException, Injectable, Logger } from '@nestjs/common';
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
import { generatedBarcodeProductsOutOfSyncStampSql } from '../channel/product-sync-stamp.util';

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

  constructor(private readonly prisma: PrismaService) {}

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
  }> {
    this.assertOrgId(orgId);
    const row = await this.prisma.organizationSettings.findUnique({
      where: { organizationId: orgId },
    });
    return {
      productSettings: parseProductSettings(row?.productSettings ?? null),
      orderSettings: parseOrderSettings(row?.orderSettings ?? null),
      inventorySettings: parseInventorySettings(row?.inventorySettings ?? null),
      taxSettings: parseTaxSettings(row?.taxSettings ?? null),
      storeProfileSettings: parseStoreProfileSettings(
        row?.storeProfileSettings ?? null,
      ),
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
    await this.upsert(orgId, {
      storeProfileSettings: next as Prisma.InputJsonValue,
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
    await this.upsert(orgId, { inventorySettings: next as Prisma.InputJsonValue });

    // Switching "send generated barcodes" on changes what a future push
    // sends, but nothing re-flags the products whose codes were minted while
    // it was off — and Sync Now's pull step re-stamps them SYNCED anyway. So
    // the toggle itself marks every synced product with a generated barcode
    // out of sync; the next Sync Now then carries the codes across. Off→on
    // only: switching off has nothing to send, and the push gate already
    // withholds the codes.
    if (!current.pushGeneratedBarcodes && next.pushGeneratedBarcodes) {
      const flagged = await this.prisma.$executeRaw(
        generatedBarcodeProductsOutOfSyncStampSql(orgId),
      );
      this.logger.log(
        `pushGeneratedBarcodes switched on for org ${orgId}: ${flagged} synced product(s) ` +
          'with generated barcodes marked OUT_OF_SYNC for the next push.',
      );
    }
    return next;
  }

  /**
   * Flip the warehousing master switch. Called ONLY by the inventory enable
   * flow, at the very end of the seed job (so legacy and bucket paths never
   * overlap for an org).
   */
  async setWarehousingEnabled(orgId: string, enabled: boolean): Promise<InventorySettings> {
    this.assertOrgId(orgId);
    const current = await this.getInventorySettings(orgId);
    const next = InventorySettingsSchema.parse({ ...current, warehousingEnabled: enabled });
    await this.upsert(orgId, { inventorySettings: next as Prisma.InputJsonValue });
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
   */
  async updateTaxSettings(
    orgId: string,
    patch: UpdateTaxSettingsInput,
  ): Promise<TaxSettings> {
    this.assertOrgId(orgId);
    const current = await this.getTaxSettings(orgId);
    const next = TaxSettingsSchema.parse({ ...current, ...patch });
    await this.upsert(orgId, { taxSettings: next as Prisma.InputJsonValue });
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
    await this.upsert(orgId, { productSettings: next as Prisma.InputJsonValue });
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
    await this.upsert(orgId, { orderSettings: next as Prisma.InputJsonValue });
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
      throw new BadRequestException(
        'Organization context required to read or write settings.',
      );
    }
  }

  private async upsert(
    orgId: string,
    data: Prisma.OrganizationSettingsUncheckedUpdateInput,
  ): Promise<void> {
    await this.prisma.organizationSettings.upsert({
      where: { organizationId: orgId },
      create: {
        ...(data as Prisma.OrganizationSettingsUncheckedCreateInput),
        organizationId: orgId,
      },
      update: data,
    });
  }
}
