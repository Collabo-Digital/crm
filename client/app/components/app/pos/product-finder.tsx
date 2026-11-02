import { useMemo, useState, type ReactNode, type RefObject } from "react";
import { Camera, Loader2, PackageSearch, Plus, ScanBarcode, Search, X } from "lucide-react";
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
 * The left side of the till (the whole sell screen on a phone): one search
 * box for name, SKU or barcode (a scanner can type into it too), the quick
 * items, and the results as a compact list.
 */
export function ProductFinder({
  storeId,
  tiles,
  canSell,
  searchRef,
  notice,
  scanning,
  inCart,
  onAdd,
  onScan,
  onCamera,
  onCustom,
  onSearchFocus,
  emptyHint,
}: {
  storeId?: string;
  tiles: PosProduct[];
  canSell: boolean;
  searchRef: RefObject<HTMLInputElement | null>;
  /** A scan that found nothing, shown under the search box. */
  notice: ScanNotice | null;
  scanning: boolean;
  /** Quantity in the cart by variant id. */
  inCart: Map<string, number>;
  onAdd: (product: PosProduct) => void;
  onScan: (code: string) => void;
  onCamera: () => void;
  onCustom: () => void;
  onSearchFocus: (focused: boolean) => void;
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

  const customRow = canSell && (
    <button
      type="button"
      onClick={onCustom}
      className="flex min-h-12 w-full items-center gap-3 rounded-xl border border-dashed px-3 text-left text-label text-muted-foreground hover:bg-muted md:hidden"
    >
      <Plus className="size-4 shrink-0" />
      Custom item
      <span className="ml-auto truncate text-caption font-normal">Not in the catalogue</span>
    </button>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 px-3 pt-2 pb-2 md:border-b md:p-4">
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
            onFocus={() => onSearchFocus(true)}
            onBlur={() => onSearchFocus(false)}
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
            className="h-11 w-full rounded-xl border border-input bg-background pl-9 pr-10 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:h-12 md:text-body"
          />
          {scanning || (searching && results.isFetching) ? (
            <Loader2 className="absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
          ) : (
            searching && (
              <button type="button" aria-label="Clear the search" onClick={() => setQuery("")} className="absolute right-0.5 top-1/2 flex size-10 -translate-y-1/2 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground">
                <X className="size-4" />
              </button>
            )
          )}
        </div>
        <Button type="button" variant="outline" className="size-11 rounded-xl px-0 md:h-12 md:w-auto md:px-3" onClick={onCamera} aria-label="Scan with the camera">
          <ScanBarcode className="md:hidden" />
          <Camera className="max-md:hidden" />
          <span className="max-md:hidden">Camera</span>
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
            "mx-3 mb-2 flex items-center gap-2 rounded-lg px-3 py-2 text-caption animate-in fade-in-0 md:mx-4 md:mt-3 md:mb-0",
            notice.ok ? "bg-success-subtle text-success" : "bg-danger-subtle text-danger",
          )}
        >
          <ScanBarcode className="size-4 shrink-0" />
          {notice.text}
        </p>
      )}

      {searching && tiles.length > 0 && (
        <ul className="flex shrink-0 gap-2 overflow-x-auto px-3 pb-2 [scrollbar-width:none] md:hidden [&::-webkit-scrollbar]:hidden" aria-label="Quick items">
          {tiles.map((p) => (
            <li key={p.variantId} className="w-44 shrink-0">
              <QuickChip product={p} count={inCart.get(p.variantId) ?? 0} disabled={!canSell} onClick={() => add(p)} />
            </li>
          ))}
        </ul>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain max-md:border-t md:p-4">
        {searching ? (
          results.isError ? (
            <p className="px-4 py-8 text-center text-caption text-danger">Products could not be searched. Check the connection and try again.</p>
          ) : rows.length === 0 ? (
            <div className="space-y-3 px-3 py-8 text-center md:px-0">
              <p className="text-caption text-muted-foreground">
                {results.isFetching || debounced !== query ? "Searching…" : `No product matches “${query.trim()}”.`}
              </p>
              {!results.isFetching && debounced === query && customRow}
            </div>
          ) : (
            <ul className="max-md:divide-y md:grid md:gap-2 lg:grid-cols-2 xl:grid-cols-3" aria-label="Search results">
              {rows.map((p) => (
                <li key={p.variantId}>
                  <ProductRow product={p} count={inCart.get(p.variantId) ?? 0} disabled={!canSell} onClick={() => add(p)} />
                </li>
              ))}
            </ul>
          )
        ) : (
          <div className="space-y-3 max-md:px-3 max-md:py-3">
            {tiles.length > 0 && (
              <>
                <p className="text-caption font-medium text-muted-foreground md:hidden">Quick items</p>
                <ul className="grid grid-cols-2 gap-2 md:hidden" aria-label="Quick items">
                  {tiles.map((p) => (
                    <li key={p.variantId}>
                      <QuickChip product={p} count={inCart.get(p.variantId) ?? 0} disabled={!canSell} onClick={() => add(p)} />
                    </li>
                  ))}
                </ul>
                <ul className="grid grid-cols-3 gap-2 max-md:hidden lg:grid-cols-4 xl:grid-cols-5" aria-label="Quick items">
                  {tiles.map((p) => (
                    <li key={p.variantId}>
                      <ProductTile product={p} count={inCart.get(p.variantId) ?? 0} disabled={!canSell} onClick={() => add(p)} />
                    </li>
                  ))}
                </ul>
              </>
            )}
            {customRow}
            {tiles.length === 0 && (
              <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
                <PackageSearch className="size-8 text-muted-foreground" />
                <p className="text-body font-medium">Search for a product or scan its barcode to start a sale.</p>
                <p className="max-w-sm text-caption text-muted-foreground">{emptyHint}</p>
              </div>
            )}
          </div>
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

const LOW_STOCK = 3;

/** Stock at this store, coloured by state: red when there is none, amber when it is low. */
export function stockLabel(p: PosProduct): { text: string; tone: "muted" | "warning" | "danger" } | null {
  if (!p.trackQuantity || p.stockAtStore == null) return null;
  if (p.stockAtStore <= 0) return { text: "Out of stock", tone: "danger" };
  if (p.stockAtStore <= LOW_STOCK) return { text: `Only ${p.stockAtStore} left`, tone: "warning" };
  return { text: `${p.stockAtStore} in stock`, tone: "muted" };
}

const TONE = { muted: "text-muted-foreground", warning: "text-warning-strong", danger: "text-danger" };

const MONOGRAM_TINTS = [
  "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200",
  "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
  "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-200",
  "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-200",
  "bg-teal-100 text-teal-800 dark:bg-teal-950 dark:text-teal-200",
];

/** "Jute Tote Bag" as "JT", tinted by the title so the same product keeps its colour. */
function monogram(title: string): { letters: string; tint: string } {
  const words = title.trim().split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  const letters = (words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? "?").slice(0, 2)).toUpperCase();
  let hash = 0;
  for (const ch of title) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return { letters, tint: MONOGRAM_TINTS[Math.abs(hash) % MONOGRAM_TINTS.length] };
}

function Thumb({ product, count = 0, big = false, className }: { product: PosProduct; count?: number; big?: boolean; className?: string }) {
  const mono = product.imageUrl ? null : monogram(product.title);
  return (
    <span className={cn("relative shrink-0", className)}>
      {product.imageUrl ? (
        <img src={product.imageUrl} alt="" loading="lazy" className="size-full rounded-lg bg-muted object-cover" />
      ) : (
        <span aria-hidden className={cn("flex size-full items-center justify-center rounded-lg font-semibold", big ? "text-[28px]" : "text-label", mono!.tint)}>
          {mono!.letters}
        </span>
      )}
      {count > 0 && (
        <span className="absolute -top-1.5 -right-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-foreground px-1 text-micro font-semibold text-background tabular-nums ring-2 ring-background">
          <span className="sr-only">In the cart: </span>
          {count}
        </span>
      )}
    </span>
  );
}

function ProductRow({ product, count, disabled, onClick }: { product: PosProduct; count: number; disabled: boolean; onClick: () => void }) {
  const stock = stockLabel(product);
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex min-h-[68px] w-full items-center gap-3 px-3 py-2 text-left transition-colors active:bg-muted disabled:cursor-default md:min-h-16 md:rounded-xl md:border md:bg-card md:p-2 md:hover:bg-muted md:disabled:hover:bg-card"
    >
      <Thumb product={product} count={count} className="size-12" />
      <span className="min-w-0 flex-1">
        <span className="line-clamp-2 text-label">{product.title}</span>
        <span className="block truncate text-caption text-muted-foreground">
          {[product.variantTitle, product.sku].filter(Boolean).join(" · ")}
        </span>
      </span>
      <span className="shrink-0 text-right">
        <span className="block text-label tabular-nums">{formatCurrency(product.price, "INR")}</span>
        {stock && <span className={cn("block text-caption md:text-micro", TONE[stock.tone])}>{stock.text}</span>}
      </span>
    </button>
  );
}

/** A quick item on a phone: small enough for two across, or a row that scrolls sideways. */
function QuickChip({ product, count, disabled, onClick }: { product: PosProduct; count: number; disabled: boolean; onClick: () => void }) {
  const stock = stockLabel(product);
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex min-h-14 w-full items-center gap-2 rounded-xl border bg-card p-1.5 pr-2.5 text-left transition-transform active:scale-[.98] disabled:cursor-default"
    >
      <Thumb product={product} count={count} className="size-10" />
      <span className="min-w-0 flex-1">
        <span className="line-clamp-2 text-caption leading-tight font-medium text-foreground">{product.variantTitle ? `${product.title} · ${product.variantTitle}` : product.title}</span>
        <span className="flex items-baseline gap-1.5 text-micro">
          <span className="font-medium tabular-nums">{formatCurrency(product.price, "INR")}</span>
          {stock && stock.tone !== "muted" && <span className={cn("truncate", TONE[stock.tone])}>{stock.text}</span>}
        </span>
      </span>
    </button>
  );
}

function ProductTile({ product, count, disabled, onClick }: { product: PosProduct; count: number; disabled: boolean; onClick: () => void }) {
  const stock = stockLabel(product);
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex h-full w-full flex-col gap-2 rounded-xl border bg-card p-2 text-left transition-colors hover:bg-muted active:scale-[.98] disabled:cursor-default disabled:hover:bg-card"
    >
      <Thumb product={product} count={count} big className="aspect-[3/2] w-full" />
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
