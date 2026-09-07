import { useEffect, useRef } from "react";
import { Link } from "react-router";

import { Input } from "~/components/ui/input";
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
  const levels = stock.data?.levels;
  const seeded = useRef(false);

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
        No stock recorded for this variant yet. Receive or adjust it from{" "}
        <Link to="/products/inventory" className="underline">
          Inventory
        </Link>
        .
      </div>
    );
  }

  return (
    <div className="divide-y rounded-lg border border-border">
      {levels.map((level) => {
        const held = level.reserved + level.qc + level.damaged;
        return (
          <div key={level.id} className="flex items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-label text-foreground">
                {level.warehouse.name}
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
