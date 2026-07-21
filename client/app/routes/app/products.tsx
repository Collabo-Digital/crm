import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import {
  Search, Plus, Filter, ChevronLeft, ChevronRight, Package, ListChecks,
  PackageX, AlertTriangle, Check, Loader2, Pencil, Trash2, UploadCloud,
  Download, Upload,
} from "lucide-react";
import { StatCard } from "~/components/app/stat-card";
import { TableSkeleton } from "~/components/app/table-skeleton";
import { EmptyState } from "~/components/app/empty-state";
import { Skeleton } from "~/components/ui/skeleton";
import { ProductFormDialog } from "~/components/app/product-create/product-form-dialog";
import { BulkActionBar } from "~/components/app/products/bulk-action-bar";
import { CsvImportWizard } from "~/components/app/products/csv-import-wizard";
import { formatCurrency } from "~/lib/utils";
import { useProducts, useProductTypes, useProductStats } from "~/hooks/use-product-queries";
import {
  useDeleteProductMutation,
  useSyncProductMutation,
} from "~/hooks/use-product-mutations";
import { productService } from "~/services/product.service";
import { useCurrentOrg } from "~/hooks/use-org-queries";
import { useCurrentRole } from "~/hooks/use-current-role";
import { handleMutationError } from "~/lib/handle-mutation-error";
import type { ProductStatus, ProductListParams, Product } from "~/types/api";

export function meta() {
  return [{ title: "Products | Collabo CRM" }];
}

const STATUS_LABEL: Record<ProductStatus, string> = {
  ACTIVE: "Active",
  DRAFT: "Draft",
  ARCHIVED: "Archived",
};

const STATUS_CLASS: Record<ProductStatus, string> = {
  ACTIVE: "bg-[#CEF17B]/30 text-[#084734]",
  DRAFT: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
  ARCHIVED: "bg-orange-100 text-orange-700",
};

const PAGE_SIZE = 12;

