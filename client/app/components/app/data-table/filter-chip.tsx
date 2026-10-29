import { useState } from "react";
import { Check, ChevronRight, Plus, X } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Input } from "~/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover";
import { cn } from "~/lib/utils";

import { CHIP_CLEAR_CLASS, OPTION_CLASS, chipClass } from "./chip";
import type { DataTableState, FilterDef } from "./use-data-table-state";

/** Above this many options the popover gets its own search box. */
const SEARCHABLE_AT = 8;

/**
 * One applied filter: "Status: Paid, Pending ×" with a popover of its options.
 * Single-select closes on pick; multi-select stays open and ticks boxes.
 */
export function FilterChip<Row>({
  state,
  def,
  open,
  onOpenChange,
  onPicked,
}: {
  state: DataTableState<Row>;
  def: FilterDef;
  open: boolean;
  /** Dismissed (click outside, Escape, ×) — may close a pending chip for good. */
  onOpenChange: (open: boolean) => void;
  /** A single-select value was chosen: close the popover, keep the chip. */
  onPicked: () => void;
}) {
  const [query, setQuery] = useState("");
  const values = state.filters[def.key] ?? [];
  const has = values.length > 0;
  const options = def.options ?? [];
  const searchable = options.length >= SEARCHABLE_AT;
  const shown = query
    ? options.filter((o) => o.label.toLowerCase().includes(query.toLowerCase()))
    : options;
  const labelOf = (value: string) => options.find((o) => o.value === value)?.label ?? value;
  const valueLabel = !has
    ? "Select…"
    : values.length <= 2
      ? values.map(labelOf).join(", ")
      : `${labelOf(values[0])} +${values.length - 1}`;

  function remove() {
    onOpenChange(false);
    state.setFilter(def.key, []);
  }

  function pick(value: string, on: boolean) {
    if (def.multi) {
      state.setFilter(def.key, on ? values.filter((v) => v !== value) : [...values, value]);
    } else {
      state.setFilter(def.key, on ? [] : [value]);
      // Not `onOpenChange(false)`: the URL write is async, so a dismissal
      // handler reading the filters now would still see the chip as empty
      // and drop it before the value lands.
      onPicked();
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) setQuery("");
      }}
    >
      <div className={chipClass(has)}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-haspopup="listbox"
            aria-expanded={open}
            className="flex h-11 items-center gap-1 whitespace-nowrap rounded-full pl-3 pr-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:h-7 pointer-coarse:h-11"
          >
            <span className="font-medium">{def.label}:</span>
            <span className="max-w-50 truncate">{valueLabel}</span>
          </button>
        </PopoverTrigger>
        <button
          type="button"
          onClick={remove}
          aria-label={`Remove ${def.label} filter`}
          title="Remove filter"
          className={CHIP_CLEAR_CLASS}
        >
          <X className="size-3" strokeWidth={2.5} />
        </button>
      </div>
      {/* Closes on a click outside or Escape only, never on focus moving
          away: this popover is opened from the "+ Filter" menu, and that
          menu's close-time focus return would otherwise dismiss it. */}
      <PopoverContent
        align="start"
        className="w-60 p-1"
        onFocusOutside={(event) => event.preventDefault()}
      >
        {searchable && (
          <div className="p-1 pb-1.5">
            <Input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={`Search ${def.label.toLowerCase()}`}
              aria-label={`Search ${def.label}`}
              className="h-8 text-label"
            />
          </div>
        )}
        <div
          role="listbox"
          aria-multiselectable={def.multi || undefined}
          aria-label={def.label}
          className="flex max-h-70 flex-col overflow-auto"
        >
          {def.options === undefined ? (
            <div className="px-2 py-2.5 text-label text-muted-foreground">Loading…</div>
          ) : shown.length === 0 ? (
            <div className="px-2 py-2.5 text-label text-muted-foreground">No matches</div>
          ) : (
            shown.map((option) => {
              const on = values.includes(option.value);
              return (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={on}
                  onClick={() => pick(option.value, on)}
                  className={OPTION_CLASS}
                >
                  {def.multi && (
                    <span
                      aria-hidden
                      className={cn(
                        "flex size-4 shrink-0 items-center justify-center rounded-[4px]",
                        on ? "bg-ink text-brand" : "ring-1 ring-inset ring-muted-foreground/50",
                      )}
                    >
                      {on && <Check className="size-3" strokeWidth={3} />}
                    </span>
                  )}
                  <span className="flex-1 truncate">{option.label}</span>
                  {!def.multi && on && (
                    <Check className="size-3.5 shrink-0 text-brand-strong" strokeWidth={2.5} />
                  )}
                </button>
              );
            })
          )}
        </div>
        {has && (
          <div className="mt-1 border-t border-border pt-1">
            <button
              type="button"
              onClick={remove}
              className={cn(OPTION_CLASS, "h-7 text-muted-foreground hover:text-foreground")}
            >
              Clear {def.label}
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** The dashed "+ Filter" pill listing filters not yet on the row. */
export function AddFilterMenu({
  filters,
  onAdd,
}: {
  filters: ReadonlyArray<FilterDef>;
  onAdd: (key: string) => void;
}) {
  if (filters.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex h-11 shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-dashed border-muted-foreground/50 bg-card px-3 text-label font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:h-7 md:px-2.5 pointer-coarse:h-11"
        >
          <Plus className="size-3" strokeWidth={2.5} />
          Filter
        </button>
      </DropdownMenuTrigger>
      {/* Picking an item opens the new chip's popover; the menu must not
          pull focus back to this trigger as it closes, or the popover sees
          focus leave and dismisses itself. */}
      <DropdownMenuContent
        align="start"
        className="w-50"
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <DropdownMenuLabel className="text-caption font-normal text-muted-foreground">
          Filter by
        </DropdownMenuLabel>
        {filters.map((filter) => (
          <DropdownMenuItem key={filter.key} onSelect={() => onAdd(filter.key)}>
            <span className="flex-1">{filter.label}</span>
            <ChevronRight className="text-muted-foreground/60" />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
