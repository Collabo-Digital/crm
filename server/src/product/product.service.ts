import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  ChannelPlatform,
  ChannelStatus,
  GstSupplyType,
  Prisma,
  ProductStatus,
  ProductVariant,
} from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { QueryProductsDto } from './dto/query-products.dto';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import {
  BulkUpdateVariantsDto,
  CreateVariantDto,
  ReorderVariantsDto,
  UpdateVariantDto,
} from './dto/variant.dto';
import { DEFAULT_VARIANT_TITLE } from './variant-title.util';
import {
  ReorderImagesDto,
  SetVariantImageDto,
  UpdateImageDto,
} from './dto/image.dto';
import { ProductOptionDto } from './dto/option.dto';
import { ShopifyPushEnqueuer } from '../channel/shopify-push.enqueuer';
import { OrganizationSettingsService } from '../organization-settings/organization-settings.service';
import { InventoryLedgerService } from '../inventory/inventory-ledger.service';
import { SkuGeneratorService } from '../inventory/sku-generator.service';
import { FxRateService } from '../common/fx/fx-rate.service';
import { normalizeUqc } from '../gst/constants/uqc';
import {
  type IImageStorage,
  IMAGE_STORAGE,
} from './image-storage/image-storage.interface';
import {
  buildShopifyCsv,
  groupRowsIntoProducts,
  parseShopifyCsv,
  type ParsedProductCandidate,
} from './csv/shopify-csv.format';
import type {
  ProductImportError,
  ProductImportJobView,
} from './dto/import.dto';

const ALLOWED_IMAGE_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB
const MAX_IMAGES_PER_PRODUCT = 10;

type ShopifySyncStatus = 'PENDING' | 'SYNCED' | 'FAILED' | 'OUT_OF_SYNC';

type ShopifySyncPatch = Partial<{
  status: ShopifySyncStatus;
  shopifyProductId: string;
  error: string;
  syncedAt: string;
  attempts: number;
}>;

@Injectable()
export class ProductService {
  private readonly logger = new Logger(ProductService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly shopifyPushEnqueuer: ShopifyPushEnqueuer,
    private readonly settings: OrganizationSettingsService,
    private readonly inventoryLedger: InventoryLedgerService,
    private readonly skuGenerator: SkuGeneratorService,
    // Restates catalogue prices when a caller asks for one currency across a
    // multi-channel catalogue — see `QueryProductsDto.priceIn`.
    private readonly fx: FxRateService,
    @Inject(IMAGE_STORAGE) private readonly imageStorage: IImageStorage,
  ) { }

  /**
   * Manual SKU/barcode edits are policed for org-wide uniqueness (409 on
   * collision). Only NEW duplicates are blocked — data synced from Shopify may
   * legally contain duplicates (surfaced by the duplicates report instead).
   * Empty strings clear the field and are always allowed.
   */
  private async assertVariantCodesFree(
    orgId: string,
    dto: { sku?: string | null; barcode?: string | null },
    excludeVariantId?: string,
  ) {
    if (dto.sku) await this.skuGenerator.assertCodeFree(orgId, dto.sku, excludeVariantId);
    if (dto.barcode && dto.barcode !== dto.sku) {
      await this.skuGenerator.assertCodeFree(orgId, dto.barcode, excludeVariantId);
    }
  }

