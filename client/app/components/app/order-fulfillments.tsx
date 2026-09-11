import { useMemo, useState } from "react";
import {
  CheckCircle2,
  XCircle,
  Pencil,
  ExternalLink,
  AlertCircle,
  Loader2,
  Truck,
} from "lucide-react";
import {
  ModalShell,
  DialogFooter,
  CheckboxRow,
} from "~/components/app/order-dialog-primitives";
import { useFulfillableLineItems } from "~/hooks/use-order-queries";
import {
  useCreateFulfillmentMutation,
  useUpdateTrackingMutation,
  useCancelFulfillmentMutation,
  useMarkFulfillmentDeliveredMutation,
} from "~/hooks/use-order-mutations";
import { CarrierDatalist } from "~/components/app/carrier-datalist";
import {
  SHIPMENT_STATE_CLASSES,
  fulfillmentStatusLabel,
  isShipmentCancelled,
  isShipmentDelivered,
  normalizeFulfillmentStatus,
} from "~/lib/order-status";
import type {
  OrderDetail,
  OrderFulfillment,
  FulfillableLineItem,
  FulfillableFulfillmentOrder,
  TrackingInfoInput,
} from "~/types/api";

// ─── Fulfillments section (renders the list with per-row actions) ───────────

/**
 * Renders the order's existing fulfillments as cards. Each card surfaces the
 * status, tracking link (if any) and two actions — edit tracking, cancel.
 * If the order has no fulfillments yet the section returns `null` so the
 * detail page doesn't show an empty box.
 */
