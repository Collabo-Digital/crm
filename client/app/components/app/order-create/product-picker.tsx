import { useState } from "react";
import { Search, Plus } from "lucide-react";
import { useProducts } from "~/hooks/use-product-queries";
import { useOrganizationSettings } from "~/hooks/use-settings-queries";
import { formatCurrency } from "~/lib/utils";
import type { Product, ProductVariant } from "~/types/api";
import { useDebounced } from "~/hooks/use-debounced";

export type CartLineSeed = {
  variantId: string;
  productId: string;
  productTitle: string;
  variantTitle: string;
  unitPrice: number;
  inventoryQuantity: number;
  gstRate: number | null;
  /**
   * True when the variant is allowed to oversell — either the org-level
   * `allowOversellGlobally` is on, or the variant's per-row
   * `continueSellingWhenOutOfStock` is on, or stock isn't tracked at all.
   * Threaded into the cart so it can soften its overflow warning instead of
   * blocking submission.
   */
  canOversell: boolean;
};


export function ProductPicker({
  onAdd,
  currency,
  excludedVariantIds,
}: {
  onAdd: (line: CartLineSeed) => void;
  currency: string;
  excludedVariantIds: Set<string>;
}) {
  const [query, setQuery] = useState("");
  const debounced = useDebounced(query);
  // Prices restated in the currency THIS order is billed in. A variant synced
  // from a foreign-currency store carries that store's number, so without this
  // the picker showed a $749.95 snowboard as "₹749.95" and seeded the cart with
  // 749.95 — about a ninety-fourth of the real price. The server re-converts at
  // submit, so what is shown here is what gets charged.
  const { data, isLoading } = useProducts({
    search: debounced || undefined,
    limit: 8,
    status: "ACTIVE",
    priceIn: currency,
  });
  const { data: orgSettings } = useOrganizationSettings();
  const oversellGlobally =
    orgSettings?.productSettings?.allowOversellGlobally === true;
  const trackGlobally =
    orgSettings?.productSettings?.trackQuantityGlobally === true;

  const rows: Array<{ product: Product; variant: ProductVariant }> = [];
  for (const product of data?.data ?? []) {
    for (const variant of product.variants) {
      if (excludedVariantIds.has(variant.id)) continue;
      rows.push({ product, variant });
    }
  }

  /**
   * Per-variant decision: should this row let me Add even at 0 stock?
   *
   *   - If overselling is allowed (global flag or variant flag) → yes
   *   - If the variant isn't tracked (variant flag off and global track off) → yes
   *   - Otherwise → only when stock > 0
   *
   * The flag this returns also flows into the cart so the overflow indicator
   * picks the right tone (amber "backorder" vs. red "out of stock").
   */
  function resolveCanOversell(variant: ProductVariant) {
    const tracks = trackGlobally || variant.trackQuantity !== false;
    if (!tracks) return true;
    if (oversellGlobally) return true;
    if (variant.continueSellingWhenOutOfStock === true) return true;
    return false;
  }

  function add(product: Product, variant: ProductVariant) {
    onAdd({
      variantId: variant.id,
      productId: product.id,
      productTitle: product.title,
      variantTitle: variant.title,
      unitPrice: variant.price,
      inventoryQuantity: variant.inventoryQuantity,
      // Product GST rate is not exposed on the list summary; the server is the
      // source of truth at submit time. UI shows preview using 0 fallback.
      gstRate: null,
      canOversell: resolveCanOversell(variant),
    });
  }

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          type="search"
          placeholder="Search products by name, vendor or SKU…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="h-9 w-full rounded-lg border border-input bg-white dark:bg-gray-900 pl-8 pr-3 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-[#CEF17B]/50"
        />
      </div>

      <div className="rounded-lg border bg-white dark:bg-gray-900 max-h-72 overflow-y-auto">
        {isLoading ? (
          <p className="p-3 text-xs text-muted-foreground">Searching…</p>
        ) : rows.length === 0 ? (
          <p className="p-3 text-xs text-muted-foreground">
            {debounced
              ? `No products match "${debounced}".`
              : "Start typing to search products."}
          </p>
        ) : (
          rows.map(({ product, variant }) => {
            const oos = variant.inventoryQuantity <= 0;
            const canOversell = resolveCanOversell(variant);
            // The server restates prices into this order's currency, but it
            // leaves them alone when the rate is unreachable. Adding such a
            // line would put a foreign number into the cart and charge it as
            // local money, so block it and say why — the cashier can still ring
            // the item up by entering the price on an existing line.
            const priceCurrency = product.priceCurrency ?? currency;
            const foreignPrice = priceCurrency.toUpperCase() !== currency.toUpperCase();
            const blockAdd = (oos && !canOversell) || foreignPrice;
            return (
              <div
                key={variant.id}
                className="flex items-center justify-between gap-3 border-b last:border-b-0 px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium text-gray-900 dark:text-gray-100 truncate">
                    {product.title}
                  </p>
                  <p className="text-[10px] text-muted-foreground truncate">
                    {variant.title}
                    {variant.sku ? ` • SKU ${variant.sku}` : ""}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-xs font-semibold tabular-nums text-gray-900 dark:text-gray-100">
                    {formatCurrency(variant.price, priceCurrency)}
                  </p>
                  <p
                    className={`text-[10px] tabular-nums ${oos
                      ? canOversell
                        ? "text-amber-600"
                        : "text-red-600"
                      : variant.inventoryQuantity <= 5
                        ? "text-amber-600"
                        : "text-muted-foreground"
                      }`}
                  >
                    {oos && canOversell
                      ? "Out of stock · backorder OK"
                      : `${variant.inventoryQuantity} in stock`}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => add(product, variant)}
                  disabled={blockAdd}
                  title={
                    foreignPrice
                      ? `Priced in ${priceCurrency} and today's ${priceCurrency}→${currency} rate is unavailable, so this cannot be billed in ${currency} yet.`
                      : blockAdd
                        ? "Out of stock. Enable 'Continue selling when out of stock' on this variant or globally to allow backorders."
                        : undefined
                  }
                  className="inline-flex h-8 items-center gap-1 rounded-lg bg-[#CEF17B] px-3 text-xs font-medium text-gray-900 hover:bg-[#BADE6F] disabled:pointer-events-none disabled:opacity-40"
                >
                  <Plus className="size-3.5" />
                  Add
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
