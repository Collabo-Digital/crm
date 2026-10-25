import { Store, Warehouse as WarehouseIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import type { LocationKind } from "~/types/api";

export const LOCATION_KIND_LABEL: Record<LocationKind, string> = {
  STORE: "Store",
  WAREHOUSE: "Warehouse",
};

export const LOCATION_KIND_ICON = { STORE: Store, WAREHOUSE: WarehouseIcon } as const;

/** Store or Warehouse, wherever a location is named. */
export function LocationKindBadge({
  kind,
  className,
}: {
  kind: LocationKind;
  className?: string;
}) {
  const Icon = LOCATION_KIND_ICON[kind];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold leading-4",
        kind === "STORE" ? "bg-info-subtle text-info" : "bg-muted text-muted-foreground",
        className,
      )}
    >
      <Icon className="size-2.5" />
      {LOCATION_KIND_LABEL[kind]}
    </span>
  );
}
