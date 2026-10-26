import { Plus, X } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { LocationKindBadge } from "~/components/app/inventory/location-kind-badge";
import type { OpeningStockLine, ProductVariantInput, Warehouse } from "~/types/api";

/** The first active location not chosen yet, the default before any other. */
export function nextUnusedLocation(
  locations: Warehouse[],
  chosenIds: string[],
): Warehouse | undefined {
  const unused = locations.filter((location) => !chosenIds.includes(location.id));
  return unused.find((location) => location.isDefault) ?? unused[0];
}

/**
 * A variant's stock lines lined up with the chosen locations. Quantities
 * belong to a row, so a row whose location is changed keeps its number.
 */
export function stockLinesFor(
  variant: Pick<ProductVariantInput, "stock">,
  locationIds: string[],
): OpeningStockLine[] {
  return locationIds.map((warehouseId, index) => ({
    warehouseId,
    quantity: variant.stock?.[index]?.quantity ?? 0,
  }));
}

/**
 * The locations a new product is stocked at, one row each: a location
 * dropdown, the quantity there when `quantities` is given, a remove button on
 * every row after the first, and a button that adds the next unused location.
 */
export function StockLocationRows({
  locations,
  locationIds,
  onLocationChange,
  onAdd,
  onRemove,
  quantities,
  onQuantityChange,
}: {
  /** Active locations only. */
  locations: Warehouse[];
  locationIds: string[];
  onLocationChange: (index: number, warehouseId: string) => void;
  onAdd: () => void;
  onRemove: (index: number) => void;
  quantities?: string[];
  onQuantityChange?: (index: number, quantity: string) => void;
}) {
  const canAdd = !!nextUnusedLocation(locations, locationIds);

  return (
    <div className="space-y-2">
      {locationIds.map((warehouseId, index) => {
        const name = locations.find((location) => location.id === warehouseId)?.name ?? "location";
        return (
          <div key={index} className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <Select
                value={warehouseId}
                onValueChange={(next) => onLocationChange(index, next)}
              >
                <SelectTrigger
                  className="w-full bg-white text-xs data-[size=default]:h-9 dark:bg-gray-800"
                  aria-label={`Location ${index + 1}`}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {locations.map((location) => (
                    <SelectItem
                      key={location.id}
                      value={location.id}
                      // A location already on another row cannot be picked
                      // twice; it stays listed so the merchant sees why.
                      disabled={location.id !== warehouseId && locationIds.includes(location.id)}
                      className="text-xs"
                    >
                      <span className="truncate">{location.name}</span>
                      {/* On a phone the chosen row shows the name alone; the
                          list below it still says Store or Warehouse. */}
                      <LocationKindBadge
                        kind={location.kind}
                        className="max-sm:in-data-[slot=select-trigger]:hidden"
                      />
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {quantities && onQuantityChange && (
              <input
                type="number"
                inputMode="numeric"
                min={0}
                step={1}
                value={quantities[index] ?? ""}
                onChange={(e) => onQuantityChange(index, e.target.value)}
                aria-label={`Stock at ${name}`}
                className="h-9 w-20 shrink-0 rounded-lg border border-input bg-white px-3 text-right text-xs tabular-nums sm:w-24 focus:outline-none focus:ring-2 focus:ring-[#CEF17B]/50 dark:bg-gray-800"
              />
            )}
            {index > 0 ? (
              <button
                type="button"
                onClick={() => onRemove(index)}
                aria-label={`Remove ${name}`}
                title={`Remove ${name}`}
                className="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-gray-100 hover:text-red-600 dark:hover:bg-gray-800"
              >
                <X className="size-3.5" />
              </button>
            ) : (
              // Keeps the first row's fields lined up with the rows below it.
              <span className="size-9 shrink-0" aria-hidden />
            )}
          </div>
        );
      })}
      {canAdd && (
        <button
          type="button"
          onClick={onAdd}
          className="inline-flex items-center gap-1 rounded-md border border-dashed border-input px-2.5 py-1.5 text-[11px] font-medium text-gray-700 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-800"
        >
          <Plus className="size-3.5" />
          Add another location
        </button>
      )}
    </div>
  );
}
