import { useEffect, useMemo, useState } from "react";
import { useListUrlState } from "~/hooks/use-list-url-state";
import { AxiosError } from "axios";
import { Link } from "react-router";
import {
  Boxes,
  IndianRupee,
  AlertTriangle,
  PackageX,
  Printer,
  Barcode,
  MapPin,
  Warehouse as WarehouseIcon,
} from "lucide-react";
import { StatCard } from "~/components/app/stat-card";
import { EmptyState } from "~/components/app/empty-state";
import { QueryErrorState } from "~/components/app/query-error-state";
import { TableSkeleton } from "~/components/app/table-skeleton";
import { ModalShell, DialogFooter } from "~/components/app/order-dialog-primitives";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Separator } from "~/components/ui/separator";
import {
  DataTable,
  DateCell,
  MonoCell,
  ProductCell,
  useDataTableState,
  type ColumnDef,
} from "~/components/app/data-table";
import { Skeleton } from "~/components/ui/skeleton";
import { LocationPicker } from "~/components/app/inventory/location-picker";
import { ProductCodesDialog } from "~/components/app/inventory/product-codes-dialog";
import {
  StockSaveBar,
  type PendingChange,
} from "~/components/app/inventory/stock-save-bar";
import { StockExplainer } from "~/components/app/inventory/stock-explainer";
import { InventoryTabs } from "~/components/app/inventory/inventory-tabs";
import { Tip } from "~/components/ui/tooltip";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/components/ui/popover";
import {
  BUCKET_TERMS,
  MANUAL_REASONS,
  STOCK_TERMS,
  reasonLabel,
} from "~/lib/inventory-vocabulary";
import { cn } from "~/lib/utils";
import { useSelectedLocation } from "~/hooks/use-selected-location";
import { useCurrentOrg } from "~/hooks/use-org-queries";
import {
  useCodeStatus,
  useInventoryStatus,
  useStock,
  useStockStats,
} from "~/hooks/use-inventory-queries";
import {
  useCreateAdjustmentMutation,
  useBulkAdjustmentMutation,
} from "~/hooks/use-inventory-mutations";
import type { StockBucket, StockLine, StockListParams } from "~/types/api";

const BUCKETS: StockBucket[] = ["AVAILABLE", "RESERVED", "QC", "DAMAGED"];

/** Stock-level tabs; the value is the API's `stockFilter` (absent for "all"). */
const STOCK_TABS = [
  { value: "all", label: "All stock" },
  { value: "low", label: "Low stock" },
  { value: "out", label: "Out of stock" },
  { value: "oversold", label: "Oversold" },
] as const;
const STOCK_TAB_VALUES = STOCK_TABS.map((t) => t.value);

export default function InventoryPage() {
  const status = useInventoryStatus();

  if (status.isLoading) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">Inventory</h1>
        <TableSkeleton rows={6} columns={5} />
      </div>
    );
  }
  if (status.isError || !status.data) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">Inventory</h1>
        <QueryErrorState resource="inventory" onRetry={() => status.refetch()} />
      </div>
    );
  }
  // The server sets locations up by itself and copies the stock across;
  // `useInventoryStatus` checks back until it has.
  if (!status.data.warehousingEnabled) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">Inventory</h1>
        <div className="rounded-xl bg-card px-4 py-12 shadow-sm ring-1 ring-border">
          <EmptyState
            icon={WarehouseIcon}
            title="Setting up your locations…"
            description="Your current quantities are being copied into your locations. This page updates by itself when it is done."
          />
        </div>
      </div>
    );
  }
  return <StockScreen />;
}

// ─────────────────────────── Stock screen ───────────────────────────

