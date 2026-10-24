import { useMemo, useState } from "react";
import { useListUrlState } from "~/hooks/use-list-url-state";
import { Link, useNavigate } from "react-router";
import {
  Plus, Package, ListChecks,
  PackageX, Loader2, Pencil, Trash2, UploadCloud,
  Download, Upload, Boxes, Barcode, MoreHorizontal,
} from "lucide-react";
import { StatCard } from "~/components/app/stat-card";
import { Skeleton } from "~/components/ui/skeleton";
import { ProductFormDialog } from "~/components/app/product-create/product-form-dialog";
import { BulkActionBar } from "~/components/app/products/bulk-action-bar";
import { CsvImportWizard } from "~/components/app/products/csv-import-wizard";
import { ProductCodesDialog } from "~/components/app/inventory/product-codes-dialog";
import {
  DataTable,
  DateCell,
  ProductCell,
  StatusPill,
  TextCell,
  useDataTableState,
  type ColumnDef,
  type FilterDef,
} from "~/components/app/data-table";
import { cn, formatCurrency } from "~/lib/utils";
import { useProducts, useProductTypes, useProductStats, useProductVendors } from "~/hooks/use-product-queries";
import { useCodeStatus } from "~/hooks/use-inventory-queries";
import {
  useDeleteProductMutation,
  useSyncProductMutation,
} from "~/hooks/use-product-mutations";
import { productService } from "~/services/product.service";
import { useCurrentOrg } from "~/hooks/use-org-queries";
import { useCurrentRole } from "~/hooks/use-current-role";
import { handleMutationError } from "~/lib/handle-mutation-error";
import {
  describeProductShopifySync,
  productSyncActionTitle,
  type ProductSyncAction,
} from "~/lib/product-shopify-sync";
import { ShopifySyncCell } from "~/components/app/shopify-sync-cell";
import type { ProductStatus, ProductListParams, Product, ProductStatsResponse, StockStatus } from "~/types/api";
import { Separator } from "~/components/ui/separator";
import { Button } from "~/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "~/components/ui/dropdown-menu";
import { PageHeader, PageHeaderContent, PageHeaderTitle, PageHeaderDescription, PageHeaderActions } from "~/components/ui/page-header";

export function meta() {
  return [{ title: "Products | Collabo CRM" }];
}

const STATUS_LABEL: Record<ProductStatus, string> = {
  ACTIVE: "Active",
  DRAFT: "Draft",
  ARCHIVED: "Archived",
};

const STAT_CARDS = [
  { key: "totalProducts", label: "Total Products", icon: <Package className="size-4" /> },
  { key: "activeListings", label: "Active Listings", icon: <ListChecks className="size-4" /> },
  { key: "outOfStockProducts", label: "Out of Stock", icon: <PackageX className="size-4" /> },
  { key: "totalInventoryUnits", label: "Inventory Units", icon: <Boxes className="size-4" /> },
] as const satisfies ReadonlyArray<{
  key: keyof ProductStatsResponse;
  label: string;
  icon: React.ReactNode;
}>;

const STATUS_CLASS: Record<ProductStatus, string> = {
  ACTIVE: "bg-brand/30 text-brand-strong",
  DRAFT: "bg-muted text-muted-foreground",
  ARCHIVED: "bg-warning-strong-subtle text-warning-strong",
};

/** Filter chip options carry the API value, so the URL and the request agree. */
const STATUS_OPTIONS: ReadonlyArray<{ value: ProductStatus; label: string }> = [
  { value: "ACTIVE", label: "Active" },
  { value: "DRAFT", label: "Draft" },
  { value: "ARCHIVED", label: "Archived" },
];
const STOCK_OPTIONS: ReadonlyArray<{ value: StockStatus; label: string }> = [
  { value: "in_stock", label: "In stock" },
  { value: "low_stock", label: "Low stock" },
  { value: "out_of_stock", label: "Out of stock" },
];

