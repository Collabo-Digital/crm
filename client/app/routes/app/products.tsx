import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import {
  Search, Plus, Filter, ChevronLeft, ChevronRight, Package, ListChecks,
  PackageX, AlertTriangle, Check, Loader2, Pencil, Trash2, UploadCloud,
  Download, Upload, X, ArrowUpDown, ChevronDown, Boxes, Barcode,
} from "lucide-react";
import { StatCard } from "~/components/app/stat-card";
import { TableSkeleton } from "~/components/app/table-skeleton";
import { EmptyState } from "~/components/app/empty-state";
import { Skeleton } from "~/components/ui/skeleton";
import { ProductFormDialog } from "~/components/app/product-create/product-form-dialog";
import { BulkActionBar } from "~/components/app/products/bulk-action-bar";
import { CsvImportWizard } from "~/components/app/products/csv-import-wizard";
import { ProductCodesDialog } from "~/components/app/inventory/product-codes-dialog";
import { formatCurrency } from "~/lib/utils";
import { useProducts, useProductTypes, useProductStats, useProductVendors } from "~/hooks/use-product-queries";
import { useDebounced } from "~/hooks/use-debounced";
import { useCodeStatus } from "~/hooks/use-inventory-queries";
import {
  useDeleteProductMutation,
  useSyncProductMutation,
} from "~/hooks/use-product-mutations";
import { productService } from "~/services/product.service";
import { useCurrentOrg } from "~/hooks/use-org-queries";
import { Tip } from "~/components/ui/tooltip";
import { useCurrentRole } from "~/hooks/use-current-role";
import { handleMutationError } from "~/lib/handle-mutation-error";
import type { ProductStatus, ProductListParams, Product, ProductStatsResponse, StockStatus } from "~/types/api";
import { Separator } from "~/components/ui/separator";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "~/components/ui/dropdown-menu";

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
  ACTIVE: "bg-[#CEF17B]/30 text-[#084734]",
  DRAFT: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
  ARCHIVED: "bg-orange-100 text-orange-700",
};

const PAGE_SIZE = 12;
const FILTER_OPTIONS = ["Status", "Type", "Stock", "Vendor"] as const;
const FILTER_VALUES: Record<(typeof FILTER_OPTIONS)[number], string[]> = {
  Status: ["Active", "Draft", "Archived"],
  Stock: ["In stock", "Low stock", "Out of stock"],
  Type: [],
  Vendor: [],
};
const SORT_OPTIONS: { label: string; sortBy: string; sortOrder: "asc" | "desc" }[] = [
  { label: "Newest first", sortBy: "createdAt", sortOrder: "desc" },
  { label: "Oldest first", sortBy: "createdAt", sortOrder: "asc" },
  { label: "Recently updated", sortBy: "updatedAt", sortOrder: "desc" },
  { label: "Name (A–Z)", sortBy: "title", sortOrder: "asc" },
  { label: "Name (Z–A)", sortBy: "title", sortOrder: "desc" },
];

const STATUS_VALUE_MAP: Record<string, ProductStatus> = {
  Active: "ACTIVE",
  Draft: "DRAFT",
  Archived: "ARCHIVED",
};
const STOCK_VALUE_MAP: Record<string, StockStatus> = {
  "In stock": "in_stock",
  "Low stock": "low_stock",
  "Out of stock": "out_of_stock",
};



