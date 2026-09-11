import { isAxiosError } from "axios";
import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { Search, Download, Plus, ChevronLeft, ChevronRight, Clock, X, AlertTriangle } from "lucide-react";

import {
  PageHeader,
  PageHeaderContent,
  PageHeaderTitle,
  PageHeaderDescription,
  PageHeaderActions,
} from "~/components/ui/page-header";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Button } from "~/components/ui/button";
import { Separator } from "~/components/ui/separator";
import { Skeleton } from "~/components/ui/skeleton";
import { SectionCard } from "~/components/app/section-card";
import { StatCard } from "~/components/app/stat-card";
import { SegmentedTabs } from "~/components/app/segmented-tabs";
import { InvoicesTable } from "~/components/app/invoices-table";
import { InvoiceDetailDialog } from "~/components/app/invoice-detail-dialog";
import { CreditNoteDialog } from "~/components/app/credit-note-dialog";
import { CancelInvoiceDialog } from "~/components/app/cancel-invoice-dialog";
import {
  Gstr1B2bPanel,
  Gstr1B2clPanel,
  Gstr1B2csPanel,
  Gstr1HsnPanel,
  Gstr1DocumentsPanel,
  Gstr1NilRatedPanel,
  Gstr1CreditNotePanel,
} from "~/components/app/gstr1-panels";
import {
  Gstr3bOutwardPanel,
  Gstr3bOutwardReverseChargePanel,
  Gstr3bOtherSuppliesPanel,
  Gstr3bInterStatePanel,
} from "~/components/app/gstr3b-panels";
import {
  GstFilingSidebar,
  type ReturnType,
} from "~/components/app/gst-filing-sidebar";
import { EmptyState } from "~/components/app/empty-state";
import { TableSkeleton } from "~/components/app/table-skeleton";
import { QueryErrorState } from "~/components/app/query-error-state";
import { useRefundsPendingCredit } from "~/hooks/use-invoice-queries";
import { DismissibleWarning } from "~/components/app/dismissible-warning";
import { InwardSuppliesPanel } from "~/components/app/inward-supplies-panel";
import {
  useInvoices,
  useInvoiceStats,
  useGstReturn,
  useGstFilings,
} from "~/hooks/use-invoice-queries";
import { useInvoiceActionGates } from "~/hooks/use-invoice-action-gates";
import { useCurrentOrg } from "~/hooks/use-org-queries";
import { useGstins } from "~/hooks/use-gst-queries";
import { useWarehouses } from "~/hooks/use-inventory-queries";
import {
  MarkFiledDialog,
  ReopenPeriodDialog,
} from "~/components/app/mark-filed-dialog";
import { useDebounced } from "~/hooks/use-debounced";
import { invoiceService } from "~/services/invoice.service";
import { downloadBlob } from "~/lib/download-blob";
import { formatCurrency } from "~/lib/utils";
import {
  MONTHS,
  b2bSectionTotals,
  daysUntil,
  financialYearOptions,
  formatPeriodLabel,
  getCurrentFinancialYear,
  getCurrentPeriod,
  outwardSupplyTotals,
  returnDueDate,
} from "~/lib/gst-return";
import type {
  RefundPendingCredit,
  InvoiceDetail,
  GstFiling,
  GstReturnGstr1,
  GstReturnGstr3B,
  Invoice,
  InvoiceListParams,
  InvoiceSortField,
  InvoiceStats,
  OrganizationGstin,
} from "~/types/api";

export function meta() {
  return [
    { title: "Invoices | Collabo CRM" },
    { name: "description", content: "GST invoices and tax return summaries" },
  ];
}

const PAGE_SIZE = 15;

type Tab = "invoices" | "filing";
type Chip = "all" | "unpaid" | "b2b" | "cancelled";

/**
 * Chip → the list filter it applies. `all` deliberately carries none.
 *
 * There is no `drafts` chip: `InvoiceStatus.DRAFT` exists in the enum but no
 * code path ever writes it, so the chip could only ever show zero and match
 * nothing. It comes back with a real draft-invoice lifecycle.
 */
const CHIP_FILTERS: Record<Chip, Partial<InvoiceListParams>> = {
  all: {},
  unpaid: { paymentState: "UNPAID" },
  b2b: { buyerType: "B2B" },
  cancelled: { status: "CANCELLED" },
};

const CHIPS: ReadonlyArray<Chip> = ["all", "unpaid", "b2b", "cancelled"];
const FY_OPTIONS = financialYearOptions();
const SORT_FIELDS: ReadonlyArray<InvoiceSortField> = [
  "invoiceDate",
  "invoiceNumber",
  "buyerName",
  "subtotal",
  "totalTax",
  "grandTotal",
];

/** "1 – 24 Aug 2026" — the window the month-to-date figures cover. */
function formatStatsWindow(stats: InvoiceStats): string {
  const start = new Date(stats.periodStart);
  const end = new Date(stats.periodEnd);
  const endLabel = end.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  return `${start.getDate()} – ${endLabel}`;
}

