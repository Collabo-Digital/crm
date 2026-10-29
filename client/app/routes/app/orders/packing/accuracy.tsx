import { useMemo } from "react";
import { Link } from "react-router";
import { ChevronRight } from "lucide-react";
import { DataTable, NumCell, PersonCell, useDataTableState, type ColumnDef } from "~/components/app/data-table";
import { StatCard } from "~/components/app/stat-card";
import {
  PageHeader,
  PageHeaderContent,
  PageHeaderDescription,
  PageHeaderTitle,
} from "~/components/ui/page-header";
import { useCurrentRole } from "~/hooks/use-current-role";
import { useWarehouses } from "~/hooks/use-inventory-queries";
import { useListUrlState } from "~/hooks/use-list-url-state";
import { useCurrentOrg } from "~/hooks/use-org-queries";
import { usePackingAccuracy } from "~/hooks/use-packing-queries";
import { calendarDaysAgo, reportingTimeZone, todayIn } from "~/lib/reporting-date";
import type { PackingAccuracyCounts, PackingAccuracyRow } from "~/types/api";

export function meta() {
  return [{ title: "Packing accuracy | Collabo CRM" }];
}

type RangePreset = "today" | "7d" | "30d";
const PRESETS: ReadonlyArray<{ value: RangePreset; label: string }> = [
  { value: "today", label: "Today" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
];
const PRESET_DAYS: Record<RangePreset, number> = { today: 0, "7d": 6, "30d": 29 };

/** Units checked by hand or by a typed count, out of every unit packed. */
function byHandShare(c: PackingAccuracyCounts): string {
  const total = c.unitsScanned + c.unitsHandConfirmed + c.unitsCounted;
  if (total === 0) return "—";
  return `${Math.round(((c.unitsHandConfirmed + c.unitsCounted) / total) * 100)}%`;
}

export default function PackingAccuracyPage() {
  const list = useListUrlState("packing-accuracy");
  const { can } = useCurrentRole();
  const { data: org } = useCurrentOrg();
  const timeZone = reportingTimeZone(org?.timezone);
  const today = todayIn(timeZone);
  const warehouses = useWarehouses(can("inventory.view"));
  const locations = useMemo(() => (warehouses.data ?? []).filter((w) => w.isActive), [warehouses.data]);

  const columns = useMemo<ColumnDef<PackingAccuracyRow>[]>(
    () => [
      { key: "name", label: "Packer", width: 200, locked: true, cell: (r) => <PersonCell name={r.name} /> },
      { key: "orders", label: "Orders packed", width: 120, align: "right", cell: (r) => <NumCell value={r.ordersPacked} strong /> },
      { key: "scanned", label: "Scanned", width: 100, align: "right", cell: (r) => <NumCell value={r.unitsScanned} /> },
      {
        key: "hand",
        label: "By hand",
        headerTooltip: "Items confirmed by hand or counted instead of scanned.",
        width: 110,
        align: "right",
        cell: (r) => (
          <span className="tabular-nums">
            {r.unitsHandConfirmed + r.unitsCounted}
            <span className="text-muted-foreground"> · {byHandShare(r)}</span>
          </span>
        ),
      },
      {
        key: "wrong",
        label: "Wrong items caught",
        headerTooltip: "Scans of a product that wasn't in the order. Each one is a mistake stopped before it shipped.",
        width: 150,
        align: "right",
        cell: (r) => <NumCell value={r.wrongScans} />,
      },
      {
        key: "over",
        label: "Extra scans",
        headerTooltip: "Scans of an item the order already had enough of.",
        width: 110,
        align: "right",
        cell: (r) => <NumCell value={r.overScans} />,
      },
      { key: "problems", label: "Problems", width: 100, align: "right", cell: (r) => <NumCell value={r.problems} /> },
    ],
    [],
  );

  const table = useDataTableState({
    key: "packing-accuracy",
    list,
    columns,
    // The server's own default window, so a bare link means the same thing.
    date: { presets: PRESETS, default: "30d", custom: true, today },
    scopes: [
      {
        key: "warehouseId",
        label: "Location",
        default: "",
        options: [
          { value: "", label: "All locations" },
          ...locations.map((w) => ({ value: w.id, label: w.name })),
          { value: "none", label: "No location set" },
        ],
      },
    ],
  });

  // Calendar days in the organization's reporting zone, like every other report.
  const custom = table.date?.custom;
  const preset = (table.date?.preset ?? "30d") as RangePreset;
  const from = custom ? custom.from : calendarDaysAgo(PRESET_DAYS[preset] ?? 29, timeZone);
  const to = custom ? custom.to : today;
  const accuracy = usePackingAccuracy({ from, to, warehouseId: table.scope.warehouseId || undefined });
  const totals = accuracy.data?.totals;

  const tiles = [
    { label: "Orders packed", value: totals?.ordersPacked.toLocaleString("en-IN") },
    { label: "Items scanned", value: totals?.unitsScanned.toLocaleString("en-IN") },
    { label: "Checked by hand", value: totals ? byHandShare(totals) : undefined, note: "Share of items not scanned" },
    { label: "Wrong items caught", value: totals?.wrongScans.toLocaleString("en-IN"), note: "Stopped before shipping" },
  ];

  return (
    <div className="space-y-6">
      <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-caption">
        <Link to="/orders/packing" className="text-muted-foreground hover:text-foreground">
          Packing
        </Link>
        <ChevronRight className="size-3 text-muted-foreground" />
        <span className="font-medium text-foreground">Accuracy</span>
      </nav>
      <PageHeader data-mobile-title>
        <PageHeaderContent>
          <PageHeaderTitle>Packing accuracy</PageHeaderTitle>
          <PageHeaderDescription>
            Who packed what, and how much was checked by scanning rather than by hand.
          </PageHeaderDescription>
        </PageHeaderContent>
      </PageHeader>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {tiles.map((t) => (
          <StatCard key={t.label} label={t.label} value={t.value} changeLabel={t.note} isLoading={accuracy.isLoading} />
        ))}
      </div>

      <DataTable
        state={table}
        rows={accuracy.data?.rows ?? []}
        rowKey={(r) => r.userId}
        meta={undefined}
        paginated={false}
        searchable={false}
        status={{
          isLoading: accuracy.isLoading,
          isError: accuracy.isError,
          isPlaceholderData: accuracy.isPlaceholderData,
          refetch: () => void accuracy.refetch(),
        }}
        noun="packers"
        emptyState={{
          title: "No packing in this period",
          description: "Once orders are packed, each packer's figures show up here.",
        }}
      />
    </div>
  );
}