export function OrderFulfillmentsSection({
  order,
  canAct,
}: {
  order: OrderDetail;
  /**
   * Whether the viewer may edit shipments. Required, not defaulted: these three
   * buttons carried no role check at all, so a read-only viewer was shown
   * Cancel / Edit tracking / Mark delivered and every click 403'd.
   */
  canAct: boolean;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  // Held here rather than in the row so every row shares one in-flight state —
  // `variables` identifies which shipment is actually pending.
  const markDelivered = useMarkFulfillmentDeliveredMutation(order.id);

  if (!order.fulfillments || order.fulfillments.length === 0) {
    return null;
  }

  const editingFulfillment = order.fulfillments.find((f) => f.id === editingId);
  const cancellingFulfillment = order.fulfillments.find((f) => f.id === cancellingId);

  return (
    <>
      <section className="rounded-xl bg-white dark:bg-gray-900 shadow-sm ring-1 ring-border">
        <h2 className="border-b px-5 py-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Fulfillments ({order.fulfillments.length})
        </h2>
        <div className="divide-y">
          {order.fulfillments.map((f) => (
            <FulfillmentRow
              key={f.id}
              fulfillment={f}
              canAct={canAct}
              onEditTracking={() => setEditingId(f.id)}
              onCancel={() => setCancellingId(f.id)}
              onMarkDelivered={() => markDelivered.mutate(f.id)}
              deliveringId={markDelivered.isPending ? markDelivered.variables : undefined}
              busy={markDelivered.isPending}
            />
          ))}
        </div>
      </section>

      {editingFulfillment && (
        <EditTrackingDialog
          order={order}
          fulfillment={editingFulfillment}
          onClose={() => setEditingId(null)}
        />
      )}
      {cancellingFulfillment && (
        <CancelFulfillmentDialog
          order={order}
          fulfillment={cancellingFulfillment}
          onClose={() => setCancellingId(null)}
        />
      )}
    </>
  );
}

function FulfillmentRow({
  fulfillment,
  canAct,
  onEditTracking,
  onCancel,
  onMarkDelivered,
  deliveringId,
  busy,
}: {
  fulfillment: OrderFulfillment;
  canAct: boolean;
  onEditTracking: () => void;
  onCancel: () => void;
  onMarkDelivered: () => void;
  /** Id of the shipment currently being marked delivered, if any. */
  deliveringId?: string;
  busy: boolean;
}) {
  // Read through the normalizer: a Shopify-synced shipment carries `success`,
  // not `fulfilled`, so both flags below used to be false on every synced row
  // and the chip printed Shopify's raw word.
  const stateKey = normalizeFulfillmentStatus(fulfillment.status);
  const isCancelled = isShipmentCancelled(fulfillment);
  // `deliveredAt` counts too: the next Shopify pull overwrites a locally-set
  // `delivered` back to `success` while leaving the timestamp, which made
  // "Mark delivered" reappear on an already-delivered shipment.
  const isDelivered = isShipmentDelivered(fulfillment);
  return (
    <div className="flex items-start justify-between gap-3 px-5 py-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${
              SHIPMENT_STATE_CLASSES[isDelivered ? "delivered" : stateKey]
            }`}
          >
            {isCancelled || stateKey === "failed" ? (
              <XCircle className="size-3" />
            ) : (
              <CheckCircle2 className="size-3" />
            )}
            {isDelivered ? "Delivered" : fulfillmentStatusLabel(fulfillment.status)}
          </span>
          <span className="text-[10px] text-muted-foreground">
            {new Date(fulfillment.createdAt).toLocaleString("en-IN", {
              day: "2-digit",
              month: "short",
              year: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
        </div>
        {fulfillment.trackingNumber ? (
          <p className="mt-1 text-xs">
            <span className="text-muted-foreground">Tracking: </span>
            {fulfillment.trackingUrl ? (
              <a
                href={fulfillment.trackingUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 font-mono text-blue-600 hover:underline"
              >
                {fulfillment.trackingNumber}
                <ExternalLink className="size-3" />
              </a>
            ) : (
              <span className="font-mono">{fulfillment.trackingNumber}</span>
            )}
          </p>
        ) : (
          <p className="mt-1 text-[10px] text-muted-foreground italic">No tracking info</p>
        )}
      </div>
      {canAct && !isCancelled && (
        <div className="flex shrink-0 items-center gap-1">
          {/* Delivered is terminal, so this disappears once set — matching how
              the per-line actions treat it. */}
          {!isDelivered && (
            <button
              onClick={onMarkDelivered}
              disabled={busy}
              className="rounded-md p-1.5 text-muted-foreground hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100 disabled:opacity-50"
              title="Mark shipment delivered"
            >
              {deliveringId === fulfillment.id ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Truck className="size-3.5" />
              )}
            </button>
          )}
          <button
            onClick={onEditTracking}
            disabled={busy}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100 disabled:opacity-50"
            title="Edit tracking"
          >
            <Pencil className="size-3.5" />
          </button>
          <button
            onClick={onCancel}
            disabled={busy}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-red-50 dark:hover:bg-red-900/30 hover:text-red-600 disabled:opacity-50"
            title="Cancel fulfillment"
          >
            <XCircle className="size-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Fulfill Dialog ─────────────────────────────────────────────────────────
// Triggered from the Actions menu when the order has fulfillable items.

type SelectedItem = {
  lineItemId: string;
  selected: boolean;
  quantity: number;
  maxQuantity: number;
};

/** What the user has changed. Deliberately carries no `maxQuantity`. */
export type SelectionEdit = { selected?: boolean; quantity?: number };

/**
 * Combine what the server currently says is fulfillable with the edits the user
 * has made, letting the server win on everything except intent.
 *
 * This replaces a one-way latch: the previous `merged` returned the live map
 * only while no edit existed, and from the first keystroke onwards every later
 * server response was computed and then discarded. Because the dialog reopens
 * onto a cached payload (`useFulfillableLineItems` sets `staleTime: 0` but no
 * `gcTime`, and invalidating a query nobody is observing only marks it stale),
 * the values it latched onto were routinely out of date. Fulfil 2 of 5, reopen,
 * touch the quantity box before the refetch lands, and the dialog kept offering
 * `/5` and would POST 5 against 3 remaining.
 *
 * So: `maxQuantity` always comes from `live`, a stale quantity is clamped down
 * to it, and an edit whose line item is no longer fulfillable is dropped rather
 * than lingering invisibly in the payload.
 *
 * Exported as a pure function because the client has no test runner — this is
 * the only way to exercise the behaviour rather than the shape.
 */
export function mergeSelections(
  live: Map<string, SelectedItem>,
  edits: Map<string, SelectionEdit>,
): Map<string, SelectedItem> {
  const merged = new Map<string, SelectedItem>();
  for (const [id, base] of live) {
    const edit = edits.get(id);
    merged.set(
      id,
      edit
        ? {
          ...base,
          selected: edit.selected ?? base.selected,
          quantity: Math.min(edit.quantity ?? base.quantity, base.maxQuantity),
        }
        : base,
    );
  }
  return merged;
}

export function FulfillDialog({
  order,
  onClose,
}: {
  order: OrderDetail;
  onClose: () => void;
}) {
  const isShopify = order.channel.platform === "SHOPIFY";
  const { data, isLoading, error } = useFulfillableLineItems(order.id, true);
  const mutation = useCreateFulfillmentMutation(order.id);

  const [tracking, setTracking] = useState<TrackingInfoInput>({
    number: "",
    url: "",
    company: "",
  });
  const [notifyCustomer, setNotifyCustomer] = useState(true);

  // What the server currently says is fulfillable. Recomputed on every response.
  const liveSelections = useMemo<Map<string, SelectedItem>>(() => {
    const map = new Map<string, SelectedItem>();
    if (!data) return map;
    for (const fo of data.fulfillmentOrders) {
      for (const li of fo.lineItems) {
        map.set(li.lineItemId, {
          lineItemId: li.lineItemId,
          selected: true,
          quantity: li.remainingQuantity,
          maxQuantity: li.remainingQuantity,
        });
      }
    }
    return map;
  }, [data]);

  // Edits only — never a copy of the server's numbers, so they cannot go stale.
  const [edits, setEdits] = useState<Map<string, SelectionEdit>>(new Map());
  const merged = useMemo(
    () => mergeSelections(liveSelections, edits),
    [liveSelections, edits],
  );

  function setSelection(lineItemId: string, patch: Partial<SelectedItem>) {
    if (!liveSelections.has(lineItemId)) return;
    const next = new Map(edits);
    const current = next.get(lineItemId) ?? {};
    next.set(lineItemId, {
      selected: patch.selected ?? current.selected,
      quantity: patch.quantity ?? current.quantity,
    });
    setEdits(next);
  }

  const selectedCount = Array.from(merged.values()).filter((s) => s.selected).length;
  const noFulfillable =
    !isLoading && data && data.fulfillmentOrders.every((fo) => fo.lineItems.length === 0);

  function handleSubmit() {
    // Belt and braces: `merged` already clamps, but re-derive straight from the
    // live map so nothing can be submitted above what is currently fulfillable.
    const lineItems = Array.from(merged.values())
      .filter((s) => s.selected && s.quantity > 0)
      .map((s) => ({
        lineItemId: s.lineItemId,
        quantity: Math.min(
          s.quantity,
          liveSelections.get(s.lineItemId)?.maxQuantity ?? s.quantity,
        ),
      }))
      .filter((s) => s.quantity > 0);
    if (lineItems.length === 0) return;
    const trackingPayload: TrackingInfoInput | undefined =
      tracking.number || tracking.url || tracking.company
        ? {
            number: tracking.number || undefined,
            url: tracking.url || undefined,
            company: tracking.company || undefined,
          }
        : undefined;
    mutation.mutate(
      {
        lineItems,
        tracking: trackingPayload,
        notifyCustomer: isShopify ? notifyCustomer : undefined,
      },
      { onSuccess: () => onClose() },
    );
  }

  return (
    <ModalShell
      title="Fulfill items"
      subtitle={`Order ${order.name}`}
      onClose={onClose}
      maxWidthClass="max-w-lg"
    >
      <div className="space-y-4 px-6 py-4">
        {isLoading && (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-xs text-red-700 dark:text-red-300">
            <AlertCircle className="size-4 shrink-0" />
            <span>Couldn't load fulfillable items. Try closing and re-opening.</span>
          </div>
        )}

        {noFulfillable && (
          <p className="text-xs text-muted-foreground italic">
            Nothing left to fulfill on this order.
          </p>
        )}

        {data && !noFulfillable && (
          <>
            {data.fulfillmentOrders.map((fo) => (
              <FulfillmentOrderBlock
                key={fo.id}
                fo={fo}
                selections={merged}
                onSelectionChange={setSelection}
              />
            ))}

            <div className="space-y-3 rounded-lg border bg-gray-50 dark:bg-gray-800/40 px-3 py-3">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Tracking info (optional)
              </p>
              <TextField
                label="Tracking number"
                value={tracking.number ?? ""}
                onChange={(v) => setTracking({ ...tracking, number: v })}
                placeholder="e.g. 1Z999AA10123456784"
              />
              <TextField
                label="Carrier"
                listId="carriers-shipment"
                value={tracking.company ?? ""}
                onChange={(v) => setTracking({ ...tracking, company: v })}
                placeholder="e.g. Shiprocket, Delhivery, Blue Dart"
              />
              <TextField
                label="Tracking URL"
                value={tracking.url ?? ""}
                onChange={(v) => setTracking({ ...tracking, url: v })}
                placeholder="https://"
              />
            </div>

            {isShopify && (
              <CheckboxRow
                checked={notifyCustomer}
                onChange={setNotifyCustomer}
                label="Email customer"
                help="Shopify sends the shipping confirmation email."
              />
            )}
          </>
        )}
      </div>

      <DialogFooter
        confirmLabel={`Fulfill ${selectedCount} item${selectedCount === 1 ? "" : "s"}`}
        onConfirm={handleSubmit}
        onClose={onClose}
        pending={mutation.isPending}
        confirmDisabled={selectedCount === 0 || isLoading}
      />
    </ModalShell>
  );
}

function FulfillmentOrderBlock({
  fo,
  selections,
  onSelectionChange,
}: {
  fo: FulfillableFulfillmentOrder;
  selections: Map<string, SelectedItem>;
  onSelectionChange: (lineItemId: string, patch: Partial<SelectedItem>) => void;
}) {
  if (fo.lineItems.length === 0) return null;
  return (
    <div className="space-y-2">
      {/* No `uppercase` on this line: it is Shopify's own location name and is
          shown exactly as Shopify spells it. */}
      {fo.locationName && (
        <p className="text-micro tracking-wide text-muted-foreground">
          From {fo.locationName}
        </p>
      )}
      <div className="divide-y rounded-lg border">
        {fo.lineItems.map((li) => (
          <LineItemRow
            key={li.lineItemId}
            li={li}
            state={selections.get(li.lineItemId)}
            onChange={(patch) => onSelectionChange(li.lineItemId, patch)}
          />
        ))}
      </div>
    </div>
  );
}

function LineItemRow({
  li,
  state,
  onChange,
}: {
  li: FulfillableLineItem;
  state: SelectedItem | undefined;
  onChange: (patch: Partial<SelectedItem>) => void;
}) {
  if (!state) return null;
  return (
    <label className="flex items-center justify-between gap-3 px-3 py-2 text-xs cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/40">
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <input
          type="checkbox"
          checked={state.selected}
          onChange={(e) => onChange({ selected: e.target.checked })}
          className="mt-0.5"
        />
        <div className="min-w-0">
          <p className="font-medium text-gray-900 dark:text-gray-100 truncate">{li.title}</p>
          {li.variantTitle && (
            <p className="text-[10px] text-muted-foreground truncate">{li.variantTitle}</p>
          )}
          {li.sku && (
            <p className="text-[10px] font-mono text-muted-foreground truncate">SKU {li.sku}</p>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <input
          type="number"
          min={1}
          max={state.maxQuantity}
          value={state.quantity}
          disabled={!state.selected}
          onChange={(e) =>
            onChange({
              quantity: Math.max(
                1,
                Math.min(state.maxQuantity, parseInt(e.target.value || "0", 10)),
              ),
            })
          }
          className="w-14 rounded-md border bg-white dark:bg-gray-800 px-2 py-1 text-xs text-right tabular-nums outline-none focus:ring-1 focus:ring-[#cdff8c] disabled:opacity-50"
        />
        <span className="text-[10px] text-muted-foreground">/{state.maxQuantity}</span>
      </div>
    </label>
  );
}

// ─── Edit Tracking Dialog ──────────────────────────────────────────────────

function EditTrackingDialog({
  order,
  fulfillment,
  onClose,
}: {
  order: OrderDetail;
  fulfillment: OrderFulfillment;
  onClose: () => void;
}) {
  const isShopify = order.channel.platform === "SHOPIFY";
  const mutation = useUpdateTrackingMutation(order.id);
  // Every field must be seeded from the record. PATCH .../tracking is a FULL
  // REPLACE — order.service.ts writes trackingCompany: dto.tracking.company ?? null
  // and pushes the same null to Shopify — so a field this form does not carry is
  // a field it erases. company was hardcoded to "" here, so correcting a typo in
  // a tracking number silently wiped the carrier in both systems. Clearing a
  // value stays expressible: empty the box and it is written as null.
  const [tracking, setTracking] = useState<TrackingInfoInput>({
    number: fulfillment.trackingNumber ?? "",
    url: fulfillment.trackingUrl ?? "",
    company: fulfillment.trackingCompany ?? "",
  });
  const [notifyCustomer, setNotifyCustomer] = useState(false);

  function handleSubmit() {
    mutation.mutate(
      {
        fulfillmentId: fulfillment.id,
        data: {
          tracking: {
            number: tracking.number || undefined,
            url: tracking.url || undefined,
            company: tracking.company || undefined,
          },
          notifyCustomer: isShopify ? notifyCustomer : undefined,
        },
      },
      { onSuccess: () => onClose() },
    );
  }

  return (
    <ModalShell
      title="Edit tracking"
      subtitle={`Order ${order.name}`}
      onClose={onClose}
    >
      <div className="space-y-3 px-6 py-4">
        <TextField
          label="Tracking number"
          value={tracking.number ?? ""}
          onChange={(v) => setTracking({ ...tracking, number: v })}
          placeholder="e.g. 1Z999AA10123456784"
        />
        <TextField
          label="Carrier"
          listId="carriers-edit"
          value={tracking.company ?? ""}
          onChange={(v) => setTracking({ ...tracking, company: v })}
          placeholder="e.g. Shiprocket, Delhivery, Blue Dart"
        />
        <TextField
          label="Tracking URL"
          value={tracking.url ?? ""}
          onChange={(v) => setTracking({ ...tracking, url: v })}
          placeholder="https://"
        />

        {isShopify && (
          <CheckboxRow
            checked={notifyCustomer}
            onChange={setNotifyCustomer}
            label="Email customer about the update"
            help="Sends a Shopify tracking-updated email."
          />
        )}
      </div>

      <DialogFooter
        confirmLabel="Save tracking"
        onConfirm={handleSubmit}
        onClose={onClose}
        pending={mutation.isPending}
      />
    </ModalShell>
  );
}

// ─── Cancel Fulfillment Dialog ─────────────────────────────────────────────

function CancelFulfillmentDialog({
  order,
  fulfillment,
  onClose,
}: {
  order: OrderDetail;
  fulfillment: OrderFulfillment;
  onClose: () => void;
}) {
  const mutation = useCancelFulfillmentMutation(order.id);

  function handleConfirm() {
    mutation.mutate(fulfillment.id, { onSuccess: () => onClose() });
  }

  return (
    <ModalShell title="Cancel fulfillment?" onClose={onClose}>
      <p className="px-6 py-4 text-xs text-muted-foreground">
        This will mark the fulfillment as cancelled and re-open its line items so
        they can be fulfilled again. For Shopify orders the cancellation also flows
        to Shopify.
      </p>
      <DialogFooter
        confirmLabel="Cancel fulfillment"
        confirmTone="destructive"
        onConfirm={handleConfirm}
        onClose={onClose}
        pending={mutation.isPending}
      />
    </ModalShell>
  );
}

// ─── Small text-field helper ────────────────────────────────────────────────

function TextField({
  label,
  value,
  onChange,
  placeholder,
  listId,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  /** When set, backs the input with the shared carrier suggestion list. */
  listId?: string;
}) {
  return (
    <div>
      <label className="text-[10px] font-medium text-gray-600 dark:text-gray-400">
        {label}
      </label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        list={listId}
        className="mt-1 w-full rounded-lg border bg-white dark:bg-gray-800 px-3 py-2 text-xs outline-none focus:ring-1 focus:ring-[#cdff8c]"
      />
      {listId && <CarrierDatalist id={listId} />}
    </div>
  );
}

