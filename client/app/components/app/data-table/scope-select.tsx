import { useState } from "react";
import { Check, ChevronDown } from "lucide-react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover";

import { OPTION_CLASS } from "./chip";
import type { DataTableState, ScopeDef } from "./use-data-table-state";

/** Above this many options the popover gets its own search box. */
const SEARCHABLE_AT = 6;

/**
 * A scope is context the list is read in — financial year, seller GSTIN,
 * location — rather than a filter on it, so it always has a value and sits
 * beside the search box, not in the chip row.
 */
export function ScopeSelect<Row>({ state, def }: { state: DataTableState<Row>; def: ScopeDef }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const value = state.scope[def.key];
  const current = def.options.find((o) => o.value === value) ?? def.options[0];
  const searchable = def.options.length >= SEARCHABLE_AT;
  const shown = query
    ? def.options.filter((o) => o.label.toLowerCase().includes(query.toLowerCase()))
    : def.options;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="outline" aria-haspopup="listbox" aria-expanded={open} className="h-11 max-w-full rounded-xl md:h-8 md:rounded-lg">
          <span className="font-normal text-muted-foreground">{def.label}</span>
          <span className="min-w-0 max-w-50 truncate">{current?.label ?? "—"}</span>
          <ChevronDown className="text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-70 p-1"
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
        <div role="listbox" aria-label={def.label} className="flex max-h-70 flex-col overflow-auto">
          {shown.length === 0 ? (
            <div className="px-2 py-2.5 text-label text-muted-foreground">No matches</div>
          ) : (
            shown.map((option) => {
              const on = option.value === value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={on}
                  onClick={() => {
                    setOpen(false);
                    setQuery("");
                    if (!on) state.setScope(def.key, option.value);
                  }}
                  className={OPTION_CLASS}
                >
                  <span className="flex-1 truncate">{option.label}</span>
                  {on && <Check className="size-3.5 shrink-0 text-brand-strong" strokeWidth={2.5} />}
                </button>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
