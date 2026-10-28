import { Fragment, useState, type ReactNode } from "react";
import {
  CheckCircle2,
  CircleAlert,
  Clock,
  Loader2,
  MapPin,
  MoreHorizontal,
  Package,
  PackageOpen,
  PauseCircle,
  PlayCircle,
  Truck,
  Undo2,
  type LucideIcon,
} from "lucide-react";
import {
  useSetItemsStatusMutation,
  useCreateFulfillmentMutation,
  useMarkDeliveredMutation,
  useUnfulfillMutation,
  useUpdateItemTrackingMutation,
} from "~/hooks/use-order-mutations";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { CarrierDatalist } from "~/components/app/carrier-datalist";
import { EmptyState } from "~/components/app/empty-state";
import {
  canEditLineTracking,
  canMarkLineDelivered,
  canUnfulfilLine,
  lineStatusClass,
  lineStatusLabel,
  remainingUnits,
} from "~/lib/order-status";
import { cn, formatCurrency } from "~/lib/utils";

/**
 * Carrier entry. Free text with suggestions rather than a closed dropdown —
 * see the note on CARRIER_SUGGESTIONS. This was a one-entry `<select>` that
 * made any non-Shiprocket shipment unrecordable.
 */
function CarrierInput({
  value,
  onChange,
  className,
  listId,
}: {
  value: string;
  onChange: (v: string) => void;
  className?: string;
  listId: string;
}) {
  return (
    <>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        list={listId}
        placeholder="Shipping carrier"
        className={className}
      />
      <CarrierDatalist id={listId} />
    </>
  );
}

export interface FulfillmentItem {
  id: string;
  title: string;
  variantTitle: string | null;
  sku: string | null;
  quantity: number;
  /** Units shipped so far, 0..quantity. Absent on older payloads → treated as 0. */
  fulfilledQuantity?: number;
  price: string | number;
  fulfillmentStatus: string | null;
  imageUrl?: string | null;
  trackingNumber?: string | null;
  trackingUrl?: string | null;
  trackingCompany?: string | null;
}

/**
 * The fulfilment buckets the `"detail"` layout groups lines into, in the order
 * they are rendered — the order work flows through, not alphabetical.
 */
export type LineGroupKey =
  | "unfulfilled"
  | "on_hold"
  | "in_progress"
  | "partial"
  | "fulfilled"
  | "delivered";

const GROUP_ORDER: LineGroupKey[] = [
  "unfulfilled",
  "on_hold",
  "in_progress",
  "partial",
  "fulfilled",
  "delivered",
];

/**
 * Per-bucket chrome. One entry drives the progress segment, the legend dot and
 * the group header strip, so a bucket can never read as orange in the bar and
 * blue in its header.
 */
const GROUP_META: Record<
  LineGroupKey,
  {
    label: string;
    /** Lowercase, for the progress legend — "3 unfulfilled". */
    legend: string;
    icon: LucideIcon;
    /** Progress-bar segment and legend dot. */
    bar: string;
    /** Group header strip fill. */
    header: string;
    /** Icon + label colour on that strip. */
    accent: string;
    /** Unit-count chip on that strip. */
    chip: string;
  }
> = {
  unfulfilled: {
    label: "Unfulfilled",
    legend: "unfulfilled",
    icon: CircleAlert,
    bar: "bg-warning",
    header: "bg-warning-subtle",
    accent: "text-warning-text",
    chip: "bg-card text-warning-text",
  },
  // Grey, matching LINE_STATUS_CLASSES.on_hold in lib/order-status.ts.
  on_hold: {
    label: "On hold",
    legend: "on hold",
    icon: PauseCircle,
    bar: "bg-muted-foreground",
    header: "bg-muted",
    accent: "text-muted-foreground",
    chip: "bg-card text-muted-foreground",
  },
  in_progress: {
    label: "In progress",
    legend: "in progress",
    icon: Clock,
    bar: "bg-info",
    header: "bg-info-subtle",
    accent: "text-info-text",
    chip: "bg-card text-info-text",
  },
  // Some units shipped, some still owed. A real, reachable state now that the
  // server tracks `fulfilledQuantity` — it used to be lumped in with
  // unfulfilled, so a half-shipped line looked untouched. Same tone as
  // unfulfilled (units are still owed); a lighter bar keeps the two apart.
  partial: {
    label: "Partly shipped",
    legend: "partly shipped",
    icon: PackageOpen,
    bar: "bg-warning/50",
    header: "bg-warning-subtle",
    accent: "text-warning-text",
    chip: "bg-card text-warning-text",
  },
  fulfilled: {
    label: "Fulfilled",
    legend: "fulfilled",
    icon: CheckCircle2,
    bar: "bg-success/60",
    header: "bg-success-subtle",
    accent: "text-success-text",
    chip: "bg-card text-success-text",
  },
  delivered: {
    label: "Delivered",
    legend: "delivered",
    icon: CheckCircle2,
    bar: "bg-success",
    header: "bg-success-subtle",
    accent: "text-success-text",
    chip: "bg-card text-success-text",
  },
};

/**
 * `null` is the API's "never actioned" value. Anything outside the six buckets
 * above lands in Unfulfilled and keeps its own status pill on the row, so an
 * unrecognised value stays readable rather than disappearing.
 */