export default function ProductsPage() {
  const navigate = useNavigate();
  const { isVendor } = useCurrentRole();
  const [searchQuery, setSearchQuery] = useState("");
  const debouncedSearch = useDebounced(searchQuery, 350);
  const [selectedType, setSelectedType] = useState("All");
  const [currentPage, setCurrentPage] = useState(1);
  // Full edit/create dialog state. `creatingProduct` toggles the create form;
  // `editingFullProductId` opens the edit form for a MANUAL-channel product
  // (also reachable from the detail page).
  const [creatingProduct, setCreatingProduct] = useState(false);
  const [editingFullProductId, setEditingFullProductId] = useState<string | null>(null);
  // Phase 3: bulk-selection state + wizards
  // Selected products by id, kept as full objects so a selection made on one
  // page survives paging to another. This used to be a Set of ids resolved
  // against the CURRENT page only, so the bar (and every bulk action) saw just
  // the visible page's selection: select on page 1, click Next, and the bar
  // vanished; come back and only page 1's rows were "selected".
  const [selected, setSelected] = useState<Map<string, Product>>(new Map());
  const [importOpen, setImportOpen] = useState(false);
  const [codesOpen, setCodesOpen] = useState(false);

  // Org-wide, so the badge is honest about what the dialog will change. Hidden
  // from vendors along with the rest of the catalogue-wide actions.
  const codeStatus = useCodeStatus(!isVendor);
  const pendingCodes = codeStatus.data
    ? codeStatus.data.missingSku +
      codeStatus.data.missingBarcode +
      codeStatus.data.longBarcode
    : 0;
  const [activeFilters, setActiveFilters] = useState<string[]>([]);
  const [filterValues, setFilterValues] = useState<Record<string, string>>({});
  const [sortBy, setSortBy] = useState("createdAt");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
  const [exporting, setExporting] = useState(false);

  const deleteProduct = useDeleteProductMutation();

  const { data: org } = useCurrentOrg();
  const gstEnabled = org?.gstEnabled ?? false;
  // The org's own threshold, not a hard-coded 100 — this column used to call
  // "low" something different from every other screen.
  const lowStockThreshold = org?.lowStockThreshold ?? 10;
  const orgCurrency = org?.currency ?? "USD";

  const params: ProductListParams = {
    page: currentPage,
    limit: PAGE_SIZE,
    search: debouncedSearch || undefined,
    sortBy,
    sortOrder,
    status: filterValues.Status ? STATUS_VALUE_MAP[filterValues.Status] : undefined,
    stockStatus: filterValues.Stock ? STOCK_VALUE_MAP[filterValues.Stock] : undefined,
    productType: filterValues.Type || undefined,
    vendor: filterValues.Vendor || undefined,
  };

  const { data, isLoading } = useProducts(params);
  const { data: productTypes } = useProductTypes();
  const { data: vendors } = useProductVendors();
  const { data: stats, isLoading: statsLoading } = useProductStats();
  console.log(stats, "stats");

  const statsArray = stats ? Object.entries(stats) : [];

  const products = data?.data ?? [];
  const meta = data?.meta;
  const totalPages = meta?.totalPages ?? 1;
  const categoryFilters = ["All", ...(productTypes ?? [])];

  // Every selected product across pages; rows visible on the current page are
  // taken fresh from the list so status/tag changes show up in the bar.
  const selectedProducts = useMemo(() => {
    const byId = new Map(selected);
    for (const p of products) if (byId.has(p.id)) byId.set(p.id, p);
    return [...byId.values()];
  }, [products, selected]);
  const selectedOnPageCount = products.filter((p) => selected.has(p.id)).length;
  const allOnPageSelected =
    products.length > 0 && selectedOnPageCount === products.length;
  const allFiltersSelected = activeFilters.length === FILTER_OPTIONS.length;
  // The catalog is genuinely empty (not just filtered/searched to zero results).
  // When true, the search/sort/filter controls are pointless, so we disable them.
  const hasActiveQuery = searchQuery.trim() !== "" || activeFilters.length > 0;
  const noProducts = !isLoading && products.length === 0 && !hasActiveQuery;

  // Reset to the first page once the debounced search term settles, so we don't
  // land on an out-of-range page after the result set changes.
  useEffect(() => {
    setCurrentPage(1);
  }, [debouncedSearch, filterValues]);

  function handleSearchChange(event: React.ChangeEvent<HTMLInputElement>) {
    setSearchQuery(event.target.value);
  }

  function handleTypeFilter(type: string) {
    setSelectedType(type);
    setCurrentPage(1);
  }

  function toggleSelect(product: Product, checked: boolean) {
    setSelected((prev) => {
      const next = new Map(prev);
      if (checked) next.set(product.id, product);
      else next.delete(product.id);
      return next;
    });
  }

  function toggleSelectAllOnPage(checked: boolean) {
    setSelected((prev) => {
      const next = new Map(prev);
      if (checked) products.forEach((p) => next.set(p.id, p));
      else products.forEach((p) => next.delete(p.id));
      return next;
    });
  }

  async function handleExport() {
    setExporting(true);
    try {
      await productService.downloadExportCsv({
        search: debouncedSearch || undefined,
        status: filterValues.Status ? STATUS_VALUE_MAP[filterValues.Status] : undefined,
        productType: filterValues.Type || undefined,
        vendor: filterValues.Vendor || undefined,
      });
    } catch (err) {
      handleMutationError(err, "Failed to export CSV.");
    } finally {
      setExporting(false);
    }
  }

  function getStatCards(stats: ProductStatsResponse) {
    return STAT_CARDS.map(({ key, label, icon }) => ({
      label,
      icon,
      value: stats[key],
    }));
  }

  function getStatChartData(stats: ProductStatsResponse) {
    return STAT_CARDS.map(({ key, label }) => ({
      name: label,
      value: stats[key],
    }));
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
            <Button
              variant="outline"
              size="action"
              onClick={() => setImportOpen(true)}
              title="Import products from a Shopify-format CSV"
            >
              <Upload className="size-3.5" />
              Import
            </Button>
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
            <Button
              variant="brand"
              size="action"
              onClick={() => setCreatingProduct(true)}
            >
              <Plus className="size-3.5" />
              Add Product
            </Button>
          </div>
        )}
      </div>

      <ProductCodesDialog open={codesOpen} onOpenChange={setCodesOpen} />

      {/* Bulk action bar — only visible when at least one product is selected */}
      {!isVendor && selectedProducts.length > 0 && (
        <BulkActionBar
          selectedProducts={selectedProducts}
          offPageCount={selectedProducts.length - selectedOnPageCount}
          onClear={() => setSelected(new Map())}
        />
      )}

      {/* Stat cards */}
      <div className="grid grid-cols-1  sm:grid-cols-2 lg:grid-cols-4  bg-white p-3 rounded-xl gap-5">
        {statsLoading ? (
          Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="rounded-xl bg-white dark:bg-gray-900 p-5 shadow-sm ring-1 ring-border">
              <Skeleton className="h-3 w-24 mb-4" />
              <Skeleton className="h-7 w-20" />
            </div>
          ))
        ) : stats ? (
          STAT_CARDS.map(({ key, label, icon }, i, arr) => (
            <div key={key} className="flex items-center gap-4">
              <StatCard
                variant="inline"
                label={label}
                value={stats[key].toLocaleString()}
                change={0}
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
            <StatCard key={key} variant="inline" label={label} value="—" change={0} icon={icon} />
          ))
        )}
      </div>



      {/* Products table */}
      <div className="rounded-xl bg-white dark:bg-gray-900 shadow-sm ring-1 ring-border overflow-hidden p-2">
        {/* Search and filter */}
        <div className="flex flex-col  gap-2 pt-1 pb-2">
          <div className="flex items-center gap-3">
            <div className="relative flex-1 ">
              <Search className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                type="text"
                placeholder="Search by name or SKU…"
                value={searchQuery}
                onChange={handleSearchChange}
                disabled={noProducts}
                className="h-8 w-full rounded-lg border border-input bg-white dark:bg-gray-900 pl-8 pr-3 text-xs focus:outline-none focus:ring-2 focus:ring-[#CEF17B]/50 disabled:opacity-50 disabled:cursor-not-allowed"
              />
            </div>
            <div className="flex items-center gap-1.5">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="secondary" disabled={noProducts}>
                    <ArrowUpDown className="size-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-44">
                  <DropdownMenuLabel>Sort by</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {SORT_OPTIONS.map((opt) => (
                    <DropdownMenuCheckboxItem
                      key={opt.label}
                      checked={sortBy === opt.sortBy && sortOrder === opt.sortOrder}
                      onCheckedChange={() => {
                        setSortBy(opt.sortBy);
                        setSortOrder(opt.sortOrder);
                        setCurrentPage(1);
                      }}
                    >
                      {opt.label}
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              {/* <Filter className="size-3.5 text-muted-foreground" />
                {categoryFilters.map((filterName) => (
                  <button
                    key={filterName}
                    onClick={() => handleTypeFilter(filterName)}
                    className={`h-7 rounded-full px-3 text-xs font-medium transition-colors ${selectedType === filterName
                      ? "bg-[#CEF17B]/30 text-[#084734]"
                      : "bg-white dark:bg-gray-900 text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 border border-input"
                      }`}
                  >
                    {filterName}
                  </button>
                ))} */}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {/* Added filter badges — each opens a dropdown of its values */}
            {activeFilters.map((name) => {
              const options =
                name === "Type" ? (productTypes ?? [])
                  : name === "Vendor" ? (vendors ?? [])
                    : FILTER_VALUES[name as (typeof FILTER_OPTIONS)[number]];
              const selected = filterValues[name];
              return (
                <span
                  key={name}
                  className="inline-flex items-center rounded-full bg-[#CEF17B]/30 text-[#084734] text-xs font-medium"
                >
                  <DropdownMenu>
                    <DropdownMenuTrigger className="inline-flex items-center gap-1 rounded-l-full px-2.5 py-1 focus:outline-none">
                      {name}
                      {selected && <span className="opacity-70">: {selected}</span>}
                      <ChevronDown className="size-3" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-40">
                      {options.length === 0 ? (
                        <DropdownMenuItem disabled>No options</DropdownMenuItem>
                      ) : (
                        options.map((opt) => (
                          <DropdownMenuCheckboxItem
                            key={opt}
                            checked={selected === opt}
                            onCheckedChange={(c) =>
                              setFilterValues((prev) => ({ ...prev, [name]: c ? opt : "" }))
                            }
                          >
                            {opt}
                          </DropdownMenuCheckboxItem>
                        ))
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <button
                    type="button"
                    onClick={() => {
                      setActiveFilters((prev) => prev.filter((f) => f !== name));
                      setFilterValues((prev) => {
                        const next = { ...prev };
                        delete next[name];
                        return next;
                      });
                    }}
                    title={`Remove ${name}`}
                    className="px-1.5 py-1 hover:text-red-600"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              );
            })}

            {/* Add Filter dropdown — only shows not-yet-added options */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline" disabled={allFiltersSelected || noProducts}>
                  <Plus size={15} absoluteStrokeWidth={true} />
                  Add Filter
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-40">
                {FILTER_OPTIONS.filter((opt) => !activeFilters.includes(opt)).map((opt) => (
                  <DropdownMenuItem
                    key={opt}
                    onSelect={() => setActiveFilters((prev) => [...prev, opt])}
                  >
                    {opt}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {isLoading ? (
          <TableSkeleton rows={6} columns={gstEnabled ? 10 : 8} />
        ) : products.length === 0 ? (
          <EmptyState
            title="No products found"
            description={searchQuery ? "Try adjusting your search or filters." : "Connect a channel to sync your products."}
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-gray-50/60 dark:bg-gray-800/60 text-left">
                    <th className="w-10 px-4 py-3">
                      <input type="checkbox" checked={allOnPageSelected} onChange={(e) => toggleSelectAllOnPage(e.target.checked)} aria-label="Select all products on this page" className="size-3.5 accent-[#CEF17B] cursor-pointer" />
                    </th>
                    <th className="px-4 py-3 text-xs font-semibold text-muted-foreground">Product</th>
                    <th className="px-4 py-3 text-xs font-semibold text-muted-foreground">Type</th>
                    <th className="px-4 py-3 text-xs font-semibold text-muted-foreground">Vendor</th>
                    <th className="px-4 py-3 text-xs font-semibold text-muted-foreground text-right">Price</th>
                    <th className="px-4 py-3 text-xs font-semibold text-muted-foreground text-right">
                  {/* Deliberately a cross-location total, the way Shopify's own
                      product list works. The Inventory screen is the
                      per-location view; saying so here stops the two figures
                      reading as a contradiction. */}
                  <Tip text="Total across every location. Open Inventory to see and edit stock at one location.">
                    <span className="cursor-help underline decoration-dotted underline-offset-4">
                      Stock · all locations
                    </span>
                  </Tip>
                </th>
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
                      className={`hover:bg-gray-50/50 dark:hover:bg-gray-800/50 transition-colors cursor-pointer ${selected.has(product.id) ? "bg-[#CEF17B]/10" : ""
                        }`}
                      onClick={() => navigate(`/products/${product.id}`)}
                    >
                      <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selected.has(product.id)}
                          onChange={(e) => toggleSelect(product, e.target.checked)}
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
                        {/* A catalogue price is in the CHANNEL's currency, not
                            the workspace's — a USD store's $749.95 snowboard
                            was being listed as "₹749.95". Falls back to the org
                            currency for a channel whose currency is not yet
                            known (no order has arrived from it). */}
                        {(() => {
                          const priceCurrency = product.channel?.currency ?? orgCurrency;
                          return product.priceRange.min === product.priceRange.max
                            ? formatCurrency(product.priceRange.min, priceCurrency)
                            : `${formatCurrency(product.priceRange.min, priceCurrency)} – ${formatCurrency(product.priceRange.max, priceCurrency)}`;
                        })()}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {/* Links into the per-location view, filtered to this
                            product. The number used to be a dead end, which is
                            why nobody found where stock was edited. */}
                        <Link
                          to={`/products/inventory?search=${encodeURIComponent(product.title)}`}
                          // The whole row navigates to the product; without this
                          // the row handler wins and the stock link never fires.
                          onClick={(e) => e.stopPropagation()}
                          className={`text-xs font-medium hover:underline ${product.totalStock === 0 ? "text-red-600" : product.totalStock <= lowStockThreshold ? "text-orange-600" : "text-gray-900 dark:text-gray-100"}`}
                        >
                          {product.totalStock.toLocaleString()}
                        </Link>
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
          </>
        )}
      </div>

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

