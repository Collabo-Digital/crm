import { useMemo } from "react";
import { History, MoveRight } from "lucide-react";
import {
  DataTable,
  DateCell,
  MonoCell,
  NumCell,
  ProductCell,
  TextCell,
  useDataTableState,
  type ColumnDef,
  type FilterDef,
} from "~/components/app/data-table";
import { useListUrlState } from "~/hooks/use-list-url-state";
import { useInventoryLedger } from "~/hooks/use-inventory-queries";
import { useSelectedLocation } from "~/hooks/use-selected-location";
import { InventoryTabs } from "~/components/app/inventory/inventory-tabs";
import { LocationPicker } from "~/components/app/inventory/location-picker";
import { bucketLabel, reasonLabel } from "~/lib/inventory-vocabulary";
import type { InventoryEvent, LedgerParams } from "~/types/api";
import { pageTitle } from "~/lib/page-title";

const REASONS = [
  "sale",
  "restock",
  "sync",
  "webhook",
  "adjustment",
  "count",
  "damage",
  "found",
  "correction",
  "initial",
  "migration",
] as const;

const REASON_FILTER: FilterDef = {
  key: "reason",
  label: "Reason",
  options: REASONS.map((r) => ({ value: r, label: r.charAt(0).toUpperCase() + r.slice(1) })),
};
const FILTERS: ReadonlyArray<FilterDef> = [REASON_FILTER];

/**
 * Human phrasing for a movement row. A null bucket means the stock entered or
 * left the business entirely, which reads as In/Out rather than as a blank.
 * Labels come from the shared vocabulary so this never says AVAILABLE again.
 */
function describeMovement(e: InventoryEvent): string {
  if (e.fromBucket || e.toBucket) {
    return `${bucketLabel(e.fromBucket, "from")} → ${bucketLabel(e.toBucket, "to")}`;
  }
  // Legacy row: signed aggregate change.
  return e.changeAmount > 0 ? `+${e.changeAmount}` : String(e.changeAmount);
}

const COLUMNS: ColumnDef<InventoryEvent>[] = [
  {
    key: "when",
    label: "When",
    width: 170,
    locked: true,
    cell: (e) => <DateCell value={e.createdAt} time />,
  },
  {
    key: "product",
    label: "Product",
    width: 260,
    cell: (e) => (
      <ProductCell
        title={
          e.productTitle ?? <span className="italic text-muted-foreground">deleted variant</span>
        }
        sub={e.variantTitle && e.variantTitle !== "Default Title" ? e.variantTitle : undefined}
      />
    ),
  },
  {
    key: "sku",
    label: "SKU",
    width: 140,
    cell: (e) => <MonoCell value={e.sku} />,
  },
  {
    key: "movement",
    label: "Movement",
    width: 180,
    cell: (e) => (
      <span className="inline-flex max-w-full items-center gap-1 truncate rounded-full bg-muted px-2 py-0.5 text-micro font-medium">
        {e.fromBucket || e.toBucket ? <MoveRight className="size-3 shrink-0" /> : null}
        {describeMovement(e)}
      </span>
    ),
  },
  {
    key: "qty",
    label: "Qty",
    width: 80,
    align: "right",
    cell: (e) => <NumCell value={e.movedQty ?? Math.abs(e.changeAmount)} />,
  },
  {
    key: "available",
    label: "Available",
    width: 120,
    align: "right",
    cell: (e) => (
      <span className="whitespace-nowrap tabular-nums text-muted-foreground">
        {e.quantityBefore} → {e.quantityAfter}
      </span>
    ),
  },
  {
    key: "reason",
    label: "Reason",
    width: 120,
    cell: (e) => <TextCell>{reasonLabel(e.reason)}</TextCell>,
  },
];

export function meta() {
  return [{ title: pageTitle("Movement history", "Inventory") }];
}

export default function InventoryLedgerPage() {
  // Page, reason and page size live in the URL; the location picker writes
  // `warehouseId` there itself (useSelectedLocation).
  const list = useListUrlState("ledger");
  const { locations, locationId, location, setLocationId } = useSelectedLocation();

  const table = useDataTableState({
    key: "ledger",
    list,
    columns: COLUMNS,
    filters: FILTERS,
  });

  const params: LedgerParams = useMemo(
    () => ({
      page: table.page,
      limit: table.limit,
      reason: table.filters.reason?.[0],
      warehouseId: locationId,
    }),
    [table.page, table.limit, table.filters.reason, locationId],
  );

  const ledger = useInventoryLedger(params, Boolean(locationId));

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">
        Movement history
      </h1>

      <InventoryTabs />

      <div className="flex flex-wrap items-center gap-2">
        <LocationPicker locations={locations} value={locationId} onChange={setLocationId} />
        {location && (
          <span className="ml-auto text-caption text-muted-foreground">
            Movements at {location.name}
          </span>
        )}
      </div>

      <DataTable
        state={table}
        rows={ledger.data?.data ?? []}
        rowKey={(e) => e.id}
        meta={ledger.data?.meta}
        status={{
          isLoading: !locationId || ledger.isLoading,
          isError: ledger.isError,
          isPlaceholderData: ledger.isPlaceholderData,
          refetch: ledger.refetch,
        }}
        noun="movements"
        searchable={false}
        emptyState={{
          icon: History,
          title: "No movements yet",
          description:
            "Every stock change — sales, restocks, adjustments, sync corrections — appears here with its before/after quantities.",
        }}
      />
    </div>
  );
}