function groupKeyOf(status: string | null): LineGroupKey {
  if (status && Object.prototype.hasOwnProperty.call(GROUP_META, status)) {
    return status as LineGroupKey;
  }
  return "unfulfilled";
}

/**
 * Units on a line still owed to the customer.
 *
 * Delegates to the shared helper so the status fallback applies: the Shopify
 * sync never writes `fulfilledQuantity`, so subtracting it alone reported every
 * Shopify-fulfilled line as entirely outstanding.
 */
const remainingOf = (li: FulfillmentItem) => remainingUnits(li);

/**
 * Shipment summary for a group header — "Delhivery · AWB 4457 8891". Built from
 * the tracking the server flattens onto each line, so it says nothing when no
 * tracking has been recorded rather than inventing a carrier.
 */
function trackingCaption(lines: FulfillmentItem[]): string | null {
  const shipments = new Map<string, { company?: string | null; number?: string | null }>();
  for (const li of lines) {
    if (!li.trackingNumber && !li.trackingCompany) continue;
    shipments.set(`${li.trackingCompany ?? ""}|${li.trackingNumber ?? ""}`, {
      company: li.trackingCompany,
      number: li.trackingNumber,
    });
  }
  if (shipments.size === 0) return null;
  if (shipments.size > 1) return `${shipments.size} shipments`;
  const [only] = [...shipments.values()];
  return [only.company, only.number ? `AWB ${only.number}` : null].filter(Boolean).join(" · ");
}

const unitsOf = (lines: FulfillmentItem[]) => lines.reduce((n, li) => n + li.quantity, 0);

/**
 * Per-product fulfilment UI + actions, shared by the owner order detail and the
 * vendor view.
 *
 * Two layouts:
 * - `"detail"`  — the owner order-detail page. Lines are grouped into fulfilment
 *   buckets (unfulfilled → on hold → in progress → fulfilled → delivered) under
 *   a unit-weighted progress bar, each group carrying the one action that moves
 *   it forward plus a per-row overflow menu. Bulk selection is opt-in via
 *   "Select items" rather than a permanent column of checkboxes.
 * - `"default"` — the vendor view. A flat Item / Qty / Unit price / Line total /
 *   Status table with always-on selection.
 */