function StockScreen() {
  const { data: currentOrg } = useCurrentOrg();
  const currency = currentOrg?.currency;
  // Page and search live in the URL (`?search=` rather than `?q=`: the products
  // list and product page link a stock number straight here with it), so Back
  // from a product returns to the page the row was opened from.
  const list = useListUrlState("inventory", { searchKey: "search" });
  const {
    locations,
    locationId,
    location,
    setLocationId,
    isLoading: locationLoading,
  } = useSelectedLocation();
  const [adjusting, setAdjusting] = useState<StockLine | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [codesOpen, setCodesOpen] = useState(false);
  // Edited-but-unsaved Available values, keyed by stock line. Cleared whenever
  // the rows underneath change, so a draft can never be written against a row
  // the merchant is no longer looking at.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [reviewOpen, setReviewOpen] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const bulkAdjust = useBulkAdjustmentMutation();

  const setDraft = (stockLineId: string, value: string | undefined) => {
    setSaveError(null);
    setDrafts((prev) => {
      const next = { ...prev };
      if (value === undefined) delete next[stockLineId];
      else next[stockLineId] = value;
      return next;
    });
  };

  // The Available column closes over the drafts, so the definitions are
  // rebuilt as they change; everything else in them is static.
  const columns = useMemo<ColumnDef<StockLine>[]>(
    () => [
      {
        key: "product",
        label: "Product",
        width: 260,
        locked: true,
        sortKey: "product",
        sortType: "text",
        cell: (line) => (
          <ProductCell
            title={line.productTitle}
            sub={line.variantTitle !== "Default Title" ? line.variantTitle : undefined}
            imageUrl={line.imageUrl}
            to={`/products/${line.productId}`}
          />
        ),
      },
      {
        key: "codes",
        label: "SKU / Barcode",
        width: 150,
        sortKey: "sku",
        sortType: "text",
        cell: (line) => (
          <div className="flex min-w-0 flex-col leading-[1.3]">
            {line.sku ? (
              <span className="truncate font-mono text-caption text-foreground">{line.sku}</span>
            ) : (
              <span className="text-caption text-muted-foreground">no SKU</span>
            )}
            {line.barcode && line.barcode !== line.sku && (
              <span className="truncate font-mono text-micro text-muted-foreground">
                {line.barcode}
              </span>
            )}
          </div>
        ),
      },
      {
        key: "bin",
        label: STOCK_TERMS.bin.label,
        headerTooltip: STOCK_TERMS.bin.definition,
        width: 110,
        cell: (line) => <MonoCell value={line.defaultLocation} />,
      },
      {
        key: "unavailable",
        label: STOCK_TERMS.unavailable.label,
        headerTooltip: STOCK_TERMS.unavailable.definition,
        width: 110,
        align: "right",
        cell: (line) => <UnavailableCell line={line} />,
      },
      {
        // Mirrored from Shopify's own committed figure — it is the one
        // quantity the Admin API cannot write, so it is read, never computed.
        key: "committed",
        label: STOCK_TERMS.committed.label,
        headerTooltip: STOCK_TERMS.committed.definition,
        width: 100,
        align: "right",
        cell: (line) => (
          <span className="tabular-nums text-muted-foreground">{line.reserved}</span>
        ),
      },
      {
        key: "available",
        label: STOCK_TERMS.available.label,
        headerTooltip: STOCK_TERMS.available.definition,
        // Badge + struck-through old value + stepper + validation line.
        width: 240,
        minWidth: 240,
        align: "right",
        overflow: "visible",
        sortKey: "available",
        sortType: "number",
        cell: (line) => (
          <AvailableCell
            line={line}
            draft={drafts[line.id]}
            onChange={(value) => setDraft(line.id, value)}
          />
        ),
      },
      {
        key: "onHand",
        label: STOCK_TERMS.onHand.label,
        headerTooltip: STOCK_TERMS.onHand.definition,
        width: 100,
        align: "right",
        sortKey: "onHand",
        sortType: "number",
        cell: (line) => <span className="font-semibold tabular-nums">{line.onHand}</span>,
      },
      {
        key: "updated",
        label: "Updated",
        width: 120,
        hiddenByDefault: true,
        sortKey: "updatedAt",
        sortType: "date",
        cell: (line) => <DateCell value={line.updatedAt} />,
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setDraft is stable in effect
    [drafts],
  );

  const table = useDataTableState({
    key: "inventory",
    list,
    columns,
    tab: { param: "stock", default: "all", values: STOCK_TAB_VALUES },
    sort: { default: { field: "product", dir: "asc" } },
  });
  const sortField = table.sort?.field;
  const sortDir = table.sort?.dir;

  // Selection is by variant id and survives re-filtering, so without this the
  // "Print labels (n)" count keeps counting rows the user can no longer see —
  // and printing a sheet of labels for them is not a recoverable mistake.
  useEffect(() => {
    setSelectedIds(new Set());
  }, [table.debouncedSearch, locationId, table.tab, table.page, table.limit, sortField, sortDir]);

  // Same reasoning as the selection reset above, and more pointed: a draft
  // carried across a location switch would write one location's number onto
  // another's.
  useEffect(() => {
    setDrafts({});
    setReviewOpen(false);
    setSaveError(null);
  }, [table.debouncedSearch, locationId, table.tab, table.page, table.limit, sortField, sortDir]);

  const params: StockListParams = useMemo(
    () => ({
      page: table.page,
      limit: table.limit,
      q: table.debouncedSearch || undefined,
      warehouseId: locationId,
      stockFilter:
        table.tab === "all" ? undefined : (table.tab as StockListParams["stockFilter"]),
      sortBy: sortField as StockListParams["sortBy"],
      sortOrder: sortDir,
    }),
    [table.page, table.limit, table.debouncedSearch, locationId, table.tab, sortField, sortDir],
  );

  // Held until a location resolves. Querying without one returns a row per
  // variant PER location, so the table would flash every product several times
  // over before settling — the exact confusion this screen is fixing.
  const stock = useStock(params, Boolean(locationId));
  // Deliberately warehouse-only: `q` and `stockFilter` narrow the table, not
  // the tiles. Feeding the stock filter in would make "Low stock lines" merely
  // restate the row count and pin "Oversold lines" to 0.
  const stats = useStockStats({ warehouseId: params.warehouseId }, Boolean(locationId));

  const rows = stock.data?.data ?? [];

  const toggleSelect = (line: StockLine, checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(line.variantId);
      else next.delete(line.variantId);
      return next;
    });
  };
  const toggleSelectAllOnPage = (pageRows: ReadonlyArray<StockLine>, checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      pageRows.forEach((r) => (checked ? next.add(r.variantId) : next.delete(r.variantId)));
      return next;
    });
  };

  const fmtMoney = (n: number) =>
    new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency: currency || "INR",
      maximumFractionDigits: 0,
    }).format(n);

  // Mirrors the Products page stat row: one wrapper card, inline tiles with a
  // sparkline, vertical separators between them. Each tile resolves its own
  // em-dash fallback, so the row needs no separate error branch.
  const s = stats.data;
  const STAT_TILES = [
    {
      key: "unitsOnHand",
      label: "Units on hand",
      icon: <Boxes className="size-4" />,
      value: s ? String(s.unitsOnHand) : "—",
      changeLabel: s
        ? `${s.unitsAvailable} available · ${s.unitsReserved} reserved`
        : undefined,
    },
    {
      key: "stockValue",
      label: "Known cost value",
      icon: <IndianRupee className="size-4" />,
      value: s ? fmtMoney(s.stockValue) : "—",
      changeLabel: "On-hand units × recorded cost",
    },
    {
      key: "lowStockLines",
      label: "Low stock lines",
      icon: <AlertTriangle className="size-4" />,
      value: s ? String(s.lowStockLines) : "—",
      changeLabel: s ? `Threshold: ${s.lowStockThreshold}` : undefined,
    },
    {
      key: "oversoldLines",
      label: "Oversold lines",
      icon: <PackageX className="size-4" />,
      value: s ? String(s.oversoldLines) : "—",
      changeLabel: "Available below zero",
    },
  ];

  // The tiles are scoped to the selected location but sit above the picker,
  // so name that location in the heading — otherwise a scoped figure read on
  // its own just looks like a wrong org-wide one.
  const selectedWarehouseName = location?.name ?? null;

  const labelHref =
    selectedIds.size > 0
      ? `/products/inventory/labels/print?variantIds=${[...selectedIds].join(",")}`
      : null;

  // Codes are a CATALOGUE concern, not a location one, so the count comes from
  // the server rather than from these rows. The old toolbar counted the
  // current page's selection while the buttons acted org-wide, so the number
  // beside a button routinely described a different set from the one it
  // changed. Zero means nothing needs fixing and the button drops its badge.
  const codeStatus = useCodeStatus();
  const pendingCodes = codeStatus.data
    ? codeStatus.data.missingSku +
      codeStatus.data.missingBarcode +
      codeStatus.data.longBarcode
    : 0;

  // Only rows whose typed value is a whole number AND differs from what is
  // stored. Typing a value back to its original is not a change.
  const pendingChanges: PendingChange[] = rows.flatMap((line) => {
    const draft = drafts[line.id];
    if (draft === undefined) return [];
    const parsed = Number.parseInt(draft, 10);
    if (!Number.isInteger(parsed) || parsed === line.available) return [];
    return [
      {
        stockLineId: line.id,
        variantId: line.variantId,
        product: line.productTitle,
        variant: line.variantTitle !== "Default Title" ? line.variantTitle : null,
        from: line.available,
        to: parsed,
      },
    ];
  });

  const hasInvalidDraft = rows.some((line) => {
    const draft = drafts[line.id];
    return draft !== undefined && draft.trim() !== "" && !Number.isInteger(Number.parseInt(draft, 10));
  });

  const saveDrafts = () => {
    if (!locationId || pendingChanges.length === 0) return;
    if (hasInvalidDraft) {
      setSaveError("Some quantities are not whole numbers.");
      return;
    }
    setSaveError(null);
    bulkAdjust.mutate(
      {
        warehouseId: locationId,
        reason: "correction",
        note: "Edited from the inventory table",
        items: pendingChanges.map((c) => ({
          variantId: c.variantId,
          bucket: "AVAILABLE" as StockBucket,
          setTo: c.to,
        })),
      },
      {
        onSuccess: () => {
          setDrafts({});
          setReviewOpen(false);
        },
        // Nothing was written — the server applies the batch atomically — so
        // the drafts stay on screen to be corrected rather than lost.
        onError: (error) => {
          setSaveError(
            error instanceof AxiosError
              ? (error.response?.data?.message ?? error.message)
              : "Could not save these quantities.",
          );
        },
      },
    );
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">
          Inventory
          {selectedWarehouseName && (
            <span className="ml-2 font-normal text-muted-foreground">
              · {selectedWarehouseName}
            </span>
          )}
        </h1>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="action"
            onClick={() => setCodesOpen(true)}
          >
            <Barcode className="size-3.5" />
            {pendingCodes > 0 ? `Product codes (${pendingCodes})` : "Product codes"}
          </Button>
          {labelHref ? (
            <Button asChild variant="brand" size="action">
              <Link to={labelHref} target="_blank">
                <Printer className="size-3.5" />
                Print labels ({selectedIds.size})
              </Link>
            </Button>
          ) : (
            <Button size="action" disabled variant="outline" title="Select rows to print labels">
              <Printer className="size-3.5" />
              Print labels
            </Button>
          )}
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 bg-white dark:bg-gray-900 p-3 rounded-xl gap-5">
        {stats.isLoading ? (
          Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="rounded-xl bg-white dark:bg-gray-900 p-5 shadow-sm ring-1 ring-border"
            >
              <Skeleton className="h-3 w-24 mb-4" />
              <Skeleton className="h-7 w-20" />
            </div>
          ))
        ) : (
          STAT_TILES.map(({ key, label, icon, value, changeLabel }, i, arr) => (
            <div key={key} className="flex items-center gap-4">
              <StatCard
                variant="inline"
                label={label}
                value={value}
                changeLabel={changeLabel}
                change={0}
                icon={icon}
                className="flex-1"
              />
              {i < arr.length - 1 && (
                <Separator orientation="vertical" className="hidden md:block h-15" />
              )}
            </div>
          ))
        )}
      </div>

      {/* Filters */}
      <InventoryTabs />

      {location && (
        <StockExplainer
          locationName={location.name}
          locationCount={locations.length}
          stats={stats.data}
        />
      )}

      {/* Location leads: everything in the table below narrows what is
          already scoped to it. It keeps its own picker (full Shopify names,
          unit counts) rather than the table's generic scope control. */}
      <LocationPicker
        locations={locations}
        value={locationId}
        onChange={setLocationId}
      />

      <DataTable
        state={table}
        rows={rows}
        rowKey={(line) => line.id}
        meta={stock.data?.meta}
        status={{
          isLoading: locationLoading || !locationId || stock.isLoading,
          isError: stock.isError,
          isPlaceholderData: stock.isPlaceholderData,
          refetch: stock.refetch,
        }}
        noun="stock lines"
        tabs={{ ariaLabel: "Filter by stock level", items: STOCK_TABS }}
        searchPlaceholder="Search by SKU, barcode or title…"
        selection={{
          isSelected: (line) => selectedIds.has(line.variantId),
          onToggle: toggleSelect,
          onToggleAll: toggleSelectAllOnPage,
          label: (line) => `Select ${line.productTitle}`,
        }}
        rowActions={(line) => (
          <Button variant="outline" size="xs" onClick={() => setAdjusting(line)}>
            Adjust
          </Button>
        )}
        actionsWidth={90}
        emptyState={{
          icon: Boxes,
          title: "Nothing stocked here yet",
          description: location
            ? `No product has stock recorded at ${location.name}. Switch location — stock is held per location, so a product stocked elsewhere will not appear here.`
            : "No stock lines match these filters.",
        }}
      />

      {/* Says the quiet part out loud. The single most common misreading of
          this screen was taking a figure here as the company-wide total. */}
      {location && rows.length > 0 && (
        <p className="text-caption text-muted-foreground">
          Every quantity above is held at {location.name}. Editing one changes
          that location only.
        </p>
      )}

      <StockSaveBar
        changes={pendingChanges}
        locationName={location?.name ?? "this location"}
        reviewOpen={reviewOpen}
        onToggleReview={() => setReviewOpen((v) => !v)}
        onRevert={(id) => setDraft(id, undefined)}
        onDiscard={() => {
          setDrafts({});
          setReviewOpen(false);
          setSaveError(null);
        }}
        onSave={saveDrafts}
        saving={bulkAdjust.isPending}
        error={saveError}
      />

      <ProductCodesDialog open={codesOpen} onOpenChange={setCodesOpen} />

      {adjusting && <AdjustStockDialog line={adjusting} onClose={() => setAdjusting(null)} />}
    </div>
  );
}

