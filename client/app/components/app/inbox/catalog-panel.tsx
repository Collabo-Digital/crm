import { useMemo, useState, type DragEvent } from "react";
import { ChevronDown, ChevronRight, GripVertical, Layers, Loader2, Package, Plus, Search, Send } from "lucide-react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { useDebounced } from "~/hooks/use-debounced";
import { useInboxProducts } from "~/hooks/use-automation-queries";
import { useMediaQuery } from "~/hooks/use-media-query";
import { cn } from "~/lib/utils";
import type { StoreProduct, StoreProductsResponse } from "~/types/api";

import { MAX_PRODUCTS, formatPrice } from "./product-picker";

/** What a product or a collection carries when dragged from the panel onto the chat. */
export const PRODUCTS_DRAG_TYPE = "application/x-collabo-products";

export type CatalogDrop =
  | { kind: "products"; items: StoreProduct[]; asCards: boolean; header?: string }
  /** A collection on a number without product cards: its page link. */
  | { kind: "link"; text: string };

type Collection = StoreProductsResponse["collections"][number];

interface ProductGroup {
  productId: string;
  title: string;
  image: string | null;
  variants: StoreProduct[];
}

function byProduct(items: StoreProduct[]): ProductGroup[] {
  const groups = new Map<string, ProductGroup>();
  for (const v of items) {
    const group = groups.get(v.productId) ?? { productId: v.productId, title: v.title, image: v.image, variants: [] };
    group.variants.push(v);
    groups.set(v.productId, group);
  }
  return [...groups.values()];
}

function startDrag(event: DragEvent, drop: CatalogDrop) {
  event.dataTransfer.setData(PRODUCTS_DRAG_TYPE, JSON.stringify(drop));
  // Dropped anywhere else (a note, another app), it is the links.
  event.dataTransfer.setData(
    "text/plain",
    drop.kind === "link" ? drop.text : drop.items.map((p) => p.url ?? p.title).join("\n"),
  );
  event.dataTransfer.effectAllowed = "copy";
}

const priceRange = (variants: StoreProduct[]) => {
  const prices = variants.map((v) => Number(v.price));
  const low = variants[prices.indexOf(Math.min(...prices))];
  return Math.min(...prices) === Math.max(...prices) ? formatPrice(low) : `from ${formatPrice(low)}`;
};

/**
 * The store's catalog beside a conversation: search or pick a Shopify
 * collection, then drag a product into the chat (or Add it) to put it in the
 * reply, or Send it on its own. A whole collection goes as one product list,
 * or as its page link where product cards cannot be sent.
 */
