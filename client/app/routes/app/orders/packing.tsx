import { useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";
import { ChartColumn, Loader2, ScanBarcode } from "lucide-react";
import { DataTable, IdCell, PersonCell, useDataTableState, type ColumnDef } from "~/components/app/data-table";
import { CameraScanner, type ScanFeedback } from "~/components/app/pos/camera-scanner";
import { PackingBadges } from "~/components/app/packing/packing-badges";
import { SegmentedTabs } from "~/components/app/segmented-tabs";
import { Button } from "~/components/ui/button";
import {
  PageHeader,
  PageHeaderActions,
  PageHeaderContent,
  PageHeaderDescription,
  PageHeaderTitle,
} from "~/components/ui/page-header";
import { useKeyboardWedge } from "~/hooks/use-barcode-wedge";
import { useCurrentRole } from "~/hooks/use-current-role";
import { useWarehouses } from "~/hooks/use-inventory-queries";
import { useListUrlState } from "~/hooks/use-list-url-state";
import { useMediaQuery } from "~/hooks/use-media-query";
import { useNow } from "~/hooks/use-now";
import { useLookupMutation } from "~/hooks/use-packing-mutations";
import { usePackingQueue } from "~/hooks/use-packing-queries";
import { formatRelativeTime } from "~/lib/format-date";
import { serverMessage } from "~/lib/handle-mutation-error";
import { itemsWord, paymentBadges, queueBadges, taskBadge } from "~/lib/packing";
import { beep, wakeSound } from "~/lib/pos-device";
import type { PackingBucket, PackingQueueRow } from "~/types/api";

export function meta() {
  return [
    { title: "Packing | Collabo CRM" },
    { name: "description", content: "Scan each order's items into the parcel before it ships" },
  ];
}

const BUCKETS: ReadonlyArray<{ value: PackingBucket; label: string; empty: string; hint: string }> = [
  { value: "to_pack", label: "To pack", empty: "Nothing to pack", hint: "New orders that need packing show up here, oldest first." },
  { value: "packing", label: "Packing", empty: "No one is packing right now", hint: "Orders appear here while someone is scanning them." },
  { value: "on_hold", label: "On hold", empty: "Nothing on hold", hint: "Orders put aside, for example with items short, wait here." },
  { value: "packed", label: "Packed", empty: "Nothing packed yet", hint: "Packed orders wait here until they ship." },
];
const BUCKET_VALUES = BUCKETS.map((b) => b.value);

/** A packed order opens as it is; the rest open for packing. */
function packHref(row: PackingQueueRow): string {
  return row.task?.status === "PACKED"
    ? `/orders/packing/${row.orderId}?task=${row.task.id}`
    : `/orders/packing/${row.orderId}`;
}

export default function PackingQueuePage() {
  const list = useListUrlState("packing");
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const phone = useMediaQuery("(max-width: 767px)");
  const { can } = useCurrentRole();

  const rawBucket = params.get("bucket");
  const bucket = BUCKET_VALUES.find((b) => b === rawBucket) ?? "to_pack";
  const bucketDef = BUCKETS.find((b) => b.value === bucket)!;

  // The location list needs inventory.view; without it there is no filter.
  const warehouses = useWarehouses(can("inventory.view"));
  const locations = useMemo(() => (warehouses.data ?? []).filter((w) => w.isActive), [warehouses.data]);

  const columns = useMemo<ColumnDef<PackingQueueRow>[]>(
    () => [
      {
        key: "order",
        label: "Order",
        width: 150,
        locked: true,
        cell: (row) => (
          <div className="flex min-w-0 flex-col gap-0.5 leading-[1.35]">
            <IdCell>{row.orderName}</IdCell>
            <Ago iso={row.createdAt} className="text-caption text-muted-foreground" />
          </div>
        ),
      },
      {
        key: "customer",
        label: "Customer",
        width: 200,
        cell: (row) => <PersonCell name={row.customerName ?? "Guest"} sub={row.city} />,
      },
      {
        key: "items",
        label: "Items",
        width: 110,
        cell: (row) => (
          <span className="tabular-nums">
            {itemsWord(row.units)}
            {row.lines > 1 && <span className="text-muted-foreground"> · {row.lines} lines</span>}
          </span>
        ),
      },
      {
        key: "payment",
        label: "Payment",
        width: 170,
        cell: (row) => <PackingBadges badges={paymentBadges(row)} />,
      },
      {
        key: "packing",
        label: "Packing",
        width: 240,
        cell: (row) => <TaskCell row={row} />,
      },
      {
        key: "location",
        label: "Location",
        width: 140,
        hiddenByDefault: true,
        cell: (row) => <span className="truncate">{row.warehouse?.name ?? "—"}</span>,
      },
    ],
    [],
  );

  const table = useDataTableState({
    key: "packing",
    list,
    columns,
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

  const warehouseId = table.scope.warehouseId || undefined;
  const queue = usePackingQueue({
    bucket,
    warehouseId,
    search: table.debouncedSearch || undefined,
    page: table.page,
    limit: table.limit,
  });
  const meta = queue.data
    ? { ...queue.data.meta, totalPages: Math.max(1, Math.ceil(queue.data.meta.total / Math.max(1, queue.data.meta.limit))) }
    : undefined;
  const counts = queue.data?.counts;

  // ── Scan a packing slip: camera, or a USB scanner anywhere on the page. ──
  const [cameraOpen, setCameraOpen] = useState(false);
  const [slipFeedback, setSlipFeedback] = useState<ScanFeedback | null>(null);
  const lookup = useLookupMutation();
  const openSlip = (raw: string) => {
    const code = raw.trim();
    if (!code || lookup.isPending) return;
    lookup.mutate(code, {
      onSuccess: ({ orderId }) => {
        beep(true);
        setCameraOpen(false);
        navigate(`/orders/packing/${orderId}`);
      },
      onError: (error) => {
        beep(false);
        const text = serverMessage(error, "No order has this packing slip.");
        setSlipFeedback({ ok: false, text, at: Date.now() });
        if (!cameraOpen || !phone) toast.error(text);
      },
    });
  };
  useKeyboardWedge(openSlip, !cameraOpen || phone);

  return (
    <div className="space-y-6">
      <PageHeader>
        <PageHeaderContent>
          <PageHeaderTitle>Packing</PageHeaderTitle>
          <PageHeaderDescription>Scan each order's items into the parcel, so the right things ship.</PageHeaderDescription>
        </PageHeaderContent>
        <PageHeaderActions className="w-full md:w-auto">
          {can("inventory.reports") && (
            <Button asChild variant="outline" size="action" className="h-11 rounded-xl md:h-auto md:rounded-full">
              <Link to="/orders/packing/accuracy">
                <ChartColumn className="size-3.5" />
                Accuracy
              </Link>
            </Button>
          )}
          <Button
            variant="brand"
            size="action"
            className="h-11 flex-1 rounded-xl md:h-auto md:flex-none md:rounded-full"
            onClick={() => {
              wakeSound();
              setSlipFeedback(null);
              setCameraOpen(true);
            }}
          >
            {lookup.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <ScanBarcode className="size-3.5" />}
            Scan a packing slip
          </Button>
        </PageHeaderActions>
      </PageHeader>

      <SegmentedTabs
        ariaLabel="Packing stage"
        behaviour="filter"
        items={BUCKETS.map((b) => ({ value: b.value, label: b.label, count: counts?.[b.value] }))}
        value={bucket}
        onChange={(next) => list.patchParams({ bucket: next === "to_pack" ? null : next })}
        className="max-w-full flex-nowrap overflow-x-auto [scrollbar-width:none] max-md:[&>button]:min-h-11"
      />

      <DataTable
        state={table}
        rows={queue.data?.data ?? []}
        rowKey={(row) => row.orderId}
        meta={meta}
        status={{
          isLoading: queue.isLoading,
          isError: queue.isError,
          isPlaceholderData: queue.isPlaceholderData,
          refetch: () => void queue.refetch(),
        }}
        noun="orders"
        searchPlaceholder="Search order #, customer or phone…"
        onRowClick={(row) => navigate(packHref(row))}
        mobileRow={(row) => <QueueCard row={row} />}
        emptyState={{ title: bucketDef.empty, description: bucketDef.hint }}
      />

      <CameraScanner
        open={cameraOpen}
        onOpenChange={setCameraOpen}
        variant={phone ? "panel" : "dialog"}
        feedback={slipFeedback}
        onCode={(code) => {
          if (!phone) setCameraOpen(false);
          openSlip(code);
        }}
      />
    </div>
  );
}

function TaskCell({ row }: { row: PackingQueueRow }) {
  const badge = taskBadge(row.task);
  if (!badge || !row.task) return <span className="text-muted-foreground">Not started</span>;
  const by = row.task.lastPackerName ? `${row.task.lastPackerName} · ` : "";
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <PackingBadges badges={[badge]} />
      <span className="truncate text-caption text-muted-foreground" title={row.task.holdNote ?? undefined}>
        {row.task.status === "ON_HOLD" && row.task.holdNote ? (
          row.task.holdNote
        ) : (
          <>
            {by}
            <Ago iso={row.task.updatedAt} />
          </>
        )}
      </span>
    </div>
  );
}

/** The phone card: one reading path, top to bottom. */
function QueueCard({ row }: { row: PackingQueueRow }) {
  return (
    <div className="min-w-0 space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-section text-foreground">{row.orderName}</span>
        <Ago iso={row.createdAt} className="shrink-0 text-caption text-muted-foreground" />
      </div>
      <p className="text-body text-muted-foreground [overflow-wrap:anywhere]">
        {[row.customerName ?? "Guest", row.city].filter(Boolean).join(" · ")}
      </p>
      <p className="text-body tabular-nums text-foreground">
        {itemsWord(row.units)}
        {row.lines > 1 && <span className="text-muted-foreground"> · {row.lines} lines</span>}
        {row.warehouse && <span className="text-muted-foreground"> · {row.warehouse.name}</span>}
      </p>
      <PackingBadges badges={queueBadges(row)} />
      {row.task?.status === "ON_HOLD" && row.task.holdNote && (
        <p className="text-caption text-muted-foreground [overflow-wrap:anywhere]">“{row.task.holdNote}”</p>
      )}
      {row.task?.status === "PACKING" && row.task.lastPackerName && (
        <p className="text-caption text-muted-foreground">
          {row.task.lastPackerName} · <Ago iso={row.task.updatedAt} />
        </p>
      )}
    </div>
  );
}

/** "5m ago", kept current. Its own clock, so the whole list doesn't re-render each minute. */
function Ago({ iso, className }: { iso: string; className?: string }) {
  const now = useNow();
  return <span className={className}>{formatRelativeTime(iso, now)}</span>;
}
