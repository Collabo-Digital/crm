import { useEffect, useMemo, useRef } from "react";
import { Link } from "react-router";

import { Input } from "~/components/ui/input";
import { STOCK_TERMS } from "~/lib/inventory-vocabulary";
import { useSelectedLocation } from "~/hooks/use-selected-location";
import { useVariantStock } from "~/hooks/use-inventory-queries";
import { cn } from "~/lib/utils";

/**
 * Editable per-warehouse Available quantities for one variant.
 *
 * Only AVAILABLE is editable here. Reserved / QC / Damaged are shown as read-only
 * context so nobody reads "Available" as on-hand, but moving stock between those
 * buckets is the Inventory screen's job — it needs a reason and a bucket pair.
 *
 * Saving goes through `POST /inventory/adjustments` (one call per changed
 * warehouse), not through the variant PATCH: the server rejects an
 * `inventoryQuantity` that arrives without a `warehouseId`, and the adjustment
 * path is what writes the audit ledger row.
 */
export function VariantWarehouseStockEditor({
  variantId,
  values,
  onChange,
  onLevelsLoaded,
  disabled,
}: {
  variantId: string;
  /** warehouseId → desired AVAILABLE, as typed. */
  values: Record<string, string>;
  onChange: (warehouseId: string, value: string) => void;
  /** Fired once, when the levels first arrive, to seed the draft and baseline. */
  onLevelsLoaded: (seed: Record<string, string>) => void;
  disabled?: boolean;
}) {
  const stock = useVariantStock(variantId);
  const { locationId } = useSelectedLocation({ sync: false });
  const seeded = useRef(false);

  // Every location stays listed — Shopify's variant page lists them all, and
  // each box is labelled, so nothing is ambiguous. The one the merchant is
  // currently working in is pinned to the top so the page respects their
  // choice without hiding the others.
  const levels = useMemo(() => {
    const all = stock.data?.levels;
    if (!all || !locationId) return all;
    return [...all].sort((a, b) =>
      a.warehouseId === locationId ? -1 : b.warehouseId === locationId ? 1 : 0,
    );
  }, [stock.data?.levels, locationId]);

  useEffect(() => {
    if (seeded.current || !levels) return;
    seeded.current = true;
    const seed: Record<string, string> = {};
    for (const level of levels) seed[level.warehouseId] = String(level.available);
    onLevelsLoaded(seed);
  }, [levels, onLevelsLoaded]);

  const shell = "rounded-lg border border-border px-4 py-3 text-caption text-muted-foreground";

  if (stock.isLoading) {
    return <div className={shell}>Loading stock by warehouse…</div>;
  }
  if (stock.isError) {
    return <div className={shell}>Couldn&apos;t load stock by warehouse.</div>;
  }
  if (!levels || levels.length === 0) {
    return (
      <div className={shell}>
        No stock recorded for this variant yet. Add some from{" "}
        <Link to="/products/inventory" className="underline">
          Inventory
        </Link>
        — pick a location and set a quantity.
      </div>
    );
  }

  return (
    <div className="divide-y rounded-lg border border-border">
      {/* Names the figure being edited. Without this the merchant is typing
          into an unlabelled box and has to guess which bucket it is. */}
      <div className="flex items-center gap-3 bg-muted/50 px-4 py-2">
        <span className="min-w-0 flex-1 text-micro font-medium uppercase tracking-wide text-muted-foreground">
          Location
        </span>
        <span className="w-24 text-right text-micro font-medium uppercase tracking-wide text-muted-foreground">
          {STOCK_TERMS.available.label}
        </span>
      </div>
      {/* The Inventory screen says this in its explainer; a merchant typing a
          quantity here deserves the same warning without having to go there. */}
      <p className="bg-warning-subtle px-4 py-2 text-micro text-muted-foreground">
        Saved here and pushed to Shopify. If the same quantity changes in both
        places, the next sync from Shopify wins.
      </p>
      {levels.map((level) => {
        const held = level.reserved + level.qc + level.damaged;
        return (
          <div key={level.id} className="flex items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-label text-foreground" title={level.warehouse.name}>
                {level.warehouse.name}
                {level.warehouseId === locationId && (
                  <span className="ml-2 rounded-full bg-brand/15 px-1.5 py-0.5 text-micro font-medium text-brand-strong">
                    Selected
                  </span>
                )}
                {level.defaultLocation?.fullCode && (
                  <span className="ml-1.5 font-mono text-micro text-muted-foreground">
                    {level.defaultLocation.fullCode}
                  </span>
                )}
              </p>
              {held > 0 && (
                <p className="text-micro text-muted-foreground">
                  {[
                    level.reserved > 0 && `${level.reserved} reserved`,
                    level.qc > 0 && `${level.qc} in QC`,
                    level.damaged > 0 && `${level.damaged} damaged`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              )}
            </div>
            <Input
              type="number"
              min="0"
              step="1"
              inputMode="numeric"
              aria-label={`Available in ${level.warehouse.name}`}
              className={cn(
                "h-9 w-24 text-right tabular-nums",
                level.available < 0 && "text-danger",
              )}
              value={values[level.warehouseId] ?? ""}
              onChange={(e) => onChange(level.warehouseId, e.target.value)}
              disabled={disabled}
            />
          </div>
        );
      })}
    </div>
  );
}