export default function ProductsPage() {
  const navigate = useNavigate();
  const { isVendor } = useCurrentRole();
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedType, setSelectedType] = useState("All");
  const [currentPage, setCurrentPage] = useState(1);
  // Full edit/create dialog state. `creatingProduct` toggles the create form;
  // `editingFullProductId` opens the edit form for a MANUAL-channel product
  // (also reachable from the detail page).
  const [creatingProduct, setCreatingProduct] = useState(false);
  const [editingFullProductId, setEditingFullProductId] = useState<string | null>(null);
  // Phase 3: bulk-selection state + wizards
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [importOpen, setImportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);

  const deleteProduct = useDeleteProductMutation();

  const { data: org } = useCurrentOrg();
  const gstEnabled = org?.gstEnabled ?? false;
  const orgCurrency = org?.currency ?? "USD";

  const params: ProductListParams = {
    page: currentPage,
    limit: PAGE_SIZE,
    search: searchQuery || undefined,
    productType: selectedType !== "All" ? selectedType : undefined,
  };

  const { data, isLoading } = useProducts(params);
  const { data: productTypes } = useProductTypes();
  const { data: stats, isLoading: statsLoading } = useProductStats();

  const products = data?.data ?? [];
  const meta = data?.meta;
  const totalPages = meta?.totalPages ?? 1;
  const categoryFilters = ["All", ...(productTypes ?? [])];

  // Resolve the selected ids back to full Product objects (for the bulk bar).
  const selectedProducts = useMemo(
    () => products.filter((p) => selectedIds.has(p.id)),
    [products, selectedIds],
  );
  const allOnPageSelected =
    products.length > 0 && products.every((p) => selectedIds.has(p.id));

  function handleSearchChange(event: React.ChangeEvent<HTMLInputElement>) {
    setSearchQuery(event.target.value);
    setCurrentPage(1);
  }

  function handleTypeFilter(type: string) {
    setSelectedType(type);
    setCurrentPage(1);
  }

  function toggleSelect(id: string, checked: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function toggleSelectAllOnPage(checked: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) products.forEach((p) => next.add(p.id));
      else products.forEach((p) => next.delete(p.id));
      return next;
    });
  }

  async function handleExport() {
    setExporting(true);
    try {
      await productService.downloadExportCsv({
        search: searchQuery || undefined,
        productType: selectedType !== "All" ? selectedType : undefined,
      });
    } catch (err) {
      handleMutationError(err, "Failed to export CSV.");
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">Products</h1>
          <p className="text-sm text-muted-foreground">
            Manage your product catalog, inventory, and pricing.
          </p>
        </div>
        {!isVendor && (
          <div className="flex items-center gap-2">
            <button
              onClick={handleExport}
              disabled={exporting}
              title="Export products as Shopify-format CSV"
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-input bg-white dark:bg-gray-900 px-3 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800/60 disabled:opacity-50"
            >
              {exporting ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
              Export
            </button>
            <button
              onClick={() => setImportOpen(true)}
              title="Import products from a Shopify-format CSV"
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-input bg-white dark:bg-gray-900 px-3 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800/60"
            >
              <Upload className="size-3.5" />
              Import
            </button>
            <button
              onClick={() => setCreatingProduct(true)}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-[#CEF17B] px-3 text-xs font-medium text-gray-900 shadow-sm hover:bg-[#BADE6F]"
            >
              <Plus className="size-3.5" />
              Add Product
            </button>
          </div>
        )}
      </div>

      {/* Bulk action bar — only visible when at least one product is selected */}
      {!isVendor && selectedProducts.length > 0 && (
        <BulkActionBar
          selectedProducts={selectedProducts}
          onClear={() => setSelectedIds(new Set())}
        />
      )}

      {/* Stat cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {statsLoading ? (
          Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="rounded-xl bg-white dark:bg-gray-900 p-5 shadow-sm ring-1 ring-border">
              <Skeleton className="h-3 w-24 mb-4" />
              <Skeleton className="h-7 w-20" />
            </div>
          ))
        ) : stats ? (
          <>
            <StatCard label="Total Products" value={stats.totalProducts.toLocaleString()} change={0} icon={<Package className="size-4" />} />
            <StatCard label="Active Listings" value={stats.activeListings.toLocaleString()} change={0} icon={<ListChecks className="size-4" />} />
            <StatCard label="Out of Stock" value={stats.outOfStockProducts.toLocaleString()} change={0} icon={<PackageX className="size-4" />} />
            <StatCard label="Low Stock Items" value={stats.lowStockProducts.toLocaleString()} change={0} icon={<AlertTriangle className="size-4" />} />
          </>
        ) : (
          <>
            <StatCard label="Total Products" value="—" change={0} icon={<Package className="size-4" />} />
            <StatCard label="Active Listings" value="—" change={0} icon={<ListChecks className="size-4" />} />
            <StatCard label="Out of Stock" value="—" change={0} icon={<PackageX className="size-4" />} />
            <StatCard label="Low Stock Items" value="—" change={0} icon={<AlertTriangle className="size-4" />} />
          </>
        )}
      </div>

      {/* Search and filter */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-xs">
          <Search className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search by name or SKU…"
            value={searchQuery}
            onChange={handleSearchChange}
            className="h-8 w-full rounded-lg border border-input bg-white dark:bg-gray-900 pl-8 pr-3 text-xs focus:outline-none focus:ring-2 focus:ring-[#CEF17B]/50"
          />
        </div>
        <div className="flex items-center gap-1.5">
          <Filter className="size-3.5 text-muted-foreground" />
          {categoryFilters.map((filterName) => (
            <button
              key={filterName}
              onClick={() => handleTypeFilter(filterName)}
              className={`h-7 rounded-full px-3 text-xs font-medium transition-colors ${
                selectedType === filterName
                  ? "bg-[#CEF17B]/30 text-[#084734]"
                  : "bg-white dark:bg-gray-900 text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 border border-input"
              }`}
            >
              {filterName}
            </button>
          ))}
        </div>
      </div>

      {/* Products table */}
      {isLoading ? (
        <TableSkeleton rows={6} columns={6} />
      ) : products.length === 0 ? (
        <EmptyState
          title="No products found"
          description={searchQuery ? "Try adjusting your search or filters." : "Connect a channel to sync your products."}
        />
      ) : (
        <div className="rounded-xl bg-white dark:bg-gray-900 shadow-sm ring-1 ring-border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-gray-50/60 dark:bg-gray-800/60 text-left">
                  <th className="w-10 px-4 py-3">
                    <input
                      type="checkbox"
                      checked={allOnPageSelected}
                      onChange={(e) => toggleSelectAllOnPage(e.target.checked)}
                      title="Select all on this page"
                      className="size-3.5 accent-[#CEF17B] cursor-pointer"
                    />
                  </th>
                  <th className="px-4 py-3 text-xs font-semibold text-muted-foreground">Product</th>
                  <th className="px-4 py-3 text-xs font-semibold text-muted-foreground">Type</th>
                  <th className="px-4 py-3 text-xs font-semibold text-muted-foreground">Vendor</th>
                  <th className="px-4 py-3 text-xs font-semibold text-muted-foreground text-right">Price</th>
                  <th className="px-4 py-3 text-xs font-semibold text-muted-foreground text-right">Stock</th>
                  {gstEnabled && (
                    <>
                      <th className="px-4 py-3 text-xs font-semibold text-muted-foreground">HSN</th>
                      <th className="px-4 py-3 text-xs font-semibold text-muted-foreground">GST %</th>
                    </>
                  )}
                  <th className="px-4 py-3 text-xs font-semibold text-muted-foreground">Status</th>
                  <th className="px-4 py-3 text-xs font-semibold text-muted-foreground text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {products.map((product) => (
                  <tr
                    key={product.id}
                    className={`hover:bg-gray-50/50 dark:hover:bg-gray-800/50 transition-colors cursor-pointer ${
                      selectedIds.has(product.id) ? "bg-[#CEF17B]/10" : ""
                    }`}
                    onClick={() => navigate(`/products/${product.id}`)}
                  >
                    <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selectedIds.has(product.id)}
                        onChange={(e) => toggleSelect(product.id, e.target.checked)}
                        className="size-3.5 accent-[#CEF17B] cursor-pointer"
                      />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        {product.image ? (
                          <img
                            src={product.image.src}
                            alt={product.image.alt ?? product.title}
                            className="size-9 shrink-0 rounded-lg object-cover bg-gray-100 dark:bg-gray-800"
                          />
                        ) : (
                          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-gray-100 dark:bg-gray-800 text-gray-400">
                            <span className="text-lg">📦</span>
                          </div>
                        )}
                        <div className="min-w-0">
                          <span className="text-xs font-medium text-gray-900 dark:text-gray-100 line-clamp-1">
                            {product.title}
                          </span>
                          {product.variantCount > 1 && (
                            <p className="text-[11px] text-muted-foreground">{product.variantCount} variants</p>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{product.productType ?? "—"}</td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{product.vendor ?? "—"}</td>
                    <td className="px-4 py-3 text-xs font-semibold text-gray-900 dark:text-gray-100 text-right">
                      {product.priceRange.min === product.priceRange.max
                        ? formatCurrency(product.priceRange.min, orgCurrency)
                        : `${formatCurrency(product.priceRange.min, orgCurrency)} – ${formatCurrency(product.priceRange.max, orgCurrency)}`}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className={`text-xs font-medium ${product.totalStock === 0 ? "text-red-600" : product.totalStock < 100 ? "text-orange-600" : "text-gray-900 dark:text-gray-100"}`}>
                        {product.totalStock.toLocaleString()}
                      </span>
                    </td>
                    {gstEnabled && (
                      <>
                        <td className="px-4 py-3 text-xs font-mono text-muted-foreground">
                          {product.hsnCode || <span className="text-orange-500">—</span>}
                        </td>
                        <td className="px-4 py-3 text-xs text-muted-foreground">
                          {product.gstRate != null ? `${product.gstRate}%` : <span className="text-orange-500">—</span>}
                        </td>
                      </>
                    )}
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_CLASS[product.status]}`}>
                        {product.totalStock === 0 && product.status === "ACTIVE" ? "Out of Stock" : STATUS_LABEL[product.status]}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                      <ProductRowActions
                        product={product}
                        onEdit={() => setEditingFullProductId(product.id)}
                        onArchive={() => {
                          if (confirm(`Archive "${product.title}"? Existing orders will keep their record.`)) {
                            deleteProduct.mutate(product.id);
                          }
                        }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between border-t px-4 py-3">
            <p className="text-xs text-muted-foreground">
              Showing {products.length} of {meta?.total ?? 0} products
            </p>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setCurrentPage((prev) => Math.max(1, prev - 1))}
                disabled={currentPage === 1}
                className="inline-flex items-center gap-1 h-7 rounded-md border border-input bg-white dark:bg-gray-900 px-3 text-xs text-muted-foreground hover:text-gray-900 dark:hover:text-gray-100 disabled:opacity-40 disabled:pointer-events-none"
              >
                <ChevronLeft className="size-3" />Previous
              </button>
              <button
                onClick={() => setCurrentPage((prev) => Math.min(totalPages, prev + 1))}
                disabled={currentPage >= totalPages}
                className="inline-flex items-center gap-1 h-7 rounded-md border border-input bg-white dark:bg-gray-900 px-3 text-xs text-muted-foreground hover:text-gray-900 dark:hover:text-gray-100 disabled:opacity-40 disabled:pointer-events-none"
              >
                Next<ChevronRight className="size-3" />
              </button>
            </div>
          </div>
        </div>
      )}

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

// ── Product Row Actions ─────────────────────────────────────────────────────
// Right-most cell of each product row. Edit / Archive are always available
// (synced products are now editable too — local edits push back via the Sync
// button). The badge in front reflects the product's current sync state.

function ProductRowActions({
  product,
  onEdit,
  onArchive,
}: {
  product: Product;
  onEdit: () => void;
  onArchive: () => void;
}) {
  const isSynced = product.channel?.platform === "SHOPIFY";
  const sync = product.shopifySync;
  const syncMutation = useSyncProductMutation();

  // While a push is in flight, collapse the actions to a single spinner badge
  // — clicking anything else would race the queued job.
  if (sync?.status === "PENDING") {
    return (
      <span
        title="Syncing to Shopify in the background…"
        className="inline-flex items-center gap-1 rounded-full bg-blue-50 dark:bg-blue-900/30 px-2 py-0.5 text-[10px] font-medium text-blue-700 dark:text-blue-300"
      >
        <Loader2 className="size-3 animate-spin" />
        Syncing
      </span>
    );
  }

  // Pick a status badge for the leading slot (when applicable).
  let badge: React.ReactNode = null;
  if (sync?.status === "SYNCED" && isSynced) {
    badge = (
      <span
        title={
          sync.shopifyProductId
            ? `Shopify product ID: ${sync.shopifyProductId}`
            : "Synced to Shopify"
        }
        className="inline-flex items-center gap-1 rounded-full bg-green-50 dark:bg-green-900/30 px-2 py-0.5 text-[10px] font-medium text-green-700 dark:text-green-300"
      >
        <Check className="size-3" />
        Synced
      </span>
    );
  } else if (sync?.status === "OUT_OF_SYNC") {
    badge = (
      <span
        title="Local edits haven't been pushed to Shopify yet"
        className="inline-flex items-center gap-1 rounded-full bg-amber-50 dark:bg-amber-900/30 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300"
      >
        <AlertTriangle className="size-3" />
        Out of sync
      </span>
    );
  } else if (sync?.status === "FAILED") {
    badge = (
      <span
        title={`Shopify sync failed: ${sync.error ?? "unknown"}`}
        className="inline-flex items-center gap-1 rounded-full bg-red-50 dark:bg-red-900/30 px-2 py-0.5 text-[10px] font-medium text-red-700 dark:text-red-300"
      >
        <AlertTriangle className="size-3" />
        Sync failed
      </span>
    );
  }

  // Sync button is hidden for fully-synced (no edits yet) products to reduce
  // noise; it reappears as soon as something needs pushing or has failed.
  const showSyncButton = sync?.status !== "SYNCED" || !isSynced;

  return (
    <div className="inline-flex items-center gap-1">
      {badge}
      {showSyncButton && (
        <button
          type="button"
          title={
            sync?.status === "FAILED"
              ? "Retry sync to Shopify"
              : sync?.status === "OUT_OF_SYNC"
                ? "Push local edits to Shopify"
                : "Sync to Shopify"
          }
          disabled={syncMutation.isPending}
          onClick={() => syncMutation.mutate(product.id)}
          className="rounded-md p-1.5 text-muted-foreground hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-[#084734] disabled:opacity-50"
        >
          {syncMutation.isPending && syncMutation.variables === product.id ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <UploadCloud className="size-3.5" />
          )}
        </button>
      )}
      <button
        type="button"
        title="Edit product"
        onClick={onEdit}
        className="rounded-md p-1.5 text-muted-foreground hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100"
      >
        <Pencil className="size-3.5" />
      </button>
      <button
        type="button"
        title="Archive product"
        onClick={onArchive}
        className="rounded-md p-1.5 text-muted-foreground hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-red-600"
      >
        <Trash2 className="size-3.5" />
      </button>
    </div>
  );
}