// ─────────────────────────── Adjust dialog ───────────────────────────

/**
 * QC and damaged as one figure, the way Shopify groups them under Unavailable,
 * with the split behind a click so the row stays readable. A zero is inert —
 * offering to break down two zeroes on every row of a healthy catalogue would
 * be noise, so only a non-zero figure is interactive.
 */
function UnavailableCell({ line }: { line: StockLine }) {
  const total = line.qc + line.damaged;

  if (total === 0) {
    return <span className="tabular-nums text-muted-foreground">0</span>;
  }

  return (
    <span className="tabular-nums">
      <Popover>
        <PopoverTrigger className="underline decoration-dotted underline-offset-4 hover:text-foreground">
          {total}
        </PopoverTrigger>
        <PopoverContent align="end" className="w-64 p-3">
          <p className="mb-2 text-label font-medium text-foreground">
            {STOCK_TERMS.unavailable.label}
          </p>
          <dl className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-caption text-muted-foreground">
                {BUCKET_TERMS.QC.label}
              </dt>
              <dd className="text-caption font-medium tabular-nums text-foreground">
                {line.qc}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-caption text-muted-foreground">
                {BUCKET_TERMS.DAMAGED.label}
              </dt>
              <dd className="text-caption font-medium tabular-nums text-foreground">
                {line.damaged}
              </dd>
            </div>
          </dl>
          <p className="mt-2.5 border-t border-border pt-2 text-micro text-muted-foreground">
            Not sellable, but still on hand. Use Adjust to move units back to{" "}
            {STOCK_TERMS.available.label}.
          </p>
        </PopoverContent>
      </Popover>
    </span>
  );
}

