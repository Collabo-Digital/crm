import { lazy, Suspense, useState, type ReactNode } from "react";
import { Link } from "react-router";
import {
  BadgeCheck,
  ChartColumn,
  CircleDot,
  KeyRound,
  Receipt,
  Store,
  Table2,
  Unlock,
  type LucideIcon,
} from "lucide-react";

import { Button } from "~/components/ui/button";
import {
  PageHeader,
  PageHeaderActions,
  PageHeaderContent,
  PageHeaderDescription,
  PageHeaderTitle,
} from "~/components/ui/page-header";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Skeleton } from "~/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/ui/table";
import { DateRangeFilter } from "~/components/app/date-range-filter";
import { EmptyState } from "~/components/app/empty-state";
import { QueryErrorState } from "~/components/app/query-error-state";
import { SectionCard } from "~/components/app/section-card";
import { SegmentedTabs } from "~/components/app/segmented-tabs";
import { StatCard } from "~/components/app/stat-card";
import type { PosDailyPoint } from "~/components/app/pos-daily-sales-chart";
import {
  type CustomDateRange,
  type DateRangePreset,
  useDateRangeFilter,
} from "~/hooks/use-date-range-filter";
import { useWarehouses } from "~/hooks/use-inventory-queries";
import { useCurrentOrg } from "~/hooks/use-org-queries";
import { usePosActivity, usePosSummary } from "~/hooks/use-pos-report-queries";
import { isString, oneOf, useSessionState } from "~/hooks/use-session-state";
import { formatDateTime } from "~/lib/format-date";
import { calendarDaysAgo, formatDayRange, reportingTimeZone, todayIn } from "~/lib/reporting-date";
import { cn, formatCurrency } from "~/lib/utils";
import type {
  PosActivityEntry,
  PosPaymentMethod,
  PosReportParams,
  PosReportSummary,
} from "~/types/api";

// Lazy so the page shell and its request start while recharts downloads.
const PosDailySalesChart = lazy(() =>
  import("~/components/app/pos-daily-sales-chart").then((m) => ({
    default: m.PosDailySalesChart,
  }))
);

/** Matches the chart's rendered height so the card doesn't resize when it lands. */
const chartSkeleton = <Skeleton className="h-[220px] w-full" />;

export function meta() {
  return [{ title: "Store reports | Collabo CRM" }];
}

type PosRange = "today" | "yesterday" | "7d" | "month";

const RANGE_OPTIONS: ReadonlyArray<DateRangePreset<PosRange>> = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "7d", label: "Last 7 days" },
  { value: "month", label: "This month" },
];

/**
 * The days a preset covers, in the org's reporting zone. "Last 7 days" is 7
 * full days plus today: the same window the dashboard's "Last 7 days" covers.
 */
function periodDays(preset: PosRange, custom: CustomDateRange | null, timeZone: string): CustomDateRange {
  if (custom) return custom;
  const today = todayIn(timeZone);
  switch (preset) {
    case "today":
      return { from: today, to: today };
    case "yesterday": {
      const yesterday = calendarDaysAgo(1, timeZone);
      return { from: yesterday, to: yesterday };
    }
    case "7d":
      return { from: calendarDaysAgo(7, timeZone), to: today };
    case "month":
      return { from: `${today.slice(0, 8)}01`, to: today };
  }
}

const ALL_STORES = "all";
type ReportTab = "sales" | "activity";
const TABS: ReadonlyArray<{ value: ReportTab; label: string }> = [
  { value: "sales", label: "Sales" },
  { value: "activity", label: "Activity" },
];

