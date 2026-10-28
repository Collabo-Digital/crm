import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { ArrowDown, ArrowUp, ChevronRight, ChevronsUpDown, Search, X } from "lucide-react";

import { DateRangeFilter } from "~/components/app/date-range-filter";
import { SegmentedTabs } from "~/components/app/segmented-tabs";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { Tip } from "~/components/ui/tooltip";
import { useClampPage } from "~/hooks/use-list-url-state";
import { formatDayRange } from "~/lib/reporting-date";
import { cn } from "~/lib/utils";
import type { PaginatedResponse } from "~/types/api";

import { ColumnsMenu } from "./columns-menu";
import { AddFilterMenu, FilterChip } from "./filter-chip";
import { ScopeSelect } from "./scope-select";
import { SortMenu } from "./sort-menu";
import { TablePagination } from "./table-pagination";
import {
  SkeletonRows,
  TableEmptyState,
  TableErrorState,
  TableNoResults,
  type EmptyStateSpec,
} from "./table-states";
import { defaultDirFor, sortTypeOf, visibleColumns, type ColumnDef } from "./column";
import type { DataTableState } from "./use-data-table-state";

/**
 * The one list table. A card with: a tab row and Sort / Columns controls; a
 * search row with scope selectors; a chip row (date, filters, "+ Filter",
 * Clear all); a CSS-grid table with a sticky header and a sticky checkbox +
 * first column; skeleton / error / empty / no-results states; a footer with
 * the row summary, rows-per-page and numbered pages.
 *
 * It renders what the page gives it and never fetches. The page owns its query
 * hook, stats cards, header buttons, bulk-action dock and dialogs, and reads
 * everything it needs for its API params from `useDataTableState`.
 *
 * Layout is a grid rather than a `<table>` so the first column can stick while
 * the rest scroll sideways and so hidden columns are just absent tracks. Each
 * row repeats the template; cells clip and ellipsize unless the column opts
 * out.
 */

export interface DataTableStatus {
  isLoading: boolean;
  isError: boolean;
  /** True while rows from the previous query are shown for a new one. */
  isPlaceholderData?: boolean;
  refetch: () => void;
}

export interface DataTableSelection<Row> {
  isSelected: (row: Row) => boolean;
  onToggle: (row: Row, checked: boolean) => void;
  /** Rows on this page only — "select all" never means rows nobody can see. */
  onToggleAll: (rows: ReadonlyArray<Row>, checked: boolean) => void;
  /** Accessible name for a row's box, e.g. "Select order #1001". */
  label?: (row: Row) => string;
}

export interface DataTableTabs {
  items: ReadonlyArray<{ value: string; label: string; count?: number }>;
  ariaLabel?: string;
}

export interface DataTableProps<Row> {
  state: DataTableState<Row>;
  rows: ReadonlyArray<Row>;
  rowKey: (row: Row) => string;
  meta: PaginatedResponse<unknown>["meta"] | undefined;
  status: DataTableStatus;
  /** Plural, lowercase: "orders". Used in the summary and the state copy. */
  noun: string;
  tabs?: DataTableTabs;
  /** False for a list the server cannot search (the stock ledger). */
  searchable?: boolean;
  /** False for a short list the server returns whole (warehouses): no footer. */
  paginated?: boolean;
  searchPlaceholder?: string;
  /** Skipped when the click lands on a link, button, input or `[data-row-stop]`. */
  onRowClick?: (row: Row) => void;
  selection?: DataTableSelection<Row>;
  /** Fixed right-hand column — a ⋯ menu, a Sync button. Stops the row click. */
  rowActions?: (row: Row) => ReactNode;
  /** A focused card body on phones. Other lists use labelled column values. */
  mobileRow?: (row: Row) => ReactNode;
  actionsWidth?: number;
  emptyState: EmptyStateSpec;
  /** Right of Sort / Columns — an export button, a secondary action. */
  toolbarEnd?: ReactNode;
  className?: string;
}

const SELECT_WIDTH = 44;
/** Narrowest a column goes before the table scrolls instead; see `template`. */
const COLUMN_FLOOR = 88;
const NUMERIC_FLOOR = 120;
const LOCKED_FLOOR = 160;
const INTERACTIVE =
  "a, button, input, select, textarea, [role=checkbox], [role=menuitem], [data-row-stop]";

