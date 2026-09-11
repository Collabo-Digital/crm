import { useMemo, useState } from "react";
import { Check, ChevronDown, MapPin, Search } from "lucide-react";

import { Input } from "~/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/components/ui/popover";
import { cn } from "~/lib/utils";
import type { Warehouse } from "~/types/api";

/**
 * Picks the one location every inventory figure on the page belongs to.
 *
 * There is no "all locations" entry by design — see `useSelectedLocation`.
 *
 * The name is rendered exactly as Shopify sends it: never truncated in the
 * list, and never decorated with the internal `code` (which we mint ourselves
 * by stripping the name, so appending it reads as a typo). The trigger is the
 * one place a very long name has to fit a fixed width, so it ellipsises there
 * with the full name in `title`.
 */
const SEARCH_THRESHOLD = 6;

function cityOf(location: Warehouse): string | null {
  const address = location.address as Record<string, unknown> | null;
  const city = address?.city;
  return typeof city === "string" && city.trim() ? city.trim() : null;
}

export function LocationPicker({
  locations,
  value,
  onChange,
  className,
}: {
  locations: Warehouse[];
  value: string | undefined;
  onChange: (id: string) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const selected = locations.find((l) => l.id === value);
  const showSearch = locations.length >= SEARCH_THRESHOLD;

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return locations;
    return locations.filter(
      (l) =>
        l.name.toLowerCase().includes(q) ||
        l.code.toLowerCase().includes(q) ||
        (cityOf(l) ?? "").toLowerCase().includes(q),
    );
  }, [locations, query]);

  // One location is not a choice — show it as a label so nobody hunts for a
  // setting behind a dropdown that can only ever say one thing.
  if (locations.length <= 1) {
    return (
      <div
        className={cn(
          "flex h-9 items-center gap-2 rounded-lg border border-border bg-card px-3",
          className,
        )}
      >
        <MapPin className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate text-label text-foreground" title={selected?.name}>
          {selected?.name ?? "No location yet"}
        </span>
      </div>
    );
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger
        className={cn(
          "flex h-9 max-w-[22rem] items-center gap-2 rounded-lg border border-border bg-card px-3 text-left shadow-sm",
          "hover:border-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40",
          className,
        )}
        aria-label={`Location: ${selected?.name ?? "choose"}`}
        title={selected?.name}
      >
        <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-brand/15 text-brand-strong">
          <MapPin className="size-3" />
        </span>
        <span className="min-w-0 flex-1 truncate text-label text-foreground">
          {selected?.name ?? "Choose a location"}
        </span>
        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
      </PopoverTrigger>

      <PopoverContent className="w-[26rem] p-0">
        {showSearch && (
          <div className="border-b border-border p-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search locations…"
                aria-label="Search locations"
                className="h-8 rounded-lg pl-8 text-caption"
              />
            </div>
          </div>
        )}

        <div className="max-h-72 overflow-y-auto p-1.5">
          {shown.length === 0 ? (
            <p className="px-2.5 py-6 text-center text-caption text-muted-foreground">
              No location matches “{query}”.
            </p>
          ) : (
            shown.map((location) => {
              const active = location.id === value;
              const city = cityOf(location);
              return (
                <button
                  key={location.id}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onClick={() => {
                    onChange(location.id);
                    setOpen(false);
                  }}
                  className={cn(
                    "flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left",
                    "hover:bg-muted focus-visible:outline-none focus-visible:bg-muted",
                  )}
                >
                  <span className="w-4 shrink-0 pt-0.5 text-brand-strong">
                    {active && <Check className="size-3.5" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    {/* Wraps rather than clips: the whole point is that the
                        merchant reads the Shopify name in full. */}
                    <span className="block text-label text-foreground">
                      {location.name}
                    </span>
                    <span className="block text-micro text-muted-foreground">
                      {city ?? location.code}
                    </span>
                  </span>
                  <span className="shrink-0 whitespace-nowrap pt-0.5 text-micro tabular-nums text-muted-foreground">
                    {location.unitsAvailable.toLocaleString()} units
                  </span>
                </button>
              );
            })
          )}
        </div>

        <p className="border-t border-border bg-muted/50 px-3 py-2 text-micro text-muted-foreground">
          Active locations, synced from Shopify. Your choice is remembered.
        </p>
      </PopoverContent>
    </Popover>
  );
}