export default function ProductsPage() {
  const navigate = useNavigate();
  const { role, isVendor } = useCurrentRole();
  // Mirror the server's role groups on the product write routes
  // (server/src/auth/decorators/roles.decorator.ts): editing is ORG_OPERATORS,
  // permanent delete and CSV import are ORG_MANAGERS. A Viewer sees the
  // catalogue without buttons the API would refuse.
  const canManage = role === "OWNER" || role === "ADMIN" || role === "MANAGER";
  const canEdit = canManage || role === "AGENT";
  // The whole view — page, search, filters, sort, page size — lives in the
  // URL so Back from a product (and the product page's breadcrumb) return to
  // the exact list the row was opened from, while the navbar's bare link
  // still opens page 1 with nothing applied.
  const list = useListUrlState("products");
  // Full edit/create dialog state. `creatingProduct` toggles the create form;
  // `editingFullProductId` opens the edit form for a MANUAL-channel product
  // (also reachable from the detail page).
  const [creatingProduct, setCreatingProduct] = useState(false);
  const [editingFullProductId, setEditingFullProductId] = useState<string | null>(null);
  // Selected products by id, kept as full objects so a selection made on one
  // page survives paging to another. This used to be a Set of ids resolved
  // against the CURRENT page only, so the bar (and every bulk action) saw just
  // the visible page's selection: select on page 1, click Next, and the bar
  // vanished; come back and only page 1's rows were "selected".
  const [selected, setSelected] = useState<Map<string, Product>>(new Map());
  const [importOpen, setImportOpen] = useState(false);
  const [codesOpen, setCodesOpen] = useState(false);
  const [exporting, setExporting] = useState(false);

  // Org-wide, so the badge is honest about what the dialog will change. Hidden
  // from vendors along with the rest of the catalogue-wide actions.
  const codeStatus = useCodeStatus(!isVendor);
  const pendingCodes = codeStatus.data
    ? codeStatus.data.missingSku +
      codeStatus.data.missingBarcode +
      codeStatus.data.longBarcode
    : 0;

  const deleteProduct = useDeleteProductMutation();

  const { data: org } = useCurrentOrg();
  // The org's own threshold, not a hard-coded 100 — this column used to call
  // "low" something different from every other screen.
  const lowStockThreshold = org?.lowStockThreshold ?? 10;
  const orgCurrency = org?.currency ?? "USD";

  const { data: productTypes } = useProductTypes();
  const { data: vendors } = useProductVendors();

  const columns = useMemo<ColumnDef<Product>[]>(
    () => [
      {
        key: "product",
        label: "Product",
        width: 280,
        locked: true,
        sortKey: "title",
        sortType: "text",
        cell: (product) => (
          <ProductCell
            title={product.title}
            sub={product.variantCount > 1 ? `${product.variantCount} variants` : undefined}
            imageUrl={product.image?.src}
          />
        ),
      },
      {
        key: "type",
        label: "Type",
        width: 130,
        sortKey: "productType",
        sortType: "text",
        cell: (product) => <TextCell muted>{product.productType ?? "—"}</TextCell>,
      },
      {
        key: "vendor",
        label: "Vendor",
        width: 140,
        sortKey: "vendor",
        sortType: "text",
        cell: (product) => <TextCell muted>{product.vendor ?? "—"}</TextCell>,
      },
      {
        key: "price",
        label: "Price",
        width: 140,
        align: "right",
        cell: (product) => {
          // A catalogue price is in the CHANNEL's currency, not the
          // workspace's — a USD store's $749.95 snowboard was being listed as
          // "₹749.95". Falls back to the org currency for a channel whose
          // currency is not yet known (no order has arrived from it).
          const priceCurrency = product.channel?.currency ?? orgCurrency;
          return (
            <span className="whitespace-nowrap font-semibold tabular-nums text-foreground">
              {product.priceRange.min === product.priceRange.max
                ? formatCurrency(product.priceRange.min, priceCurrency)
                : `${formatCurrency(product.priceRange.min, priceCurrency)} – ${formatCurrency(product.priceRange.max, priceCurrency)}`}
            </span>
          );
        },
      },
      {
        key: "stock",
        label: "Stock",
        width: 100,
        align: "right",
        // Deliberately a cross-location total, the way Shopify's own product
        // list works. The Inventory screen is the per-location view; saying
        // so here stops the two figures reading as a contradiction.
        headerTooltip:
          "Total across every location. Open Inventory to see and edit stock at one location.",
        cell: (product) => (
          // Links into the per-location view, filtered to this product. The
          // number used to be a dead end, which is why nobody found where
          // stock was edited.
          <Link
            to={`/products/inventory?search=${encodeURIComponent(product.title)}`}
            className={cn(
              "font-medium tabular-nums underline-offset-3 hover:underline",
              product.totalStock === 0
                ? "text-danger"
                : product.totalStock <= lowStockThreshold
                  ? "text-warning-strong"
                  : "text-foreground",
            )}
          >
            {product.totalStock.toLocaleString("en-IN")}
          </Link>
        ),
      },
      {
        key: "status",
        label: "Status",
        width: 110,
        sortKey: "status",
        sortType: "text",
        cell: (product) => (
          <StatusPill className={STATUS_CLASS[product.status]}>
            {product.totalStock === 0 && product.status === "ACTIVE"
              ? "Out of Stock"
              : STATUS_LABEL[product.status]}
          </StatusPill>
        ),
      },
      {
        // HSN and GST % used to sit here. They belong to the product's tax
        // setup, not its listing, and are edited in the product codes dialog.
        key: "shopify",
        label: "Shopify",
        width: 150,
        cell: (product) => (
          <ShopifySyncCell
            summary={describeProductShopifySync(product)}
            title={
              product.shopifySync?.shopifyProductId
                ? `Shopify product ID: ${product.shopifySync.shopifyProductId}`
                : undefined
            }
          />
        ),
      },
      {
        key: "updated",
        label: "Updated",
        width: 120,
        hiddenByDefault: true,
        sortKey: "updatedAt",
        sortType: "date",
        cell: (product) => <DateCell value={product.updatedAt} />,
      },
      {
        key: "created",
        label: "Created",
        width: 120,
        hiddenByDefault: true,
        sortKey: "createdAt",
        sortType: "date",
        cell: (product) => <DateCell value={product.createdAt} />,
      },
    ],
    [lowStockThreshold, orgCurrency],
  );

  // Type and Vendor come from the API; `undefined` keeps the chip in its
  // loading state until they land.
  const filters = useMemo<FilterDef[]>(
    () => [
      { key: "status", label: "Status", options: STATUS_OPTIONS },
      {
        key: "type",
        label: "Type",
        options: productTypes?.map((type) => ({ value: type, label: type })),
      },
      { key: "stock", label: "Stock", options: STOCK_OPTIONS },
      {
        key: "vendor",
        label: "Vendor",
        options: vendors?.map((vendor) => ({ value: vendor, label: vendor })),
      },
    ],
    [productTypes, vendors],
  );

  const table = useDataTableState({
    key: "products",
    list,
    columns,
    filters,
    sort: { default: { field: "createdAt", dir: "desc" } },
  });

  const params: ProductListParams = {
    page: table.page,
    limit: table.limit,
    search: table.debouncedSearch || undefined,
    sortBy: table.sort?.field,
    sortOrder: table.sort?.dir,
    status: table.filters.status?.[0] as ProductStatus | undefined,
    stockStatus: table.filters.stock?.[0] as StockStatus | undefined,
    productType: table.filters.type?.[0],
    vendor: table.filters.vendor?.[0],
  };

  const { data, isLoading, isError, isPlaceholderData, refetch } = useProducts(params);
  const { data: stats, isLoading: statsLoading } = useProductStats();

  const products = data?.data ?? [];

  // Every selected product across pages; rows visible on the current page are
  // taken fresh from the list so status/tag changes show up in the bar.
  const selectedProducts = useMemo(() => {
    const byId = new Map(selected);
    for (const p of products) if (byId.has(p.id)) byId.set(p.id, p);
    return [...byId.values()];
  }, [products, selected]);
  const selectedOnPageCount = products.filter((p) => selected.has(p.id)).length;

  function toggleSelect(product: Product, checked: boolean) {
    setSelected((prev) => {
      const next = new Map(prev);
      if (checked) next.set(product.id, product);
      else next.delete(product.id);
      return next;
    });
  }

  function toggleSelectAllOnPage(rows: ReadonlyArray<Product>, checked: boolean) {
    setSelected((prev) => {
      const next = new Map(prev);
      if (checked) rows.forEach((p) => next.set(p.id, p));
      else rows.forEach((p) => next.delete(p.id));
      return next;
    });
  }

  async function handleExport() {
    setExporting(true);
    try {
      await productService.downloadExportCsv({
        search: table.debouncedSearch || undefined,
        status: params.status,
        productType: params.productType,
        vendor: params.vendor,
      });
    } catch (err) {
      handleMutationError(err, "Failed to export CSV.");
    } finally {
      setExporting(false);
    }
  }

  const showDock = canEdit && selectedProducts.length > 0;

  return (
    // Bottom padding while the bulk-action dock is up, so it never covers the
    // pagination row.
    <div className={showDock ? "space-y-6 pb-24" : "space-y-6"}>
      {/* Page header */}
      <PageHeader>
        <PageHeaderContent>
          <PageHeaderTitle>Products</PageHeaderTitle>
          <PageHeaderDescription>Your catalog, stock, and pricing in one place.</PageHeaderDescription>
        </PageHeaderContent>
        {!isVendor && (
          <PageHeaderActions className="w-full justify-end md:w-auto">
            <div className="hidden items-center gap-2 md:flex">
            <Button
              variant="outline"
              size="action"
              onClick={handleExport}
              disabled={exporting}
              title="Export products as Shopify-format CSV"
            >
              {exporting ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
              Export
            </Button>
            {canManage && (
              <Button
                variant="outline"
                size="action"
                onClick={() => setImportOpen(true)}
                title="Import products from a Shopify-format CSV"
              >
                <Upload className="size-3.5" />
                Import
              </Button>
            )}
            {/* Codes belong to the catalogue, not to a location, so this is
                their home. The Inventory page carries the same dialog, but it
                is gated on warehousing — without this trigger an org that has
                not enabled it cannot reach the flow at all. */}
            <Button
              variant="outline"
              size="action"
              onClick={() => setCodesOpen(true)}
            >
              <Barcode className="size-3.5" />
              {pendingCodes > 0 ? `Product codes (${pendingCodes})` : "Product codes"}
            </Button>
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" className="mr-auto size-11 rounded-xl md:hidden" aria-label="More product actions">
                  <MoreHorizontal className="size-5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem onSelect={handleExport} disabled={exporting}><Download /> Export products</DropdownMenuItem>
                {canManage && (
                  <DropdownMenuItem onSelect={() => setImportOpen(true)}><Upload /> Import products</DropdownMenuItem>
                )}
                <DropdownMenuItem onSelect={() => setCodesOpen(true)}><Barcode /> {pendingCodes > 0 ? `Product codes (${pendingCodes})` : "Product codes"}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            {canEdit && (
              <Button
                variant="brand"
                size="action"
                onClick={() => setCreatingProduct(true)}
                className="h-11 rounded-xl px-5 md:h-8 md:rounded-lg md:px-3"
              >
                <Plus className="size-3.5" />
                Add Product
              </Button>
            )}
          </PageHeaderActions>
        )}
      </PageHeader>

      <ProductCodesDialog open={codesOpen} onOpenChange={setCodesOpen} />

      {/* Floating bulk-action dock — only up while a product is selected */}
      {showDock && (
        <BulkActionBar
          canDelete={canManage}
          selectedProducts={selectedProducts}
          offPageCount={selectedProducts.length - selectedOnPageCount}
          onClear={() => setSelected(new Map())}
        />
      )}

      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-4 rounded-3xl bg-card p-4 md:gap-5 md:rounded-xl md:p-3 lg:grid-cols-4">
        {statsLoading ? (
          Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="min-w-0 p-1 md:p-5">
              <Skeleton className="h-3 w-24 mb-4" />
              <Skeleton className="h-7 w-20" />
            </div>
          ))
        ) : stats ? (
          STAT_CARDS.map(({ key, label, icon }, i, arr) => (
            <div key={key} className="flex min-w-0 items-center gap-4">
              <StatCard
                variant="inline"
                label={label}
                value={stats[key].toLocaleString()}
                icon={icon}
                className="flex-1"
              />
              {i < arr.length - 1 && (
                <Separator orientation="vertical" className="hidden md:block h-15" />
              )}
            </div>
          ))
        ) : (
          STAT_CARDS.map(({ key, label, icon }) => (
            <StatCard key={key} variant="inline" label={label} value="—" icon={icon} />
          ))
        )}
      </div>

      <DataTable
        state={table}
        rows={products}
        rowKey={(product) => product.id}
        meta={data?.meta}
        status={{ isLoading, isError, isPlaceholderData, refetch }}
        noun="products"
        searchPlaceholder="Search by name, vendor or SKU…"
        onRowClick={(product) => navigate(`/products/${product.id}`)}
        mobileRow={(product) => <ProductMobileSummary product={product} currency={orgCurrency} lowStockThreshold={lowStockThreshold} />}
        selection={{
          isSelected: (product) => selected.has(product.id),
          onToggle: toggleSelect,
          onToggleAll: toggleSelectAllOnPage,
          label: (product) => `Select ${product.title}`,
        }}
        rowActions={(product) => (
          <ProductRowActions
            product={product}
            syncAction={describeProductShopifySync(product).action}
            onEdit={() => setEditingFullProductId(product.id)}
            onArchive={() => {
              if (confirm(`Archive "${product.title}"? Existing orders will keep their record.`)) {
                deleteProduct.mutate(product.id);
              }
            }}
          />
        )}
        actionsWidth={150}
        emptyState={{
          title: "No products yet",
          description: "Connect a channel to sync your products, or add one here.",
        }}
      />

      {/* Create Product Dialog */}
      {creatingProduct && (
        <ProductFormDialog onClose={() => setCreatingProduct(false)} />
      )}

      {/* Full Edit Product Dialog (MANUAL-channel products only) */}
      {editingFullProductId && (
        <ProductFormDialog
          productId={editingFullProductId}
          onClose={() => setEditingFullProductId(null)}
        />
      )}

      {/* CSV import wizard */}
      {importOpen && <CsvImportWizard onClose={() => setImportOpen(false)} />}

    </div>
  );
}

