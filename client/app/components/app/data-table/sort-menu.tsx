import { ArrowUpDown, ChevronDown } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";

import {
  defaultDirFor,
  dirLabel,
  sortableColumns,
  sortTypeOf,
  type SortDir,
} from "./column";
import type { DataTableState } from "./use-data-table-state";

/**
 * "Sort: Date · Newest first ▾" — the one place every sortable field is
 * listed, for columns that are hidden or off-screen. Header clicks and this
 * menu drive the same state.
 */
export function SortMenu<Row>({ state }: { state: DataTableState<Row> }) {
  const { sort, setSort, resetSort, isDefaultSort, config } = state;
  if (!sort) return null;
  const columns = sortableColumns(config.columns);
  const active = columns.find((c) => c.sortKey === sort.field) ?? columns[0];
  if (!active) return null;
  const type = sortTypeOf(active);
  // The natural direction first: newest / highest, or A–Z.
  const dirs: SortDir[] = type === "text" ? ["asc", "desc"] : ["desc", "asc"];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex h-11 max-w-full items-center gap-1.5 whitespace-nowrap rounded-xl bg-card px-3 text-label text-muted-foreground ring-1 ring-border transition-colors hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 md:h-8 md:rounded-lg md:px-2.5"
        >
          <ArrowUpDown className="size-3.5" />
          <span className="hidden md:inline">Sort:</span>
          <span className="font-medium text-foreground">
            {active.label}<span className="hidden sm:inline"> · {dirLabel(type, sort.dir)}</span>
          </span>
          <ChevronDown className="size-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="text-caption font-normal text-muted-foreground">
          Sort by
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={sort.field}
          onValueChange={(field) => {
            const column = columns.find((c) => c.sortKey === field);
            if (column && field !== sort.field) {
              setSort({ field, dir: defaultDirFor(sortTypeOf(column)) });
            }
          }}
        >
          {columns.map((column) => (
            <DropdownMenuRadioItem key={column.key} value={column.sortKey as string}>
              {column.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup
          value={sort.dir}
          onValueChange={(dir) => setSort({ field: sort.field, dir: dir as SortDir })}
        >
          {dirs.map((dir) => (
            <DropdownMenuRadioItem key={dir} value={dir}>
              {dirLabel(type, dir)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {!isDefaultSort && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={resetSort} className="text-muted-foreground">
              Reset to default
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
