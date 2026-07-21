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
  Prisma,
  ProductStatus,
} from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { QueryProductsDto } from './dto/query-products.dto';
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
import { ProductOptionDto } from './dto/option.dto';
import { ShopifyPushEnqueuer } from '../channel/shopify-push.enqueuer';
import { OrganizationSettingsService } from '../organization-settings/organization-settings.service';
import { type IImageStorage, IMAGE_STORAGE } from './image-storage/image-storage.interface';
import {
  buildShopifyCsv,
  groupRowsIntoProducts,
  parseShopifyCsv,
  type ParsedProductCandidate,
} from './csv/shopify-csv.format';
import type { ProductImportError, ProductImportJobView } from './dto/import.dto';

const ALLOWED_IMAGE_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB
const MAX_IMAGES_PER_PRODUCT = 10;

type ShopifySyncStatus = 'PENDING' | 'SYNCED' | 'FAILED' | 'OUT_OF_SYNC';

@Injectable()
export class ProductService {
  private readonly logger = new Logger(ProductService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly shopifyPushEnqueuer: ShopifyPushEnqueuer,
    private readonly settings: OrganizationSettingsService,
    @Inject(IMAGE_STORAGE) private readonly imageStorage: IImageStorage,
  ) {}

  async findAll(orgId: string, query: QueryProductsDto, vendorScope?: string) {
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
        { variants: { some: { sku: { contains: query.search, mode: 'insensitive' } } } },
      ];
    }

    // Stock status filter — filter products by their variants' inventory
    if (query.stockStatus === 'out_of_stock') {
      where.variants = { every: { inventoryQuantity: { lte: 0 } } };
    } else if (query.stockStatus === 'low_stock') {
      // Low stock = any variant has stock > 0 but <= org threshold (default 10)
      const org = await this.prisma.organization.findUnique({ where: { id: orgId }, select: { lowStockThreshold: true } });
      const threshold = org?.lowStockThreshold ?? 10;
      where.variants = { some: { inventoryQuantity: { gt: 0, lte: threshold } } };
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
            select: { id: true, src: true, alt: true, position: true },
            orderBy: { position: 'asc' },
            take: 1,  // Only first image for list view
          },
          channel: { select: { id: true, name: true, platform: true } },
        },
        orderBy: { [query.sortBy ?? 'createdAt']: query.sortOrder ?? 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.product.count({ where }),
    ]);

    return {
      data: data.map((product) => {
        // Calculate total stock across all variants
        const totalStock = product.variants.reduce((sum, v) => sum + v.inventoryQuantity, 0);

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
          variantCount: product.variants.length,
          priceRange: this.getPriceRange(product.variants),
          image: product.images[0] || null,
          channel: product.channel,
          createdAt: product.externalCreatedAt || product.createdAt,
          variants: product.variants,
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
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
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
      where: { id, organizationId: orgId, deletedAt: null, ...(vendorScope ? { vendor: vendorScope } : {}) },
      include: {
        variants: { orderBy: { position: 'asc' } },
        images: { orderBy: { position: 'asc' } },
        channel: { select: { id: true, name: true, platform: true } },
      },
    });
    if (!product) throw new NotFoundException('Product not found');

    const totalStock = product.variants.reduce((sum, v) => sum + v.inventoryQuantity, 0);

    return {
      ...product,
      totalStock,
      priceRange: this.getPriceRange(product.variants),
    };
  }

  // Distinct vendor match keys for the invite dropdown / filter. The match key is
  // the vendor metafield value (Product.vendorKey) when present, else the built-in
  // Product.vendor name. A VENDOR only ever sees their own key.
  async getVendors(orgId: string, vendorScope?: string) {
    if (vendorScope) return [vendorScope];
    const products = await this.prisma.product.findMany({
      where: { organizationId: orgId, deletedAt: null },
      select: { vendor: true, vendorKey: true },
    });
    const keys = new Set<string>();
    for (const p of products) {
      const key = p.vendorKey ?? p.vendor;
      if (key) keys.add(key);
    }
    return Array.from(keys).sort();
  }

  // Get unique product types for filter dropdown
  async getProductTypes(orgId: string) {
    const types = await this.prisma.product.findMany({
      where: { organizationId: orgId, deletedAt: null, productType: { not: null } },
      select: { productType: true },
      distinct: ['productType'],
      orderBy: { productType: 'asc' },
    });
    return types.map((t) => t.productType).filter(Boolean);
  }

  async getStats(orgId: string, channelId?: string) {
    const baseWhere: Prisma.ProductWhereInput = {
      organizationId: orgId,
      deletedAt: null,
      ...(channelId && { channelId }),
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
      this.prisma.product.count({ where: { ...baseWhere, status: 'ACTIVE' } }),
      this.prisma.product.count({ where: { ...baseWhere, status: 'DRAFT' } }),
      this.prisma.product.count({ where: { ...baseWhere, status: 'ARCHIVED' } }),
      this.prisma.product.count({
        where: {
          ...baseWhere,
          status: 'ACTIVE',
          variants: { every: { inventoryQuantity: { lte: 0 } } },
        },
      }),
      this.prisma.product.count({
        where: {
          ...baseWhere,
          status: 'ACTIVE',
          variants: { some: { inventoryQuantity: { gt: 0, lte: threshold } } },
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

  // ─── UPDATE GST FIELDS ───
  async updateGst(id: string, orgId: string, dto: { hsnCode?: string; gstRate?: number }) {
    const product = await this.prisma.product.findFirst({
      where: { id, organizationId: orgId, deletedAt: null },
    });

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    return this.prisma.product.update({
      where: { id },
      data: {
        ...(dto.hsnCode !== undefined && { hsnCode: dto.hsnCode }),
        ...(dto.gstRate !== undefined && { gstRate: dto.gstRate }),
      },
      include: {
        variants: true,
        images: { orderBy: { position: 'asc' }, take: 1 },
      },
    });
  }

  private getPriceRange(variants: Array<{ price: any }>) {
    if (variants.length === 0) return { min: '0', max: '0' };
    const prices = variants.map((v) => parseFloat(String(v.price)));
    return { min: Math.min(...prices).toFixed(2), max: Math.max(...prices).toFixed(2) };
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
      const variantsCreate = hasMulti
        ? dto.variants!.map((v, idx) => this.buildVariantCreate(v, idx + 1, dto.options))
        : [this.buildVariantCreate(dto.variant!, 1, undefined)];

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
          options: hasMulti ? (dto.options as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
          metadata: { source: 'crm' } as Prisma.InputJsonObject,
          externalCreatedAt: new Date(),
          ...(dto.publishedAt && { publishedAt: new Date(dto.publishedAt) }),
          variants: { create: variantsCreate },
        },
        include: {
          variants: { orderBy: { position: 'asc' } },
          images: true,
          channel: { select: { id: true, name: true, platform: true } },
        },
      });

      return created;
    });

    // Auto-push to Shopify (gated on org settings).
    let shopifyPushQueued = false;
    try {
      const productSettings = await this.settings.getProductSettings(orgId);
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
              metadata: {
                ...((product.metadata as Prisma.JsonObject) ?? {}),
                shopifySync: { status: 'PENDING', attempts: 0 },
              } as Prisma.InputJsonObject,
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
    v: CreateVariantDto,
    position: number,
    options: ProductOptionDto[] | undefined,
  ): Prisma.ProductVariantCreateWithoutProductInput {
    const optionLabels = [v.option1, v.option2, v.option3].filter(Boolean) as string[];
    const isMulti = !!options && options.length > 0;
    const title = isMulti && optionLabels.length > 0 ? optionLabels.join(' / ') : 'Default Title';
    return {
      externalId: `manual_${randomUUID()}`,
      title,
      sku: v.sku ?? null,
      barcode: v.barcode ?? null,
      price: v.price,
      compareAtPrice: v.compareAtPrice ?? null,
      cost: v.cost ?? null,
      inventoryQuantity: v.inventoryQuantity ?? 0,
      trackQuantity: v.trackQuantity ?? true,
      continueSellingWhenOutOfStock: v.continueSellingWhenOutOfStock ?? false,
      weight: v.weight ?? null,
      weightUnit: v.weightUnit ?? null,
      hsCode: v.hsCode ?? null,
      countryOfOrigin: v.countryOfOrigin ?? null,
      option1: isMulti ? (v.option1 ?? null) : 'Default Title',
      option2: isMulti ? (v.option2 ?? null) : null,
      option3: isMulti ? (v.option3 ?? null) : null,
      position: v.position ?? position,
      requiresShipping: v.requiresShipping ?? true,
      taxable: v.taxable ?? true,
    };
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
    const sync = (meta.shopifySync ?? null) as
      | { status: ShopifySyncStatus }
      | null;

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
        metadata: {
          ...meta,
          shopifySync: { status: 'PENDING', attempts: 0 },
        } as Prisma.InputJsonObject,
      },
    });
    return { status: 'QUEUED' as const, productId: product.id };
  }

  // ─── UPDATE PRODUCT (top-level fields + optional default-variant fields) ───
  async update(id: string, orgId: string, dto: UpdateProductDto, vendorScope?: string) {
    const product = await this.prisma.product.findFirst({
      where: { id, organizationId: orgId, deletedAt: null },
      include: { channel: true, variants: { orderBy: { position: 'asc' }, take: 1 } },
    });
    if (!product) throw new NotFoundException('Product not found');
    this.assertVendorOwnsProduct(product.vendor, vendorScope);
    this.assertCrmEditable(product.channel.platform);

    // Vendors may not change the vendor assignment or tax fields — ignore them
    // even if present in the payload (backend guarantee; UI shows read-only).
    const isVendor = !!vendorScope;

    const updated = await this.prisma.$transaction(async (tx) => {
      const productPatch: Prisma.ProductUpdateInput = {};
      if (dto.title !== undefined) productPatch.title = dto.title;
      if (!isVendor && dto.vendor !== undefined) productPatch.vendor = dto.vendor;
      if (dto.productType !== undefined) productPatch.productType = dto.productType;
      if (dto.status !== undefined) productPatch.status = dto.status;
      if (dto.tags !== undefined) productPatch.tags = dto.tags;
      if (dto.bodyHtml !== undefined) productPatch.bodyHtml = dto.bodyHtml;
      if (!isVendor && dto.hsnCode !== undefined) productPatch.hsnCode = dto.hsnCode;
      if (!isVendor && dto.gstRate !== undefined) productPatch.gstRate = dto.gstRate;
      if (dto.publishedAt !== undefined) {
        productPatch.publishedAt = dto.publishedAt ? new Date(dto.publishedAt) : null;
      }

      if (Object.keys(productPatch).length > 0) {
        await tx.product.update({ where: { id }, data: productPatch });
      }

      // Patch the default variant if singular variant fields provided.
      if (dto.variant && product.variants[0]) {
        const variantPatch: Prisma.ProductVariantUpdateInput = {};
        if (dto.variant.price !== undefined) variantPatch.price = dto.variant.price;
        if (dto.variant.sku !== undefined) variantPatch.sku = dto.variant.sku;
        if (dto.variant.compareAtPrice !== undefined) variantPatch.compareAtPrice = dto.variant.compareAtPrice;
        if (dto.variant.inventoryQuantity !== undefined) variantPatch.inventoryQuantity = dto.variant.inventoryQuantity;

        if (Object.keys(variantPatch).length > 0) {
          await tx.productVariant.update({
            where: { id: product.variants[0].id },
            data: variantPatch,
          });
        }
      }

      return tx.product.findUnique({
        where: { id },
        include: {
          variants: { orderBy: { position: 'asc' } },
          images: { orderBy: { position: 'asc' } },
          channel: { select: { id: true, name: true, platform: true } },
        },
      });
    });

    await this.markOutOfSyncIfNeeded(id);
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
  private assertVendorOwnsProduct(productVendor: string | null, vendorScope?: string) {
    if (vendorScope && productVendor !== vendorScope) {
      throw new ForbiddenException('You can only edit your own products.');
    }
  }

  /**
   * Resolve a variant scoped to the org and assert MANUAL editability. Returns
   * the loaded variant + parent product. Throws 404 / 403 as appropriate.
   */
  private async loadVariantForEdit(variantId: string, orgId: string, vendorScope?: string) {
    const variant = await this.prisma.productVariant.findFirst({
      where: { id: variantId, product: { organizationId: orgId, deletedAt: null } },
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
  private async loadProductForEdit(productId: string, orgId: string, vendorScope?: string) {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, organizationId: orgId, deletedAt: null },
      include: { channel: true },
    });
    if (!product) throw new NotFoundException('Product not found');
    this.assertVendorOwnsProduct(product.vendor, vendorScope);
    this.assertCrmEditable(product.channel.platform);
    return product;
  }

  async createVariant(productId: string, orgId: string, dto: CreateVariantDto, vendorScope?: string) {
    const product = await this.loadProductForEdit(productId, orgId, vendorScope);

    const last = await this.prisma.productVariant.findFirst({
      where: { productId },
      orderBy: { position: 'desc' },
      select: { position: true },
    });
    const nextPosition = (last?.position ?? 0) + 1;

    const optionLabels = [dto.option1, dto.option2, dto.option3].filter(Boolean) as string[];
    const title = optionLabels.length > 0 ? optionLabels.join(' / ') : 'Default Title';

    const created = await this.prisma.productVariant.create({
      data: {
        productId,
        externalId: `manual_${randomUUID()}`,
        title,
        sku: dto.sku ?? null,
        barcode: dto.barcode ?? null,
        price: dto.price,
        compareAtPrice: dto.compareAtPrice ?? null,
        cost: dto.cost ?? null,
        inventoryQuantity: dto.inventoryQuantity ?? 0,
        trackQuantity: dto.trackQuantity ?? true,
        continueSellingWhenOutOfStock: dto.continueSellingWhenOutOfStock ?? false,
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
      },
    });

    await this.markOutOfSyncIfNeeded(product.id);
    return created;
  }

  async updateVariant(variantId: string, orgId: string, dto: UpdateVariantDto, vendorScope?: string) {
    const variant = await this.loadVariantForEdit(variantId, orgId, vendorScope);

    const patch: Prisma.ProductVariantUpdateInput = {};
    if (dto.price !== undefined) patch.price = dto.price;
    if (dto.sku !== undefined) patch.sku = dto.sku;
    if (dto.barcode !== undefined) patch.barcode = dto.barcode;
    if (dto.compareAtPrice !== undefined) patch.compareAtPrice = dto.compareAtPrice;
    if (dto.cost !== undefined) patch.cost = dto.cost;
    if (dto.inventoryQuantity !== undefined) patch.inventoryQuantity = dto.inventoryQuantity;
    if (dto.trackQuantity !== undefined) patch.trackQuantity = dto.trackQuantity;
    if (dto.continueSellingWhenOutOfStock !== undefined)
      patch.continueSellingWhenOutOfStock = dto.continueSellingWhenOutOfStock;
    if (dto.requiresShipping !== undefined) patch.requiresShipping = dto.requiresShipping;
    if (dto.weight !== undefined) patch.weight = dto.weight;
    if (dto.weightUnit !== undefined) patch.weightUnit = dto.weightUnit;
    if (dto.hsCode !== undefined) patch.hsCode = dto.hsCode;
    if (dto.countryOfOrigin !== undefined) patch.countryOfOrigin = dto.countryOfOrigin;
    // Vendors cannot change the per-variant tax flag.
    if (!vendorScope && dto.taxable !== undefined) patch.taxable = dto.taxable;
    if (dto.option1 !== undefined) patch.option1 = dto.option1;
    if (dto.option2 !== undefined) patch.option2 = dto.option2;
    if (dto.option3 !== undefined) patch.option3 = dto.option3;
    if (dto.position !== undefined) patch.position = dto.position;

    // If any option changed, recompute the title.
    if (dto.option1 !== undefined || dto.option2 !== undefined || dto.option3 !== undefined) {
      const merged = {
        option1: dto.option1 !== undefined ? dto.option1 : variant.option1,
        option2: dto.option2 !== undefined ? dto.option2 : variant.option2,
        option3: dto.option3 !== undefined ? dto.option3 : variant.option3,
      };
      const labels = [merged.option1, merged.option2, merged.option3].filter(Boolean) as string[];
      patch.title = labels.length > 0 ? labels.join(' / ') : 'Default Title';
    }

    const updated = await this.prisma.productVariant.update({
      where: { id: variantId },
      data: patch,
    });

    await this.markOutOfSyncIfNeeded(variant.product.id);
    return updated;
  }

  async deleteVariant(variantId: string, orgId: string, vendorScope?: string) {
    const variant = await this.loadVariantForEdit(variantId, orgId, vendorScope);

    const total = await this.prisma.productVariant.count({
      where: { productId: variant.productId },
    });
    if (total <= 1) {
      throw new BadRequestException(
        'Cannot delete the last variant. Delete or archive the product instead.',
      );
    }

    await this.prisma.productVariant.delete({ where: { id: variantId } });
    await this.markOutOfSyncIfNeeded(variant.product.id);
    return { id: variantId, deleted: true };
  }

  async reorderVariants(productId: string, orgId: string, dto: ReorderVariantsDto) {
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

  async updateOptions(productId: string, orgId: string, options: ProductOptionDto[], vendorScope?: string) {
    const product = await this.loadProductForEdit(productId, orgId, vendorScope);

    await this.prisma.product.update({
      where: { id: productId },
      data: {
        options: options as unknown as Prisma.InputJsonValue,
      },
    });

    await this.markOutOfSyncIfNeeded(product.id);
    return { ok: true, options };
  }

  /**
   * Generate the cartesian product of the product's defined options into
   * variant rows. Skips combinations that already exist (matched by the
   * (option1, option2, option3) triple). Useful when the merchant adds a new
   * value to an existing option type.
   */
  async generateVariantsFromOptions(productId: string, orgId: string, vendorScope?: string) {
    const product = await this.loadProductForEdit(productId, orgId, vendorScope);

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

    // Cartesian product across up to 3 option types.
    const combos: Array<{ option1: string | null; option2: string | null; option3: string | null }> = [];
    const valuesAt = (i: number) => options[i]?.values ?? [null];
    for (const v1 of valuesAt(0)) {
      for (const v2 of valuesAt(1)) {
        for (const v3 of valuesAt(2)) {
          combos.push({
            option1: v1 as string | null,
            option2: v2 as string | null,
            option3: v3 as string | null,
          });
        }
      }
    }

    const existing = new Set(
      (full?.variants ?? []).map((v) => `${v.option1 ?? ''}|${v.option2 ?? ''}|${v.option3 ?? ''}`),
    );

    const lastPos = (full?.variants ?? []).reduce((m, v) => Math.max(m, v.position), 0);
    const fallbackPrice = (full?.variants?.[0]?.price as unknown as Prisma.Decimal) ?? new Prisma.Decimal(0);
    let createdCount = 0;

    for (const combo of combos) {
      const key = `${combo.option1 ?? ''}|${combo.option2 ?? ''}|${combo.option3 ?? ''}`;
      if (existing.has(key)) continue;

      const labels = [combo.option1, combo.option2, combo.option3].filter(Boolean) as string[];
      await this.prisma.productVariant.create({
        data: {
          productId,
          externalId: `manual_${randomUUID()}`,
          title: labels.length > 0 ? labels.join(' / ') : 'Default Title',
          price: fallbackPrice,
          option1: combo.option1,
          option2: combo.option2,
          option3: combo.option3,
          position: lastPos + ++createdCount,
          requiresShipping: true,
          taxable: true,
        },
      });
    }

    await this.markOutOfSyncIfNeeded(product.id);
    return { ok: true, created: createdCount };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // IMAGE MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════════

  async addImage(
    productId: string,
    orgId: string,
    file: { buffer: Buffer; originalname: string; mimetype: string; size: number },
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

    const count = await this.prisma.productImage.count({ where: { productId } });
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
        const storageKey = image.src.substring(idx + '/uploads/products/'.length);
        await this.imageStorage.delete(storageKey);
      }
    } catch (err) {
      this.logger.warn(`Failed to delete image file for ${imageId}: ${err}`);
    }

    await this.prisma.productImage.delete({ where: { id: imageId } });
    await this.markOutOfSyncIfNeeded(image.productId);
    return { id: imageId, deleted: true };
  }

  async reorderImages(productId: string, orgId: string, dto: ReorderImagesDto) {
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

  async setVariantImage(variantId: string, orgId: string, dto: SetVariantImageDto) {
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
      where: { id: imageId, product: { organizationId: orgId, deletedAt: null } },
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
  private async markOutOfSyncIfNeeded(productId: string) {
    const p = await this.prisma.product.findUnique({
      where: { id: productId },
      select: { metadata: true },
    });
    const meta = (p?.metadata as Prisma.JsonObject) ?? {};
    const sync = meta.shopifySync as
      | { status: ShopifySyncStatus; shopifyProductId?: string; attempts?: number }
      | undefined;
    if (sync?.status === 'SYNCED') {
      await this.prisma.product.update({
        where: { id: productId },
        data: {
          metadata: {
            ...meta,
            shopifySync: {
              ...sync,
              status: 'OUT_OF_SYNC',
            },
          } as Prisma.InputJsonObject,
        },
      });
    }
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
  private async resolveBulkTargets(orgId: string, ids: string[], vendorScope?: string) {
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

  async bulkSetStatus(orgId: string, productIds: string[], status: ProductStatus) {
    const { ok, skipped } = await this.resolveBulkTargets(orgId, productIds);
    if (ok.length > 0) {
      await this.prisma.product.updateMany({
        where: { id: { in: ok }, organizationId: orgId },
        data: { status },
      });
      // Restamp OUT_OF_SYNC for any that were already SYNCED. updateMany
      // can't read+conditionally-write, so we do this via individual passes
      // — the set is bounded by MAX_BULK = 250.
      for (const id of ok) await this.markOutOfSyncIfNeeded(id);
    }
    return { ok, skipped };
  }

  async bulkArchive(orgId: string, productIds: string[]) {
    const { ok, skipped } = await this.resolveBulkTargets(orgId, productIds);
    if (ok.length > 0) {
      const now = new Date();
      await this.prisma.product.updateMany({
        where: { id: { in: ok }, organizationId: orgId },
        data: { status: 'ARCHIVED', deletedAt: now },
      });
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
    const { ok, skipped } = await this.resolveBulkTargets(orgId, productIds);
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
    const { ok, skipped } = await this.resolveBulkTargets(orgId, productIds);
    // Postgres array_cat would be faster, but Prisma's native types don't
    // expose it. With MAX_BULK=250 the per-row pass is acceptable.
    for (const id of ok) {
      const p = await this.prisma.product.findUnique({
        where: { id },
        select: { tags: true },
      });
      if (!p) continue;
      const merged = Array.from(new Set([...(p.tags ?? []), ...tags]));
      await this.prisma.product.update({ where: { id }, data: { tags: merged } });
      await this.markOutOfSyncIfNeeded(id);
    }
    return { ok, skipped };
  }

  async bulkRemoveTags(orgId: string, productIds: string[], tags: string[]) {
    const { ok, skipped } = await this.resolveBulkTargets(orgId, productIds);
    const removeSet = new Set(tags);
    for (const id of ok) {
      const p = await this.prisma.product.findUnique({
        where: { id },
        select: { tags: true },
      });
      if (!p) continue;
      const filtered = (p.tags ?? []).filter((t) => !removeSet.has(t));
      await this.prisma.product.update({ where: { id }, data: { tags: filtered } });
      await this.markOutOfSyncIfNeeded(id);
    }
    return { ok, skipped };
  }

  /**
   * Enqueue a Shopify push for each MANUAL product. Each push is independent;
   * the worker handles failures and stamps metadata.shopifySync on individual
   * products. Returns the count of jobs queued.
   */
  async bulkSync(orgId: string, productIds: string[], vendorScope?: string) {
    const { ok, skipped } = await this.resolveBulkTargets(orgId, productIds, vendorScope);
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

    let queued = 0;
    for (const id of ok) {
      try {
        await this.shopifyPushEnqueuer.enqueueProductPush({
          type: 'product',
          productId: id,
          organizationId: orgId,
        });
        // Stamp PENDING immediately so the row badge updates.
        const product = await this.prisma.product.findUnique({
          where: { id },
          select: { metadata: true },
        });
        const meta = (product?.metadata as Prisma.JsonObject) ?? {};
        await this.prisma.product.update({
          where: { id },
          data: {
            metadata: {
              ...meta,
              shopifySync: { status: 'PENDING', attempts: 0 },
            } as Prisma.InputJsonObject,
          },
        });
        queued++;
      } catch (err) {
        skipped.push({
          id,
          reason: `Failed to enqueue: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
    return { ok: ok.filter((id) => !skipped.find((s) => s.id === id)), skipped, queued };
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
      include: { variants: { orderBy: { position: 'asc' } }, images: { orderBy: { position: 'asc' } } },
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
        options: (original.options ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        metadata: { source: 'crm', duplicatedFrom: original.id } as Prisma.InputJsonObject,
        externalCreatedAt: new Date(),
        variants: {
          create: original.variants.map((v) => ({
            externalId: `manual_${randomUUID()}`,
            title: v.title,
            sku: v.sku,
            barcode: v.barcode,
            price: v.price,
            compareAtPrice: v.compareAtPrice,
            cost: v.cost,
            inventoryQuantity: v.inventoryQuantity,
            trackQuantity: v.trackQuantity,
            continueSellingWhenOutOfStock: v.continueSellingWhenOutOfStock,
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
        channel: { select: { id: true, name: true, platform: true } },
      },
    });
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
          ? (p.options as Array<{ name: string; values: string[] }>).filter(
              (o) => o && typeof o === 'object',
            )
          : [],
        variants: p.variants.map((v) => ({
          sku: v.sku,
          barcode: v.barcode,
          price: v.price.toString(),
          compareAtPrice: v.compareAtPrice?.toString() ?? null,
          cost: v.cost?.toString() ?? null,
          inventoryQuantity: v.inventoryQuantity,
          trackQuantity: v.trackQuantity,
          continueSellingWhenOutOfStock: v.continueSellingWhenOutOfStock,
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
        previewRows: rows.slice(0, 10) as unknown as Prisma.InputJsonValue,
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
        status: errorList.length > 0 && createdCount === 0 ? 'FAILED' : 'COMPLETED',
        processedRows: processed,
        createdCount,
        errorCount: errorList.length,
        errors: errorList as unknown as Prisma.InputJsonValue,
        completedAt: new Date(),
      },
    });
    return this.toImportJobView(updated);
  }

  async getImportJob(orgId: string, jobId: string): Promise<ProductImportJobView> {
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
    return this.prisma.product.create({
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
            const labels = [v.option1, v.option2, v.option3].filter(Boolean) as string[];
            return {
              externalId: `manual_${randomUUID()}`,
              title: labels.length > 0 ? labels.join(' / ') : 'Default Title',
              sku: v.sku ?? null,
              barcode: v.barcode ?? null,
              price: v.price,
              compareAtPrice: v.compareAtPrice ?? null,
              cost: v.cost ?? null,
              inventoryQuantity: v.inventoryQuantity,
              trackQuantity: v.trackQuantity,
              continueSellingWhenOutOfStock: v.continueSellingWhenOutOfStock,
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
    });
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
      errors: Array.isArray(job.errors) ? (job.errors as unknown as ProductImportError[]) : [],
      previewRows: Array.isArray(job.previewRows)
        ? (job.previewRows as unknown as Record<string, string>[])
        : [],
      createdAt: job.createdAt.toISOString(),
      completedAt: job.completedAt?.toISOString() ?? null,
    };
  }
}