/**
 * The one editable number on the row.
 *
 * Editing is inline and batched rather than one modal per row: a stocktake
 * means correcting a screenful of quantities, and doing that through a dialog
 * eight times over is the reason merchants gave up and asked where stock was
 * updated. The save bar writes them all at one location in one transaction.
 *
 * While a row is dirty the saved value stays visible, struck through, so the
 * merchant can always see what they are about to change it from.
 */
function AvailableCell({
  line,
  draft,
  onChange,
}: {
  line: StockLine;
  draft: string | undefined;
  onChange: (value: string | undefined) => void;
}) {
  const value = draft ?? String(line.available);
  const dirty = draft !== undefined && draft !== String(line.available);
  const parsed = Number.parseInt(value, 10);
  const invalid = value.trim() !== "" && !Number.isInteger(parsed);

  const step = (by: number) => {
    const base = Number.isInteger(parsed) ? parsed : line.available;
    onChange(String(base + by));
  };

  return (
    <div className="py-1">
      <div className="flex items-center justify-end gap-2">
        {/* Negative available is reachable by design: a counter sale is
            allowed even when THIS location was short, because the merchant has
            already handed the goods over. That is deliberate
            (order.service.ts, allowNegativeAvailable) — but arriving at a red
            minus number with no explanation is what made it feel like a bug. */}
        {line.available < 0 && !dirty && (
          <Tip text={`More units were sold from ${line.warehouse.name} than it held — usually a counter sale fulfilled from stock that was recorded elsewhere. Move stock here, or correct the count.`}>
            <span className="cursor-help rounded-full bg-danger-subtle px-2 py-0.5 text-[10px] font-semibold text-danger">
              Oversold
            </span>
          </Tip>
        )}
        {line.available === 0 && !dirty && (
          <span className="rounded-full bg-warning-subtle px-2 py-0.5 text-[10px] font-semibold text-warning">
            Out of stock
          </span>
        )}
        {dirty && (
          <span className="text-[11px] tabular-nums text-muted-foreground line-through">
            {line.available}
          </span>
        )}
        <div className="inline-flex h-8 items-stretch overflow-hidden rounded-lg border border-border bg-card">
          <button
            type="button"
            onClick={() => step(-1)}
            aria-label={`Decrease available for ${line.productTitle}`}
            className="w-7 border-r border-border text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            −
          </button>
          <input
            type="text"
            inputMode="numeric"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            aria-label={`Available for ${line.productTitle} at ${line.warehouse.name}`}
            className={cn(
              "w-14 bg-transparent text-center text-label font-semibold tabular-nums outline-none",
              dirty && "text-brand-strong",
              invalid && "text-danger",
            )}
          />
          <button
            type="button"
            onClick={() => step(1)}
            aria-label={`Increase available for ${line.productTitle}`}
            className="w-7 border-l border-border text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            +
          </button>
        </div>
      </div>
      {invalid && (
        <p className="mt-1 text-right text-[10px] text-danger">Whole numbers only.</p>
      )}
    </div>
  );
}