function ProductMobileSummary({ product, currency, lowStockThreshold }: { product: Product; currency: string; lowStockThreshold: number }) {
  const priceCurrency = product.channel?.currency ?? currency;
  const [failedImage, setFailedImage] = useState<string | null>(null);
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-3">
        {product.image?.src && failedImage !== product.image.src ? (
          <img src={product.image.src} alt="" loading="lazy" onError={() => setFailedImage(product.image!.src)} className="size-14 shrink-0 rounded-xl bg-muted object-cover" />
        ) : (
          <span className="flex size-14 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground"><Package className="size-6" /></span>
        )}
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 text-sm font-semibold leading-snug text-foreground">{product.title}</p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {[product.vendor, product.variantCount > 1 ? `${product.variantCount} variants` : product.productType].filter(Boolean).join(" · ")}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold tabular-nums text-foreground">
          {formatCurrency(product.priceRange.min, priceCurrency)}
          {product.priceRange.min !== product.priceRange.max && <><span className="mx-1 text-muted-foreground">–</span>{formatCurrency(product.priceRange.max, priceCurrency)}</>}
        </p>
        <StatusPill className={cn("h-6 px-2.5 text-[11px]", STATUS_CLASS[product.status])}>{STATUS_LABEL[product.status]}</StatusPill>
      </div>
      <Link
        to={`/products/inventory?search=${encodeURIComponent(product.title)}`}
        className={cn("flex min-h-10 w-fit items-center gap-1.5 text-xs font-medium", product.totalStock === 0 ? "text-danger" : product.totalStock <= lowStockThreshold ? "text-warning-strong" : "text-muted-foreground")}
      >
        <span className="size-1.5 rounded-full bg-current" />
        {product.totalStock === 0 ? "Out of stock" : `${product.totalStock.toLocaleString("en-IN")} in stock`}
        {product.totalStock > 0 && product.totalStock <= lowStockThreshold && <span>· Low stock</span>}
      </Link>
      <ShopifySyncCell summary={describeProductShopifySync(product)} />
    </div>
  );
}