export function CatalogPanel({
  conversationId,
  blockedReason,
  isSending,
  onAdd,
  onSend,
  className,
}: {
  conversationId: string;
  /** Why nothing can be sent in this chat right now, if nothing can. */
  blockedReason: string | null;
  isSending: boolean;
  onAdd: (drop: CatalogDrop) => void;
  onSend: (drop: CatalogDrop) => void;
  className?: string;
}) {
  const [search, setSearch] = useState("");
  const [collectionId, setCollectionId] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const debounced = useDebounced(search, 250);
  const { data, isLoading, isError } = useInboxProducts(conversationId, debounced.trim(), true, collectionId ?? undefined);
  const canDrag = useMediaQuery("(pointer: fine)");
  const groups = useMemo(() => byProduct(data?.products ?? []), [data]);
  const asCards = !!data?.canSendProducts;
  const collection: Collection | null = data?.collections.find((c) => c.id === collectionId) ?? null;
  const disabled = !!blockedReason || isSending;

  // A collection goes as a product list of what is in the catalog, or as its link.
  const collectionDrop: CatalogDrop | null = !collection
    ? null
    : asCards
      ? (() => {
          const items = (data?.products ?? []).filter((p) => p.inCatalog).slice(0, MAX_PRODUCTS);
          return items.length ? { kind: "products", items, asCards: true, header: collection.title } : null;
        })()
      : collection.url
        ? { kind: "link", text: `${collection.title}: ${collection.url}` }
        : null;

  const toggle = (productId: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(productId)) next.delete(productId);
      else next.add(productId);
      return next;
    });

  const actions = (drop: CatalogDrop, label: string) => (
    <span className="flex shrink-0 items-center gap-0.5">
      <Button variant="ghost" size="icon-xs" disabled={disabled} onClick={() => onAdd(drop)} aria-label={`Add ${label} to the reply`} title={blockedReason ?? "Add to the reply"}>
        <Plus />
      </Button>
      <Button variant="ghost" size="icon-xs" disabled={disabled} onClick={() => onSend(drop)} aria-label={`Send ${label}`} title={blockedReason ?? "Send now"}>
        <Send />
      </Button>
    </span>
  );

  const variantRow = (v: StoreProduct, nested: boolean) => {
    const drop: CatalogDrop = { kind: "products", items: [v], asCards };
    const name = nested ? (v.variantTitle ?? v.title) : v.title;
    return (
      <li
        key={v.variantId}
        draggable={canDrag && !disabled}
        onDragStart={(event) => startDrag(event, drop)}
        className={cn("group flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-muted/60", nested && "pl-10", canDrag && !disabled && "cursor-grab active:cursor-grabbing")}
      >
        {canDrag && !nested && <GripVertical className="size-3.5 shrink-0 text-muted-foreground/50 group-hover:text-muted-foreground" />}
        {!nested && (
          <span className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted">
            {v.image ? <img src={v.image} alt="" className="size-full object-cover" loading="lazy" draggable={false} /> : <Package className="size-4 text-muted-foreground" />}
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-caption font-medium">{name}</span>
          <span className="block truncate text-micro text-muted-foreground">
            {formatPrice(v)}
            {!v.inStock && <span className="text-warning"> · out of stock</span>}
            {asCards && !v.inCatalog && " · not in the catalog, goes as a link"}
          </span>
        </span>
        {actions(drop, name)}
      </li>
    );
  };

  return (
    <aside aria-label="Products" className={cn("flex min-h-0 flex-col", className)}>
      <div className="space-y-2 border-b p-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search products" className="h-8 pl-8" aria-label="Search products" />
        </div>
        {!!data?.collections.length && (
          <div className="-mx-3 flex gap-1.5 overflow-x-auto px-3 pb-0.5 [scrollbar-width:none]" role="radiogroup" aria-label="Collection">
            {[{ id: null, title: "All" } as const, ...data.collections].map((c) => (
              <button
                key={c.id ?? "all"}
                type="button"
                role="radio"
                aria-checked={collectionId === c.id}
                onClick={() => setCollectionId(c.id)}
                className={cn(
                  "shrink-0 whitespace-nowrap rounded-full border px-2.5 py-1 text-micro",
                  collectionId === c.id ? "border-brand bg-brand/10 font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {c.title}
                {"productCount" in c && <span className="ml-1 tabular-nums opacity-70">{c.productCount}</span>}
              </button>
            ))}
          </div>
        )}
        <p className="text-micro text-muted-foreground">
          {blockedReason ??
            (data
              ? `${asCards ? "Products go as WhatsApp product cards from your catalog." : data.catalog ? "This number shares the WhatsApp Business app, so products go as links." : "Products go as a message with each product’s link."}${canDrag ? " Drag one into the chat to add it to your reply." : ""}`
              : " ")}
        </p>
      </div>

      {collection && collectionDrop && (
        <div
          draggable={canDrag && !disabled}
          onDragStart={(event) => startDrag(event, collectionDrop)}
          className={cn("flex items-center gap-2 border-b bg-muted/40 px-3 py-2", canDrag && !disabled && "cursor-grab active:cursor-grabbing")}
        >
          <Layers className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-caption font-medium">{collection.title}</span>
            <span className="block text-micro text-muted-foreground">
              {collectionDrop.kind === "products"
                ? `${collectionDrop.items.length === MAX_PRODUCTS ? `The first ${MAX_PRODUCTS}` : collectionDrop.items.length} as one product list`
                : "As a link to the collection page"}
            </span>
          </span>
          {actions(collectionDrop, `the ${collection.title} collection`)}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {isLoading ? (
          <div className="flex h-24 items-center justify-center">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          </div>
        ) : isError ? (
          <p className="px-3 py-4 text-caption text-muted-foreground">Products could not be loaded.</p>
        ) : !groups.length ? (
          <p className="px-3 py-4 text-caption text-muted-foreground">
            {debounced ? "No products match." : collection ? "No active products in this collection." : "No active products in the store yet."}
          </p>
        ) : (
          <ul className="space-y-0.5">
            {groups.map((g) =>
              g.variants.length === 1 ? (
                variantRow(g.variants[0], false)
              ) : (
                <li key={g.productId}>
                  <button
                    type="button"
                    onClick={() => toggle(g.productId)}
                    aria-expanded={open.has(g.productId)}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-muted/60"
                  >
                    {open.has(g.productId) ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />}
                    <span className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted">
                      {g.image ? <img src={g.image} alt="" className="size-full object-cover" loading="lazy" draggable={false} /> : <Package className="size-4 text-muted-foreground" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-caption font-medium">{g.title}</span>
                      <span className="block text-micro text-muted-foreground">
                        {g.variants.length} options · {priceRange(g.variants)}
                      </span>
                    </span>
                  </button>
                  {open.has(g.productId) && <ul className="space-y-0.5">{g.variants.map((v) => variantRow(v, true))}</ul>}
                </li>
              ),
            )}
          </ul>
        )}
        {data?.more && <p className="px-3 py-3 text-micro text-muted-foreground">Showing the first 100. Search or pick a collection to see the rest.</p>}
      </div>
    </aside>
  );
}