function isInteractiveTarget(event: MouseEvent | KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;
  return Boolean(target?.closest(INTERACTIVE));
}

function localToday(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function DataTable<Row>({
  state,
  rows,
  rowKey,
  meta,
  status,
  noun,
  tabs,
  searchable = true,
  paginated = true,
  searchPlaceholder = `Search ${noun}`,
  onRowClick,
  selection,
  rowActions,
  mobileRow,
  actionsWidth = 56,
  emptyState,
  toolbarEnd,
  className,
}: DataTableProps<Row>) {
  const { config } = state;
  const columns = visibleColumns(config.columns, state.hidden);
  const hasSelection = Boolean(selection);
  const hasActions = Boolean(rowActions);

  // A restored page past the end snaps back; not while the count on screen
  // belongs to the previous query.
  useClampPage(config.list, status.isPlaceholderData ? undefined : meta?.totalPages);

  // ── Grid ───────────────────────────────────────────────────────────────────
  // Columns share the card's width in proportion to their `width` and shrink
  // down to a small floor before the table scrolls sideways, so a normal
  // laptop never sees a horizontal scrollbar. A column that declares
  // `minWidth` (an inline editor) keeps that as a hard floor instead.
  const floorOf = (c: ColumnDef<Row>) => {
    if (c.minWidth) return c.minWidth;
    // Never narrower than its own header label (≈6.5px per character at
    // 12px, plus cell padding and the sort icon); the identity column keeps
    // more, since it is what the row is recognised by.
    const label = Math.ceil(c.label.length * 6.5) + 48;
    // Right-aligned columns hold sums like ₹2,74,640.54, which clip from the
    // left when squeezed, so they keep more of their width.
    const base = Math.min(
      c.width,
      c.locked ? LOCKED_FLOOR : c.align === "right" ? NUMERIC_FLOOR : COLUMN_FLOOR,
    );
    return Math.min(c.width, Math.max(base, label));
  };
  const template = [
    hasSelection ? `${SELECT_WIDTH}px` : null,
    ...columns.map((c) => `minmax(${floorOf(c)}px, ${c.width}fr)`),
    hasActions ? `${actionsWidth}px` : null,
  ]
    .filter(Boolean)
    .join(" ");
  const minWidth =
    (hasSelection ? SELECT_WIDTH : 0) +
    columns.reduce((sum, c) => sum + floorOf(c), 0) +
    (hasActions ? actionsWidth : 0);

  // Horizontal scroll: the sticky columns grow an edge shadow once anything
  // has slid underneath them.
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [scrolledX, setScrolledX] = useState(false);
  function onScroll() {
    const el = scrollerRef.current;
    if (el) setScrolledX(el.scrollLeft > 0);
  }

  const stickyLeft = hasSelection ? SELECT_WIDTH : 0;
  function cellClass(column: ColumnDef<Row>, index: number): string {
    return cn(
      "flex min-w-0 items-center px-4 py-2",
      column.overflow === "visible" ? "overflow-visible" : "overflow-hidden",
      column.align === "right" && "justify-end text-right",
      column.locked && index === 0 && "sticky z-10 bg-inherit",
      column.locked &&
        index === 0 &&
        scrolledX &&
        "shadow-[1px_0_0_var(--border),8px_0_8px_-8px_rgba(0,0,0,0.14)]",
      column.className,
    );
  }
  function cellStyle(column: ColumnDef<Row>, index: number) {
    return column.locked && index === 0 ? { left: stickyLeft } : undefined;
  }

  // ── Search ─────────────────────────────────────────────────────────────────
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!searchable) return;
    function onKey(event: globalThis.KeyboardEvent) {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      // The target can be the document itself (no tagName) when nothing is focused.
      const target = event.target as Partial<HTMLElement> | null;
      const tag = target?.tagName?.toLowerCase();
      const editable = target?.isContentEditable;
      if (tag === "input" || tag === "textarea" || tag === "select" || editable) return;
      event.preventDefault();
      searchRef.current?.focus();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [searchable]);

  // ── Filter chips ───────────────────────────────────────────────────────────
  const filters = config.filters ?? [];
  // A filter picked from "+ Filter" shows as a chip before it has a value.
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [openChip, setOpenChip] = useState<string | null>(null);
  const applied = filters.filter((f) => state.filters[f.key]?.length || f.key === pendingKey);
  // Once the picked value has reached the URL the chip stands on its own.
  const pendingHasValue = Boolean(pendingKey && state.filters[pendingKey]?.length);
  useEffect(() => {
    if (pendingHasValue) setPendingKey(null);
  }, [pendingHasValue]);
  const addable = filters.filter((f) => !applied.includes(f));
  const dateConfig = config.date;
  const dateLabel = state.date
    ? state.date.custom
      ? formatDayRange(state.date.custom.from, state.date.custom.to)
      : (dateConfig?.presets.find((p) => p.value === state.date?.preset)?.label ?? "")
    : "";
  const hasChipRow = Boolean(dateConfig) || filters.length > 0;

  // The search box and scope selectors. They sit on their own row under the
  // tabs; a table without tabs puts them where the tabs would be instead, so
  // the first row never carries an empty stretch beside Sort and Columns.
  const hasTabs = Boolean(tabs && config.tab);
  const scopes = config.scopes ?? [];
  const hasSearchControls = searchable || scopes.length > 0;
  const searchControls = (
    <>
      {searchable && (
        <div className="relative min-w-[60%] flex-1 md:min-w-55 md:max-w-110 md:flex-[1_1_280px]">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground md:left-2.5" />
          <Input
            ref={searchRef}
            type="search"
            value={state.search}
            onChange={(event) => state.setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && state.search) state.setSearch("");
            }}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            className="h-11 rounded-xl bg-muted/50 pl-10 pr-10 text-base md:h-8 md:rounded-lg md:bg-transparent md:pl-8 md:pr-8 md:text-label pointer-coarse:h-11 [&::-webkit-search-cancel-button]:hidden"
          />
          {state.search ? (
            <button
              type="button"
              onClick={() => state.setSearch("")}
              aria-label="Clear search"
              title="Clear search"
              className="absolute right-0 top-1/2 flex size-11 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground md:right-1 md:size-6 pointer-coarse:right-0 pointer-coarse:size-11"
            >
              <X className="size-3.5" />
            </button>
          ) : (
            <kbd
              aria-hidden
              title="Press / to search"
              className="pointer-events-none absolute right-2 top-[7px] hidden h-[18px] min-w-[18px] items-center justify-center rounded-[4px] font-mono text-caption text-muted-foreground ring-1 ring-border md:flex"
            >
              /
            </kbd>
          )}
        </div>
      )}
      {scopes.map((scope) => (
        <ScopeSelect key={scope.key} state={state} def={scope} />
      ))}
    </>
  );

  // ── Selection ──────────────────────────────────────────────────────────────
  const allOnPage = rows.length > 0 && rows.every((r) => selection?.isSelected(r));
  const someOnPage = !allOnPage && rows.some((r) => selection?.isSelected(r));

  // ── Which state to show ────────────────────────────────────────────────────
  const hasRows = rows.length > 0;
  const showError = status.isError && !hasRows;
  const showSkeleton = !showError && status.isLoading && !hasRows;
  const showEmpty =
    !showError && !showSkeleton && !hasRows && !state.hasActiveFilters && state.isDefaultTab;
  const showNoResults = !showError && !showSkeleton && !hasRows && !showEmpty;
  const showFooter = paginated && !showError && !showEmpty && !showNoResults;
  const dimmed = Boolean(status.isPlaceholderData) && hasRows;

  function handleRowClick(row: Row, event: MouseEvent<HTMLDivElement>) {
    if (!onRowClick || isInteractiveTarget(event)) return;
    onRowClick(row);
  }
  function handleRowKey(row: Row, event: KeyboardEvent<HTMLDivElement>) {
    if (!onRowClick || event.key !== "Enter" || isInteractiveTarget(event)) return;
    if (event.target !== event.currentTarget) return;
    onRowClick(row);
  }

  return (
    <div
      className={cn(
        "flex min-w-0 flex-col rounded-3xl bg-card text-card-foreground shadow-sm ring-1 ring-border/60 md:rounded-xl md:ring-border",
        className,
      )}
    >
      {/* Row 1 — tabs (or, without tabs, the search and scopes), Sort, Columns */}
      <div className="flex flex-wrap items-center gap-2 px-4 pt-4 md:px-2.5 md:pt-2.5">
        {hasTabs && tabs ? (
          <SegmentedTabs
            variant="table"
            behaviour="filter"
            ariaLabel={tabs.ariaLabel ?? `Filter ${noun}`}
            items={tabs.items}
            value={state.tab}
            onChange={state.setTab}
            className="max-w-full basis-full flex-nowrap overflow-x-auto md:basis-auto"
          />
        ) : (
          searchControls
        )}
        <div className="flex-1 max-md:hidden" />
        <div className={hasTabs ? "max-md:hidden" : undefined}>
          <SortMenu state={state} />
        </div>
        <div className={mobileRow ? "hidden md:block" : undefined}>
          <ColumnsMenu state={state} />
        </div>
        {toolbarEnd}
      </div>

      {/* Row 2 — search, scopes (only when tabs took row 1) */}
      {hasTabs && hasSearchControls && (
        <div className="flex flex-wrap items-center gap-2 px-4 pb-2 pt-2 md:px-2.5 md:pb-1.5">
          {searchControls}
          <div className="md:hidden">
            <SortMenu state={state} />
          </div>
        </div>
      )}
      {!hasTabs && hasSearchControls && <div className="pb-1.5" />}

      {/* Row 3 — date chip, filter chips, + Filter, Clear all */}
      {hasChipRow && (
        <div className="flex items-center gap-2 overflow-x-auto px-4 pb-3 [scrollbar-width:none] md:flex-wrap md:gap-1.5 md:overflow-visible md:px-2.5 md:pb-2.5 [&::-webkit-scrollbar]:hidden">
          {dateConfig && state.date && (
            <DateRangeFilter
              variant="chip"
              active={!state.isDefaultDate}
              presets={dateConfig.presets}
              preset={state.date.preset}
              custom={state.date.custom}
              label={dateLabel}
              today={dateConfig.today ?? localToday()}
              onPresetChange={state.setDatePreset}
              onCustomApply={state.setDateCustom}
              onClear={() => state.setDatePreset(dateConfig.default)}
            />
          )}
          {applied.map((filter) => (
            <FilterChip
              key={filter.key}
              state={state}
              def={filter}
              open={openChip === filter.key}
              onOpenChange={(open) => {
                setOpenChip(open ? filter.key : null);
                // A pending chip dismissed without a pick goes away again.
                if (!open && pendingKey === filter.key && !state.filters[filter.key]?.length) {
                  setPendingKey(null);
                }
              }}
              onPicked={() => setOpenChip(null)}
            />
          ))}
          <AddFilterMenu
            filters={addable}
            onAdd={(key) => {
              setPendingKey(key);
              setOpenChip(key);
            }}
          />
          {state.hasActiveFilters && (
            <button
              type="button"
              onClick={() => {
                setPendingKey(null);
                state.clearAll();
              }}
              className="h-11 shrink-0 whitespace-nowrap px-2 text-label font-medium text-brand-strong underline-offset-3 hover:underline md:h-7 pointer-coarse:h-11"
            >
              Clear all
            </button>
          )}
        </div>
      )}
      {!hasChipRow && <div className={searchable ? "pb-1" : "pb-2.5"} />}

      {/* Phone lists use one vertical reading path instead of sideways tables. */}
      <div
        className={cn("border-t border-border/60 md:hidden", dimmed && "opacity-50")}
        aria-label={noun}
        aria-busy={status.isLoading || status.isPlaceholderData || undefined}
      >
        {selection && hasRows && (allOnPage || someOnPage) && (
          <label className="flex min-h-12 items-center gap-3 border-b border-border/60 px-4 text-caption font-medium text-muted-foreground">
            <Checkbox
              checked={allOnPage ? true : someOnPage ? "indeterminate" : false}
              onCheckedChange={() => selection.onToggleAll(rows, !allOnPage)}
              aria-label={allOnPage ? "Deselect all on this page" : "Select all on this page"}
            />
            {rows.filter((row) => selection.isSelected(row)).length} selected on this page
            <span className="ml-auto tabular-nums">{meta?.total?.toLocaleString()} {noun}</span>
          </label>
        )}
        {showSkeleton && (
          <div className="divide-y divide-border/60" aria-label={`Loading ${noun}`}>
            {Array.from({ length: 4 }, (_, index) => (
              <div key={index} className="space-y-3 p-4 motion-safe:animate-pulse">
                <div className="h-4 w-3/5 rounded bg-muted" />
                <div className="h-3 w-2/5 rounded bg-muted" />
                <div className="h-7 w-full rounded-lg bg-muted/70" />
              </div>
            ))}
          </div>
        )}
        {rows.map((row) => {
          const selected = selection?.isSelected(row) ?? false;
          return (
            <div
              key={rowKey(row)}
              tabIndex={onRowClick ? 0 : undefined}
              onClick={(event) => handleRowClick(row, event)}
              onKeyDown={(event) => handleRowKey(row, event)}
              className={cn(
                "group/row border-b border-border/60 p-4 last:border-b-0 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                selected && "bg-brand/15",
                onRowClick && "cursor-pointer active:bg-muted/60",
              )}
            >
              <div className="flex items-start gap-3">
                {selection && (
                  <label className="-my-2 -ml-2 flex size-10 shrink-0 items-center justify-center" data-row-stop>
                    <Checkbox
                      checked={selected}
                      onCheckedChange={(checked) => selection.onToggle(row, checked === true)}
                      aria-label={selection.label?.(row) ?? (selected ? "Deselect row" : "Select row")}
                    />
                  </label>
                )}
                <div className="min-w-0 flex-1">
                  {mobileRow ? mobileRow(row) : (
                    <>
                      {columns[0] && <div className="min-w-0 text-sm font-semibold">{columns[0].cell(row)}</div>}
                      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2">
                        {columns.slice(1).map((column) => (
                          <div
                            key={column.key}
                            // A field with nothing in it (a DashCell) is left off the card.
                            className={cn("min-w-0 [&:has(>dd>[data-empty]:only-child)]:hidden", column.minWidth && column.minWidth > 160 && "col-span-2")}
                          >
                            <dt className="text-caption font-medium text-muted-foreground">{column.label}</dt>
                            <dd className="flex min-w-0 flex-wrap text-sm [overflow-wrap:anywhere]">{column.cell(row)}</dd>
                          </div>
                        ))}
                      </dl>
                    </>
                  )}
                </div>
                {/* The row's menu sits in the card's top corner rather than on a line of its own. */}
                {rowActions ? (
                  <div data-row-stop className="-my-2.5 -mr-2 flex shrink-0 items-center">
                    {rowActions(row)}
                  </div>
                ) : (
                  onRowClick && <ChevronRight aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground/60" />
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Desktop grid */}
      <div className="relative hidden border-t border-border md:block">
        {dimmed && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 -top-px z-20 h-0.5 overflow-hidden"
          >
            <div className="h-full w-[30%] bg-brand-strong [animation:table-progress_0.9s_ease-in-out_infinite]" />
          </div>
        )}
        <div
          ref={scrollerRef}
          onScroll={onScroll}
          className="max-h-[min(64vh,720px)] overflow-auto [overscroll-behavior-x:contain]"
        >
          <div
            role="table"
            aria-label={noun}
            aria-rowcount={meta?.total}
            aria-busy={status.isLoading || status.isPlaceholderData || undefined}
            style={{ minWidth }}
            className={cn(
              "w-full text-label text-foreground transition-opacity duration-150",
              dimmed && "opacity-50",
            )}
          >
            {/* Header */}
            <div
              role="row"
              className="sticky top-0 z-20 grid h-10 border-b border-border bg-muted text-caption font-medium text-muted-foreground"
              style={{ gridTemplateColumns: template }}
            >
              {hasSelection && selection && (
                <div className="sticky left-0 z-30 flex items-center justify-center bg-inherit">
                  <Checkbox
                    checked={allOnPage ? true : someOnPage ? "indeterminate" : false}
                    disabled={rows.length === 0}
                    onCheckedChange={() => selection.onToggleAll(rows, !allOnPage)}
                    aria-label={allOnPage ? "Deselect all on this page" : "Select all on this page"}
                  />
                </div>
              )}
              {columns.map((column, index) => {
                const sortable = Boolean(state.sort && column.sortKey);
                const active = sortable && state.sort?.field === column.sortKey;
                const dir = active ? state.sort?.dir : undefined;
                const label = column.headerTooltip ? (
                  <Tip text={column.headerTooltip}>
                    <span className="underline decoration-dotted decoration-muted-foreground/60 underline-offset-3">
                      {column.label}
                    </span>
                  </Tip>
                ) : (
                  <span>{column.label}</span>
                );
                return (
                  <div
                    key={column.key}
                    role="columnheader"
                    aria-sort={
                      active ? (dir === "asc" ? "ascending" : "descending") : sortable ? "none" : undefined
                    }
                    // Only the sticky cell is raised: grid items honour
                    // z-index without positioning, so a raised static cell
                    // later in the row would paint over the sticky one.
                    className={cn(
                      cellClass(column, index),
                      "whitespace-nowrap",
                      column.locked && index === 0 && "z-30",
                    )}
                    style={cellStyle(column, index)}
                  >
                    {sortable ? (
                      <button
                        type="button"
                        title={`Sort by ${column.label.toLowerCase()}`}
                        onClick={() => {
                          if (!column.sortKey) return;
                          state.setSort(
                            active
                              ? { field: column.sortKey, dir: dir === "asc" ? "desc" : "asc" }
                              : { field: column.sortKey, dir: defaultDirFor(sortTypeOf(column)) },
                          );
                        }}
                        className={cn(
                          "-mx-1.5 inline-flex items-center gap-1 rounded-md px-1.5 py-1 hover:bg-foreground/5 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                          column.align === "right" && "flex-row-reverse",
                          active && "text-foreground",
                        )}
                      >
                        {label}
                        {dir === "asc" ? (
                          <ArrowUp className="size-3" strokeWidth={2.5} />
                        ) : dir === "desc" ? (
                          <ArrowDown className="size-3" strokeWidth={2.5} />
                        ) : (
                          <ChevronsUpDown className="size-3 text-muted-foreground/60" />
                        )}
                      </button>
                    ) : (
                      label
                    )}
                  </div>
                );
              })}
              {hasActions && <div />}
            </div>

            {/* Body */}
            {showSkeleton && (
              <SkeletonRows
                count={Math.min(state.limit, 10)}
                columns={columns}
                template={template}
                hasSelection={hasSelection}
                hasActions={hasActions}
                cellClass={cellClass}
              />
            )}
            {hasRows &&
              rows.map((row) => {
                const selected = selection?.isSelected(row) ?? false;
                return (
                  <div
                    key={rowKey(row)}
                    role="row"
                    aria-selected={selection ? selected : undefined}
                    tabIndex={onRowClick ? 0 : undefined}
                    onClick={(event) => handleRowClick(row, event)}
                    onKeyDown={(event) => handleRowKey(row, event)}
                    className={cn(
                      "group/row grid min-h-14 items-center border-b border-border transition-[filter] hover:brightness-[0.982] dark:hover:brightness-110 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                      selected
                        ? "bg-[color-mix(in_oklch,var(--brand)_15%,var(--card))]"
                        : "bg-card",
                      onRowClick && "cursor-pointer",
                    )}
                    style={{ gridTemplateColumns: template }}
                  >
                    {hasSelection && selection && (
                      <div className="sticky left-0 z-10 flex items-center justify-center bg-inherit">
                        <Checkbox
                          checked={selected}
                          onCheckedChange={(checked) => selection.onToggle(row, checked === true)}
                          aria-label={selection.label?.(row) ?? (selected ? "Deselect row" : "Select row")}
                        />
                      </div>
                    )}
                    {columns.map((column, index) => (
                      <div
                        key={column.key}
                        role="cell"
                        className={cellClass(column, index)}
                        style={cellStyle(column, index)}
                      >
                        {column.cell(row)}
                      </div>
                    ))}
                    {hasActions && rowActions && (
                      <div
                        role="cell"
                        data-row-stop
                        className="flex items-center justify-end gap-1 px-2"
                      >
                        {rowActions(row)}
                      </div>
                    )}
                  </div>
                );
              })}
          </div>
        </div>
      </div>

      {showError && <TableErrorState noun={noun} onRetry={status.refetch} />}
      {showEmpty && <TableEmptyState spec={emptyState} />}
      {showNoResults && (
        <TableNoResults
          noun={noun}
          search={state.search.trim()}
          onClear={() => {
            setPendingKey(null);
            state.clearAll();
          }}
        />
      )}
      {showFooter && (
        <TablePagination
          page={state.page}
          limit={state.limit}
          total={meta?.total}
          totalPages={meta?.totalPages}
          noun={noun}
          limitOptions={state.limitOptions}
          onPage={(page) => {
            state.setPage(page);
            if (scrollerRef.current) scrollerRef.current.scrollTop = 0;
          }}
          onLimit={state.setLimit}
        />
      )}
    </div>
  );
}