export default function PosReportsPage() {
  const { data: org } = useCurrentOrg();
  const timeZone = reportingTimeZone(org?.timezone);
  const range = useDateRangeFilter<PosRange>("posReports.range", "today", RANGE_OPTIONS);
  const days = periodDays(range.preset, range.custom, timeZone);
  const [tab, setTab] = useSessionState<ReportTab>("posReports.tab", "sales", oneOf(["sales", "activity"]));
  const [storeId, setStoreId] = useSessionState("posReports.store", ALL_STORES, isString);

  const { data: warehouses } = useWarehouses();
  const stores = (warehouses ?? []).filter((w) => w.isActive);
  // A remembered store that has since been closed is no filter at all.
  const knownStore = !warehouses || stores.some((s) => s.id === storeId);
  const selectedStore = storeId !== ALL_STORES && knownStore ? storeId : undefined;

  const params: PosReportParams = {
    from: days.from,
    to: days.to,
    ...(selectedStore && { storeId: selectedStore }),
  };

  return (
    <div className="space-y-5">
      <PageHeader>
        <PageHeaderContent>
          <PageHeaderTitle>Store reports</PageHeaderTitle>
          <PageHeaderDescription>
            What your stores billed at the counter, and what happened at the till.
          </PageHeaderDescription>
        </PageHeaderContent>
        <PageHeaderActions className="max-md:w-full">
          <DateRangeFilter
            presets={RANGE_OPTIONS}
            preset={range.preset}
            custom={range.custom}
            label={range.label}
            today={todayIn(timeZone)}
            onPresetChange={range.selectPreset}
            onCustomApply={range.applyCustom}
          />
          {/* Sales only: the activity log is kept for the whole organisation. */}
          {tab === "sales" && stores.length > 1 && (
            <Select value={selectedStore ?? ALL_STORES} onValueChange={setStoreId}>
              <SelectTrigger
                aria-label="Store"
                className="h-8 min-w-0 max-w-full rounded-lg border border-input bg-card px-2.5 text-caption font-medium shadow-sm sm:w-48"
              >
                <Store className="size-3.5 text-muted-foreground" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_STORES}>All stores</SelectItem>
                {stores.map((store) => (
                  <SelectItem key={store.id} value={store.id}>
                    {store.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </PageHeaderActions>
      </PageHeader>

      <SegmentedTabs items={TABS} value={tab} onChange={setTab} ariaLabel="Report" idPrefix="pos-report" />

      <div role="tabpanel" id={`pos-report-panel-${tab}`} aria-labelledby={`pos-report-tab-${tab}`}>
        {tab === "sales" ? (
          <SalesReport
            params={params}
            periodLabel={range.label}
            fallbackCurrency={org?.currency ?? "INR"}
          />
        ) : (
          <ActivityLog from={days.from} to={days.to} periodLabel={range.label} />
        )}
      </div>
    </div>
  );
}

// ─── Sales ──────────────────────────────────────────────────────────────────

const METHOD_LABEL: Record<PosPaymentMethod, string> = {
  CASH: "Cash",
  UPI: "UPI",
  CARD: "Card",
  OTHER: "Other",
};

function SalesReport({
  params,
  periodLabel,
  fallbackCurrency,
}: {
  params: PosReportParams;
  periodLabel: string;
  fallbackCurrency: string;
}) {
  const { data, isLoading, isError, refetch, isPlaceholderData } = usePosSummary(params);

  if (isError && !data) {
    return <QueryErrorState resource="the store report" onRetry={() => void refetch()} />;
  }

  const currency = data?.currency ?? fallbackCurrency;
  const money = (amount: number) => formatCurrency(amount, currency);
  const totals = data?.totals;
  const owing = data?.partPaid.orders ?? 0;

  return (
    <div className={cn("space-y-4 transition-opacity", isPlaceholderData && "opacity-50")}>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 2xl:grid-cols-6">
        <StatCard label="Sales" value={totals && money(totals.sales)} isLoading={isLoading} />
        <StatCard label="Bills" value={totals?.orders.toLocaleString("en-IN")} isLoading={isLoading} />
        <StatCard label="Average bill" value={totals && money(totals.avgBill)} isLoading={isLoading} />
        <StatCard label="Items sold" value={totals?.itemsSold.toLocaleString("en-IN")} isLoading={isLoading} />
        <StatCard label="Discounts" value={totals && money(totals.discounts)} isLoading={isLoading} />
        <StatCard
          label="Balance due"
          value={totals && money(totals.balanceDue)}
          isLoading={isLoading}
          changeLabel={
            data
              ? owing > 0
                ? `On ${owing} ${owing === 1 ? "bill" : "bills"} not paid in full`
                : "Every bill is paid in full"
              : undefined
          }
        />
      </div>

      {data && data.unconvertedOrders > 0 && (
        <p className="text-caption text-warning">
          {data.unconvertedOrders} {data.unconvertedOrders === 1 ? "bill is" : "bills are"} left out
          of these figures because {data.unconvertedOrders === 1 ? "its" : "their"} exchange rate is
          not known yet.
        </p>
      )}

      {isLoading || !data ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-48 w-full rounded-xl" />
          ))}
        </div>
      ) : data.totals.orders === 0 ? (
        <div className="rounded-xl bg-card px-5 py-12 ring-1 ring-border">
          <EmptyState
            icon={Receipt}
            title="No store sales in this period"
            description="Bills rung up at the point of sale appear here. Try a longer period or another store."
          />
        </div>
      ) : (
        <>
          <DailySales data={data.byDay} currency={currency} periodLabel={periodLabel} />
          <div className="grid items-start gap-4 lg:grid-cols-2">
            <StoresCard report={data} money={money} />
            <StaffCard report={data} money={money} />
            <PaymentsCard report={data} money={money} />
            <TopProductsCard report={data} money={money} />
          </div>
        </>
      )}
    </div>
  );
}

function DailySales({
  data,
  currency,
  periodLabel,
}: {
  data: PosDailyPoint[];
  currency: string;
  periodLabel: string;
}) {
  const [asTable, setAsTable] = useState(false);
  // One bar is not a chart; the Sales tile already says it.
  const chartable = data.length > 1;

  return (
    <SectionCard
      title="Sales by day"
      description={periodLabel}
      action={
        chartable && (
          <Button variant="outline" size="sm" onClick={() => setAsTable((v) => !v)} aria-pressed={asTable}>
            {asTable ? <ChartColumn /> : <Table2 />}
            {asTable ? "Show chart" : "Show table"}
          </Button>
        )
      }
    >
      {!chartable ? (
        <p className="px-5 py-6 text-caption text-muted-foreground">
          Pick a period longer than one day to see sales day by day.
        </p>
      ) : asTable ? (
        <ul className="divide-y divide-border">
          {data.map((day) => (
            <li key={day.date} className="flex items-baseline justify-between gap-3 px-5 py-2.5 text-body">
              <span className="text-foreground">{formatDayRange(day.date, day.date)}</span>
              <span className="text-right">
                <span className="font-semibold tabular-nums text-foreground">{formatCurrency(day.sales, currency)}</span>
                <span className="ml-2 text-caption text-muted-foreground">{billsLabel(day.orders)}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="px-3 pb-3 pt-4">
          <Suspense fallback={chartSkeleton}>
            <PosDailySalesChart data={data} currency={currency} />
          </Suspense>
        </div>
      )}
    </SectionCard>
  );
}

type Money = (amount: number) => string;

function StoresCard({ report, money }: { report: PosReportSummary; money: Money }) {
  return (
    <SectionCard title="Stores" description="Sales at each store, largest first.">
      <ReportRows
        rows={report.byStore}
        rowKey={(r) => r.storeId ?? "none"}
        columns={[
          { label: "Store", cell: (r) => <Name muted={!r.storeId}>{r.storeName}</Name> },
          { label: "Bills", align: "right", cell: (r) => r.orders.toLocaleString("en-IN") },
          { label: "Sales", align: "right", cell: (r) => money(r.sales) },
          { label: "Share", cell: (r) => <Share value={r.sales} total={report.totals.sales} /> },
        ]}
        card={(r) => ({
          title: <Name muted={!r.storeId}>{r.storeName}</Name>,
          value: money(r.sales),
          sub: billsLabel(r.orders),
          extra: <Share value={r.sales} total={report.totals.sales} />,
        })}
      />
    </SectionCard>
  );
}

function StaffCard({ report, money }: { report: PosReportSummary; money: Money }) {
  return (
    <SectionCard title="Staff" description="Who billed what, by the PIN they unlocked point of sale with.">
      <ReportRows
        rows={report.byStaff}
        rowKey={(r) => r.posStaffId ?? "none"}
        columns={[
          { label: "Staff", cell: (r) => <Name muted={!r.posStaffId}>{r.name}</Name> },
          { label: "Bills", align: "right", cell: (r) => r.orders.toLocaleString("en-IN") },
          { label: "Sales", align: "right", cell: (r) => money(r.sales) },
          { label: "Average bill", align: "right", cell: (r) => money(r.avgBill) },
        ]}
        card={(r) => ({
          title: <Name muted={!r.posStaffId}>{r.name}</Name>,
          value: money(r.sales),
          sub: `${billsLabel(r.orders)} · average ${money(r.avgBill)}`,
        })}
      />
    </SectionCard>
  );
}

function PaymentsCard({ report, money }: { report: PosReportSummary; money: Money }) {
  // Other is shown only when it was used; cash, UPI and card always are.
  const rows = report.byPayment.filter((p) => p.method !== "OTHER" || p.count > 0);
  const { paid, balanceDue } = report.totals;

  return (
    <SectionCard title="Payment methods" description="How the period's bills were paid.">
      <ReportRows
        rows={rows}
        rowKey={(r) => r.method}
        columns={[
          { label: "Method", cell: (r) => <Name>{METHOD_LABEL[r.method]}</Name> },
          { label: "Payments", align: "right", cell: (r) => r.count.toLocaleString("en-IN") },
          { label: "Amount", align: "right", cell: (r) => money(r.amount) },
          { label: "Share", cell: (r) => <Share value={r.amount} total={paid} /> },
        ]}
        card={(r) => ({
          title: <Name>{METHOD_LABEL[r.method]}</Name>,
          value: money(r.amount),
          sub: `${r.count.toLocaleString("en-IN")} ${r.count === 1 ? "payment" : "payments"}`,
          extra: <Share value={r.amount} total={paid} />,
        })}
      />
      <p className="border-t px-5 py-3 text-caption text-muted-foreground">
        {money(paid)} taken in all.
        {balanceDue > 0 &&
          ` ${money(balanceDue)} is still to collect on ${report.partPaid.orders} ${report.partPaid.orders === 1 ? "bill" : "bills"}.`}
      </p>
    </SectionCard>
  );
}

function TopProductsCard({ report, money }: { report: PosReportSummary; money: Money }) {
  return (
    <SectionCard title="Top products" description="The ten that sold the most units.">
      <ReportRows
        rows={report.topProducts}
        rowKey={(r) => r.variantId ?? `title:${r.title}`}
        columns={[
          { label: "Product", cell: (r) => <Name wrap>{r.title}</Name> },
          { label: "Units", align: "right", cell: (r) => r.quantity.toLocaleString("en-IN") },
          { label: "Sales", align: "right", cell: (r) => money(r.sales) },
        ]}
        card={(r) => ({
          title: <Name wrap>{r.title}</Name>,
          value: money(r.sales),
          sub: `${r.quantity.toLocaleString("en-IN")} ${r.quantity === 1 ? "unit" : "units"}`,
        })}
      />
    </SectionCard>
  );
}

interface ReportColumn<T> {
  label: string;
  align?: "right";
  cell: (row: T) => ReactNode;
}

/** A table from md up; below it, one card per row so nothing scrolls sideways. */
function ReportRows<T>({
  rows,
  rowKey,
  columns,
  card,
}: {
  rows: T[];
  rowKey: (row: T) => string;
  columns: ReportColumn<T>[];
  card: (row: T) => { title: ReactNode; value: ReactNode; sub?: ReactNode; extra?: ReactNode };
}) {
  return (
    <>
      <ul className="divide-y divide-border md:hidden">
        {rows.map((row) => {
          const c = card(row);
          return (
            <li key={rowKey(row)} className="space-y-1.5 px-5 py-3">
              <div className="flex items-baseline justify-between gap-3">
                <div className="min-w-0 flex-1 text-body">{c.title}</div>
                <p className="shrink-0 text-body font-semibold tabular-nums text-foreground">{c.value}</p>
              </div>
              {c.sub && <p className="text-caption text-muted-foreground">{c.sub}</p>}
              {c.extra}
            </li>
          );
        })}
      </ul>
      <div className="hidden md:block">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              {columns.map((col) => (
                <TableHead
                  key={col.label}
                  className={cn("px-5 text-caption text-muted-foreground", col.align === "right" && "text-right")}
                >
                  {col.label}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={rowKey(row)}>
                {columns.map((col) => (
                  <TableCell
                    key={col.label}
                    className={cn("px-5 text-body", col.align === "right" && "text-right tabular-nums")}
                  >
                    {col.cell(row)}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </>
  );
}

function Name({ children, muted, wrap }: { children: ReactNode; muted?: boolean; wrap?: boolean }) {
  return (
    <span
      className={cn(
        "font-medium",
        muted ? "text-muted-foreground" : "text-foreground",
        wrap ? "whitespace-normal break-words" : "block truncate",
      )}
    >
      {children}
    </span>
  );
}

/** Share of a total as a meter: the track is a lighter step of the fill's own colour. */
function Share({ value, total }: { value: number; total: number }) {
  const pct = total > 0 ? Math.max(0, Math.min(100, (value / total) * 100)) : 0;
  return (
    <div className="flex min-w-24 items-center gap-2">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-brand-strong/20">
        <div className="h-full rounded-full bg-brand-strong" style={{ width: `${pct}%` }} />
      </div>
      <span className="w-9 shrink-0 text-right text-caption tabular-nums text-muted-foreground">
        {Math.round(pct)}%
      </span>
    </div>
  );
}

function billsLabel(count: number): string {
  return `${count.toLocaleString("en-IN")} ${count === 1 ? "bill" : "bills"}`;
}

// ─── Activity ───────────────────────────────────────────────────────────────

const ACTIVITY_FILTERS = [
  { value: "all", label: "All" },
  { value: "sale", label: "Sales" },
  { value: "approval", label: "Approvals" },
  { value: "pin_failed", label: "Wrong PINs" },
  { value: "unlock", label: "Unlocks" },
] as const;
type ActivityFilter = (typeof ACTIVITY_FILTERS)[number]["value"];

const PAGE = 50;
/** The server's own ceiling on one page. */
const MAX_ENTRIES = 200;

function ActivityLog({ from, to, periodLabel }: { from: string; to: string; periodLabel: string }) {
  const [type, setType] = useSessionState<ActivityFilter>(
    "posReports.activity",
    "all",
    oneOf(ACTIVITY_FILTERS.map((f) => f.value)),
  );
  const [limit, setLimit] = useState(PAGE);
  const { data, isLoading, isError, refetch, isPlaceholderData } = usePosActivity({
    from,
    to,
    limit,
    ...(type !== "all" && { type }),
  });

  return (
    <div className="space-y-4">
      <SegmentedTabs
        items={ACTIVITY_FILTERS}
        value={type}
        onChange={(next) => {
          setType(next);
          setLimit(PAGE);
        }}
        ariaLabel="Show"
        behaviour="filter"
      />
      <SectionCard title="Point of sale activity" description={periodLabel}>
        {isError && !data ? (
          <div className="p-8">
            <QueryErrorState resource="the activity log" onRetry={() => void refetch()} />
          </div>
        ) : isLoading || !data ? (
          <div className="space-y-3 p-5">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : data.items.length === 0 ? (
          <div className="px-5 py-12">
            <EmptyState
              icon={CircleDot}
              title="Nothing happened at point of sale in this period"
              description="Sales, approvals, wrong PINs and unlocks are logged here as they happen."
            />
          </div>
        ) : (
          <div className={cn("transition-opacity", isPlaceholderData && "opacity-50")}>
            <ul className="divide-y divide-border">
              {data.items.map((entry) => (
                <ActivityRow key={entry.id} entry={entry} />
              ))}
            </ul>
            {data.hasMore && (
              <div className="flex flex-wrap items-center justify-between gap-2 border-t px-5 py-3 text-caption text-muted-foreground">
                <span>Showing the latest {data.items.length} entries.</span>
                {limit < MAX_ENTRIES && (
                  <Button variant="outline" size="sm" onClick={() => setLimit((n) => Math.min(n + PAGE, MAX_ENTRIES))}>
                    Show more
                  </Button>
                )}
              </div>
            )}
          </div>
        )}
      </SectionCard>
    </div>
  );
}

const ACTIVITY_LOOK: Record<string, { icon: LucideIcon; label: string; tone: string }> = {
  sale: { icon: Receipt, label: "Sale", tone: "bg-muted text-foreground" },
  approval: { icon: BadgeCheck, label: "Approval", tone: "bg-info-subtle text-info" },
  pin_failed: { icon: KeyRound, label: "Wrong PIN", tone: "bg-danger-subtle text-danger" },
  unlock: { icon: Unlock, label: "Unlock", tone: "bg-muted text-foreground" },
};

/** "price_override" → "Price override", for types this page has no wording for yet. */
function humanize(type: string): string {
  const words = type.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function describe(entry: PosActivityEntry): string {
  const staff = entry.staff?.name;
  switch (entry.type) {
    case "sale":
      return `${staff ?? "Someone without a staff PIN"} billed ${entry.order?.name ?? "a sale"}.`;
    case "approval":
      return entry.approvedBy
        ? `${entry.approvedBy.name} approved a request${staff ? ` from ${staff}` : ""}.`
        : `A request${staff ? ` from ${staff}` : ""} was approved.`;
    case "pin_failed":
      return "A wrong PIN was entered.";
    case "unlock":
      return `${staff ?? "Someone"} unlocked point of sale.`;
    default:
      return `${humanize(entry.type)}${staff ? ` by ${staff}` : ""}.`;
  }
}

/** The reason or note the till recorded with an entry, when it gave one. */
function detailNote(details: PosActivityEntry["details"]): string | null {
  for (const key of ["reason", "message", "note"]) {
    const value = details?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function ActivityRow({ entry }: { entry: PosActivityEntry }) {
  const look = ACTIVITY_LOOK[entry.type] ?? { icon: CircleDot, label: humanize(entry.type), tone: "bg-muted text-foreground" };
  const Icon = look.icon;
  const note = detailNote(entry.details);

  return (
    <li className="flex items-start gap-3 px-5 py-3">
      <span className={cn("mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full", look.tone)}>
        <Icon className="size-4" aria-hidden />
      </span>
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="text-body text-foreground">
          <span className="font-semibold">{look.label}.</span> {describe(entry)}
        </p>
        {note && <p className="break-words text-caption text-foreground/80">{note}</p>}
        <p className="flex flex-wrap gap-x-2 text-caption text-muted-foreground">
          <time dateTime={entry.createdAt}>{formatDateTime(entry.createdAt)}</time>
          {entry.deviceUser && <span>Signed in as {entry.deviceUser.name}</span>}
          {entry.order && (
            <Link to={`/orders/${entry.order.id}`} className="font-medium text-brand-strong hover:underline">
              Open {entry.order.name}
            </Link>
          )}
        </p>
      </div>
    </li>
  );
}
