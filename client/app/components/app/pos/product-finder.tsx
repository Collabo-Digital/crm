import { useMemo, useState, type ReactNode, type RefObject } from "react";
import { Camera, ImageIcon, Loader2, PackageSearch, Plus, ScanBarcode, Search, X } from "lucide-react";
import { Button } from "~/components/ui/button";
import { useDebounced } from "~/hooks/use-debounced";
import { createBurstTracker } from "~/hooks/use-barcode-wedge";
import { usePosProducts } from "~/hooks/use-pos-queries";
import { cn, formatCurrency } from "~/lib/utils";
import type { PosProduct } from "~/types/api";

export interface ScanNotice {
  ok: boolean;
  text: string;
  /** Changes on every scan, so the same message twice still flashes. */
  at: number;
}

/**
 * The left side of the till: one search box for name, SKU or barcode (a
 * scanner can type into it too), the results, and the quick tiles when
 * nothing is being searched.
 */
export function ProductFinder({
  storeId,
  tiles,
  canSell,
  searchRef,
  notice,
  scanning,
  onAdd,
  onScan,
  onCamera,
  onCustom,
  emptyHint,
}: {
  storeId?: string;
  tiles: PosProduct[];
  canSell: boolean;
  searchRef: RefObject<HTMLInputElement | null>;
  notice: ScanNotice | null;
  scanning: boolean;
  onAdd: (product: PosProduct) => void;
  onScan: (code: string) => void;
  onCamera: () => void;
  onCustom: () => void;
  emptyHint: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const debounced = useDebounced(query, 200);
  const results = usePosProducts(debounced, storeId);
  const burst = useMemo(createBurstTracker, []);
  const searching = query.trim().length > 0;
  const rows = searching && debounced.trim() ? (results.data ?? []) : [];

  const add = (product: PosProduct) => {
    onAdd(product);
    setQuery("");
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b p-3 md:p-4">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            ref={searchRef}
            type="text"
            inputMode="search"
            autoComplete="off"
            spellCheck={false}
            enterKeyHint="search"
            value={query}
            aria-label="Search products by name, SKU or barcode"
            placeholder="Search or scan a barcode"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              burst.key(e.key);
              if (e.key === "Escape" && query) {
                e.preventDefault();
                setQuery("");
              }
              if (e.key !== "Enter") return;
              e.preventDefault();
              const code = burst.scanned(query);
              const typed = query.trim();
              if (code) {
                setQuery("");
                onScan(code);
              } else if (rows[0] && canSell && debounced === query && !results.isPlaceholderData) {
                add(rows[0]);
              } else if (/\d/.test(typed) && !/\s/.test(typed)) {
                // A typed SKU or barcode the search has not caught up with.
                setQuery("");
                onScan(typed);
              }
            }}
            className="h-12 w-full rounded-xl border border-input bg-background pl-9 pr-10 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-body"
          />
          {scanning || (searching && results.isFetching) ? (
            <Loader2 className="absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
          ) : (
            searching && (
              <button type="button" aria-label="Clear the search" onClick={() => setQuery("")} className="absolute right-1 top-1/2 flex size-10 -translate-y-1/2 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground">
                <X className="size-4" />
              </button>
            )
          )}
        </div>
        <Button type="button" variant="outline" className="h-12 rounded-xl max-sm:w-12 max-sm:px-0" onClick={onCamera} aria-label="Scan with the camera">
          <Camera />
          <span className="max-sm:hidden">Camera</span>
        </Button>
        {canSell && (
          <Button type="button" variant="outline" className="h-12 rounded-xl max-md:hidden" onClick={onCustom}>
            <Plus />
            Custom item
          </Button>
        )}
      </div>

      {notice && (
        <p
          key={notice.at}
          role="status"
          className={cn(
            "mx-3 mt-3 flex items-center gap-2 rounded-lg px-3 py-2 text-caption animate-in fade-in-0 md:mx-4",
            notice.ok ? "bg-success-subtle text-success" : "bg-danger-subtle text-danger",
          )}
        >
          <ScanBarcode className="size-4 shrink-0" />
          {notice.text}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3 md:p-4">
        {searching ? (
          results.isError ? (
            <p className="py-8 text-center text-caption text-danger">Products could not be searched. Check the connection and try again.</p>
          ) : rows.length === 0 ? (
            <p className="py-8 text-center text-caption text-muted-foreground">
              {results.isFetching || debounced !== query ? "Searching…" : `No product matches “${query.trim()}”.`}
            </p>
          ) : (
            <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3" aria-label="Search results">
              {rows.map((p) => (
                <li key={p.variantId}>
                  <ProductRow product={p} disabled={!canSell} onClick={() => add(p)} />
                </li>
              ))}
            </ul>
          )
        ) : (
          <>
            {(tiles.length > 0 || canSell) && (
              <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5" aria-label="Quick items">
                {tiles.map((p) => (
                  <li key={p.variantId}>
                    <ProductTile product={p} disabled={!canSell} onClick={() => add(p)} />
                  </li>
                ))}
                {canSell && (
                  <li className="md:hidden">
                    <button
                      type="button"
                      onClick={onCustom}
                      className="flex h-full min-h-28 w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed text-caption font-medium text-muted-foreground hover:bg-muted"
                    >
                      <Plus className="size-5" />
                      Custom item
                    </button>
                  </li>
                )}
              </ul>
            )}
            {tiles.length === 0 && (
              <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
                <PackageSearch className="size-8 text-muted-foreground" />
                <p className="text-body font-medium">Search for a product or scan its barcode to start a sale.</p>
                <p className="max-w-sm text-caption text-muted-foreground">{emptyHint}</p>
              </div>
            )}
          </>
        )}
      </div>

      <p className="hidden shrink-0 border-t px-4 py-2 text-micro text-muted-foreground md:block">
        <Kbd>/</Kbd> or <Kbd>F2</Kbd> search
        {canSell && (
          <>
            {" "}· <Kbd>F9</Kbd> or <Kbd>Ctrl</Kbd>+<Kbd>Enter</Kbd> pay
          </>
        )}{" "}
        · <Kbd>Esc</Kbd> closes a window
      </p>
    </div>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border bg-muted px-1 font-mono text-[10px] text-foreground">{children}</kbd>;
}

export function stockLabel(p: PosProduct): { text: string; tone: "muted" | "warning" | "danger" } | null {
  if (!p.trackQuantity || p.stockAtStore == null) return null;
  if (p.stockAtStore <= 0) return { text: "Out of stock", tone: p.allowOversell ? "warning" : "danger" };
  return { text: `${p.stockAtStore} in stock`, tone: p.stockAtStore <= 3 ? "warning" : "muted" };
}

const TONE = { muted: "text-muted-foreground", warning: "text-warning", danger: "text-danger" };

function Thumb({ product, className }: { product: PosProduct; className?: string }) {
  return product.imageUrl ? (
    <img src={product.imageUrl} alt="" loading="lazy" className={cn("rounded-lg bg-muted object-cover", className)} />
  ) : (
    <span className={cn("flex items-center justify-center rounded-lg bg-muted text-muted-foreground", className)}>
      <ImageIcon className="size-5" />
    </span>
  );
}

function ProductRow({ product, disabled, onClick }: { product: PosProduct; disabled: boolean; onClick: () => void }) {
  const stock = stockLabel(product);
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex min-h-16 w-full items-center gap-3 rounded-xl border bg-card p-2 text-left transition-colors hover:bg-muted disabled:cursor-default disabled:hover:bg-card"
    >
      <Thumb product={product} className="size-12 shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="line-clamp-2 text-label">{product.title}</span>
        <span className="block truncate text-caption text-muted-foreground">
          {[product.variantTitle, product.sku].filter(Boolean).join(" · ")}
        </span>
      </span>
      <span className="shrink-0 text-right">
        <span className="block text-label tabular-nums">{formatCurrency(product.price, "INR")}</span>
        {stock && <span className={cn("block text-micro", TONE[stock.tone])}>{stock.text}</span>}
      </span>
    </button>
  );
}

function ProductTile({ product, disabled, onClick }: { product: PosProduct; disabled: boolean; onClick: () => void }) {
  const stock = stockLabel(product);
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex h-full w-full flex-col gap-2 rounded-xl border bg-card p-2 text-left transition-colors hover:bg-muted active:scale-[.98] disabled:cursor-default disabled:hover:bg-card"
    >
      <Thumb product={product} className="aspect-[3/2] w-full" />
      <span className="min-w-0 px-0.5">
        <span className="line-clamp-2 text-label">{product.title}</span>
        {product.variantTitle && <span className="block truncate text-caption text-muted-foreground">{product.variantTitle}</span>}
        <span className="mt-1 flex items-baseline justify-between gap-2">
          <span className="text-label tabular-nums">{formatCurrency(product.price, "INR")}</span>
          {stock && <span className={cn("truncate text-micro", TONE[stock.tone])}>{stock.text}</span>}
        </span>
      </span>
    </button>
  );
}
