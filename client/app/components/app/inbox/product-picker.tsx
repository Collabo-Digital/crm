import { useState } from "react";
import { Check, ChevronDown, Loader2, Package, Search, X } from "lucide-react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover";
import { useDebounced } from "~/hooks/use-debounced";
import { useInboxProducts } from "~/hooks/use-automation-queries";
import { cn } from "~/lib/utils";
import type { InboxSendPayload, StoreProduct } from "~/types/api";

export const MAX_PRODUCTS = 30;
/** WhatsApp product cards: 2 to 10 in one message. */
export const MAX_CARDS = 10;

/** How several catalog products go: one list message, or cards to swipe through. */
export type ProductsFormat = "list" | "cards";

export function formatPrice(p: Pick<StoreProduct, "price" | "currency">): string {
  const n = Number(p.price);
  try {
    return new Intl.NumberFormat("en-IN", { style: "currency", currency: p.currency || "INR", maximumFractionDigits: 2 }).format(n);
  } catch {
    return `${p.currency} ${n.toFixed(2)}`;
  }
}

const label = (p: StoreProduct) => `${p.title}${p.variantTitle ? ` (${p.variantTitle})` : ""}`;

/**
 * What staged products are sent as. Product cards need a WhatsApp number with
 * a synced catalog; anywhere else they go as a message with each product's
 * name, price and link.
 */
export function productsPayload(
  items: StoreProduct[],
  text: string,
  asCards: boolean,
  opts: { header?: string; format?: ProductsFormat } = {},
): InboxSendPayload {
  if (asCards && items.every((p) => p.inCatalog)) {
    return {
      type: "products",
      variantIds: items.map((p) => p.variantId),
      ...(text ? { text } : {}),
      ...(opts.header ? { header: opts.header.slice(0, 60) } : {}),
      ...(opts.format === "cards" && items.length >= 2 && items.length <= MAX_CARDS ? { format: "cards" as const } : {}),
    };
  }
  const lines = items.map((p) => `• ${label(p)} — ${formatPrice(p)}${p.url ? `\n  ${p.url}` : ""}`);
  return { type: "text", text: [text, ...lines].filter(Boolean).join("\n") };
}