export function OrderItemsFulfillment({
  orderId,
  items,
  currency,
  title = "Line items",
  showSubtotal = false,
  allowInProgress = false,
  variant = "default",
  headerAction,
  footer,
  groupCaptions,
  canActOnItems,
  canCreateFulfillment,
}: {
  orderId: string;
  items: FulfillmentItem[];
  currency: string;
  title?: string;
  showSubtotal?: boolean;
  /** Owner/organization only — surfaces the "Mark in progress" action. */
  allowInProgress?: boolean;
  variant?: "default" | "detail";
  /** Trailing header slot — e.g. the Fulfil items button. */
  headerAction?: ReactNode;
  /** Rendered below the items, inside the card — e.g. the totals block. */
  footer?: ReactNode;
  /**
   * Whether the viewer may correct fulfilment state on individual lines:
   * unfulfil, mark delivered, add tracking, hold, release. Role only — no
   * endpoint behind these looks at the order's fulfilment status. Which lines
   * each action is offered on is decided per line by the predicates in
   * `lib/order-status`, never by the group label.
   *
   * Every endpoint behind these controls is ORG_OPERATORS_AND_VENDORS, but this
   * component had no role awareness at all, so a VIEWER was shown the full
   * action set and every click 403'd.
   */
  canActOnItems: boolean;
  /**
   * Whether the viewer may create a NEW shipment. Separate from the above
   * because it is also false once nothing is outstanding — and folding the two
   * together is what removed every per-line action from fully-fulfilled
   * orders, which is the normal end state of every order.
   *
   * Both are required rather than defaulted: the vendor view used to omit the
   * single flag and silently get the full action set.
   */
  canCreateFulfillment: boolean;
  /**
   * `"detail"` only. Overrides a group header's caption with something the
   * order payload knows and the line items do not — shipment dates, say. A
   * group with no entry falls back to its own tracking summary.
   */
  groupCaptions?: Partial<Record<LineGroupKey, string | null>>;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [trackingNumber, setTrackingNumber] = useState("");
  const [trackingCompany, setTrackingCompany] = useState("");
  const [trackingUrl, setTrackingUrl] = useState("");
  const [holdReason, setHoldReason] = useState("");
  // `"detail"` only — bulk selection is opt-in there, so the default reading
  // view is a clean list rather than a column of checkboxes.
  const [selectMode, setSelectMode] = useState(false);

  const setStatus = useSetItemsStatusMutation(orderId);
  const createFulfillment = useCreateFulfillmentMutation(orderId);
  const markDelivered = useMarkDeliveredMutation(orderId);
  const unfulfill = useUnfulfillMutation(orderId);
  const updateTracking = useUpdateItemTrackingMutation(orderId);

  // Which line's inline "add tracking" form is open, plus its draft values.
  const [trackingLine, setTrackingLine] = useState<string | null>(null);
  const [tNumber, setTNumber] = useState("");
  const [tCompany, setTCompany] = useState("");
  const [tUrl, setTUrl] = useState("");

  const isDetail = variant === "detail";
  // Item / Qty / Unit price / Line total / Status, plus the selection column,
  // which is only rendered for someone who can act on the lines.
  const columnCount = canActOnItems ? 6 : 5;

  const selectedIds = [...selected];
  // Only lines with units still to ship can be bulk-selected — the bulk actions
  // all move a line forward. Keyed on units rather than the status string so a
  // partly-shipped line stays selectable for its remainder, and a Shopify line
  // carrying no `fulfilledQuantity` is not mistaken for unshipped.
  const selectableLines = items.filter((li) => remainingOf(li) > 0);
  const allSelected =
    selectableLines.length > 0 && selectableLines.every((li) => selected.has(li.id));

  function toggle(id: string, checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  /**
   * Every write below takes an explicit id list. The bulk toolbar passes the
   * selection; group headers and row menus pass their own lines, so a one-line
   * action never depends on what happens to be ticked elsewhere.
   */
  function fulfillLines(ids: string[]) {
    if (ids.length === 0) return;
    const hasTracking = trackingNumber || trackingCompany || trackingUrl;
    createFulfillment.mutate(
      {
        lineItems: ids.map((lineItemId) => ({ lineItemId })),
        tracking: hasTracking
          ? {
              number: trackingNumber || undefined,
              company: trackingCompany || undefined,
              url: trackingUrl || undefined,
            }
          : undefined,
      },
      {
        onSuccess: () => {
          setSelected(new Set());
          setTrackingNumber("");
          setTrackingCompany("");
          setTrackingUrl("");
        },
      },
    );
  }

  function holdLines(ids: string[]) {
    if (ids.length === 0) return;
    setStatus.mutate(
      { status: "on_hold", lineItemIds: ids, reason: holdReason.trim() || undefined },
      {
        onSuccess: () => {
          setSelected(new Set());
          setHoldReason("");
        },
      },
    );
  }

  function releaseLines(ids: string[]) {
    if (ids.length === 0) return;
    setStatus.mutate(
      { status: "released", lineItemIds: ids },
      { onSuccess: () => setSelected(new Set()) },
    );
  }

  function inProgressLines(ids: string[]) {
    if (ids.length === 0) return;
    setStatus.mutate(
      { status: "in_progress", lineItemIds: ids },
      { onSuccess: () => setSelected(new Set()) },
    );
  }

  /**
   * Sequential, not `Promise.all` — the endpoint is per line, each call
   * invalidates the order query, and one line failing should not abort the
   * rest of the group.
   */
  async function deliverLines(ids: string[]) {
    for (const id of ids) {
      await markDelivered.mutateAsync(id).catch(() => undefined);
    }
  }

  /**
   * Of these lines, the ones marking delivered is actually legal on. A group
   * can hold a partly-shipped line, and delivering that would strand its
   * remaining units — the server would accept it and then refuse to unfulfil.
   */
  function deliverableIds(ids: string[]): string[] {
    const byId = new Map(items.map((li) => [li.id, li]));
    return ids.filter((id) => {
      const li = byId.get(id);
      return !!li && canMarkLineDelivered(li);
    });
  }

  function openTracking(li: FulfillmentItem) {
    setTrackingLine(li.id);
    setTNumber(li.trackingNumber ?? "");
    setTCompany(li.trackingCompany ?? "");
    setTUrl(li.trackingUrl ?? "");
  }

  function saveTracking(lineId: string) {
    updateTracking.mutate(
      {
        lineId,
        data: {
          tracking: {
            number: tNumber || undefined,
            company: tCompany || undefined,
            url: tUrl || undefined,
          },
        },
      },
      { onSuccess: () => setTrackingLine(null) },
    );
  }

  function exitSelectMode() {
    setSelectMode(false);
    setSelected(new Set());
    setHoldReason("");
  }

  const subtotal = items.reduce((sum, li) => sum + Number(li.price) * li.quantity, 0);
  // Every mutation this component can fire. It previously listed only the two
  // bulk ones, so the bulk toolbar stayed live while a per-row Mark delivered /
  // Unfulfill / tracking save was still in flight — letting a second write race
  // the first against the same line items.
  const busy =
    setStatus.isPending ||
    createFulfillment.isPending ||
    markDelivered.isPending ||
    unfulfill.isPending ||
    updateTracking.isPending;

  /**
   * Per-line actions, `"default"` layout.
   *
   * Each button asks the shared predicate for its own action rather than all
   * three sharing one `status === "fulfilled"` test. That test hid every action
   * on a partly-shipped line and on any Shopify-fulfilled line, and it offered
   * Mark delivered on partials — which strands their remaining units, because
   * delivering does not ship them and unfulfil then refuses the line for ever.
   */
  function lineActions(li: FulfillmentItem) {
    if (!canActOnItems) return null;
    const showDeliver = canMarkLineDelivered(li);
    const showTracking = canEditLineTracking(li);
    const showUnfulfil = canUnfulfilLine(li);
    if (!showDeliver && !showTracking && !showUnfulfil) return null;
    // Tracking used to stay clickable mid-mutation while the other two were
    // disabled, so the dialog could open over an in-flight fulfil/unfulfil.
    const rowBusy = markDelivered.isPending || unfulfill.isPending;
    return (
      <div className="flex flex-wrap items-center justify-end gap-1">
        {showDeliver && (
          <Button
            variant="brand"
            size="xs"
            onClick={() => markDelivered.mutate(li.id)}
            disabled={rowBusy}
            className="text-micro"
          >
            {markDelivered.isPending && markDelivered.variables === li.id ? (
              <Loader2 className="animate-spin" />
            ) : (
              <Truck />
            )}
            Mark delivered
          </Button>
        )}
        {showTracking && (
          <Button
            variant="outline"
            size="xs"
            onClick={() => openTracking(li)}
            disabled={rowBusy}
            title="Add or update tracking"
            className="text-micro text-muted-foreground"
          >
            <MapPin />
            {li.trackingNumber ? "Edit tracking" : "Add tracking"}
          </Button>
        )}
        {showUnfulfil && (
          <Button
            variant="outline"
            size="xs"
            onClick={() => unfulfill.mutate(li.id)}
            disabled={rowBusy}
            title="Switch back to unfulfilled"
            className="text-micro text-muted-foreground"
          >
            {unfulfill.isPending && unfulfill.variables === li.id ? (
              <Loader2 className="animate-spin" />
            ) : (
              <Undo2 />
            )}
            Unfulfill
          </Button>
        )}
      </div>
    );
  }

  function statusPill(li: FulfillmentItem) {
    return (
      <span
        className={cn(
          "inline-flex items-center rounded-full px-2 py-0.5 text-micro font-medium",
          lineStatusClass(li.fulfillmentStatus),
        )}
      >
        {lineStatusLabel(li.fulfillmentStatus)}
      </span>
    );
  }

  /* ── Shared: the inline "add tracking" editor for one line ───────────────── */
  function trackingForm(lineId: string) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={tNumber}
          onChange={(e) => setTNumber(e.target.value)}
          placeholder="Tracking number"
          className="min-w-[10rem] flex-1 rounded-lg border bg-background px-3 py-2 text-caption outline-none focus-visible:border-ring focus-visible:outline-solid focus-visible:outline-1 focus-visible:outline-offset-0 focus-visible:outline-ring"
        />
        <CarrierInput
          value={tCompany}
          onChange={setTCompany}
          listId="carriers-line"
          className="min-w-[8rem] flex-1 rounded-lg border bg-background px-3 py-2 text-caption outline-none focus-visible:border-ring focus-visible:outline-solid focus-visible:outline-1 focus-visible:outline-offset-0 focus-visible:outline-ring"
        />
        {/* Tracking URL must be present here too: the endpoint is a FULL
            REPLACE (order.service.ts writes `trackingUrl: dto.tracking.url ??
            null`), so a form that omits the field silently erases a stored
            URL. */}
        <input
          value={tUrl}
          onChange={(e) => setTUrl(e.target.value)}
          placeholder="Tracking URL"
          className="min-w-[10rem] flex-1 rounded-lg border bg-background px-3 py-2 text-caption outline-none focus-visible:border-ring focus-visible:outline-solid focus-visible:outline-1 focus-visible:outline-offset-0 focus-visible:outline-ring"
        />
        <Button
          variant="brand"
          onClick={() => saveTracking(lineId)}
          disabled={updateTracking.isPending}
          className="text-caption"
        >
          {updateTracking.isPending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <MapPin className="size-3.5" />
          )}
          Save
        </Button>
        <Button
          variant="ghost"
          onClick={() => setTrackingLine(null)}
          className="text-caption text-muted-foreground"
        >
          Cancel
        </Button>
      </div>
    );
  }

  /* ── Shared: the bulk fulfil / hold / release toolbar ────────────────────── */
  function bulkToolbar() {
    return (
      <div
        className={cn(
          "space-y-2 bg-surface-sunken px-5 py-3 dark:bg-muted/40",
          isDetail ? "border-y" : "border-b",
        )}
      >
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <input
            value={trackingNumber}
            onChange={(e) => setTrackingNumber(e.target.value)}
            placeholder="Tracking number (optional)"
            className="rounded-lg border bg-background px-3 py-2 text-caption outline-none focus-visible:border-ring focus-visible:outline-solid focus-visible:outline-1 focus-visible:outline-offset-0 focus-visible:outline-ring"
          />
          <CarrierInput
            value={trackingCompany}
            onChange={setTrackingCompany}
            listId="carriers-bulk"
            className="rounded-lg border bg-background px-3 py-2 text-caption outline-none focus-visible:border-ring focus-visible:outline-solid focus-visible:outline-1 focus-visible:outline-offset-0 focus-visible:outline-ring"
          />
          <input
            value={trackingUrl}
            onChange={(e) => setTrackingUrl(e.target.value)}
            placeholder="Tracking URL (optional)"
            className="rounded-lg border bg-background px-3 py-2 text-caption outline-none focus-visible:border-ring focus-visible:outline-solid focus-visible:outline-1 focus-visible:outline-offset-0 focus-visible:outline-ring"
          />
        </div>
        <input
          value={holdReason}
          onChange={(e) => setHoldReason(e.target.value)}
          placeholder="Reason for hold (optional)"
          className="w-full rounded-lg border bg-background px-3 py-2 text-caption outline-none focus-visible:border-ring focus-visible:outline-solid focus-visible:outline-1 focus-visible:outline-offset-0 focus-visible:outline-ring"
        />
        <div className="flex flex-wrap items-center gap-2">
          {isDetail && (
            <Button
              variant="outline"
              onClick={() =>
                setSelected(allSelected ? new Set() : new Set(selectableLines.map((li) => li.id)))
              }
              className="text-caption text-muted-foreground"
            >
              {allSelected ? "Clear selection" : "Select all"}
            </Button>
          )}
          {canCreateFulfillment && (
            <Button
              variant="accent"
              onClick={() => fulfillLines(selectedIds)}
              disabled={busy || selectedIds.length === 0}
              className="text-caption font-semibold text-brand-strong"
            >
              {createFulfillment.isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <CheckCircle2 className="size-3.5" />
              )}
              Mark fulfilled
            </Button>
          )}
          {allowInProgress && (
            <Button
              variant="ghost"
              onClick={() => inProgressLines(selectedIds)}
              disabled={busy || selectedIds.length === 0}
              className="bg-info-subtle text-caption text-info-text hover:bg-info-subtle hover:text-info-text hover:opacity-80 dark:hover:bg-info-subtle"
            >
              {setStatus.isPending && setStatus.variables?.status === "in_progress" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Clock className="size-3.5" />
              )}
              Mark in progress
            </Button>
          )}
          <Button
            variant="ghost"
            onClick={() => holdLines(selectedIds)}
            disabled={busy || selectedIds.length === 0}
            className="bg-warning-subtle text-caption text-warning-text hover:bg-warning-subtle hover:text-warning-text hover:opacity-80 dark:hover:bg-warning-subtle"
          >
            {setStatus.isPending && setStatus.variables?.status === "on_hold" ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <PauseCircle className="size-3.5" />
            )}
            Add hold
          </Button>
          <Button
            variant="outline"
            onClick={() => releaseLines(selectedIds)}
            disabled={busy || selectedIds.length === 0}
            className="text-caption text-foreground"
          >
            {setStatus.isPending && setStatus.variables?.status === "released" ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <PlayCircle className="size-3.5" />
            )}
            Release hold
          </Button>
        </div>
      </div>
    );
  }

  /* Previously the table rendered anyway, so an order with no lines showed a
     header row above an empty tbody — a ghost table that reads as a broken
     page rather than an empty one. */
  const empty = (
    <div className="px-5 py-10">
      <EmptyState
        icon={Package}
        title="No items on this order"
        description="This order has no line items to fulfil."
      />
    </div>
  );

  /* ══ "detail" — grouped by fulfilment state ══════════════════════════════ */
  if (isDetail) {
    const groups = GROUP_ORDER.map((key) => ({
      key,
      meta: GROUP_META[key],
      lines: items.filter((li) => groupKeyOf(li.fulfillmentStatus) === key),
    })).filter((g) => g.lines.length > 0);

    const totalUnits = unitsOf(items);
    // Units still owed, across every bucket — not the size of the Unfulfilled
    // group. A half-shipped line owes its remainder too, and counting only the
    // one group hid exactly the units a partial shipment leaves behind.
    const unfulfilledUnits = items.reduce((n, li) => n + remainingOf(li), 0);

    /** The one action that moves a group forward, mirrored in its overflow menu. */
    const groupAction = (key: LineGroupKey, ids: string[]) => {
      if (!canActOnItems) return null;
      switch (key) {
        // In progress has no "Add tracking" of its own on purpose: tracking is
        // written against a fulfilment, and updateItemTracking rejects a line
        // that has none ("Fulfil this item before adding tracking").
        case "unfulfilled":
        case "in_progress":
        case "partial":
          if (!canCreateFulfillment) return null;
          return (
            <Button variant="accent" size="xs" onClick={() => fulfillLines(ids)} disabled={busy}>
              {createFulfillment.isPending ? <Loader2 className="animate-spin" /> : null}
              {key === "partial" ? "Fulfil remaining" : "Fulfil items"}
            </Button>
          );
        case "on_hold":
          return (
            <Button variant="outline" size="xs" onClick={() => releaseLines(ids)} disabled={busy}>
              {setStatus.isPending && setStatus.variables?.status === "released" ? (
                <Loader2 className="animate-spin" />
              ) : null}
              Release
            </Button>
          );
        case "fulfilled": {
          // Only the lines this is actually legal on — a group can hold a
          // partly-shipped line, and delivering that would strand its
          // remainder.
          const deliverable = deliverableIds(ids);
          if (deliverable.length === 0) return null;
          return (
            <Button
              variant="brand"
              size="xs"
              onClick={() => deliverLines(deliverable)}
              disabled={busy}
            >
              {markDelivered.isPending ? <Loader2 className="animate-spin" /> : null}
              Mark delivered
            </Button>
          );
        }
        default:
          return null;
      }
    };

    /**
     * Group overflow menu. Delivered keeps one — selecting its lines is still
     * useful, and the rows themselves stay re-trackable.
     */
    const groupMenu = (key: LineGroupKey, ids: string[]) => {
      if (!canActOnItems) return null;
      return (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`More actions for ${GROUP_META[key].label.toLowerCase()} items`}
              className="text-muted-foreground"
            >
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            {key === "delivered" ? null : key === "fulfilled" ? (
              deliverableIds(ids).length > 0 ? (
                <DropdownMenuItem
                  onSelect={() => deliverLines(deliverableIds(ids))}
                  disabled={busy}
                >
                  <Truck />
                  Mark all delivered
                </DropdownMenuItem>
              ) : null
            ) : (
              <>
                {canCreateFulfillment && (
                  <DropdownMenuItem onSelect={() => fulfillLines(ids)} disabled={busy}>
                    <CheckCircle2 />
                    Fulfil these items
                  </DropdownMenuItem>
                )}
                {key === "on_hold" ? (
                  <DropdownMenuItem onSelect={() => releaseLines(ids)} disabled={busy}>
                    <PlayCircle />
                    Release hold
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem onSelect={() => holdLines(ids)} disabled={busy}>
                    <PauseCircle />
                    Put on hold
                  </DropdownMenuItem>
                )}
                {allowInProgress && key !== "in_progress" && (
                  <DropdownMenuItem onSelect={() => inProgressLines(ids)} disabled={busy}>
                    <Clock />
                    Mark in progress
                  </DropdownMenuItem>
                )}
              </>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => {
                setSelectMode(true);
                setSelected(new Set(ids));
              }}
            >
              <Package />
              Select these items
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      );
    };

    /**
     * Row overflow menu.
     *
     * Every entry asks its own predicate rather than the group label. Delivered
     * lines still get Edit tracking (a corrected AWB is a legitimate edit the
     * server accepts) but never Unfulfil, which is the one transition the
     * server refuses.
     */
    const rowMenu = (li: FulfillmentItem) => {
      const key = groupKeyOf(li.fulfillmentStatus);
      // A read-only viewer still gets the tracking link — it reveals nothing
      // the row does not already show and changes nothing.
      if (!canActOnItems && !li.trackingUrl) return null;
      const trigger = (
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Actions for ${li.title}`}
            className="text-muted-foreground"
          >
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
      );
      const trackLink = li.trackingUrl ? (
        <DropdownMenuItem asChild>
          <a href={li.trackingUrl} target="_blank" rel="noreferrer">
            <MapPin />
            Track shipment
          </a>
        </DropdownMenuItem>
      ) : null;

      if (!canActOnItems) {
        if (!trackLink) return null;
        return (
          <DropdownMenu>
            {trigger}
            <DropdownMenuContent align="end" className="w-48">
              {trackLink}
            </DropdownMenuContent>
          </DropdownMenu>
        );
      }

      const showFulfil = canCreateFulfillment && remainingOf(li) > 0;
      const showDeliver = canMarkLineDelivered(li);
      const showTracking = canEditLineTracking(li);
      const showUnfulfil = canUnfulfilLine(li);
      // Hold / release stay keyed on the group: they are genuinely a statement
      // about the line's status rather than about what has shipped.
      const showHold = key !== "delivered" && key !== "fulfilled";
      const showInProgress = allowInProgress && showHold && key !== "in_progress";
      if (
        !showFulfil &&
        !showDeliver &&
        !showTracking &&
        !showUnfulfil &&
        !showHold &&
        !trackLink
      ) {
        return null;
      }

      return (
        <DropdownMenu>
          {trigger}
          <DropdownMenuContent align="end" className="w-48">
            {showFulfil && (
              <DropdownMenuItem onSelect={() => fulfillLines([li.id])} disabled={busy}>
                <CheckCircle2 />
                Fulfil this item
              </DropdownMenuItem>
            )}
            {showDeliver && (
              <DropdownMenuItem onSelect={() => markDelivered.mutate(li.id)} disabled={busy}>
                <Truck />
                Mark delivered
              </DropdownMenuItem>
            )}
            {showTracking && (
              <DropdownMenuItem onSelect={() => openTracking(li)} disabled={busy}>
                <MapPin />
                {li.trackingNumber ? "Edit tracking" : "Add tracking"}
              </DropdownMenuItem>
            )}
            {trackLink}
            {showHold &&
              (key === "on_hold" ? (
                <DropdownMenuItem onSelect={() => releaseLines([li.id])} disabled={busy}>
                  <PlayCircle />
                  Release hold
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem onSelect={() => holdLines([li.id])} disabled={busy}>
                  <PauseCircle />
                  Put on hold
                </DropdownMenuItem>
              ))}
            {showInProgress && (
              <DropdownMenuItem onSelect={() => inProgressLines([li.id])} disabled={busy}>
                <Clock />
                Mark in progress
              </DropdownMenuItem>
            )}
            {showUnfulfil && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => unfulfill.mutate(li.id)} disabled={busy}>
                  <Undo2 />
                  Switch to unfulfilled
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      );
    };

    return (
      <section className="rounded-xl bg-card shadow-sm ring-1 ring-border">
        {/* Header — what is on the order, and the two things you do to it. */}
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-5 pb-2.5 pt-3.5">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-1">
            <h2 className="text-micro font-semibold uppercase tracking-wider text-muted-foreground">
              {title}
            </h2>
            {items.length > 0 && (
              <p className="text-caption text-muted-foreground">
                {items.length} {items.length === 1 ? "item" : "items"} · {totalUnits}{" "}
                {totalUnits === 1 ? "unit" : "units"}
                {unfulfilledUnits > 0 && ` · ${unfulfilledUnits} unfulfilled`}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            {canActOnItems && items.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => (selectMode ? exitSelectMode() : setSelectMode(true))}
                className="text-caption text-muted-foreground"
              >
                {selectMode
                  ? selectedIds.length > 0
                    ? `${selectedIds.length} selected · Done`
                    : "Done"
                  : "Select items"}
              </Button>
            )}
            {headerAction}
          </div>
        </div>

        {items.length === 0 ? (
          empty
        ) : (
          <>
            {/* Progress across the fulfilment states. Segments are weighted by
                UNITS, not by line count, so a 5-unit line reads as the bulk of
                the order that it is. */}
            <div className="space-y-2 px-5 pb-3">
              <div className="flex h-1.5 gap-1">
                {groups.map((g) => (
                  <div
                    key={g.key}
                    style={{ flexGrow: unitsOf(g.lines) }}
                    className={cn("rounded-full", g.meta.bar)}
                  />
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                {groups.map((g) => (
                  <span
                    key={g.key}
                    className="inline-flex items-center gap-1.5 text-micro text-muted-foreground"
                  >
                    <span className={cn("size-1.5 rounded-full", g.meta.bar)} />
                    {unitsOf(g.lines)} {g.meta.legend}
                  </span>
                ))}
              </div>
            </div>

            {selectMode && bulkToolbar()}

            <div className="space-y-3 px-4 pb-4 pt-1">
              {groups.map((g) => {
                const ids = g.lines.map((li) => li.id);
                const caption =
                  groupCaptions && g.key in groupCaptions
                    ? groupCaptions[g.key]
                    : trackingCaption(g.lines);
                const groupUnits = unitsOf(g.lines);
                const Icon = g.meta.icon;

                return (
                  <div key={g.key} className="overflow-hidden rounded-xl ring-1 ring-border">
                    <div
                      className={cn(
                        "flex flex-wrap items-center gap-x-2 gap-y-1 px-3.5 py-2.5",
                        g.meta.header,
                      )}
                    >
                      <Icon className={cn("size-4 shrink-0", g.meta.accent)} />
                      <span className={cn("text-caption font-semibold", g.meta.accent)}>
                        {g.meta.label}
                      </span>
                      <span
                        className={cn(
                          "rounded-full px-1.5 py-0.5 text-micro font-medium",
                          g.meta.chip,
                        )}
                      >
                        {groupUnits} {groupUnits === 1 ? "unit" : "units"}
                      </span>
                      {caption && (
                        <span className="min-w-0 truncate text-micro text-muted-foreground">
                          {caption}
                        </span>
                      )}
                      <div className="ml-auto flex items-center gap-1">
                        {groupAction(g.key, ids)}
                        {groupMenu(g.key, ids)}
                      </div>
                    </div>

                    <ul className="divide-y bg-card">
                      {g.lines.map((li) => {
                        const selectable =
                          li.fulfillmentStatus !== "fulfilled" &&
                          li.fulfillmentStatus !== "delivered";
                        return (
                          <li key={li.id} className="px-3.5 py-3">
                            <div className="flex items-center gap-3">
                              {selectMode && (
                                <input
                                  type="checkbox"
                                  checked={selected.has(li.id)}
                                  disabled={!selectable}
                                  onChange={(e) => toggle(li.id, e.target.checked)}
                                  aria-label={`Select ${li.title}`}
                                  className="shrink-0 disabled:opacity-30"
                                />
                              )}
                              {li.imageUrl ? (
                                <img
                                  src={li.imageUrl}
                                  alt=""
                                  className="size-9 shrink-0 rounded-lg object-cover ring-1 ring-border"
                                />
                              ) : (
                                <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                                  <Package className="size-4" />
                                </div>
                              )}

                              <div className="min-w-0 flex-1">
                                <div className="flex min-w-0 items-center gap-2">
                                  <p className="truncate text-body font-medium text-brand-strong">
                                    {li.title}
                                  </p>
                                  {/* Only for a status with no group of its own —
                                      otherwise the group header already says it. */}
                                  {li.fulfillmentStatus &&
                                    groupKeyOf(li.fulfillmentStatus) !== li.fulfillmentStatus &&
                                    statusPill(li)}
                                </div>
                                {li.variantTitle && (
                                  <p className="truncate text-micro text-muted-foreground">
                                    {li.variantTitle}
                                  </p>
                                )}
                                <p className="truncate font-mono text-micro text-muted-foreground">
                                  {li.sku ?? "No SKU"}
                                </p>
                                {/* Only when the two disagree — on a whole line
                                    the quantity column already says it. */}
                                {remainingOf(li) > 0 && (li.fulfilledQuantity ?? 0) > 0 && (
                                  <p className="truncate text-micro font-medium text-warning-text">
                                    {li.fulfilledQuantity} of {li.quantity} shipped ·{" "}
                                    {remainingOf(li)} still to send
                                  </p>
                                )}
                              </div>

                              <span className="shrink-0 whitespace-nowrap text-caption tabular-nums text-muted-foreground">
                                {li.quantity} × {formatCurrency(Number(li.price), currency)}
                              </span>
                              <span className="shrink-0 whitespace-nowrap text-body font-semibold tabular-nums text-foreground">
                                {formatCurrency(Number(li.price) * li.quantity, currency)}
                              </span>
                              <div className="flex w-6 shrink-0 justify-end">{rowMenu(li)}</div>
                            </div>

                            {trackingLine === li.id && (
                              <div className="mt-3 rounded-lg bg-surface-sunken p-2.5 dark:bg-muted/40">
                                {trackingForm(li.id)}
                              </div>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                );
              })}
            </div>
          </>
        )}

        {footer}
      </section>
    );
  }

  /* ══ "default" — flat table, vendor view ═════════════════════════════════ */
  return (
    <section className="rounded-xl bg-card shadow-sm ring-1 ring-border">
      <div className="flex items-center justify-between border-b px-5 py-3">
        <h2 className="text-micro font-semibold uppercase tracking-wider text-muted-foreground">
          {`${title} (${items.length})`}
        </h2>
        <div className="flex items-center gap-3">
          {selectedIds.length > 0 && (
            <span className="text-micro text-muted-foreground">{selectedIds.length} selected</span>
          )}
          {headerAction}
        </div>
      </div>

      {/* Bulk action toolbar — shown only when items are selected. Gated: this
          layout had no role awareness at all, so a read-only viewer got a full
          bulk fulfil / hold toolbar. */}
      {canActOnItems && selectedIds.length > 0 && bulkToolbar()}

      {items.length === 0 ? (
        empty
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-caption">
            <thead className="text-micro uppercase tracking-wider text-muted-foreground">
              <tr className="border-b">
                {canActOnItems && (
                  <th className="w-8 px-5 py-2 text-left">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={(e) =>
                        setSelected(
                          e.target.checked
                            ? new Set(selectableLines.map((li) => li.id))
                            : new Set(),
                        )
                      }
                    />
                  </th>
                )}
                <th className="px-5 py-2 text-left font-medium">Item</th>
                <th className="px-5 py-2 text-right font-medium">Qty</th>
                <th className="px-5 py-2 text-right font-medium">Unit price</th>
                <th className="px-5 py-2 text-right font-medium">Line total</th>
                <th className="px-5 py-2 text-right font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {items.map((li) => (
                <Fragment key={li.id}>
                  <tr>
                    {canActOnItems && (
                      <td className="px-5 py-3 align-top">
                        <input
                          type="checkbox"
                          checked={selected.has(li.id)}
                          disabled={remainingOf(li) === 0}
                          onChange={(e) => toggle(li.id, e.target.checked)}
                          className="disabled:opacity-30"
                        />
                      </td>
                    )}
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2.5">
                        {li.imageUrl ? (
                          <img
                            src={li.imageUrl}
                            alt=""
                            className="size-9 shrink-0 rounded-md object-cover ring-1 ring-border"
                          />
                        ) : (
                          <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                            <Package className="size-4" />
                          </div>
                        )}
                        <div className="min-w-0">
                          <p className="font-medium text-foreground">{li.title}</p>
                          {li.variantTitle && (
                            <p className="text-micro text-muted-foreground">{li.variantTitle}</p>
                          )}
                          {li.sku && (
                            <p className="font-mono text-micro text-muted-foreground">
                              SKU {li.sku}
                            </p>
                          )}
                          {(li.trackingNumber || li.trackingCompany) && (
                            <p className="text-micro text-muted-foreground">
                              Tracking:{" "}
                              {li.trackingUrl ? (
                                <a
                                  href={li.trackingUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="underline"
                                >
                                  {li.trackingNumber ?? "link"}
                                </a>
                              ) : (
                                li.trackingNumber
                              )}
                              {li.trackingCompany ? ` (${li.trackingCompany})` : ""}
                            </p>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-3 text-right align-top tabular-nums">{li.quantity}</td>
                    <td className="px-5 py-3 text-right align-top tabular-nums">
                      {formatCurrency(Number(li.price), currency)}
                    </td>
                    <td className="px-5 py-3 text-right align-top font-semibold tabular-nums">
                      {formatCurrency(Number(li.price) * li.quantity, currency)}
                    </td>
                    <td className="px-5 py-3 text-right align-top">
                      <div className="flex flex-col items-end gap-1.5">
                        {statusPill(li)}
                        {lineActions(li)}
                      </div>
                    </td>
                  </tr>

                  {/* Inline "add tracking" form for this product. */}
                  {trackingLine === li.id && (
                    <tr className="bg-surface-sunken dark:bg-muted/40">
                      {/* Spacer under the selection column, which is only
                          rendered when the viewer can act. */}
                      {canActOnItems && <td />}
                      <td
                        colSpan={canActOnItems ? columnCount - 1 : columnCount}
                        className="px-5 pb-3"
                      >
                        {trackingForm(li.id)}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
            {showSubtotal && (
              <tfoot>
                <tr className="border-t">
                  <td colSpan={columnCount - 3} />
                  <td className="px-5 py-3 text-right text-micro uppercase tracking-wider text-muted-foreground">
                    Subtotal
                  </td>
                  <td className="px-5 py-3 text-right font-bold tabular-nums">
                    {formatCurrency(subtotal, currency)}
                  </td>
                  <td />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}

      {footer}
    </section>
  );
}