function AdjustStockDialog({ line, onClose }: { line: StockLine; onClose: () => void }) {
  const [bucket, setBucket] = useState<StockBucket>("AVAILABLE");
  const [mode, setMode] = useState<"add" | "remove" | "set">("add");
  const [qty, setQty] = useState<string>("");
  const [reason, setReason] = useState<string>("correction");
  const [note, setNote] = useState("");
  const adjust = useCreateAdjustmentMutation();

  const current = { AVAILABLE: line.available, RESERVED: line.reserved, QC: line.qc, DAMAGED: line.damaged }[bucket];
  const parsed = parseInt(qty, 10);
  const valid = Number.isInteger(parsed) && parsed >= 0 && (mode === "set" || parsed > 0);
  const result =
    mode === "set" ? parsed : mode === "add" ? current + parsed : current - parsed;

  const submit = () => {
    if (!valid) return;
    adjust.mutate(
      {
        variantId: line.variantId,
        warehouseId: line.warehouse.id,
        bucket,
        ...(mode === "set"
          ? { setTo: parsed }
          : { delta: mode === "add" ? parsed : -parsed }),
        reason: reason as "correction",
        note: note || undefined,
      },
      { onSuccess: () => onClose() },
    );
  };

  return (
    <ModalShell
      title="Adjust stock"
      subtitle={`${line.productTitle}${line.variantTitle !== "Default Title" ? ` — ${line.variantTitle}` : ""} · ${line.warehouse.name}`}
      onClose={onClose}
    >
      <div className="space-y-4 px-6 py-4 text-xs">
        {/* Names the location before anything else. A merchant working several
            locations needs to know where this lands before they type a
            number, not after. */}
        <p className="flex items-center gap-2 rounded-lg bg-brand/15 px-3 py-2 text-caption font-medium text-brand-strong">
          <MapPin className="size-3.5 shrink-0" />
          Writing to {line.warehouse.name}
        </p>
        <div className="grid grid-cols-2 gap-3">
          <label className="space-y-1">
            <span className="font-medium text-gray-700 dark:text-gray-300">Bucket</span>
            <Select value={bucket} onValueChange={(v) => setBucket(v as StockBucket)}>
              <SelectTrigger className="h-8 w-full rounded-lg text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BUCKETS.map((b) => (
                  <SelectItem key={b} value={b}>
                    {BUCKET_TERMS[b].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="space-y-1">
            <span className="font-medium text-gray-700 dark:text-gray-300">Action</span>
            <Select value={mode} onValueChange={(v) => setMode(v as "add")}>
              <SelectTrigger className="h-8 w-full rounded-lg text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="add">Add units</SelectItem>
                <SelectItem value="remove">Remove units</SelectItem>
                <SelectItem value="set">Set exact value</SelectItem>
              </SelectContent>
            </Select>
          </label>
        </div>
        <label className="block space-y-1">
          <span className="font-medium text-gray-700 dark:text-gray-300">
            {mode === "set" ? "New quantity" : "Units"}
            <span className="ml-2 font-normal text-muted-foreground">
              current: {current}
            </span>
          </span>
          <Input
            type="number"
            min={0}
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            className="h-8 text-xs"
            placeholder="0"
            autoFocus
          />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="space-y-1">
            <span className="font-medium text-gray-700 dark:text-gray-300">Reason</span>
            <Select value={reason} onValueChange={setReason}>
              <SelectTrigger className="h-8 w-full rounded-lg text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MANUAL_REASONS.map((r) => (
                  <SelectItem key={r} value={r}>
                    {reasonLabel(r)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="space-y-1">
            <span className="font-medium text-gray-700 dark:text-gray-300">Note (optional)</span>
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="h-8 text-xs"
              placeholder="e.g. cycle count Aug"
            />
          </label>
        </div>
        {/* What the number becomes, before committing to it. */}
        <div className="flex items-center justify-between gap-3 rounded-lg bg-muted px-3 py-2.5">
          <span className="text-caption text-muted-foreground">
            {BUCKET_TERMS[bucket].label} here after this
          </span>
          <span className="text-label font-semibold tabular-nums text-foreground">
            {current} → {valid ? result : "…"}
          </span>
        </div>
        {mode === "remove" && parsed > current && bucket !== "AVAILABLE" && (
          <p className="rounded-md bg-red-50 px-3 py-2 text-[11px] text-red-700">
            Removing more than the current {BUCKET_TERMS[bucket].label.toLowerCase()} quantity will be rejected.
          </p>
        )}
      </div>
      <DialogFooter
        confirmLabel={mode === "set" ? `Set ${BUCKET_TERMS[bucket].label} to ${valid ? parsed : "…"}` : mode === "add" ? "Add units" : "Remove units"}
        onConfirm={submit}
        onClose={onClose}
        pending={adjust.isPending}
        confirmDisabled={!valid}
      />
    </ModalShell>
  );
}