/** The composer's “Products” button: search the store and pick what to share. */
export function ProductPickerButton({
  conversationId,
  selected,
  disabled,
  onToggle,
}: {
  conversationId: string;
  selected: StoreProduct[];
  disabled: boolean;
  /** Pick or unpick one product; `asCards` says whether this chat can get product cards. */
  onToggle: (product: StoreProduct, asCards: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const debounced = useDebounced(search, 250);
  const { data, isLoading, isError } = useInboxProducts(conversationId, debounced.trim(), open);
  const picked = new Set(selected.map((p) => p.variantId));
  const asCards = !!data?.canSendProducts;


  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon-sm" disabled={disabled} aria-label="Share products" title="Share products" className="rounded-full md:size-9">
          <Package className="size-[18px]" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-96 p-0">
        <div className="border-b p-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search products" className="h-8 pl-7" aria-label="Search products" autoFocus />
          </div>
          <p className="mt-1.5 px-1 text-micro text-muted-foreground">
            {data
              ? asCards
                ? "Sent as WhatsApp product cards from your catalog."
                : data.catalog
                  ? "This number shares the WhatsApp Business app, so products go as links."
                  : "Sent as a message with each product’s link."
              : " "}
          </p>
        </div>
        <div className="max-h-80 overflow-y-auto p-1">
          {isLoading ? (
            <div className="flex h-20 items-center justify-center">
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            </div>
          ) : isError ? (
            <p className="px-3 py-4 text-caption text-muted-foreground">Products could not be loaded.</p>
          ) : !data?.products.length ? (
            <p className="px-3 py-4 text-caption text-muted-foreground">{debounced ? "No products match." : "No active products in the store yet."}</p>
          ) : (
            data.products.map((p) => {
              const on = picked.has(p.variantId);
              const unavailable = asCards && !p.inCatalog;
              return (
                <button
                  key={p.variantId}
                  type="button"
                  onClick={() => onToggle(p, asCards)}
                  aria-pressed={on}
                  className={cn("flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-muted", on && "bg-brand/10")}
                >
                  <span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted">
                    {p.image ? <img src={p.image} alt="" className="size-full object-cover" loading="lazy" /> : <Package className="size-4 text-muted-foreground" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-caption font-medium">{label(p)}</span>
                    <span className="block text-micro text-muted-foreground">
                      {formatPrice(p)}
                      {!p.inStock && " · out of stock"}
                      {unavailable && " · not in catalog, goes as a link"}
                    </span>
                  </span>
                  {on && <Check className="size-4 shrink-0 text-brand-strong" />}
                </button>
              );
            })
          )}
        </div>
        {selected.length > 0 && (
          <div className="flex items-center justify-between border-t px-3 py-2 text-caption">
            <span>{selected.length} selected</span>
            <Button size="xs" variant="accent" onClick={() => setOpen(false)}>
              Done
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** Products staged above the reply box. Nothing goes out until Send. */
export function ProductTray({
  items,
  asCards,
  header,
  format,
  onFormat,
  onRemove,
  onClear,
}: {
  items: StoreProduct[];
  asCards: boolean;
  /** A collection's name, for the list's title. */
  header?: string;
  format: ProductsFormat;
  onFormat: (format: ProductsFormat) => void;
  onRemove: (variantId: string) => void;
  onClear: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!items.length) return null;
  const catalog = asCards && items.every((p) => p.inCatalog);
  const canCards = catalog && items.length >= 2 && items.length <= MAX_CARDS;
  const shown = expanded || items.length <= 3 ? items : items.slice(0, 2);
  return (
    <div className="mb-2 space-y-1.5">
      {(header || items.length > 3) && (
        <div className="flex items-center justify-between gap-2 text-micro text-muted-foreground">
          <span className="truncate">{header ? `${header} · ${items.length} products` : `${items.length} products`}</span>
          <Button variant="ghost" size="xs" onClick={onClear}>
            Remove all
          </Button>
        </div>
      )}
      <ul className="flex flex-col gap-1.5">
        {shown.map((p) => (
          <li key={p.variantId} className="flex items-center gap-2.5 rounded-lg border bg-muted/40 p-2">
            <span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-md bg-card">
              {p.image ? <img src={p.image} alt="" className="size-full object-cover" /> : <Package className="size-4 text-muted-foreground" />}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-caption text-foreground">{label(p)}</p>
              <p className="text-micro text-muted-foreground">{formatPrice(p)}</p>
            </div>
            <Button variant="ghost" size="icon-xs" onClick={() => onRemove(p.variantId)} aria-label={`Remove ${p.title}`} className="shrink-0">
              <X className="size-3.5" />
            </Button>
          </li>
        ))}
      </ul>
      {shown.length < items.length && (
        <Button variant="ghost" size="xs" onClick={() => setExpanded(true)}>
          <ChevronDown />
          {items.length - shown.length} more
        </Button>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {canCards && (
          <div className="flex rounded-md border p-0.5 text-micro" role="radiogroup" aria-label="Send the products as">
            {(["cards", "list"] as const).map((f) => (
              <button
                key={f}
                type="button"
                role="radio"
                aria-checked={format === f}
                onClick={() => onFormat(f)}
                className={cn("rounded px-2 py-0.5", format === f ? "bg-muted font-medium text-foreground" : "text-muted-foreground")}
              >
                {f === "cards" ? "Cards" : "List"}
              </button>
            ))}
          </div>
        )}
        <p className="text-micro text-muted-foreground">
          {!catalog
            ? "Goes as one message with names, prices and links."
            : items.length === 1
              ? "Goes as a product card."
              : canCards && format === "cards"
                ? "Goes as cards to swipe through; your message goes above them."
                : "Goes as a product list; your message becomes its text."}
        </p>
      </div>
    </div>
  );
}