/**
 * Message for a failed GST-return request.
 *
 * The server carries real remedies in its message — notably the 413 for a
 * period with more invoices than the return builder will assemble, which names
 * the actual count and tells the merchant to file per GSTIN or pick a single
 * month. Showing a generic "something went wrong" would throw that away.
 */
function returnErrorMessage(error: unknown): string {
  if (isAxiosError(error)) {
    const data = error.response?.data as { message?: string } | undefined;
    if (data?.message) return data.message;
  }
  return "Something went wrong building this return. Please try again.";
}

export default function InvoicesPage() {
  const [searchParams, setSearchParams] = useSearchParams();

  // Tab, return type, period, financial year, filters, page and the open
  // invoice all live in the URL. The design links across them — the due banner
  // jumps to the filing view and the sidebar crosses between GSTR-1 and
  // GSTR-3B — and local state cannot express those as real links. It also means
  // a filtered list, a chosen year and an open invoice all survive a reload and
  // can be pasted to a colleague, and the back button behaves.
  const tab = (searchParams.get("tab") as Tab) ?? "invoices";
  const returnType = (searchParams.get("return") as ReturnType) ?? "GSTR1";
  const period = searchParams.get("period") ?? getCurrentPeriod();

  const fyParam = searchParams.get("fy");
  const financialYear =
    fyParam && FY_OPTIONS.includes(fyParam) ? fyParam : getCurrentFinancialYear();

  const chipParam = searchParams.get("chip") as Chip | null;
  const chip: Chip = chipParam && CHIPS.includes(chipParam) ? chipParam : "all";

  const pageParam = Number(searchParams.get("page"));
  const currentPage = Number.isInteger(pageParam) && pageParam > 0 ? pageParam : 1;

  const sortParam = searchParams.get("sort") as InvoiceSortField | null;
  const sortBy: InvoiceSortField =
    sortParam && SORT_FIELDS.includes(sortParam) ? sortParam : "invoiceDate";
  const sortOrder = searchParams.get("order") === "asc" ? "asc" : "desc";

  const dateFrom = searchParams.get("from") ?? "";
  const dateTo = searchParams.get("to") ?? "";
  const sellerGstinId = searchParams.get("gstin") ?? "";
  // Reference-only lens over the return. Kept in the URL like every other
  // filter so a scoped view is shareable and survives a reload.
  const warehouseScopeId = searchParams.get("warehouse") ?? "";
  const selectedInvoiceId = searchParams.get("invoice");

  // Search stays local so typing is instant; only the debounced value reaches
  // the query key and the URL.
  const [searchQuery, setSearchQuery] = useState(
    () => searchParams.get("q") ?? "",
  );
  const debouncedSearch = useDebounced(searchQuery, 350);

  const [invoiceToCredit, setInvoiceToCredit] = useState<InvoiceDetail | null>(
    null,
  );
  // A refunded order picked from the banner. Carries the refund figures so the
  // dialog can pre-fill instead of making someone re-key an amount off Shopify.
  const [pendingCreditTarget, setPendingCreditTarget] =
    useState<RefundPendingCredit | null>(null);
  const [invoiceToCancel, setInvoiceToCancel] = useState<{
    id: string;
    invoiceNumber: string;
  } | null>(null);
  const [downloading, setDownloading] = useState<"list" | "return" | null>(null);

  const { data: org } = useCurrentOrg();
  const currency = org?.currency ?? "INR";
  const { canIssue, canCancel } = useInvoiceActionGates();

  // Only used to decide whether a GSTIN filter is worth showing at all — a
  // single-registration org has nothing to filter by.
  const { data: gstins = [] } = useGstins();
  const activeGstins = gstins.filter((g: OrganizationGstin) => g.isActive);

  // Which periods are locked. Keyed by FY so switching year refetches.
  const filings = useGstFilings(financialYear);
  const [markingFiled, setMarkingFiled] = useState(false);
  const [reopening, setReopening] = useState<GstFiling | null>(null);

  // A filing covers one registration, one period and one return. `?? null` on
  // both sides so "filed for all registrations" matches the unscoped view.
  const currentFiling =
    (filings.data ?? []).find(
      (f) =>
        f.financialYear === financialYear &&
        f.period.toUpperCase() === period.toUpperCase() &&
        f.returnType === returnType &&
        (f.sellerGstinId ?? null) === (sellerGstinId || null),
    ) ?? null;

  const warehouses = useWarehouses();
  const activeWarehouses = (warehouses.data ?? []).filter((w) => w.isActive);
  const scopedWarehouse =
    activeWarehouses.find((w) => w.id === warehouseScopeId) ?? null;

  /**
   * Patch the URL. `null` deletes a key so it stops appearing in the address
   * bar once cleared, and any change other than paging itself resets to page 1
   * — otherwise narrowing a filter while on page 4 lands on an empty page.
   */
  function patchParams(patch: Record<string, string | null>) {
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        for (const [key, value] of Object.entries(patch)) {
          if (value === null || value === "") next.delete(key);
          else next.set(key, value);
        }
        if (!("page" in patch)) next.delete("page");
        return next;
      },
      { replace: true },
    );
  }

  const listParams: InvoiceListParams = {
    page: currentPage,
    limit: PAGE_SIZE,
    financialYear,
    search: debouncedSearch || undefined,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
    sellerGstinId: sellerGstinId || undefined,
    sortBy,
    sortOrder,
    ...CHIP_FILTERS[chip],
  };

  const {
    data: invoiceData,
    isLoading,
    isError,
    refetch,
  } = useInvoices(listParams);
  const { data: stats, isLoading: statsLoading } = useInvoiceStats({
    financialYear,
  });

  // Driven BY the stats count, not the other way round: a healthy org never
  // issues this query at all.
  const { data: pendingCredits } = useRefundsPendingCredit(
    (stats?.refundsNeedingCreditNote ?? 0) > 0,
  );

  const invoices = invoiceData?.data ?? [];
  const meta = invoiceData?.meta;
  const totalPages = meta?.totalPages ?? 1;

  const {
    data: returnData,
    isLoading: returnLoading,
    error: returnError,
  } = useGstReturn(
    tab === "filing"
      ? {
          financialYear,
          period,
          returnType,
          // A multi-registration org files ONE RETURN PER GSTIN. Omitting this
          // produced a merged return that matched no return they actually file.
          sellerGstinId: sellerGstinId || undefined,
          // Reference view only — never a filing. See the banner below.
          dispatchWarehouseId: warehouseScopeId || undefined,
        }
      : null,
  );

  const periodLabel = formatPeriodLabel(financialYear, period) ?? period;
  const gstr1DueDate = returnDueDate(financialYear, period, "GSTR1");
  const gstr1DaysLeft = gstr1DueDate ? daysUntil(gstr1DueDate) : null;

  const hasFilters =
    chip !== "all" ||
    !!searchQuery ||
    !!dateFrom ||
    !!dateTo ||
    !!sellerGstinId;

  function handleSearch(event: React.ChangeEvent<HTMLInputElement>) {
    const value = event.target.value;
    setSearchQuery(value);
    patchParams({ q: value || null });
  }

  /** Clicking the active column flips direction; a new column starts descending. */
  function handleSort(field: InvoiceSortField) {
    if (field === sortBy) {
      patchParams({ order: sortOrder === "asc" ? "desc" : "asc" });
      return;
    }
    patchParams({ sort: field, order: "desc" });
  }

  function clearFilters() {
    setSearchQuery("");
    patchParams({
      chip: null,
      q: null,
      from: null,
      to: null,
      gstin: null,
    });
  }

  async function download(
    kind: "list" | "return",
    fetcher: () => Promise<Blob>,
    filename: string,
    errorMessage: string,
  ) {
    // Tracked per button. A single shared flag disabled the GST-return download
    // while an invoice CSV was in flight, and vice versa.
    setDownloading(kind);
    try {
      await downloadBlob(fetcher, filename, errorMessage);
    } finally {
      setDownloading(null);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader>
        <PageHeaderContent>
          <PageHeaderTitle>Invoices</PageHeaderTitle>
          <PageHeaderDescription>
            GST invoices and tax return summaries for your business.
          </PageHeaderDescription>
        </PageHeaderContent>
        <PageHeaderActions>
          <Button
            variant="outline"
            size="action"
            disabled={downloading !== null}
            onClick={() =>
              download(
                "list",
                // Exports exactly what the table is showing: the server shares
                // one `where` builder between the list and the export, so the
                // search box, date range and chips all reach the file.
                () => invoiceService.exportCsv(listParams),
                `invoices-${financialYear}.csv`,
                "Could not export invoices. Please try again.",
              )
            }
          >
            <Download className="size-3.5" />
            Export CSV
          </Button>
          {/* Invoices are raised against an order, so this goes to the order
              list rather than to a standalone create form — there isn't one.
              Hidden for roles the server would reject at POST /invoices. */}
          {canIssue && (
            <Button variant="brand" size="action" asChild>
              <Link to="/orders" title="Pick an order to raise an invoice against">
                <Plus className="size-3.5" />
                New invoice
              </Link>
            </Button>
          )}
        </PageHeaderActions>
      </PageHeader>

      {/* View switch */}
      <div className="flex flex-wrap items-center gap-3">
        <SegmentedTabs
          items={[
            { value: "invoices", label: "Invoices" },
            { value: "filing", label: "GST filing" },
          ]}
          value={tab}
          onChange={(next) => patchParams({ tab: next })}
          ariaLabel="Invoice views"
          idPrefix="view"
        />
        {/* The financial year was pinned at mount with no setter, so no prior
            year — or prior year's return — was reachable from the UI. */}
        <Select
          value={financialYear}
          onValueChange={(next) => patchParams({ fy: next })}
        >
          <SelectTrigger className="h-8 w-30 text-caption" aria-label="Financial year">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FY_OPTIONS.map((year) => (
              <SelectItem key={year} value={year} className="text-caption">
                FY {year}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Hoisted out of the invoices-only filter bar. A GST return is filed
            PER REGISTRATION, so this must scope the filing tab too — while it
            lived under `tab === "invoices"` a multi-state business could only
            ever see one merged return that matched nothing they file. */}
        {activeGstins.length > 1 && (
          <Select
            value={sellerGstinId || "all"}
            onValueChange={(next) =>
              patchParams({ gstin: next === "all" ? null : next })
            }
          >
            <SelectTrigger className="h-8 w-45 text-caption" aria-label="Seller GSTIN">
              <SelectValue placeholder="All GSTINs" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all" className="text-caption">
                All GSTINs
              </SelectItem>
              {activeGstins.map((gstin: OrganizationGstin) => (
                <SelectItem key={gstin.id} value={gstin.id} className="text-caption">
                  {gstin.gstin} — {gstin.stateName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {/* Reference lens, filing tab only. A GST return has no warehouse
            dimension — see the strip below the picker. */}
        {tab === "filing" && activeWarehouses.length > 1 && (
          <Select
            value={warehouseScopeId || "all"}
            onValueChange={(next) =>
              patchParams({ warehouse: next === "all" ? null : next })
            }
          >
            <SelectTrigger className="h-8 w-45 text-caption" aria-label="Dispatch warehouse">
              <SelectValue placeholder="All warehouses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all" className="text-caption">
                All warehouses
              </SelectItem>
              {activeWarehouses.map((w) => (
                <SelectItem key={w.id} value={w.id} className="text-caption">
                  {w.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {tab === "invoices" ? (
        <div
          role="tabpanel"
          id="view-panel-invoices"
          aria-labelledby="view-tab-invoices"
          className="space-y-6"
        >
          {/* KPI row */}
          <div className="grid grid-cols-1 gap-5 rounded-xl bg-card p-3 sm:grid-cols-2 lg:grid-cols-4">
            {statsLoading || !stats ? (
              Array.from({ length: 4 }).map((_, index) => (
                <div key={index} className="p-5">
                  <Skeleton className="mb-4 h-3 w-24" />
                  <Skeleton className="h-7 w-20" />
                </div>
              ))
            ) : (
              [
                {
                  key: "invoiced",
                  label: "Invoiced this month",
                  value: formatCurrency(stats.invoicedThisMonth.amount, currency, {
                    maximumFractionDigits: 0,
                  }),
                  change: stats.invoicedThisMonth.changePct ?? undefined,
                  changeLabel: formatStatsWindow(stats),
                },
                {
                  key: "tax",
                  label: "Tax collected",
                  value: formatCurrency(stats.taxCollected.amount, currency, {
                    maximumFractionDigits: 0,
                  }),
                  change: stats.taxCollected.changePct ?? undefined,
                  changeLabel: "CGST + SGST + IGST",
                },
                {
                  key: "outstanding",
                  label: "Outstanding",
                  value: formatCurrency(stats.outstanding.amount, currency, {
                    maximumFractionDigits: 0,
                  }),
                  changeLabel: `${stats.outstanding.invoiceCount} invoices unpaid`,
                },
                {
                  key: "issued",
                  label: "Issued",
                  value: stats.counts.issued.toLocaleString("en-IN"),
                  changeLabel: `of ${stats.counts.all} in FY ${financialYear}`,
                },
              ].map((card, index, all) => (
                <div key={card.key} className="flex items-center gap-4">
                  <StatCard
                    variant="inline"
                    label={card.label}
                    value={card.value}
                    change={card.change}
                    changeLabel={card.changeLabel}
                    className="flex-1"
                  />
                  {index < all.length - 1 && (
                    <Separator orientation="vertical" className="hidden h-15 md:block" />
                  )}
                </div>
              ))
            )}
          </div>

          {/* Filing reminder */}
          {gstr1DueDate && gstr1DaysLeft !== null && gstr1DaysLeft >= 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-brand px-5 py-3">
              <p className="flex items-center gap-2 text-caption text-brand-foreground">
                <Clock className="size-4 shrink-0" />
                <span>
                  <strong className="font-semibold">
                    GSTR-1 for {periodLabel} is due in {gstr1DaysLeft}{" "}
                    {gstr1DaysLeft === 1 ? "day" : "days"}.
                  </strong>{" "}
                  {stats
                    ? `${stats.counts.issued} issued invoices in FY ${financialYear}.`
                    : null}
                </span>
              </p>
              <Button
                variant="brand"
                size="sm"
                onClick={() => patchParams({ tab: "filing", return: "GSTR1" })}
              >
                Review filing
              </Button>
            </div>
          )}

          {/* Filters */}
          <div className="flex flex-wrap items-center gap-3">
            <SegmentedTabs
              items={[
                { value: "all", label: "All", count: stats?.counts.all },
                { value: "unpaid", label: "Unpaid", count: stats?.counts.unpaid },
                { value: "b2b", label: "B2B", count: stats?.counts.b2b },
                {
                  value: "cancelled",
                  label: "Cancelled",
                  count: stats?.counts.cancelled,
                },
              ]}
              value={chip}
              onChange={(next) => patchParams({ chip: next === "all" ? null : next })}
              ariaLabel="Filter invoices"
              behaviour="filter"
            />

            {/* Date range. The server reads these as calendar days in the
                merchant's timezone, so they agree with the GST return. */}
            <div className="flex items-center gap-1.5">
              <label className="text-micro text-muted-foreground" htmlFor="invoice-from">
                From
              </label>
              <input
                id="invoice-from"
                type="date"
                value={dateFrom}
                max={dateTo || undefined}
                onChange={(event) => patchParams({ from: event.target.value || null })}
                className="h-8 rounded-lg border border-input bg-transparent px-2 text-caption focus:outline-none focus:ring-2 focus:ring-brand/50"
              />
              <label className="text-micro text-muted-foreground" htmlFor="invoice-to">
                to
              </label>
              <input
                id="invoice-to"
                type="date"
                value={dateTo}
                min={dateFrom || undefined}
                onChange={(event) => patchParams({ to: event.target.value || null })}
                className="h-8 rounded-lg border border-input bg-transparent px-2 text-caption focus:outline-none focus:ring-2 focus:ring-brand/50"
              />
            </div>

            {hasFilters && (
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                <X className="size-3.5" />
                Clear
              </Button>
            )}
          </div>

          <SectionCard
            title="All invoices"
            description={`Every GST invoice raised against an order in FY ${financialYear}.`}
            action={
              <div className="relative min-w-50 max-w-xs flex-1">
                <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <input
                  type="search"
                  placeholder="Invoice #, buyer or GSTIN…"
                  value={searchQuery}
                  onChange={handleSearch}
                  aria-label="Search invoices"
                  className="h-8 w-full rounded-lg border border-input bg-transparent pl-8 pr-3 text-caption placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-brand/50"
                />
              </div>
            }
          >
            {/* Error MUST precede loading and empty: a failed request leaves
                isLoading false and data undefined, so the empty branch was
                reached and the user was told no invoices existed. `!invoiceData`
                keeps a failed background refetch from blanking a live table. */}
            {isError && !invoiceData ? (
              <div className="p-8">
                <QueryErrorState resource="invoices" onRetry={() => refetch()} />
              </div>
            ) : isLoading ? (
              <div className="p-4">
                <TableSkeleton rows={PAGE_SIZE} columns={9} />
              </div>
            ) : invoices.length === 0 ? (
              <div className="p-8">
                <EmptyState
                  title="No invoices found"
                  description={
                    hasFilters
                      ? "Try adjusting your search or filters."
                      : `No GST invoices were raised in FY ${financialYear}. Generate one from an order to see it here.`
                  }
                />
              </div>
            ) : (
              <InvoicesTable
                invoices={invoices}
                currency={currency}
                canCancel={canCancel}
                sortBy={sortBy}
                sortOrder={sortOrder}
                onSortChange={handleSort}
                onSelect={(id) => patchParams({ invoice: id, page: String(currentPage) })}
                onCancel={(invoice: Invoice) =>
                  setInvoiceToCancel({
                    id: invoice.id,
                    invoiceNumber: invoice.invoiceNumber,
                  })
                }
              />
            )}

            {!isLoading && invoices.length > 0 && (
              <div className="flex items-center justify-between border-t px-5 py-3">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    patchParams({ page: String(Math.max(1, currentPage - 1)) })
                  }
                  disabled={currentPage === 1}
                >
                  <ChevronLeft className="size-3.5" />
                  Previous
                </Button>
                <p className="text-caption text-muted-foreground">
                  Page {meta?.page ?? 1} of {totalPages} ({meta?.total ?? 0} total)
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    patchParams({
                      page: String(Math.min(totalPages, currentPage + 1)),
                    })
                  }
                  disabled={currentPage >= totalPages}
                >
                  Next
                  <ChevronRight className="size-3.5" />
                </Button>
              </div>
            )}
          </SectionCard>
        </div>
      ) : (
        <div
          role="tabpanel"
          id="view-panel-filing"
          aria-labelledby="view-tab-filing"
          className="space-y-6"
        >
          {/* Data-integrity warnings. These sit ABOVE the return itself on purpose:
              both describe reasons the figures below may not be what the merchant
              should file, and both were previously invisible in the product.

              Each is dismissible, but only for the count that raised it — see
              DismissibleWarning. Some of these cannot be cleared quickly (no
              product in the live catalogues carries an HSN code, and adding them
              is hours of data entry), and a warning that can be neither quieted
              nor acted on is one people learn to look past. */}
          {stats && stats.uninvoicedPaidOrders > 0 && (
            <DismissibleWarning
              id="uninvoiced-orders"
              scope={org?.id}
              signature={stats.uninvoicedPaidOrders}
              label="paid orders with no invoice"
            >
              <p>
                <strong className="font-semibold">
                  {stats.uninvoicedPaidOrders} paid{" "}
                  {stats.uninvoicedPaidOrders === 1 ? "order has" : "orders have"} no
                  invoice.
                </strong>{" "}
                Their tax is missing from every return below. Auto-invoicing may
                have failed, or never run — it only fires on live Shopify
                webhooks, and only when it is switched on in Settings → Orders.
                Open the order to see the reason and issue the invoice.
              </p>
            </DismissibleWarning>
          )}
          {stats && stats.refundsNeedingCreditNote > 0 && (
            <DismissibleWarning
              id="refunds-pending-credit"
              scope={org?.id}
              signature={stats.refundsNeedingCreditNote}
              label="refunds without a credit note"
            >
              <>
                <p>
                  <strong className="font-semibold">
                    {stats.refundsNeedingCreditNote} refunded{" "}
                    {stats.refundsNeedingCreditNote === 1 ? "order is" : "orders are"}{" "}
                    not fully credited.
                  </strong>{" "}
                  Until one is raised, the full sale value stays in your declared tax
                  — a refund does not reduce it on its own.
                </p>
                {pendingCredits && pendingCredits.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {pendingCredits.slice(0, 5).map((r) => (
                      <li key={r.invoiceId} className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-micro">{r.invoiceNumber}</span>
                        <span className="text-micro text-muted-foreground">
                          {r.orderName} ·{" "}
                          {formatCurrency(Number(r.pendingAmount), r.currency)}{" "}
                          uncredited
                          {Number(r.creditedAmount) > 0 && (
                            <>
                              {" "}
                              (of{" "}
                              {formatCurrency(
                                Number(r.refundedAmount),
                                r.currency,
                              )}{" "}
                              refunded)
                            </>
                          )}
                        </span>
                        <button
                          type="button"
                          onClick={() => setPendingCreditTarget(r)}
                          className="text-micro font-medium text-brand-strong underline-offset-2 hover:underline"
                        >
                          Raise credit note
                        </button>
                      </li>
                    ))}
                    {pendingCredits.length > 5 && (
                      <li className="text-micro text-muted-foreground">
                        and {pendingCredits.length - 5} more
                      </li>
                    )}
                  </ul>
                )}
              </>
            </DismissibleWarning>
          )}
          {stats && stats.invoicesMissingHsn > 0 && (
            <DismissibleWarning
              id="missing-hsn"
              scope={org?.id}
              signature={stats.invoicesMissingHsn}
              label="invoices missing an HSN code"
            >
              <p>
                <strong className="font-semibold">
                  {stats.invoicesMissingHsn}{" "}
                  {stats.invoicesMissingHsn === 1 ? "invoice has" : "invoices have"}{" "}
                  a line with no HSN code.
                </strong>{" "}
                GSTR-1 table 12 cannot be filed until every product is classified.
                Add HSN codes in Products, then reissue those invoices.
              </p>
            </DismissibleWarning>
          )}
          {stats && stats.taxMismatches > 0 && (
            <DismissibleWarning
              id="tax-mismatch"
              scope={org?.id}
              signature={stats.taxMismatches}
              label="invoices whose declared tax differs from the tax charged"
            >
              <p>
                <strong className="font-semibold">
                  {stats.taxMismatches}{" "}
                  {stats.taxMismatches === 1 ? "invoice declares" : "invoices declare"}{" "}
                  a different tax than the sales channel charged.
                </strong>{" "}
                Your CRM tax configuration and your store’s may have drifted apart.
                Reconcile before filing.
              </p>
            </DismissibleWarning>
          )}
          {scopedWarehouse && (
            <div className="flex items-start gap-2 rounded-xl bg-warning-subtle px-5 py-3">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
              <p className="text-caption">
                <strong className="font-semibold">
                  Showing only sales dispatched from {scopedWarehouse.name}.
                </strong>{" "}
                For your reference — a GST return is filed per GSTIN, not per
                warehouse, and the portal has no field for one. Clear the
                warehouse filter before using these figures to file.
              </p>
            </div>
          )}
          {stats && stats.invoicesFromUnlinkedWarehouse > 0 && (
            <DismissibleWarning
              id="unlinked-warehouse"
              scope={org?.id}
              signature={stats.invoicesFromUnlinkedWarehouse}
              label="invoices dispatched from a warehouse with no GST registration"
            >
              <p>
                <strong className="font-semibold">
                  {stats.invoicesFromUnlinkedWarehouse}{" "}
                  {stats.invoicesFromUnlinkedWarehouse === 1
                    ? "invoice was"
                    : "invoices were"}{" "}
                  issued from a warehouse that is not linked to a GST registration.
                </strong>{" "}
                Every place of business you invoice from must be declared under a
                registration on the GST portal. Link each warehouse in Products →
                Inventory → Warehouses.
              </p>
            </DismissibleWarning>
          )}
          {activeGstins.length > 1 && !sellerGstinId && (
            <div className="flex items-start gap-2 rounded-xl bg-warning-subtle px-5 py-3">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
              <p className="text-caption">
                <strong className="font-semibold">
                  This return merges all {activeGstins.length} of your registrations.
                </strong>{" "}
                GST returns are filed per GSTIN — pick one above to see a return that
                matches what you actually file.
              </p>
            </div>
          )}
          {/* Return switch and period */}
          <div className="flex flex-wrap items-center gap-3">
            <SegmentedTabs
              items={[
                { value: "GSTR1", label: "GSTR-1" },
                { value: "GSTR3B", label: "GSTR-3B" },
              ]}
              value={returnType}
              onChange={(next) => patchParams({ return: next })}
              ariaLabel="GST return type"
              idPrefix="return"
            />
            <span className="text-caption text-muted-foreground">
              {returnType === "GSTR1"
                ? "Outward supplies · invoice-wise"
                : "Summary return · tax payable"}
            </span>
            <Select value={period} onValueChange={(next) => patchParams({ period: next })}>
              <SelectTrigger className="h-8 w-35 text-caption" aria-label="Return period">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MONTHS.map((month) => (
                  <SelectItem
                    key={month.value}
                    value={month.value}
                    className="text-caption"
                  >
                    {month.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            <div className="space-y-6 lg:col-span-2">
              {returnLoading ? (
                <>
                  <Skeleton className="h-24 w-full rounded-xl" />
                  <Skeleton className="h-64 w-full rounded-xl" />
                </>
              ) : returnError ? (
                /* Error MUST precede the empty state, same as the invoice table above.
                   A failed return request leaves isLoading false and data undefined, so
                   this used to render "No issued invoices" — telling a merchant with a
                   period too large to assemble that they had nothing to file. */
                <div className="rounded-xl bg-card p-8 shadow-sm ring-1 ring-border">
                  <EmptyState
                    title="Could not build this return"
                    description={returnErrorMessage(returnError)}
                  />
                </div>
              ) : !returnData ? (
                <div className="rounded-xl bg-card p-8 shadow-sm ring-1 ring-border">
                  <EmptyState
                    title="No return data"
                    description={`No issued invoices for ${periodLabel}.`}
                  />
                </div>
              ) : returnType === "GSTR1" ? (
                <Gstr1View
                  data={returnData as GstReturnGstr1}
                  currency={currency}
                />
              ) : (
                <Gstr3bView
                  data={returnData as GstReturnGstr3B}
                  currency={currency}
                />
              )}

              {/* Below the return, and outside it. Gateway fees never alter a
                  return figure — a sale keeps its full declared value however
                  much the supplier deducts, and the fee's GST is recovered
                  separately as input tax credit. Rendered here so the claim is
                  visible next to the period it belongs to. */}
              <InwardSuppliesPanel
                financialYear={financialYear}
                period={period}
                currency={currency}
                canEdit={canIssue}
              />
            </div>

            <GstFilingSidebar
              financialYear={financialYear}
              period={period}
              returnType={returnType}
              periodLabel={periodLabel}
              facts={
                returnData
                  ? returnType === "GSTR1"
                    ? gstr1Facts(returnData as GstReturnGstr1, currency)
                    : gstr3bFacts(returnData as GstReturnGstr3B, currency)
                  : []
              }
              onSwitchReturn={(next) => patchParams({ return: next })}
              filing={currentFiling}
              canFile={canIssue}
              scoped={!!warehouseScopeId}
              onMarkFiled={() => setMarkingFiled(true)}
              onReopen={() => setReopening(currentFiling)}
              isDownloading={downloading === "return"}
              onDownloadCsv={() =>
                download(
                  "return",
                  () =>
                    invoiceService.exportGstReturnCsv({
                      financialYear,
                      period,
                      returnType,
                      sellerGstinId: sellerGstinId || undefined,
                      dispatchWarehouseId: warehouseScopeId || undefined,
                    }),
                  `${returnType}-${financialYear}-${period}.csv`,
                  "Could not download the return. Please try again.",
                )
              }
            />
          </div>
        </div>
      )}

      <MarkFiledDialog
        open={markingFiled}
        onClose={() => setMarkingFiled(false)}
        financialYear={financialYear}
        period={period}
        periodLabel={periodLabel}
        returnType={returnType}
        sellerGstinId={sellerGstinId || undefined}
        gstinLabel={
          activeGstins.find((g: OrganizationGstin) => g.id === sellerGstinId)
            ?.gstin ?? "all registrations"
        }
      />
      <ReopenPeriodDialog
        filing={reopening}
        periodLabel={periodLabel}
        onClose={() => setReopening(null)}
      />

      <InvoiceDetailDialog
        invoiceId={selectedInvoiceId}
        currency={currency}
        canCancel={canCancel}
        onClose={() => patchParams({ invoice: null, page: String(currentPage) })}
        onRequestCancel={setInvoiceToCancel}
        onRequestCreditNote={setInvoiceToCredit}
      />

      {/* One dialog, two entry points: the invoice detail view opens it blank,
          the refunds banner opens it pre-filled from the refund. */}
      <CreditNoteDialog
        invoice={
          pendingCreditTarget
            ? {
                id: pendingCreditTarget.invoiceId,
                invoiceNumber: pendingCreditTarget.invoiceNumber,
                grandTotal: pendingCreditTarget.invoiceTotal,
              }
            : invoiceToCredit
        }
        currency={pendingCreditTarget?.currency ?? currency}
        prefill={
          pendingCreditTarget
            ? {
                // The remaining balance, not the gross refund: an order
                // already part-credited would otherwise prefill an amount the
                // server refuses as over-crediting.
                amount: pendingCreditTarget.pendingAmount,
                tax: pendingCreditTarget.pendingTax,
                reason: pendingCreditTarget.reason ?? "Refunded",
              }
            : null
        }
        onClose={() => {
          setInvoiceToCredit(null);
          setPendingCreditTarget(null);
        }}
      />

      <CancelInvoiceDialog
        invoice={invoiceToCancel}
        onClose={() => setInvoiceToCancel(null)}
        // Close the detail dialog too — it would otherwise sit there showing an
        // invoice whose status has just changed underneath it.
        onCancelled={() => patchParams({ invoice: null, page: String(currentPage) })}
      />
    </div>
  );
}

// ── Return views ────────────────────────────────────────────────────────────

/** Compact KPI strip above the return tables. */
function ReturnStats({
  cards,
}: {
  cards: ReadonlyArray<{
    key: string;
    label: string;
    value: string;
    inverted?: boolean;
  }>;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {cards.map((card) => (
        <StatCard
          key={card.key}
          label={card.label}
          value={card.value}
          tone={card.inverted ? "inverted" : "default"}
          className="rounded-xl"
        />
      ))}
    </div>
  );
}

function Gstr1View({
  data,
  currency,
}: {
  data: GstReturnGstr1;
  currency: string;
}) {
  const money = (amount: number) =>
    formatCurrency(amount, currency, { maximumFractionDigits: 0 });

  return (
    <>
      <ReturnStats
        cards={[
          {
            key: "invoices",
            label: "Invoices",
            value: data.totals.totalInvoices.toLocaleString("en-IN"),
          },
          {
            key: "taxable",
            label: "Taxable value",
            value: money(data.totals.totalTaxable),
          },
          {
            key: "cgst-sgst",
            label: "CGST + SGST",
            value: money(data.totals.totalCgst + data.totals.totalSgst),
          },
          { key: "igst", label: "IGST", value: money(data.totals.totalIgst) },
        ]}
      />
      <Gstr1B2bPanel data={data} currency={currency} />
      {/* B2CL and B2CS pair naturally; the HSN table is too wide to sit 2-up
          now that it carries a UQC, rate and tax split, so it goes full width
          like B2B. */}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Gstr1B2clPanel data={data} currency={currency} />
        <Gstr1B2csPanel data={data} currency={currency} />
      </div>
      <Gstr1HsnPanel data={data} currency={currency} />
      <Gstr1CreditNotePanel data={data} currency={currency} />
      <Gstr1NilRatedPanel data={data} currency={currency} />
      <Gstr1DocumentsPanel data={data} currency={currency} />
    </>
  );
}

function Gstr3bView({
  data,
  currency,
}: {
  data: GstReturnGstr3B;
  currency: string;
}) {
  const money = (amount: number) =>
    formatCurrency(amount, currency, { maximumFractionDigits: 0 });
  const totals = outwardSupplyTotals(data.outwardSupplies);

  return (
    <>
      <ReturnStats
        cards={[
          {
            key: "outward",
            label: "Outward taxable value",
            value: money(totals.taxableValue),
          },
          { key: "igst", label: "IGST", value: money(data.taxPayable.igst) },
          {
            key: "cgst-sgst",
            label: "CGST + SGST",
            value: money(data.taxPayable.cgst + data.taxPayable.sgst),
          },
          {
            key: "payable",
            label: "Tax payable",
            value: money(data.taxPayable.total),
            // With no ITC ledger in the system, tax payable *is* the net
            // payable in cash — nothing can be set off against it.
            inverted: true,
          },
        ]}
      />
      <Gstr3bOutwardPanel data={data} currency={currency} />
      <Gstr3bOutwardReverseChargePanel data={data} currency={currency} />
      <Gstr3bOtherSuppliesPanel data={data} currency={currency} />
      <Gstr3bInterStatePanel data={data} currency={currency} />
    </>
  );
}

// ── Sidebar facts ───────────────────────────────────────────────────────────

function gstr1Facts(data: GstReturnGstr1, currency: string) {
  const b2b = b2bSectionTotals(data.b2b);
  const b2cInvoices = data.b2cSummary.reduce(
    (sum, entry) => sum + entry.invoiceCount,
    0,
  );

  return [
    { label: "Invoices in period", value: String(data.totals.totalInvoices) },
    { label: "B2B / B2C", value: `${b2b.invoiceCount} / ${b2cInvoices}` },
    {
      label: "Total tax",
      value: formatCurrency(data.totals.totalTax, currency, {
        maximumFractionDigits: 0,
      }),
    },
  ];
}

function gstr3bFacts(data: GstReturnGstr3B, currency: string) {
  const totals = outwardSupplyTotals(data.outwardSupplies);

  return [
    {
      label: "Taxable value",
      value: formatCurrency(totals.taxableValue, currency, {
        maximumFractionDigits: 0,
      }),
    },
    { label: "Rate slabs", value: String(data.outwardSupplies.length) },
    {
      label: "Tax payable",
      value: formatCurrency(data.taxPayable.total, currency, {
        maximumFractionDigits: 0,
      }),
    },
  ];
}