// ── Product Row Actions ─────────────────────────────────────────────────────
// Right-most cell of each product row. Edit / Archive are always available
// (synced products are now editable too — local edits push back via the Sync
// button). The sync STATE is the Shopify column's job; this cell only holds
// the matching action, labelled so the row reads "Out of sync → Push",
// "Sync failed → Retry", "Not on Shopify → Publish".

const SYNC_ACTION_LABEL: Record<NonNullable<ProductSyncAction>, string> = {
  push: "Push",
  retry: "Retry",
  publish: "Publish",
};

function ProductRowActions({
  product,
  syncAction,
  onEdit,
  onArchive,
}: {
  product: Product;
  /** From `describeProductShopifySync`: null while a push is in flight or
      there is nothing to push, so the one rule decides both pill and button. */
  syncAction: ProductSyncAction;
  onEdit: () => void;
  onArchive: () => void;
}) {
  const sync = product.shopifySync;
  const syncMutation = useSyncProductMutation();
  const thisRowSyncing = syncMutation.isPending && syncMutation.variables === product.id;

  return (
    <div className="inline-flex items-center gap-1">
      {syncAction !== null && (
        <Button
          type="button"
          variant="outline"
          size="xs"
          title={productSyncActionTitle(sync)}
          disabled={syncMutation.isPending}
          onClick={() => syncMutation.mutate(product.id)}
          className="mr-1 text-brand-strong"
        >
          {thisRowSyncing ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <UploadCloud className="size-3" />
          )}
          {SYNC_ACTION_LABEL[syncAction]}
        </Button>
      )}
      <Button variant="ghost" size="icon-sm" title="Edit product" aria-label="Edit product" onClick={onEdit}>
        <Pencil className="size-3.5 text-muted-foreground" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        title="Archive product"
        aria-label="Archive product"
        onClick={onArchive}
        className="hover:text-danger"
      >
        <Trash2 className="size-3.5" />
      </Button>
    </div>
  );
}