  async findAll(
    orgId: string,
    query: QueryProductsDto,
    vendorScope?: string,
  ) {
    const where: Prisma.ProductWhereInput = {
      organizationId: orgId,
      deletedAt: null,
    };

    if (query.status) where.status = query.status;
    if (query.vendor) where.vendor = query.vendor;
    // VENDOR role: force the scope, overriding any client-supplied vendor filter.
    if (vendorScope) where.vendor = vendorScope;
    if (query.productType) where.productType = query.productType;
    if (query.channelId) where.channelId = query.channelId;

    if (query.search) {
      where.OR = [
        { title: { contains: query.search, mode: 'insensitive' } },
        { vendor: { contains: query.search, mode: 'insensitive' } },
        {
          variants: {
            some: {
              sku: {
                contains: query.search,
                mode: 'insensitive',
              },
            },
          },
        },
      ];
    }

    // Stock status filter — filter products by their variants' inventory
    if (query.stockStatus === 'out_of_stock') {
      // some:{} excludes zero-variant products — `every` alone is vacuously
      // true for them. Keeps this filter in lockstep with getStats.
      where.variants = {
        some: {},
        every: { inventoryQuantity: { lte: 0 } },
      };
    } else if (query.stockStatus === 'low_stock') {
      // Low stock = any variant has stock > 0 but <= org threshold (default 10)
      const org = await this.prisma.organization.findUnique({
        where: { id: orgId },
        select: { lowStockThreshold: true },
      });
      const threshold = org?.lowStockThreshold ?? 10;
      where.variants = {
        some: { inventoryQuantity: { gt: 0, lte: threshold } },
      };
    } else if (query.stockStatus === 'in_stock') {
      where.variants = { some: { inventoryQuantity: { gt: 0 } } };
    }

    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        include: {
          variants: {
            // trackQuantity + continueSellingWhenOutOfStock are needed by the
            // order-create picker to decide whether a 0-stock variant can be
            // added as a backorder. Without them the client sees `undefined`
            // and falls back to the strict "block at 0" branch.
            select: {
              id: true,
              title: true,
              sku: true,
              // barcode rides along for the products bulk bar, which counts
              // how many selected variants still need one before calling
              // /inventory/labels/generate-barcodes. Without it the button
              // could only offer a blind "generate" with no idea of the scope.
              barcode: true,
              price: true,
              inventoryQuantity: true,
              option1: true,
              option2: true,
              option3: true,
              position: true,
              trackQuantity: true,
              continueSellingWhenOutOfStock: true,
            },
            orderBy: { position: 'asc' },
          },
          images: {
            select: {
              id: true,
              src: true,
              alt: true,
              position: true,
            },
            orderBy: { position: 'asc' },
            take: 1, // Only first image for list view
          },
          channel: {
            select: { id: true, name: true, platform: true, currency: true },
          },
        },
        orderBy: {
          [query.sortBy ?? 'createdAt']: query.sortOrder ?? 'desc',
        },
        skip,
        take: limit,
      }),
      this.prisma.product.count({ where }),
    ]);

    // Opt-in restatement of catalogue prices into one currency — see
    // `QueryProductsDto.priceIn`. Resolved once for the whole page rather than
    // per product, and a missing rate leaves that product's prices untouched
    // (the response says which currency each one is in, so the caller can tell).
    const priceIn = query.priceIn?.toUpperCase();
    const rates = priceIn
      ? await this.priceRatesFor(data.map((p) => p.channel?.currency), priceIn)
      : null;

    return {
      data: data.map((product) => {
        // Calculate total stock across all variants
        const totalStock = product.variants.reduce(
          (sum, v) => sum + v.inventoryQuantity,
          0,
        );

        const source = (product.channel?.currency ?? priceIn ?? '').toUpperCase();
        const rate = rates?.get(source) ?? null;
        const variants =
          rate === null || rate === 1
            ? product.variants
            // The list projection selects `price` only; compare-at is not part
            // of it, so there is nothing else on the row to restate.
            : product.variants.map((v) => ({
                ...v,
                price: this.convertMoney(v.price, rate),
              }));
        // The currency those numbers are now in, so the client never has to
        // assume: the requested one when converted, else the channel's own.
        const priceCurrency =
          rate !== null ? (priceIn as string) : (product.channel?.currency ?? null);

        return {
          id: product.id,
          title: product.title,
          vendor: product.vendor,
          productType: product.productType,
          status: product.status,
          tags: product.tags,
          hsnCode: product.hsnCode,
          gstRate: product.gstRate,
          totalStock,
          variantCount: variants.length,
          priceRange: this.getPriceRange(variants),
          priceCurrency,
          image: product.images[0] || null,
          channel: product.channel,
          createdAt: product.externalCreatedAt || product.createdAt,
          variants,
          shopifySync: this.extractShopifySync(product.metadata),
        };
      }),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  /**
   * Pull the shopifySync sub-object out of Product.metadata for the list
   * response so the UI can render Syncing / Synced / Failed badges without
   * loading the full product detail.
   */
  private extractShopifySync(metadata: Prisma.JsonValue | null) {
    if (
      !metadata ||
      typeof metadata !== 'object' ||
      Array.isArray(metadata)
    ) {
      return null;
    }
    const sync = (metadata as Record<string, unknown>).shopifySync;
    if (!sync || typeof sync !== 'object') return null;
    return sync as {
      status: ShopifySyncStatus;
      shopifyProductId?: string;
      error?: string;
      syncedAt?: string;
      attempts: number;
    };
  }

  async findOne(id: string, orgId: string, vendorScope?: string) {
    const product = await this.prisma.product.findFirst({
      where: {
        id,
        organizationId: orgId,
        deletedAt: null,
        ...(vendorScope ? { vendor: vendorScope } : {}),
      },
      include: {
        variants: { orderBy: { position: 'asc' } },
        images: { orderBy: { position: 'asc' } },
        channel: { select: { id: true, name: true, platform: true, currency: true } },
      },
    });
    if (!product) throw new NotFoundException('Product not found');

    const totalStock = product.variants.reduce(
      (sum, v) => sum + v.inventoryQuantity,
      0,
    );

    return {
      ...product,
      totalStock,
      priceRange: this.getPriceRange(product.variants),
    };
  }

  /**
   * Distinct vendor match keys for the invite dropdown / filter. The match key is
   * the vendor metafield value (Product.vendorKey) when present, else the built-in
   * Product.vendor name. A VENDOR only ever sees their own key.
   */
  async getVendors(orgId: string, vendorScope?: string) {
    if (vendorScope) return [vendorScope];
    const [byKey, byVendor] = await Promise.all([
      this.prisma.product.findMany({
        where: {
          organizationId: orgId,
          deletedAt: null,
          vendorKey: { not: null },
        },
        select: { vendorKey: true },
        distinct: ['vendorKey'],
      }),
      this.prisma.product.findMany({
        where: {
          organizationId: orgId,
          deletedAt: null,
          vendorKey: null,
          vendor: { not: null },
        },
        select: { vendor: true },
        distinct: ['vendor'],
      }),
    ]);
    const keys = new Set<string>();
    for (const r of byKey) if (r.vendorKey) keys.add(r.vendorKey);
    for (const r of byVendor) if (r.vendor) keys.add(r.vendor);
    return Array.from(keys).sort();
  }

  // Get unique product types for filter dropdown
  async getProductTypes(orgId: string, vendorScope?: string) {
    const types = await this.prisma.product.findMany({
      where: {
        organizationId: orgId,
        deletedAt: null,
        productType: { not: null },
        // A vendor's filter should offer only the types they actually have —
        // an unscoped list both leaks the org's catalogue shape and offers
        // options that match none of their products.
        ...(vendorScope ? { vendor: vendorScope } : {}),
      },
      select: { productType: true },
      distinct: ['productType'],
      orderBy: { productType: 'asc' },
    });
    return types.map((t) => t.productType).filter(Boolean);
  }

  async getStats(orgId: string, channelId?: string, vendorScope?: string) {
    // Every query below derives from baseWhere (the variant aggregate joins
    // through `product: baseWhere`), so scoping here scopes all seven.
    // Matches on `vendor` exactly as findAll does, keeping the tiles and the
    // list they sit above in agreement — see the vendorKey caveat on findAll.
    const baseWhere: Prisma.ProductWhereInput = {
      organizationId: orgId,
      deletedAt: null,
      ...(channelId && { channelId }),
      ...(vendorScope ? { vendor: vendorScope } : {}),
    };

    // Get the org's low stock threshold
    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
      select: { lowStockThreshold: true },
    });
    const threshold = org?.lowStockThreshold ?? 10;

    const [
      totalProducts,
      activeListings,
      draftProducts,
      archivedProducts,
      outOfStockProducts,
      lowStockProducts,
      totalInventory,
    ] = await Promise.all([
      this.prisma.product.count({ where: baseWhere }),
      this.prisma.product.count({
        where: { ...baseWhere, status: 'ACTIVE' },
      }),
      this.prisma.product.count({
        where: { ...baseWhere, status: 'DRAFT' },
      }),
      this.prisma.product.count({
        where: { ...baseWhere, status: 'ARCHIVED' },
      }),
      this.prisma.product.count({
        where: {
          ...baseWhere,
          status: 'ACTIVE',
          variants: {
            some: {},
            every: { inventoryQuantity: { lte: 0 } },
          },
        },
      }),
      this.prisma.product.count({
        where: {
          ...baseWhere,
          status: 'ACTIVE',
          variants: {
            some: { inventoryQuantity: { gt: 0, lte: threshold } },
          },
        },
      }),
      this.prisma.productVariant.aggregate({
        where: { product: baseWhere },
        _sum: { inventoryQuantity: true },
      }),
    ]);

    return {
      totalProducts,
      activeListings,
      draftProducts,
      archivedProducts,
      outOfStockProducts,
      lowStockProducts,
      lowStockThreshold: threshold,
      totalInventoryUnits: totalInventory._sum.inventoryQuantity ?? 0,
    };
  }

  /**
   * Rate per source currency for restating catalogue prices into `target`.
   *
   * One lookup per distinct currency on the page, not per product. A currency
   * whose rate cannot be reached is simply absent from the map, and the caller
   * leaves those prices in their own currency rather than inventing a number —
   * the response's `priceCurrency` then says so.
   */
  private async priceRatesFor(
    sourceCurrencies: Array<string | null | undefined>,
    target: string,
  ): Promise<Map<string, number>> {
    const rates = new Map<string, number>([[target, 1]]);
    const distinct = new Set(
      sourceCurrencies
        .map((c) => (c ?? '').toUpperCase())
        .filter((c) => c && c !== target),
    );
    for (const source of distinct) {
      const rate = await this.fx.getRate(source, target, new Date());
      if (rate != null) rates.set(source, rate);
    }
    return rates;
  }

  /** Money × rate, at the 2dp every currency this app serves is stored to. */
  private convertMoney(value: unknown, rate: number): string | null {
    if (value === null || value === undefined) return null;
    const num = parseFloat(String(value));
    if (!Number.isFinite(num)) return null;
    return (num * rate).toFixed(2);
  }

  private getPriceRange(variants: Array<{ price: any }>) {
    if (variants.length === 0) return { min: '0', max: '0' };
    const prices = variants.map((v) => parseFloat(String(v.price)));
    return {
      min: Math.min(...prices).toFixed(2),
      max: Math.max(...prices).toFixed(2),
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CREATE PRODUCT — single-variant (legacy) OR multi-variant (new) flow.
  // ═══════════════════════════════════════════════════════════════════════
  async create(orgId: string, _userId: string, dto: CreateProductDto) {
    // Cross-field guard: exactly one of `variant` | `variants` must be set.
    const hasSingle = !!dto.variant;
    const hasMulti = Array.isArray(dto.variants) && dto.variants.length > 0;
    if (hasSingle && hasMulti) {
      throw new BadRequestException(
        'Provide either `variant` (single) or `variants` (array) — not both.',
      );
    }
    if (!hasSingle && !hasMulti) {
      throw new BadRequestException(
        'A product must include at least one variant (use `variant` or `variants`).',
      );
    }
    if (hasMulti && (!dto.options || dto.options.length === 0)) {
      throw new BadRequestException(
        'Multi-variant products must define `options` (e.g. Size, Color).',
      );
    }

    const product = await this.prisma.$transaction(async (tx) => {
      // Lazy-create the MANUAL channel.
      const channel = await tx.channel.upsert({
        where: {
          organizationId_platform: {
            organizationId: orgId,
            platform: ChannelPlatform.MANUAL,
          },
        },
        create: {
          organizationId: orgId,
          platform: ChannelPlatform.MANUAL,
          name: 'In-Store / Manual',
          status: ChannelStatus.CONNECTED,
          isEnabled: true,
        },
        update: {},
      });

      // Build variants payload.
      // Product create is admin-only (no @AllowVendor on the route), so no
      // vendor scope to thread here; the builder still takes one for parity.
      const variantsCreate = hasMulti
        ? dto.variants!.map((v, idx) =>
          this.buildVariantCreate(orgId, v, idx + 1, dto.options),
        )
        : [this.buildVariantCreate(orgId, dto.variant!, 1, undefined)];

      // SKUs and barcodes must be free — the same check `createVariant`,
      // `updateVariant` and the bulk update already run. Product create was
      // the ONE path that skipped it, so a whole catalogue could be built on
      // colliding codes: three products were created here sharing SKU
      // "QA-DUP-001". Inventory, label printing and barcode scanning all
      // identify a variant by these codes, so a duplicate is not cosmetic.
      const incoming = hasMulti ? dto.variants! : [dto.variant!];
      for (const v of incoming) {
        await this.assertVariantCodesFree(orgId, v);
      }

      // Codes must also be unique WITHIN the payload — the check above compares
      // against what is already stored, and two new variants carrying the same
      // SKU would each pass it and then both be written.
      const seen = new Set<string>();
      for (const v of incoming) {
        for (const code of [v.sku, v.barcode]) {
          if (!code) continue;
          const key = code.trim().toLowerCase();
          if (seen.has(key)) {
            throw new BadRequestException(
              `Duplicate code "${code}" appears on more than one variant of this product.`,
            );
          }
          seen.add(key);
        }
      }

      const created = await tx.product.create({
        data: {
          organizationId: orgId,
          channelId: channel.id,
          externalId: `manual_${randomUUID()}`,
          title: dto.title,
          vendor: dto.vendor ?? null,
          productType: dto.productType ?? null,
          status: dto.status ?? ProductStatus.ACTIVE,
          tags: dto.tags ?? [],
          bodyHtml: dto.bodyHtml ?? null,
          hsnCode: dto.hsnCode ?? null,
          gstRate: dto.gstRate ?? null,
          // Canonicalised, like variantGstOverride: a lowercase "nos" stored raw
          // reads as "no UQC set" at invoice time and silently falls back.
          unitOfMeasure: normalizeUqc(dto.unitOfMeasure),
          ...(dto.supplyType ? { supplyType: dto.supplyType } : {}),
          options: hasMulti
            ? (dto.options as unknown as Prisma.InputJsonValue)
            : Prisma.JsonNull,
          metadata: { source: 'crm' } as Prisma.InputJsonObject,
          externalCreatedAt: new Date(),
          ...(dto.publishedAt && {
            publishedAt: new Date(dto.publishedAt),
          }),
          variants: { create: variantsCreate },
        },
        include: {
          variants: { orderBy: { position: 'asc' } },
          images: true,
          channel: {
            select: { id: true, name: true, platform: true, currency: true },
          },
        },
      });

      // Ledger: initial stock for variants created with a non-zero quantity.
      await this.inventoryLedger.recordInitialQuantities(
        tx,
        orgId,
        created.variants,
        'initial',
        'product',
        created.id,
        _userId,
      );

      // …and a stock row per variant, in the same transaction. Without this a
      // warehousing org's new product never appears in Inventory, so it can
      // never be given stock, so the order builder permanently disables it.
      await this.inventoryLedger.ensureStockRows(tx, orgId, created.variants);

      return created;
    });

    // Give every new variant a scannable barcode before anything can push.
    //
    // Labels are printed from `barcode`, falling back to `sku` — and the SKU
    // shape ({PREFIX}-{PRODUCTCODE}-{SEQ}-{OPTIONS}) needs ~48 mm of label, so
    // it cannot print on small or jewellery stock at any resolution. Minting a
    // 6-digit code here means a product is labellable the moment it exists,
    // with no separate step to remember.
    //
    // Ordering matters: this runs BEFORE the Shopify push is enqueued, so the
    // pushed payload reflects the final row rather than racing it. Whether the
    // code actually reaches Shopify is a separate decision —
    // inventorySettings.pushGeneratedBarcodes, default off.
    //
    // Best-effort: a product that exists without a barcode is recoverable (the
    // bulk action fills it in); failing the create is not.
    try {
      await this.skuGenerator.generateBarcodes(orgId, {
        variantIds: product.variants.map((v) => v.id),
        format: 'short',
      });
    } catch (err) {
      this.logger.warn(
        `Barcode generation failed for new product ${product.id}: ${(err as Error).message}`,
      );
    }

    // Auto-push to Shopify (gated on org settings).
    let shopifyPushQueued = false;
    try {
      const productSettings =
        await this.settings.getProductSettings(orgId);
      if (productSettings.autoSyncToShopify) {
        const shopify = await this.prisma.channel.findUnique({
          where: {
            organizationId_platform: {
              organizationId: orgId,
              platform: ChannelPlatform.SHOPIFY,
            },
          },
        });
        if (shopify?.status === ChannelStatus.CONNECTED) {
          await this.shopifyPushEnqueuer.enqueueProductPush({
            type: 'product',
            productId: product.id,
            organizationId: orgId,
          });
          shopifyPushQueued = true;
          await this.prisma.product.update({
            where: { id: product.id },
            data: {
              metadata: this.mergeShopifySync(product.metadata, {
                status: 'PENDING',
                attempts: 0,
              }),
            },
          });
        }
      }
    } catch (err) {
      this.logger.warn(
        `Skipping Shopify push enqueue for product ${product.id}: ${err}`,
      );
    }

    return { ...product, shopifyPushQueued };
  }

  /**
   * Build a Prisma-ready variant create payload from a CreateVariantDto.
   * - `position` defaults to the row index (1-based) when omitted.
   * - `title` is auto-derived from option values: "Small / Red". Falls back
   *   to "Default Title" for single-variant products.
   * - Phase-2 fields (cost, weight, barcode, trackQuantity, etc.) flow through
   *   when provided on the DTO; Prisma defaults apply otherwise.
   */
  private buildVariantCreate(
    orgId: string,
    v: CreateVariantDto,
    position: number,
    options: ProductOptionDto[] | undefined,
    vendorScope?: string,
  ): Prisma.ProductVariantCreateWithoutProductInput {
    const optionLabels = [v.option1, v.option2, v.option3].filter(
      Boolean,
    ) as string[];
    const isMulti = !!options && options.length > 0;
    const title =
      isMulti && optionLabels.length > 0
        ? optionLabels.join(' / ')
        : DEFAULT_VARIANT_TITLE;
    return {
      organizationId: orgId,
      externalId: `manual_${randomUUID()}`,
      title,
      sku: v.sku ?? null,
      barcode: v.barcode ?? null,
      // A barcode supplied at create time was typed or imported by a person.
      // Variants left without one are minted a GENERATED code after the
      // transaction — see create().
      barcodeSource: v.barcode ? 'MANUAL' : null,
      price: v.price ?? 0,
      compareAtPrice: v.compareAtPrice ?? null,
      cost: v.cost ?? null,
      inventoryQuantity: v.inventoryQuantity ?? 0,
      trackQuantity: v.trackQuantity ?? true,
      continueSellingWhenOutOfStock:
        v.continueSellingWhenOutOfStock ?? false,
      weight: v.weight ?? null,
      weightUnit: v.weightUnit ?? null,
      hsCode: v.hsCode ?? null,
      countryOfOrigin: v.countryOfOrigin ?? null,
      option1: isMulti ? (v.option1 ?? null) : DEFAULT_VARIANT_TITLE,
      option2: isMulti ? (v.option2 ?? null) : null,
      option3: isMulti ? (v.option3 ?? null) : null,
      position: v.position ?? position,
      requiresShipping: v.requiresShipping ?? true,
      // Vendors cannot set tax fields — the same rule createVariant and
      // buildVariantPatch apply; this builder used to skip it.
      taxable: vendorScope ? true : (v.taxable ?? true),
      ...(vendorScope ? {} : this.variantGstOverride(v)),
    };
  }

  /**
   * The four per-variant GST override columns from a DTO, empty strings
   * collapsed to null (= inherit from the product). Callers apply the vendor
   * guard; this only shapes the values.
   */
  private variantGstOverride(v: {
    hsnCode?: string | null;
    gstRate?: number | null;
    unitOfMeasure?: string | null;
    supplyType?: GstSupplyType | null;
  }): Pick<
    Prisma.ProductVariantCreateWithoutProductInput,
    'hsnCode' | 'gstRate' | 'unitOfMeasure' | 'supplyType'
  > {
    const out: ReturnType<ProductService['variantGstOverride']> = {};
    if (v.hsnCode !== undefined) out.hsnCode = v.hsnCode?.trim() || null;
    if (v.gstRate !== undefined) out.gstRate = v.gstRate;
    if (v.unitOfMeasure !== undefined)
      out.unitOfMeasure = normalizeUqc(v.unitOfMeasure);
    if (v.supplyType !== undefined) out.supplyType = v.supplyType;
    return out;
  }

  // ─── SYNC TO SHOPIFY ───
  // Allowed for both MANUAL (creates a new Shopify product) and SHOPIFY-channel
  // products (pushes local edits as an update). The push service decides which
  // path to take based on `product.channel.platform`.
  async syncToShopify(id: string, orgId: string, vendorScope?: string) {
    const product = await this.prisma.product.findFirst({
      where: { id, organizationId: orgId, deletedAt: null },
      include: { channel: true },
    });
    if (!product) throw new NotFoundException('Product not found');
    this.assertVendorOwnsProduct(product.vendor, vendorScope);

    const shopify = await this.prisma.channel.findUnique({
      where: {
        organizationId_platform: {
          organizationId: orgId,
          platform: ChannelPlatform.SHOPIFY,
        },
      },
    });
    if (!shopify || shopify.status !== ChannelStatus.CONNECTED) {
      throw new ForbiddenException(
        'No connected Shopify channel. Connect Shopify first, then sync.',
      );
    }

    const meta = (product.metadata as Prisma.JsonObject) ?? {};
    const sync = (meta.shopifySync ?? null) as {
      status: ShopifySyncStatus;
    } | null;

    if (sync?.status === 'SYNCED') {
      return { status: 'ALREADY_SYNCED' as const, productId: product.id };
    }
    if (sync?.status === 'PENDING') {
      return { status: 'ALREADY_QUEUED' as const, productId: product.id };
    }

    await this.shopifyPushEnqueuer.enqueueProductPush({
      type: 'product',
      productId: product.id,
      organizationId: orgId,
    });
    await this.prisma.product.update({
      where: { id: product.id },
      data: {
        metadata: this.mergeShopifySync(product.metadata, {
          status: 'PENDING',
          attempts: 0,
        }),
      },
    });
    return { status: 'QUEUED' as const, productId: product.id };
  }

  // ─── UPDATE PRODUCT (top-level fields + optional default-variant fields) ───
  async update(
    id: string,
    orgId: string,
    dto: UpdateProductDto,
    vendorScope?: string,
  ) {
    const product = await this.prisma.product.findFirst({
      where: { id, organizationId: orgId, deletedAt: null },
      include: {
        channel: true,
        variants: { orderBy: { position: 'asc' }, take: 1 },
      },
    });
    if (!product) throw new NotFoundException('Product not found');
    this.assertVendorOwnsProduct(product.vendor, vendorScope);
    this.assertCrmEditable(product.channel.platform);

    // Vendors may not change the vendor assignment or tax fields — ignore them
    // even if present in the payload (backend guarantee; UI shows read-only).
    const isVendor = !!vendorScope;

    // Variants whose stock actually moved; pushed after commit so a queue
    // outage cannot roll the edit back.
    const stockMovedVariantIds: string[] = [];

    const updated = await this.prisma.$transaction(async (tx) => {
      const productPatch: Prisma.ProductUpdateInput = {};
      if (dto.title !== undefined) productPatch.title = dto.title;
      // Empty string clears the column (stored as null, like hsnCode) so a
      // form that blanks the field can actually remove the value.
      if (!isVendor && dto.vendor !== undefined)
        productPatch.vendor = dto.vendor || null;
      if (dto.productType !== undefined)
        productPatch.productType = dto.productType || null;
      if (dto.status !== undefined) productPatch.status = dto.status;
      if (dto.tags !== undefined) productPatch.tags = dto.tags;
      if (dto.bodyHtml !== undefined)
        productPatch.bodyHtml = dto.bodyHtml;
      if (!isVendor && dto.hsnCode !== undefined)
        productPatch.hsnCode = dto.hsnCode || null;
      if (!isVendor && dto.gstRate !== undefined)
        productPatch.gstRate = dto.gstRate;
      if (!isVendor && dto.unitOfMeasure !== undefined)
        productPatch.unitOfMeasure = normalizeUqc(dto.unitOfMeasure);
      if (!isVendor && dto.supplyType !== undefined)
        productPatch.supplyType = dto.supplyType;
      if (dto.publishedAt !== undefined) {
        productPatch.publishedAt = dto.publishedAt
          ? new Date(dto.publishedAt)
          : null;
      }

      if (Object.keys(productPatch).length > 0) {
        await tx.product.update({ where: { id }, data: productPatch });
      }

      // Patch the default variant if singular variant fields provided. Goes
      // through the same builder as PATCH /variants/:id so every field the
      // DTO accepts is honoured — this block used to copy only price / sku /
      // compareAtPrice / inventoryQuantity and silently drop cost, barcode,
      // weight, HS code, country, the inventory toggles and requiresShipping
      // while still returning 200.
      if (dto.variant && product.variants[0]) {
        const variantPatch = this.buildVariantPatch(
          dto.variant,
          product.variants[0],
          vendorScope,
        );

        if (Object.keys(variantPatch).length > 0) {
          // Audited update — quantity changes always emit an InventoryEvent
          // (this path historically mutated stock silently).
          await this.inventoryLedger.auditedVariantUpdate(
            {
              orgId,
              variantId: product.variants[0].id,
              data: variantPatch,
              reason: 'adjustment',
              referenceType: 'manual',
              // Warehousing orgs: the quantity is one location's available, so
              // the ledger needs to know which. It refuses the edit without it.
              warehouseId: dto.variant.warehouseId,
            },
            tx,
          );
          if (dto.variant.inventoryQuantity !== undefined) {
            stockMovedVariantIds.push(product.variants[0].id);
          }
        }
      }

      return tx.product.findUnique({
        where: { id },
        include: {
          variants: { orderBy: { position: 'asc' } },
          images: { orderBy: { position: 'asc' } },
          channel: {
            select: { id: true, name: true, platform: true, currency: true },
          },
        },
      });
    });

    await this.markOutOfSyncIfNeeded(id);
    await this.shopifyPushEnqueuer.enqueueAvailabilityPush(
      orgId,
      stockMovedVariantIds,
    );
    return updated;
  }

  // ─── SOFT DELETE ───
  async softDelete(id: string, orgId: string) {
    const product = await this.prisma.product.findFirst({
      where: { id, organizationId: orgId, deletedAt: null },
      include: { channel: true },
    });
    if (!product) throw new NotFoundException('Product not found');
    this.assertCrmEditable(product.channel.platform);

    await this.prisma.product.update({
      where: { id },
      data: { deletedAt: new Date() },
    });

    return { id, deletedAt: new Date().toISOString() };
  }

  /**
   * Editability gate.
   *
   * Originally MANUAL-only. Loosened so the CRM can edit Shopify-synced
   * products too — local edits stamp the product OUT_OF_SYNC and the merchant
   * can push them back via the Sync button (handled in ShopifyPushService).
   *
   * Kept as a no-op (and still called from every editing method) so we can
   * re-tighten the rule in the future without re-threading every call site —
   * just put the throw back here.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected assertCrmEditable(_platform: ChannelPlatform) {
    // Intentionally empty.
  }

  // ═══════════════════════════════════════════════════════════════════════
  // VARIANT MANAGEMENT (multi-variant products)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Ownership gate for vendor-scoped edits. A VENDOR may only touch products
   * whose `vendor` column matches their scope. No-op for admins (vendorScope
   * undefined), so existing behavior is unchanged.
   */
  private assertVendorOwnsProduct(
    productVendor: string | null,
    vendorScope?: string,
  ) {
    if (vendorScope && productVendor !== vendorScope) {
      throw new ForbiddenException(
        'You can only edit your own products.',
      );
    }
  }

  /**
   * Resolve a variant scoped to the org and assert MANUAL editability. Returns
   * the loaded variant + parent product. Throws 404 / 403 as appropriate.
   */
  private async loadVariantForEdit(
    variantId: string,
    orgId: string,
    vendorScope?: string,
  ) {
    const variant = await this.prisma.productVariant.findFirst({
      where: {
        id: variantId,
        product: { organizationId: orgId, deletedAt: null },
      },
      include: { product: { include: { channel: true } } },
    });
    if (!variant) throw new NotFoundException('Variant not found');
    this.assertVendorOwnsProduct(variant.product.vendor, vendorScope);
    this.assertCrmEditable(variant.product.channel.platform);
    return variant;
  }

  /**
   * Resolve a product scoped to the org and assert MANUAL editability. Returns
   * the loaded product. Throws 404 / 403 as appropriate.
   */
  private async loadProductForEdit(
    productId: string,
    orgId: string,
    vendorScope?: string,
  ) {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, organizationId: orgId, deletedAt: null },
      include: { channel: true },
    });
    if (!product) throw new NotFoundException('Product not found');
    this.assertVendorOwnsProduct(product.vendor, vendorScope);
    this.assertCrmEditable(product.channel.platform);
    return product;
  }

  async createVariant(
    productId: string,
    orgId: string,
    dto: CreateVariantDto,
    vendorScope?: string,
  ) {
    const product = await this.loadProductForEdit(
      productId,
      orgId,
      vendorScope,
    );

    const last = await this.prisma.productVariant.findFirst({
      where: { productId },
      orderBy: { position: 'desc' },
      select: { position: true },
    });
    const nextPosition = (last?.position ?? 0) + 1;

    // Shopify parity: a new variant added without an explicit price inherits
    // the product's base price (the first variant by position) — the merchant
    // adjusts it afterwards. An explicit price (including 0) always wins.
    let price: number | Prisma.Decimal = dto.price ?? 0;
    if (dto.price === undefined) {
      const base = await this.prisma.productVariant.findFirst({
        where: { productId },
        orderBy: { position: 'asc' },
        select: { price: true },
      });
      if (base) price = base.price;
    }

    const optionLabels = [dto.option1, dto.option2, dto.option3].filter(
      Boolean,
    ) as string[];
    const title =
      optionLabels.length > 0
        ? optionLabels.join(' / ')
        : DEFAULT_VARIANT_TITLE;

    await this.assertVariantCodesFree(orgId, dto);

    const created = await this.prisma.$transaction(async (tx) => {
      const row = await tx.productVariant.create({
      data: {
        productId,
        organizationId: orgId,
        externalId: `manual_${randomUUID()}`,
        title,
        sku: dto.sku ?? null,
        barcode: dto.barcode ?? null,
        barcodeSource: dto.barcode ? 'MANUAL' : null,
        price,
        compareAtPrice: dto.compareAtPrice ?? null,
        cost: dto.cost ?? null,
        inventoryQuantity: dto.inventoryQuantity ?? 0,
        trackQuantity: dto.trackQuantity ?? true,
        continueSellingWhenOutOfStock:
          dto.continueSellingWhenOutOfStock ?? false,
        weight: dto.weight ?? null,
        weightUnit: dto.weightUnit ?? null,
        hsCode: dto.hsCode ?? null,
        countryOfOrigin: dto.countryOfOrigin ?? null,
        option1: dto.option1 ?? null,
        option2: dto.option2 ?? null,
        option3: dto.option3 ?? null,
        position: dto.position ?? nextPosition,
        imageId: dto.imageId ?? null,
        requiresShipping: dto.requiresShipping ?? true,
        // Vendors cannot set the tax flag — always defaults to taxable.
        taxable: vendorScope ? true : (dto.taxable ?? true),
        ...(vendorScope ? {} : this.variantGstOverride(dto)),
      },
      });
      // Ledger: initial stock when created with a non-zero quantity.
      await this.inventoryLedger.recordInitialQuantities(
        tx,
        orgId,
        [row],
        'initial',
        'variant',
        row.id,
      );
      // A variant added to an existing product needs its stock row for the
      // same reason a brand-new product's does.
      await this.inventoryLedger.ensureStockRows(tx, orgId, [row]);
      return row;
    });

    // Same reasoning as create(): a variant without a barcode cannot be
    // labelled on small stock, and the SKU is too long to stand in for one.
    // No-ops when the caller supplied a barcode (the generator only fills gaps).
    try {
      await this.skuGenerator.generateBarcodes(orgId, {
        variantIds: [created.id],
        format: 'short',
      });
    } catch (err) {
      this.logger.warn(
        `Barcode generation failed for new variant ${created.id}: ${(err as Error).message}`,
      );
    }

    await this.markOutOfSyncIfNeeded(product.id);
    return created;
  }

  /**
   * Build the Prisma patch for a variant update. Shared by updateVariant and
   * bulkUpdateVariants so vendor rules and title re-derivation stay identical.
   */
  private buildVariantPatch(
    dto: UpdateVariantDto,
    current: {
      option1: string | null;
      option2: string | null;
      option3: string | null;
    },
    vendorScope?: string,
  ): Prisma.ProductVariantUpdateInput {
    const patch: Prisma.ProductVariantUpdateInput = {};
    if (dto.price !== undefined) patch.price = dto.price;
    if (dto.sku !== undefined) patch.sku = dto.sku;
    if (dto.barcode !== undefined) {
      patch.barcode = dto.barcode;
      // A person editing the field takes ownership of it: the value stops being
      // ours to regenerate, and stops being suppressed from Shopify pushes.
      // Clearing the field clears the provenance with it.
      patch.barcodeSource = dto.barcode ? 'MANUAL' : null;
    }
    if (dto.compareAtPrice !== undefined)
      patch.compareAtPrice = dto.compareAtPrice;
    if (dto.cost !== undefined) patch.cost = dto.cost;
    if (dto.inventoryQuantity !== undefined)
      patch.inventoryQuantity = dto.inventoryQuantity;
    if (dto.trackQuantity !== undefined)
      patch.trackQuantity = dto.trackQuantity;
    if (dto.continueSellingWhenOutOfStock !== undefined)
      patch.continueSellingWhenOutOfStock =
        dto.continueSellingWhenOutOfStock;
    if (dto.requiresShipping !== undefined)
      patch.requiresShipping = dto.requiresShipping;
    if (dto.weight !== undefined) patch.weight = dto.weight;
    if (dto.weightUnit !== undefined) patch.weightUnit = dto.weightUnit;
    if (dto.hsCode !== undefined) patch.hsCode = dto.hsCode;
    if (dto.countryOfOrigin !== undefined)
      patch.countryOfOrigin = dto.countryOfOrigin;
    // Vendors cannot change the per-variant tax flag, nor the GST override.
    if (!vendorScope && dto.taxable !== undefined)
      patch.taxable = dto.taxable;
    if (!vendorScope) Object.assign(patch, this.variantGstOverride(dto));
    if (dto.option1 !== undefined) patch.option1 = dto.option1;
    if (dto.option2 !== undefined) patch.option2 = dto.option2;
    if (dto.option3 !== undefined) patch.option3 = dto.option3;
    if (dto.position !== undefined) patch.position = dto.position;

    // If any option changed, recompute the title.
    if (
      dto.option1 !== undefined ||
      dto.option2 !== undefined ||
      dto.option3 !== undefined
    ) {
      const merged = {
        option1:
          dto.option1 !== undefined ? dto.option1 : current.option1,
        option2:
          dto.option2 !== undefined ? dto.option2 : current.option2,
        option3:
          dto.option3 !== undefined ? dto.option3 : current.option3,
      };
      const labels = [
        merged.option1,
        merged.option2,
        merged.option3,
      ].filter(Boolean) as string[];
      patch.title =
        labels.length > 0 ? labels.join(' / ') : DEFAULT_VARIANT_TITLE;
    }
    return patch;
  }

  async updateVariant(
    variantId: string,
    orgId: string,
    dto: UpdateVariantDto,
    vendorScope?: string,
  ) {
    const variant = await this.loadVariantForEdit(
      variantId,
      orgId,
      vendorScope,
    );
    await this.assertVariantCodesFree(orgId, dto, variantId);

    // Audited update — quantity changes always emit an InventoryEvent (this
    // was THE historical ledger hole: stock edits via variant PATCH left no
    // audit trail).
    const updated = await this.inventoryLedger.auditedVariantUpdate({
      orgId,
      variantId,
      data: this.buildVariantPatch(dto, variant, vendorScope),
      reason: 'adjustment',
      referenceType: 'manual',
      warehouseId: dto.warehouseId,
    });

    await this.markOutOfSyncIfNeeded(variant.product.id);
    // A stock change has to reach Shopify: the pull treats Shopify as
    // authoritative, so an un-pushed local edit is reverted by the next sync.
    if (dto.inventoryQuantity !== undefined) {
      await this.shopifyPushEnqueuer.enqueueAvailabilityPush(orgId, [variantId]);
    }
    return updated;
  }

  /**
   * Patch many variants of ONE product in a single transaction. Powers the
   * grouped-variant editor's parent-row edits (e.g. set price for every
   * "black" variant at once). One OUT_OF_SYNC stamp for the whole batch.
   */
  async bulkUpdateVariants(
    productId: string,
    orgId: string,
    dto: BulkUpdateVariantsDto,
    vendorScope?: string,
  ) {
    const product = await this.loadProductForEdit(
      productId,
      orgId,
      vendorScope,
    );

    const own = await this.prisma.productVariant.findMany({
      where: { productId },
    });
    const byId = new Map(own.map((v) => [v.id, v]));
    const unknown = dto.updates.filter((u) => !byId.has(u.variantId));
    if (unknown.length > 0) {
      throw new BadRequestException(
        `Variants not on this product: ${unknown
          .map((u) => u.variantId)
          .join(', ')}`,
      );
    }

    for (const u of dto.updates) {
      await this.assertVariantCodesFree(orgId, u, u.variantId);
    }

    const variants = await this.prisma.$transaction(async (tx) => {
      const updated: ProductVariant[] = [];
      for (const u of dto.updates) {
        const before = byId.get(u.variantId)!;
        // Routed through auditedVariantUpdate rather than a direct update plus
        // recordQuantityChange, so this path inherits the warehouse guard: on a
        // warehousing org a quantity edit here used to write the derived cache
        // and be erased by the next movement, exactly as the single-variant
        // PATCH did.
        const row = await this.inventoryLedger.auditedVariantUpdate(
          {
            orgId,
            variantId: u.variantId,
            data: this.buildVariantPatch(u, before, vendorScope),
            reason: 'adjustment',
            referenceType: 'manual',
            warehouseId: u.warehouseId,
          },
          tx,
        );
        updated.push(row);
      }
      await this.markOutOfSyncIfNeeded(product.id, tx);
      return updated;
    });

    const movedStock = dto.updates
      .filter((u) => u.inventoryQuantity !== undefined)
      .map((u) => u.variantId);
    await this.shopifyPushEnqueuer.enqueueAvailabilityPush(orgId, movedStock);

    return { ok: true, updated: variants.length, variants };
  }

  async deleteVariant(
    variantId: string,
    orgId: string,
    vendorScope?: string,
  ) {
    const variant = await this.loadVariantForEdit(
      variantId,
      orgId,
      vendorScope,
    );

    const total = await this.prisma.productVariant.count({
      where: { productId: variant.productId },
    });

    // Shopify parity: "deleting" the last variant reverts the product to
    // the single-variant default state instead of erroring. Unlike Shopify
    // we KEEP the row (same id, price, sku, stock) — order line items
    // reference variant ids, and Shopify's wipe-to-zero reset is a known
    // data-loss gotcha we deliberately avoid.
    if (total <= 1) {
      const reset = await this.prisma.$transaction(async (tx) => {
        const updated = await tx.productVariant.update({
          where: { id: variantId },
          data: {
            option1: DEFAULT_VARIANT_TITLE,
            option2: null,
            option3: null,
            title: DEFAULT_VARIANT_TITLE,
            position: 1,
          },
        });
        await tx.product.update({
          where: { id: variant.productId },
          data: { options: Prisma.JsonNull },
        });
        await this.markOutOfSyncIfNeeded(variant.productId, tx);
        return updated;
      });
      return {
        id: variantId,
        deleted: false,
        resetToDefault: true,
        variant: reset,
      };
    }

    await this.prisma.$transaction(async (tx) => {
      // Warehousing: refuse deletion while any bucket is non-zero; remove
      // all-zero StockLevel rows so the RESTRICT FK doesn't block the delete.
      // No-op for legacy orgs (they have no stock rows).
      await this.inventoryLedger.releaseStockRowsForDelete(tx, variantId);
      await tx.productVariant.delete({ where: { id: variantId } });
    });
    await this.markOutOfSyncIfNeeded(variant.product.id);
    return { id: variantId, deleted: true };
  }

  async reorderVariants(
    productId: string,
    orgId: string,
    dto: ReorderVariantsDto,
  ) {
    const product = await this.loadProductForEdit(productId, orgId);

    const own = await this.prisma.productVariant.findMany({
      where: { productId },
      select: { id: true },
    });
    const ownIds = new Set(own.map((v) => v.id));
    const allBelong = dto.variantIds.every((id) => ownIds.has(id));
    if (!allBelong || dto.variantIds.length !== ownIds.size) {
      throw new BadRequestException(
        'variantIds must include every variant belonging to this product, exactly once.',
      );
    }

    await this.prisma.$transaction(
      dto.variantIds.map((variantId, idx) =>
        this.prisma.productVariant.update({
          where: { id: variantId },
          data: { position: idx + 1 },
        }),
      ),
    );

    await this.markOutOfSyncIfNeeded(product.id);
    return { ok: true };
  }

  async updateOptions(
    productId: string,
    orgId: string,
    options: ProductOptionDto[],
    vendorScope?: string,
  ) {
    await this.loadProductForEdit(productId, orgId, vendorScope);

    // Shopify parity: options can only be fully removed once a single
    // variant remains (Shopify likewise refuses to drop options while
    // combinations exist). With one survivor, clearing options resets it
    // to the default placeholder — the exact reverse of generate()'s
    // single→multi conversion.
    if (options.length === 0) {
      const variantCount = await this.prisma.productVariant.count({
        where: { productId },
      });
      if (variantCount > 1) {
        throw new BadRequestException(
          'Delete variants down to one before removing all options.',
        );
      }
      await this.prisma.$transaction(async (tx) => {
        await tx.product.update({
          where: { id: productId },
          data: { options: Prisma.JsonNull },
        });
        await tx.productVariant.updateMany({
          where: { productId },
          data: {
            option1: DEFAULT_VARIANT_TITLE,
            option2: null,
            option3: null,
            title: DEFAULT_VARIANT_TITLE,
            position: 1,
          },
        });
        await this.markOutOfSyncIfNeeded(productId, tx);
      });
      return { ok: true, options: [] };
    }

    const current = await this.prisma.product.findUnique({
      where: { id: productId },
      select: { options: true },
    });
    const oldNames = (
      Array.isArray(current?.options)
        ? (current.options as unknown as ProductOptionDto[])
        : []
    )
      .map((o) => o?.name)
      .filter(Boolean);

    // position is derived, not authoritative — normalize to array index.
    const normalized = options.map((o, i) => ({ ...o, position: i + 1 }));

    // For each NEW slot, which OLD slot held that option? (name-matched;
    // -1 = brand-new option → its slot starts empty on existing variants).
    // Rename+reorder in ONE call is ambiguous — the client must send them
    // as separate operations (Shopify's UI enforces the same).
    const slotMap = normalized.map((o) => oldNames.indexOf(o.name));
    const structureChanged =
      oldNames.length > 0 &&
      slotMap.some((oldIdx, newIdx) => oldIdx !== newIdx);

    await this.prisma.$transaction(async (tx) => {
      await tx.product.update({
        where: { id: productId },
        data: { options: normalized as unknown as Prisma.InputJsonValue },
      });

      // Reorder/removal: carry each variant's values to their option's new
      // slot so combinations stay intact (Shopify remaps the same way).
      if (structureChanged) {
        const variants = await tx.productVariant.findMany({
          where: { productId },
        });
        for (const v of variants) {
          const oldVals = [v.option1, v.option2, v.option3];
          const next = [0, 1, 2].map((i) =>
            slotMap[i] !== undefined && slotMap[i] !== -1
              ? oldVals[slotMap[i]]
              : null,
          );
          const labels = next.filter(Boolean) as string[];
          await tx.productVariant.update({
            where: { id: v.id },
            data: {
              option1: next[0],
              option2: next[1],
              option3: next[2],
              title:
                labels.length > 0
                  ? labels.join(' / ')
                  : DEFAULT_VARIANT_TITLE,
            },
          });
        }
      }

      await this.markOutOfSyncIfNeeded(productId, tx);
    });

    return { ok: true, options: normalized };
  }

  /**
   * Generate the cartesian product of the product's defined options into
   * variant rows. Skips combinations that already exist (matched by the
   * (option1, option2, option3) triple). Useful when the merchant adds a new
   * value to an existing option type.
   */
  async generateVariantsFromOptions(
    productId: string,
    orgId: string,
    vendorScope?: string,
  ) {
    await this.loadProductForEdit(productId, orgId, vendorScope);

    const full = await this.prisma.product.findUnique({
      where: { id: productId },
      include: { variants: true },
    });
    const options = (full?.options as ProductOptionDto[] | null) ?? [];
    if (!Array.isArray(options) || options.length === 0) {
      throw new BadRequestException(
        'Product has no options defined. Set options first via PATCH /products/:id/options.',
      );
    }

    const valuesAt = (i: number) => options[i]?.values ?? [null];
    const combos: Array<{
      option1: string | null;
      option2: string | null;
      option3: string | null;
    }> = [];
    for (const v1 of valuesAt(0))
      for (const v2 of valuesAt(1))
        for (const v3 of valuesAt(2))
          combos.push({
            option1: v1 as string | null,
            option2: v2 as string | null,
            option3: v3 as string | null,
          });

    const variants = full?.variants ?? [];

    // Pre-existing variants that lack a value for some option get the FIRST
    // value of each option they are missing — the single "Default Title"
    // placeholder becoming the first combination is the special case of this.
    // Shopify applies the same rule when an option is added
    // (productOptionsCreate, LEAVE_AS_IS), so the CRM row and its Shopify
    // variant keep describing the same combination and price / sku / stock
    // stay attached. Leaving the slot null instead produced a row Shopify
    // cannot represent PLUS a generated twin of what Shopify makes from the
    // original — the push then tried to create that twin and was refused.
    // Mutating the snapshot BEFORE building the dedupe set makes the set see
    // the converted keys, not the old ones.
    const slotKeys = ['option1', 'option2', 'option3'] as const;
    const converted: typeof variants = [];
    for (const v of variants) {
      const isPlaceholder = v.option1 === DEFAULT_VARIANT_TITLE;
      let changed = false;
      for (let i = 0; i < slotKeys.length; i++) {
        const current = isPlaceholder ? null : v[slotKeys[i]];
        const first = (options[i]?.values?.[0] as string | undefined) ?? null;
        const next = i < options.length ? (current ?? first) : null;
        if (next !== v[slotKeys[i]]) {
          v[slotKeys[i]] = next;
          changed = true;
        }
      }
      if (changed) converted.push(v);
    }

    const existing = new Set(
      variants.map(
        (v) =>
          `${v.option1 ?? ''}|${v.option2 ?? ''}|${v.option3 ?? ''}`,
      ),
    );
    const lastPos = variants.reduce(
      (m, v) => Math.max(m, v.position),
      0,
    );
    const fallbackPrice =
      (variants[0]?.price as unknown as Prisma.Decimal) ??
      new Prisma.Decimal(0);

    const toCreate = combos
      .filter(
        (c) =>
          !existing.has(
            `${c.option1 ?? ''}|${c.option2 ?? ''}|${c.option3 ?? ''}`,
          ),
      )
      .map((combo, idx) => {
        const labels = [
          combo.option1,
          combo.option2,
          combo.option3,
        ].filter(Boolean) as string[];
        return {
          productId,
          organizationId: orgId,
          externalId: `manual_${randomUUID()}`,
          title:
            labels.length > 0
              ? labels.join(' / ')
              : DEFAULT_VARIANT_TITLE,
          price: fallbackPrice,
          option1: combo.option1,
          option2: combo.option2,
          option3: combo.option3,
          position: lastPos + idx + 1,
          requiresShipping: true,
          taxable: true,
        };
      });

    if (converted.length > 0 || toCreate.length > 0) {
      await this.prisma.$transaction(async (tx) => {
        for (const v of converted) {
          const labels = [v.option1, v.option2, v.option3].filter(
            Boolean,
          ) as string[];
          await tx.productVariant.update({
            where: { id: v.id },
            data: {
              option1: v.option1,
              option2: v.option2,
              option3: v.option3,
              title:
                labels.length > 0
                  ? labels.join(' / ')
                  : DEFAULT_VARIANT_TITLE,
            },
          });
        }
        if (toCreate.length > 0) {
          await tx.productVariant.createMany({ data: toCreate });

          // `createMany` returns no rows, so re-read the product's variants
          // and seed across all of them. `ensureStockRows` skips duplicates,
          // making the wider sweep harmless — and it also repairs any earlier
          // variant that predates this seeding.
          const all = await tx.productVariant.findMany({
            where: { productId, organizationId: orgId },
            select: { id: true, inventoryQuantity: true, trackQuantity: true },
          });
          await this.inventoryLedger.ensureStockRows(tx, orgId, all);
        }
        await this.markOutOfSyncIfNeeded(productId, tx);
      });
    }

    return {
      ok: true,
      created: toCreate.length,
      converted: converted.length,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // IMAGE MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════════

  async addImage(
    productId: string,
    orgId: string,
    file: {
      buffer: Buffer;
      originalname: string;
      mimetype: string;
      size: number;
    },
  ) {
    const product = await this.loadProductForEdit(productId, orgId);

    if (!ALLOWED_IMAGE_MIME.has(file.mimetype)) {
      throw new BadRequestException(
        `Unsupported image type ${file.mimetype}. Allowed: JPEG, PNG, WebP, GIF.`,
      );
    }
    if (file.size > MAX_IMAGE_BYTES) {
      throw new BadRequestException('Image exceeds 5MB limit.');
    }

    const count = await this.prisma.productImage.count({
      where: { productId },
    });
    if (count >= MAX_IMAGES_PER_PRODUCT) {
      throw new BadRequestException(
        `Each product can have at most ${MAX_IMAGES_PER_PRODUCT} images.`,
      );
    }

    const stored = await this.imageStorage.upload({
      orgId,
      buffer: file.buffer,
      originalName: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
    });

    const lastPos = await this.prisma.productImage.aggregate({
      where: { productId },
      _max: { position: true },
    });

    const created = await this.prisma.productImage.create({
      data: {
        productId,
        externalId: `manual_${randomUUID()}`,
        src: stored.url,
        alt: null,
        position: (lastPos._max.position ?? 0) + 1,
      },
    });

    await this.markOutOfSyncIfNeeded(product.id);
    return created;
  }

  async updateImage(imageId: string, orgId: string, dto: UpdateImageDto) {
    const image = await this.loadImageForEdit(imageId, orgId);
    const updated = await this.prisma.productImage.update({
      where: { id: imageId },
      data: { ...(dto.alt !== undefined && { alt: dto.alt }) },
    });
    await this.markOutOfSyncIfNeeded(image.productId);
    return updated;
  }

  async removeImage(imageId: string, orgId: string) {
    const image = await this.loadImageForEdit(imageId, orgId);

    // Best-effort delete from storage; DB row removal is the source of truth.
    try {
      // Recover storageKey from the URL: /uploads/products/<orgId>/<filename>
      const idx = image.src.indexOf('/uploads/products/');
      if (idx >= 0) {
        const storageKey = image.src.substring(
          idx + '/uploads/products/'.length,
        );
        await this.imageStorage.delete(storageKey);
      }
    } catch (err) {
      this.logger.warn(
        `Failed to delete image file for ${imageId}: ${err}`,
      );
    }

    await this.prisma.productImage.delete({ where: { id: imageId } });
    await this.markOutOfSyncIfNeeded(image.productId);
    return { id: imageId, deleted: true };
  }

  async reorderImages(
    productId: string,
    orgId: string,
    dto: ReorderImagesDto,
  ) {
    const product = await this.loadProductForEdit(productId, orgId);

    const own = await this.prisma.productImage.findMany({
      where: { productId },
      select: { id: true },
    });
    const ownIds = new Set(own.map((i) => i.id));
    const allBelong = dto.imageIds.every((id) => ownIds.has(id));
    if (!allBelong || dto.imageIds.length !== ownIds.size) {
      throw new BadRequestException(
        'imageIds must include every image belonging to this product, exactly once.',
      );
    }

    await this.prisma.$transaction(
      dto.imageIds.map((imageId, idx) =>
        this.prisma.productImage.update({
          where: { id: imageId },
          data: { position: idx + 1 },
        }),
      ),
    );

    await this.markOutOfSyncIfNeeded(product.id);
    return { ok: true };
  }

  async setVariantImage(
    variantId: string,
    orgId: string,
    dto: SetVariantImageDto,
  ) {
    const variant = await this.loadVariantForEdit(variantId, orgId);

    if (dto.imageId !== null) {
      const image = await this.prisma.productImage.findUnique({
        where: { id: dto.imageId },
      });
      if (!image || image.productId !== variant.productId) {
        throw new BadRequestException(
          'imageId must reference an image attached to this product.',
        );
      }
    }

    await this.prisma.productVariant.update({
      where: { id: variantId },
      data: { imageId: dto.imageId },
    });

    await this.markOutOfSyncIfNeeded(variant.product.id);
    return { ok: true, imageId: dto.imageId };
  }

  private async loadImageForEdit(imageId: string, orgId: string) {
    const image = await this.prisma.productImage.findFirst({
      where: {
        id: imageId,
        product: { organizationId: orgId, deletedAt: null },
      },
      include: { product: { include: { channel: true } } },
    });
    if (!image) throw new NotFoundException('Image not found');
    this.assertCrmEditable(image.product.channel.platform);
    return image;
  }

  // ─── SYNC LIFECYCLE HELPER ─────────────────────────────────────────────
  // Stamp `metadata.shopifySync.status = 'OUT_OF_SYNC'` whenever a previously-
  // SYNCED product gets a local edit. UI surfaces this as an amber pill +
  // Sync button so the merchant can re-push when ready. We do NOT auto-enqueue
  // because that would surprise users who're mid-edit.

  /** Merge a shopifySync patch into an existing metadata blob. Pure — no DB. */
  private mergeShopifySync(
    metadata: Prisma.JsonValue | null,
    patch: ShopifySyncPatch,
  ): Prisma.InputJsonObject {
    const meta = (metadata as Prisma.JsonObject) ?? {};
    const current = (meta.shopifySync as Prisma.JsonObject) ?? {};
    return {
      ...meta,
      shopifySync: { ...current, ...patch },
    } as Prisma.InputJsonObject;
  }

  private async markOutOfSyncIfNeeded(
    productId: string,
    tx?: Prisma.TransactionClient,
  ) {
    const run = async (client: Prisma.TransactionClient) => {
      const row = await client.product.findUnique({
        where: { id: productId },
        select: { metadata: true },
      });
      const sync = (row?.metadata as Prisma.JsonObject)?.shopifySync as
        | { status?: ShopifySyncStatus }
        | undefined;
      if (sync?.status !== 'SYNCED') return;
      await client.product.update({
        where: { id: productId },
        data: {
          metadata: this.mergeShopifySync(row!.metadata, {
            status: 'OUT_OF_SYNC',
          }),
        },
      });
    };
    // Default isolation on purpose: this is a last-write-wins status stamp.
    // Serializable would abort one of two concurrent editors (P2034) with no
    // retry — a 500 for the user — while buying nothing for correctness.
    return tx ? run(tx) : this.prisma.$transaction(run);
  }

  /** Bulk restamp SYNCED → OUT_OF_SYNC. One read + one batched transaction. */
  private async markManyOutOfSync(ids: string[]) {
    if (ids.length === 0) return;
    const rows = await this.prisma.product.findMany({
      where: { id: { in: ids } },
      select: { id: true, metadata: true },
    });
    const updates = rows.flatMap((r) => {
      const sync = (r.metadata as Prisma.JsonObject)?.shopifySync as
        | { status?: ShopifySyncStatus }
        | undefined;
      if (sync?.status !== 'SYNCED') return [];
      return [
        this.prisma.product.update({
          where: { id: r.id },
          data: {
            metadata: this.mergeShopifySync(r.metadata, {
              status: 'OUT_OF_SYNC',
            }),
          },
        }),
      ];
    });
    if (updates.length > 0) await this.prisma.$transaction(updates);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PHASE 3 — BULK ACTIONS
  // Each method gates per-product on assertCrmEditable. Products that fail
  // (e.g. SHOPIFY platform) land in `skipped` rather than throwing, so the
  // batch as a whole succeeds and the UI can show "X done, Y skipped".
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Resolve a list of product ids scoped to the org. Both MANUAL and SHOPIFY
   * channel products are editable — the editability restriction was lifted so
   * merchants can manage their full catalog from the CRM. Only `not found`
   * lands in `skipped`.
   */
  private async resolveBulkTargets(
    orgId: string,
    ids: string[],
    vendorScope?: string,
  ) {
    const products = await this.prisma.product.findMany({
      where: {
        id: { in: ids },
        organizationId: orgId,
        deletedAt: null,
        ...(vendorScope ? { vendor: vendorScope } : {}),
      },
      include: { channel: { select: { platform: true } } },
    });
    const found = new Set(products.map((p) => p.id));
    const ok = products.map((p) => p.id);
    const skipped: Array<{ id: string; reason: string }> = [];
    for (const id of ids) {
      if (!found.has(id)) skipped.push({ id, reason: 'Not found' });
    }
    return { ok, skipped };
  }

  async bulkSetStatus(
    orgId: string,
    productIds: string[],
    status: ProductStatus,
  ) {
    const { ok, skipped } = await this.resolveBulkTargets(
      orgId,
      productIds,
    );
    if (ok.length > 0) {
      await this.prisma.product.updateMany({
        where: { id: { in: ok }, organizationId: orgId },
        data: { status },
      });
      await this.markManyOutOfSync(ok);
    }
    return { ok, skipped };
  }

  async bulkArchive(orgId: string, productIds: string[]) {
    const { ok, skipped } = await this.resolveBulkTargets(
      orgId,
      productIds,
    );
    if (ok.length > 0) {
      await this.prisma.product.updateMany({
        where: { id: { in: ok }, organizationId: orgId },
        data: { status: 'ARCHIVED' },
      });
      await this.markManyOutOfSync(ok);
    }
    return { ok, skipped };
  }

  /**
   * Hard-delete: removes the product row. Allowed only if every target is
   * already ARCHIVED — guards against accidental bulk-destruction of live
   * SKUs. Order line items keep their snapshot since `OrderLineItem.variantId`
   * is `onDelete: SetNull` in the schema, preserving order history.
   */
  async bulkDelete(orgId: string, productIds: string[]) {
    const { ok, skipped } = await this.resolveBulkTargets(
      orgId,
      productIds,
    );
    if (ok.length === 0) return { ok: [], skipped, deleted: 0 };

    const archivedOnly = await this.prisma.product.findMany({
      where: {
        id: { in: ok },
        organizationId: orgId,
        status: 'ARCHIVED',
      },
      select: { id: true },
    });
    const allowed = new Set(archivedOnly.map((p) => p.id));
    for (const id of ok) {
      if (!allowed.has(id)) {
        skipped.push({ id, reason: 'Must be archived first' });
      }
    }
    const toDelete = ok.filter((id) => allowed.has(id));
    if (toDelete.length === 0) return { ok: [], skipped, deleted: 0 };

    const result = await this.prisma.product.deleteMany({
      where: { id: { in: toDelete }, organizationId: orgId },
    });
    return { ok: toDelete, skipped, deleted: result.count };
  }

  async bulkAddTags(orgId: string, productIds: string[], tags: string[]) {
    const { ok, skipped } = await this.resolveBulkTargets(
      orgId,
      productIds,
    );
    if (ok.length === 0 || tags.length === 0) return { ok, skipped };

    const rows = await this.prisma.product.findMany({
      where: { id: { in: ok } },
      select: { id: true, tags: true, metadata: true },
    });

    const updates = rows.map((p) => {
      const data: Prisma.ProductUpdateInput = {
        tags: Array.from(new Set([...(p.tags ?? []), ...tags])),
      };
      const meta = (p.metadata as Prisma.JsonObject) ?? {};
      const sync = meta.shopifySync as
        | { status?: ShopifySyncStatus }
        | undefined;
      if (sync?.status === 'SYNCED') {
        data.metadata = {
          ...meta,
          shopifySync: { ...sync, status: 'OUT_OF_SYNC' },
        } as Prisma.InputJsonObject;
      }
      return this.prisma.product.update({ where: { id: p.id }, data });
    });

    await this.prisma.$transaction(updates);
    return { ok, skipped };
  }

  async bulkRemoveTags(orgId: string, productIds: string[], tags: string[]) {
    const { ok, skipped } = await this.resolveBulkTargets(
      orgId,
      productIds,
    );
    if (ok.length === 0 || tags.length === 0) return { ok, skipped };

    const removeSet = new Set(tags);
    const rows = await this.prisma.product.findMany({
      where: { id: { in: ok } },
      select: { id: true, tags: true, metadata: true },
    });

    const updates = rows.map((p) => {
      const data: Prisma.ProductUpdateInput = {
        tags: (p.tags ?? []).filter((t) => !removeSet.has(t)),
      };
      const meta = (p.metadata as Prisma.JsonObject) ?? {};
      const sync = meta.shopifySync as
        | { status?: ShopifySyncStatus }
        | undefined;
      if (sync?.status === 'SYNCED') {
        data.metadata = {
          ...meta,
          shopifySync: { ...sync, status: 'OUT_OF_SYNC' },
        } as Prisma.InputJsonObject;
      }
      return this.prisma.product.update({ where: { id: p.id }, data });
    });

    await this.prisma.$transaction(updates);
    return { ok, skipped };
  }

  /**
   * Enqueue a Shopify push for each MANUAL product. Each push is independent;
   * the worker handles failures and stamps metadata.shopifySync on individual
   * products. Returns the count of jobs queued.
   */
  async bulkSync(orgId: string, productIds: string[], vendorScope?: string) {
    const { ok, skipped } = await this.resolveBulkTargets(
      orgId,
      productIds,
      vendorScope,
    );
    if (ok.length === 0) return { ok: [], skipped, queued: 0 };

    const shopify = await this.prisma.channel.findUnique({
      where: {
        organizationId_platform: {
          organizationId: orgId,
          platform: ChannelPlatform.SHOPIFY,
        },
      },
    });
    if (!shopify || shopify.status !== ChannelStatus.CONNECTED) {
      throw new ForbiddenException(
        'No connected Shopify channel. Connect Shopify first, then sync.',
      );
    }

    const results = await Promise.allSettled(
      ok.map((id) =>
        this.shopifyPushEnqueuer.enqueueProductPush({
          type: 'product',
          productId: id,
          organizationId: orgId,
        }),
      ),
    );

    const queuedIds: string[] = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        queuedIds.push(ok[i]);
      } else {
        skipped.push({
          id: ok[i],
          reason: `Failed to enqueue: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`,
        });
      }
    });

    if (queuedIds.length > 0) {
      const rows = await this.prisma.product.findMany({
        where: { id: { in: queuedIds } },
        select: { id: true, metadata: true },
      });
      await this.prisma.$transaction(
        rows.map((p) =>
          this.prisma.product.update({
            where: { id: p.id },
            data: {
              metadata: this.mergeShopifySync(p.metadata, {
                status: 'PENDING',
                attempts: 0,
              }),
            },
          }),
        ),
      );
    }

    return { ok: queuedIds, skipped, queued: queuedIds.length };
  }
  // ═══════════════════════════════════════════════════════════════════════
  // PHASE 3 — DUPLICATE
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Deep-clone a product on the same org's MANUAL channel. Title becomes
   * "<original> (Copy)", status forced to DRAFT, sync metadata cleared so
   * the duplicate is treated as a brand-new local product. Variants and
   * images are cloned with fresh ids; image URLs are reused (we don't copy
   * the underlying file blobs).
   */
  async duplicate(productId: string, orgId: string) {
    const original = await this.prisma.product.findFirst({
      where: { id: productId, organizationId: orgId, deletedAt: null },
      include: {
        variants: { orderBy: { position: 'asc' } },
        images: { orderBy: { position: 'asc' } },
      },
    });
    if (!original) throw new NotFoundException('Product not found');

    // We allow duplicating SHOPIFY-channel products as a quick way to seed a
    // new MANUAL product from a synced one. The duplicate lives on MANUAL
    // and starts unsynced, so the read-only constraint isn't relevant.
    const manual = await this.prisma.channel.upsert({
      where: {
        organizationId_platform: {
          organizationId: orgId,
          platform: ChannelPlatform.MANUAL,
        },
      },
      create: {
        organizationId: orgId,
        platform: ChannelPlatform.MANUAL,
        name: 'In-Store / Manual',
        status: ChannelStatus.CONNECTED,
        isEnabled: true,
      },
      update: {},
    });

    const created = await this.prisma.product.create({
      data: {
        organizationId: orgId,
        channelId: manual.id,
        externalId: `manual_${randomUUID()}`,
        title: `${original.title} (Copy)`,
        bodyHtml: original.bodyHtml,
        vendor: original.vendor,
        productType: original.productType,
        status: 'DRAFT',
        tags: original.tags,
        hsnCode: original.hsnCode,
        gstRate: original.gstRate,
        unitOfMeasure: original.unitOfMeasure,
        supplyType: original.supplyType,
        options: (original.options ??
          Prisma.JsonNull) as Prisma.InputJsonValue,
        metadata: {
          source: 'crm',
          duplicatedFrom: original.id,
        } as Prisma.InputJsonObject,
        externalCreatedAt: new Date(),
        variants: {
          create: original.variants.map((v) => ({
            organizationId: orgId,
            externalId: `manual_${randomUUID()}`,
            title: v.title,
            sku: v.sku,
            // Never clone a barcode we minted — that guarantees a duplicate,
            // and with no DB unique constraint the scan resolver (findFirst)
            // would silently pick whichever row Postgres returned. The copy is
            // left without one and gets a fresh code below; a real GTIN or a
            // hand-entered code is deliberately carried over, because a
            // duplicated product legitimately shares the manufacturer's code.
            barcode: v.barcodeSource === 'GENERATED' ? null : v.barcode,
            barcodeSource: v.barcodeSource === 'GENERATED' ? null : v.barcodeSource,
            price: v.price,
            compareAtPrice: v.compareAtPrice,
            cost: v.cost,
            inventoryQuantity: v.inventoryQuantity,
            trackQuantity: v.trackQuantity,
            continueSellingWhenOutOfStock:
              v.continueSellingWhenOutOfStock,
            weight: v.weight,
            weightUnit: v.weightUnit,
            hsCode: v.hsCode,
            countryOfOrigin: v.countryOfOrigin,
            option1: v.option1,
            option2: v.option2,
            option3: v.option3,
            position: v.position,
            requiresShipping: v.requiresShipping,
            taxable: v.taxable,
            hsnCode: v.hsnCode,
            gstRate: v.gstRate,
            unitOfMeasure: v.unitOfMeasure,
            supplyType: v.supplyType,
          })),
        },
        images: {
          create: original.images.map((img) => ({
            externalId: `manual_${randomUUID()}`,
            src: img.src,
            alt: img.alt,
            position: img.position,
            width: img.width,
            height: img.height,
          })),
        },
      },
      include: {
        variants: { orderBy: { position: 'asc' } },
        images: { orderBy: { position: 'asc' } },
        channel: { select: { id: true, name: true, platform: true, currency: true } },
      },
    });
    // Ledger: duplicated variants carry the original's stock — record it as
    // their initial quantity so the ledger reconstructs to the right number.
    await this.inventoryLedger.recordInitialQuantities(
      this.prisma,
      orgId,
      created.variants,
      'initial',
      'product_duplicate',
      created.id,
    );

    // Replace the generated barcodes deliberately dropped above with fresh
    // ones, so the copy is labellable immediately instead of inheriting the
    // original's code.
    try {
      await this.skuGenerator.generateBarcodes(orgId, {
        variantIds: created.variants.map((v) => v.id),
        format: 'short',
      });
    } catch (err) {
      this.logger.warn(
        `Barcode generation failed for duplicated product ${created.id}: ${(err as Error).message}`,
      );
    }

    return created;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PHASE 3 — CSV EXPORT / IMPORT
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Build a Shopify-compatible CSV of all products matching the query.
   * Returns the raw CSV text — the controller streams it as text/csv.
   * Multi-variant rows share a Handle column per Shopify's import spec.
   */
  async exportCsv(orgId: string, query: QueryProductsDto): Promise<string> {
    const where: Prisma.ProductWhereInput = {
      organizationId: orgId,
      deletedAt: null,
    };
    if (query.status) where.status = query.status;
    if (query.vendor) where.vendor = query.vendor;
    if (query.productType) where.productType = query.productType;
    if (query.channelId) where.channelId = query.channelId;
    if (query.search) {
      where.OR = [
        { title: { contains: query.search, mode: 'insensitive' } },
        { vendor: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const products = await this.prisma.product.findMany({
      where,
      include: {
        variants: { orderBy: { position: 'asc' } },
        images: { orderBy: { position: 'asc' } },
      },
      orderBy: { createdAt: 'desc' },
      take: 10000, // Cap to avoid runaway exports.
    });

    return buildShopifyCsv(
      products.map((p) => ({
        title: p.title,
        bodyHtml: p.bodyHtml,
        vendor: p.vendor,
        productType: p.productType,
        tags: p.tags ?? [],
        status: p.status,
        publishedAt: p.publishedAt,
        options: Array.isArray(p.options)
          ? (
            p.options as Array<{ name: string; values: string[] }>
          ).filter((o) => o && typeof o === 'object')
          : [],
        variants: p.variants.map((v) => ({
          sku: v.sku,
          barcode: v.barcode,
          price: v.price.toString(),
          compareAtPrice: v.compareAtPrice?.toString() ?? null,
          cost: v.cost?.toString() ?? null,
          inventoryQuantity: v.inventoryQuantity,
          trackQuantity: v.trackQuantity,
          continueSellingWhenOutOfStock:
            v.continueSellingWhenOutOfStock,
          weight: v.weight?.toString() ?? null,
          weightUnit: v.weightUnit,
          requiresShipping: v.requiresShipping,
          taxable: v.taxable,
          option1: v.option1,
          option2: v.option2,
          option3: v.option3,
        })),
        images: p.images.map((img) => ({
          src: img.src,
          alt: img.alt,
          position: img.position,
        })),
      })),
    );
  }

  /**
   * Stage 1 of CSV import: parse the uploaded file, surface the first 10
   * rows as a preview, persist a ProductImportJob row in PREVIEW state.
   * The job can then be confirmed via `confirmImport()` to actually create
   * products, or abandoned (the row will eventually be cleaned up).
   */
  async startImportPreview(
    orgId: string,
    userId: string | undefined,
    file: { buffer: Buffer; originalname: string },
  ): Promise<ProductImportJobView> {
    const text = file.buffer.toString('utf-8');
    const rows = parseShopifyCsv(text);
    if (rows.length === 0) {
      throw new BadRequestException(
        'CSV is empty or malformed. Expecting a header row + at least one data row.',
      );
    }

    const job = await this.prisma.productImportJob.create({
      data: {
        organizationId: orgId,
        userId: userId ?? null,
        status: 'PREVIEW',
        filename: file.originalname,
        totalRows: rows.length,
        processedRows: 0,
        createdCount: 0,
        updatedCount: 0,
        errorCount: 0,
        previewRows: rows.slice(
          0,
          10,
        ) as unknown as Prisma.InputJsonValue,
      },
    });
    return this.toImportJobView(job);
  }

  /**
   * Stage 2 of CSV import: re-parse the original CSV (we kept it in
   * previewRows aren't enough for the full run, so the controller passes
   * the raw text again) and create products row-by-row. Errors per-row are
   * collected; the job's status flips to COMPLETED when done, FAILED on a
   * fatal error.
   *
   * NOTE: For Phase 3 we run inline (synchronous). For very large imports
   * a future improvement is to enqueue this onto BullMQ — the job table
   * is already designed to support polling progress.
   */
  async confirmImport(
    orgId: string,
    userId: string | undefined,
    jobId: string,
    rawCsv: string,
  ): Promise<ProductImportJobView> {
    const job = await this.prisma.productImportJob.findFirst({
      where: { id: jobId, organizationId: orgId },
    });
    if (!job) throw new NotFoundException('Import job not found');
    if (job.status !== 'PREVIEW') {
      throw new BadRequestException(
        `Cannot confirm a job in status ${job.status}.`,
      );
    }

    await this.prisma.productImportJob.update({
      where: { id: jobId },
      data: { status: 'RUNNING' },
    });

    const rows = parseShopifyCsv(rawCsv);
    const { products, errors } = groupRowsIntoProducts(rows);

    const errorList: ProductImportError[] = [...errors];
    let createdCount = 0;
    let processed = 0;

    // Lazy MANUAL channel
    const manual = await this.prisma.channel.upsert({
      where: {
        organizationId_platform: {
          organizationId: orgId,
          platform: ChannelPlatform.MANUAL,
        },
      },
      create: {
        organizationId: orgId,
        platform: ChannelPlatform.MANUAL,
        name: 'In-Store / Manual',
        status: ChannelStatus.CONNECTED,
        isEnabled: true,
      },
      update: {},
    });

    for (const candidate of products) {
      try {
        await this.createFromCsvCandidate(orgId, manual.id, candidate);
        createdCount++;
      } catch (err) {
        errorList.push({
          row: 0,
          handle: candidate.handle,
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        processed++;
      }
    }

    const updated = await this.prisma.productImportJob.update({
      where: { id: jobId },
      data: {
        status:
          errorList.length > 0 && createdCount === 0
            ? 'FAILED'
            : 'COMPLETED',
        processedRows: processed,
        createdCount,
        errorCount: errorList.length,
        errors: errorList as unknown as Prisma.InputJsonValue,
        completedAt: new Date(),
      },
    });
    return this.toImportJobView(updated);
  }

  async getImportJob(
    orgId: string,
    jobId: string,
  ): Promise<ProductImportJobView> {
    const job = await this.prisma.productImportJob.findFirst({
      where: { id: jobId, organizationId: orgId },
    });
    if (!job) throw new NotFoundException('Import job not found');
    return this.toImportJobView(job);
  }

  /**
   * Build a single Product + variants + images from a CSV-parsed candidate.
   * Mirrors `create()`'s shape but bypasses the DTO validation since the
   * CSV parser already normalized everything.
   */
  private async createFromCsvCandidate(
    orgId: string,
    manualChannelId: string,
    candidate: ParsedProductCandidate,
  ) {
    const created = await this.prisma.product.create({
      data: {
        organizationId: orgId,
        channelId: manualChannelId,
        externalId: `manual_${randomUUID()}`,
        title: candidate.title,
        bodyHtml: candidate.bodyHtml ?? null,
        vendor: candidate.vendor ?? null,
        productType: candidate.productType ?? null,
        status: candidate.status,
        tags: candidate.tags,
        options:
          candidate.options.length > 0
            ? (candidate.options as unknown as Prisma.InputJsonValue)
            : Prisma.JsonNull,
        metadata: { source: 'csv-import' } as Prisma.InputJsonObject,
        externalCreatedAt: new Date(),
        variants: {
          create: candidate.variants.map((v, idx) => {
            const labels = [v.option1, v.option2, v.option3].filter(
              Boolean,
            ) as string[];
            return {
              organizationId: orgId,
              externalId: `manual_${randomUUID()}`,
              title:
                labels.length > 0
                  ? labels.join(' / ')
                  : DEFAULT_VARIANT_TITLE,
              sku: v.sku ?? null,
              barcode: v.barcode ?? null,
              price: v.price,
              compareAtPrice: v.compareAtPrice ?? null,
              cost: v.cost ?? null,
              inventoryQuantity: v.inventoryQuantity,
              trackQuantity: v.trackQuantity,
              continueSellingWhenOutOfStock:
                v.continueSellingWhenOutOfStock,
              weight: v.weight ?? null,
              weightUnit: v.weightUnit ?? null,
              option1: v.option1 ?? null,
              option2: v.option2 ?? null,
              option3: v.option3 ?? null,
              position: idx + 1,
              requiresShipping: v.requiresShipping,
              taxable: v.taxable,
            };
          }),
        },
        images: {
          create: candidate.images.map((img) => ({
            externalId: `manual_${randomUUID()}`,
            src: img.src,
            alt: img.alt ?? null,
            position: img.position,
          })),
        },
      },
      include: { variants: true },
    });
    // Ledger: imported variants with a non-zero quantity get an initial event.
    await this.inventoryLedger.recordInitialQuantities(
      this.prisma,
      orgId,
      created.variants,
      'initial',
      'csv_import',
      created.id,
    );
    return created;
  }

  /** Marshal a Prisma ProductImportJob row into the API view shape. */
  private toImportJobView(job: {
    id: string;
    status: string;
    filename: string;
    totalRows: number;
    processedRows: number;
    createdCount: number;
    updatedCount: number;
    errorCount: number;
    errors: Prisma.JsonValue;
    previewRows: Prisma.JsonValue;
    createdAt: Date;
    completedAt: Date | null;
  }): ProductImportJobView {
    return {
      id: job.id,
      status: job.status as ProductImportJobView['status'],
      filename: job.filename,
      totalRows: job.totalRows,
      processedRows: job.processedRows,
      createdCount: job.createdCount,
      updatedCount: job.updatedCount,
      errorCount: job.errorCount,
      errors: Array.isArray(job.errors)
        ? (job.errors as unknown as ProductImportError[])
        : [],
      previewRows: Array.isArray(job.previewRows)
        ? (job.previewRows as unknown as Record<string, string>[])
        : [],
      createdAt: job.createdAt.toISOString(),
      completedAt: job.completedAt?.toISOString() ?? null,
    };
  }
}
