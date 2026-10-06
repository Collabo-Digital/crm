import { useState } from "react";
import {
  ChevronDown,
  CheckCircle2,
  XCircle,
  Archive,
  RotateCcw,
  CreditCard,
  Pencil,
  Truck,
  UploadCloud,
  Loader2,
} from "lucide-react";
import { Button } from "~/components/ui/button";
import { ShopifySyncCell } from "~/components/app/shopify-sync-cell";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  useUpdateOrderMutation,
  useCancelOrderMutation,
  useCloseOrderMutation,
  useOpenOrderMutation,
  useMarkOrderPaidMutation,
  useCaptureOrderPaymentMutation,
  useSyncOrderMutation,
} from "~/hooks/use-order-mutations";
import { formatCurrency } from "~/lib/utils";
import { useCurrentRole } from "~/hooks/use-current-role";
import type { OrderDetail, OrderCancelReason, OrderShopifySync } from "~/types/api";
import {
  canRetryShopifySync,
  describeOrderShopifySync,
  shopifySyncActionLabel,
} from "~/lib/shopify-sync";
import { hasOutstandingUnits } from "~/lib/order-status";
import {
  ModalShell,
  DialogFooter,
  CheckboxRow,
} from "~/components/app/order-dialog-primitives";
import { FulfillDialog } from "~/components/app/order-fulfillments";

type DialogKind =
  | "edit"
  | "cancel"
  | "capture"
  | "markPaid"
  | "close"
  | "open"
  | "fulfill"
  | null;

/**
 * Which order actions the current user may see, given their role and the
 * order's state.
 *
 * Financial actions (cancel / capture / mark-paid) are manager-only on the
 * server. Mirror that here so a VIEWER or AGENT isn't shown buttons that can
 * only answer 403 — the server remains the actual boundary.
 *
 * Exported because the order detail page's right rail offers Capture payment,
 * Cancel order and Fulfil items as well. Those buttons used to carry no gate
 * at all, so they handed a VIEWER exactly the 403-only button this logic
 * exists to prevent. One copy, two consumers — don't inline these again.
 */
export function useOrderActionGates(order: OrderDetail | undefined) {
  const { role } = useCurrentRole();
  // These three tiers mirror the server's role groups verbatim
  // (server/src/auth/decorators/roles.decorator.ts). Keep them in step — a tier
  // that drifts wider than the server's shows a button that can only 403, and
  // one that drifts narrower silently removes an action the user is allowed.
  const canManage = role === "OWNER" || role === "ADMIN" || role === "MANAGER"; // ORG_MANAGERS
  const canOperate = canManage || role === "AGENT"; //                            ORG_OPERATORS
  const canOperateOrVendor = canOperate || role === "VENDOR"; //  ORG_OPERATORS_AND_VENDORS

  // `order` is optional because the detail page calls this above its error /
  // loading early-returns to keep the hook order stable. Everything is false
  // until the order lands, so nothing renders early.
  //
  // `channel` is optional-chained too: the vendor projection of `GET /orders/:id`
  // has no `channel` key at all, and only the route’s role router keeps that
  // payload out of here. Guard it anyway — this hook is exported.
  const isShopify = order?.channel?.platform === "SHOPIFY";
  const isManual = order?.channel?.platform === "MANUAL";
  const isCancelled = !!order?.cancelledAt;
  const isClosed = !!order?.closedAt;
  const canMarkPaid =
    !!order &&
    canManage &&
    order.financialStatus !== "PAID" &&
    order.financialStatus !== "REFUNDED" &&
    order.financialStatus !== "VOIDED";
  const canCapture =
    !!order &&
    canManage &&
    isShopify &&
    (order.financialStatus === "AUTHORIZED" ||
      order.financialStatus === "PARTIALLY_PAID");
  // Two DIFFERENT questions, which used to share one flag.
  //
  // `canFulfill` answers "may I create a new shipment", and one flag answering
  // both meant the whole per-line action set vanished the moment an order was
  // fully fulfilled — which the server does the instant the last unit ships. So
  // on the normal end state of every order there was no way to unfulfil, mark
  // delivered or add tracking, even though the server accepts all three there.
  //
  // POST /orders/:id/fulfillments is ORG_OPERATORS_AND_VENDORS. This carried no
  // role gate at all, so a VIEWER was shown "Fulfil items" at four separate
  // entry points — every one of them a guaranteed 403.
  //
  // Keyed on units outstanding rather than the header enum: a RESTOCKED or
  // FULFILLED order has nothing left to ship and so offers no Fulfil button,
  // but a PARTIAL one still does, and the button is never rendered dead.
  const canFulfill =
    !!order &&
    canOperateOrVendor &&
    !isCancelled &&
    order.fulfillmentStatus !== "RESTOCKED" &&
    hasOutstandingUnits(order.lineItems ?? []);

  // Per-line corrections: unfulfil, mark delivered, add/edit tracking, hold and
  // release. Role only — no server endpoint behind these looks at the order's
  // fulfilment status. Still allowed on a CANCELLED order so a shipment sent in
  // error can be walked back; only the forward actions above are withdrawn.
  const canActOnItems = !!order && canOperateOrVendor;
  const canCancel = canManage && !isCancelled && !!order;
  // PATCH /orders/:id is ORG_OPERATORS — covers Edit details, the note field and
  // the tag editor, all three of which hit that one endpoint.
  const canEdit = !!order && canOperate;

  // Manual sync to Shopify: only meaningful for MANUAL orders that haven't
  // been pushed yet, where the previous push failed, or whose PENDING claim
  // is old enough that the job has clearly been lost (see lib/shopify-sync).
  // POST /orders/:id/sync is ORG_OPERATORS; without the role gate a Viewer
  // was shown a button that could only 403.
  const syncMeta = (order?.metadata as { shopifySync?: OrderShopifySync } | undefined)
    ?.shopifySync;
  const canSyncToShopify = canOperate && isManual && canRetryShopifySync(syncMeta);

  return {
    canManage,
    canOperate,
    isShopify,
    isCancelled,
    isClosed,
    canMarkPaid,
    canCapture,
    canFulfill,
    canActOnItems,
    canCancel,
    canEdit,
    canSyncToShopify,
  };
}

/**
 * Actions menu shown next to the order header. Renders a dropdown of
 * lifecycle/metadata actions and the matching dialog when one is selected.
 *
 * Each action is gated by the order's current state so the merchant never
 * sees an option that the server would reject (cancel is hidden on an
 * already-cancelled order, etc.). Capture is Shopify-only because manual
 * orders don't have an authorize/capture cycle.
 */
/**
 * The order's Shopify state, beside the Actions menu: a "Sync to Shopify" /
 * "Retry sync" button for a Collabo order with something to push, "Syncing…"
 * while a push runs, and a Synced pill once it has landed. It used to be an
 * item inside the Actions dropdown, where nobody found it; the same rule
 * (`describeOrderShopifySync`) drives the orders table, so the two agree.
 * Renders nothing for an order that came from Shopify — the channel badge
 * already says so.
 */
export function OrderSyncButton({ order }: { order: OrderDetail }) {
  const syncMutation = useSyncOrderMutation(order.id);
  const { canSyncToShopify } = useOrderActionGates(order);
  const summary = describeOrderShopifySync(order);

  if (summary.state === "syncing") {
    return (
      <Button type="button" variant="outline" size="sm" disabled>
        <Loader2 className="size-3.5 animate-spin" />
        Syncing…
      </Button>
    );
  }
  if (summary.action !== null) {
    if (!canSyncToShopify) return null;
    return (
      <Button
        type="button"
        variant="brand"
        size="sm"
        title={shopifySyncActionLabel(
          (order.metadata as { shopifySync?: OrderShopifySync } | undefined)?.shopifySync,
        )}
        disabled={syncMutation.isPending}
        onClick={() => syncMutation.mutate()}
      >
        {syncMutation.isPending ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <UploadCloud className="size-3.5" />
        )}
        {summary.action === "retry" ? "Retry sync" : "Sync to Shopify"}
      </Button>
    );
  }
  // A Collabo order that has been pushed: say so, with when and as what.
  if (order.channel?.platform === "MANUAL" && summary.state === "synced") {
    return <ShopifySyncCell summary={summary} />;
  }
  return null;
}

export function OrderActionsMenu({ order }: { order: OrderDetail }) {
  const [dialog, setDialog] = useState<DialogKind>(null);

  // All mutation hooks must be called unconditionally at the top of the
  // component (Rules of Hooks). Previously these were inlined into the
  // conditional `dialog === ...` blocks, which crashed React with
  // "Rendered more hooks than during the previous render" the first time
  // any action was opened.
  const markPaidMutation = useMarkOrderPaidMutation(order.id);
  const closeMutation = useCloseOrderMutation(order.id);
  const openMutation = useOpenOrderMutation(order.id);

  const {
    isShopify,
    isCancelled,
    isClosed,
    canMarkPaid,
    canCapture,
    canFulfill,
    canCancel,
    canEdit,
  } = useOrderActionGates(order);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="inline-flex items-center gap-1.5 rounded-lg border bg-white dark:bg-gray-900 px-3 py-2 text-xs font-semibold text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800">
            Actions
            <ChevronDown className="size-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          {canEdit && (
            <DropdownMenuItem onSelect={() => setDialog("edit")}>
              <Pencil className="size-3.5" />
              Edit details
            </DropdownMenuItem>
          )}

          {/* Sync to Shopify moved out of this menu to `OrderSyncButton`,
              rendered beside it in the header. */}

          {canFulfill && (
            <DropdownMenuItem onSelect={() => setDialog("fulfill")}>
              <Truck className="size-3.5" />
              Fulfil items
            </DropdownMenuItem>
          )}

          {canMarkPaid && (
            <DropdownMenuItem onSelect={() => setDialog("markPaid")}>
              <CheckCircle2 className="size-3.5" />
              Mark as paid
            </DropdownMenuItem>
          )}

          {canCapture && (
            <DropdownMenuItem onSelect={() => setDialog("capture")}>
              <CreditCard className="size-3.5" />
              Capture payment
            </DropdownMenuItem>
          )}

          <DropdownMenuSeparator />

          {!isClosed && !isCancelled && (
            <DropdownMenuItem onSelect={() => setDialog("close")}>
              <Archive className="size-3.5" />
              Archive order
            </DropdownMenuItem>
          )}

          {isClosed && !isCancelled && (
            <DropdownMenuItem onSelect={() => setDialog("open")}>
              <RotateCcw className="size-3.5" />
              Re-open order
            </DropdownMenuItem>
          )}

          {canCancel && (
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => setDialog("cancel")}
            >
              <XCircle className="size-3.5" />
              Cancel order
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {dialog === "edit" && (
        <EditOrderDialog order={order} onClose={() => setDialog(null)} />
      )}
      {dialog === "cancel" && (
        <CancelOrderDialog order={order} onClose={() => setDialog(null)} />
      )}
      {dialog === "capture" && (
        <CapturePaymentDialog order={order} onClose={() => setDialog(null)} />
      )}
      {dialog === "markPaid" && (
        <ConfirmActionDialog
          title="Mark as paid?"
          body={`Order ${order.name} will be marked as paid${
            isShopify ? " in Shopify and locally" : ""
          }.`}
          confirmLabel="Mark paid"
          mutation={markPaidMutation}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "close" && (
        <ConfirmActionDialog
          title="Archive this order?"
          body={`Order ${order.name} will be archived${
            isShopify ? " in Shopify and locally" : ""
          }. You can re-open it any time.`}
          confirmLabel="Archive"
          mutation={closeMutation}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "open" && (
        <ConfirmActionDialog
          title="Re-open this order?"
          body={`Order ${order.name} will be moved out of the archive.`}
          confirmLabel="Re-open"
          mutation={openMutation}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "fulfill" && (
        <FulfillDialog order={order} onClose={() => setDialog(null)} />
      )}
    </>
  );
}

// ─── Edit Order Dialog ──────────────────────────────────────────────────────
// Lightweight edit: tags (comma-separated) + note. Address / contact / custom
// attributes are accepted by the API but stay out of this dialog for now.

function EditOrderDialog({
  order,
  onClose,
}: {
  order: OrderDetail;
  onClose: () => void;
}) {
  const mutation = useUpdateOrderMutation(order.id);
  const [tagsText, setTagsText] = useState((order.tags ?? []).join(", "));
  const [note, setNote] = useState(order.note ?? "");

  function handleSubmit() {
    const tags = tagsText
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    mutation.mutate(
      // Send note only when changed, but send "" so a note can be cleared.
      { tags, ...(note !== (order.note ?? "") ? { note } : {}) },
      { onSuccess: () => onClose() },
    );
  }

  return (
    <ModalShell title="Edit order" subtitle={`Order ${order.name}`} onClose={onClose}>
      <div className="space-y-4 px-6 py-4">
        <div>
          <label className="text-[10px] font-medium text-gray-600 dark:text-gray-400">
            Tags (comma-separated)
          </label>
          <input
            value={tagsText}
            onChange={(e) => setTagsText(e.target.value)}
            placeholder="e.g. vip, retry, wholesale"
            className="mt-1 w-full rounded-lg border bg-white dark:bg-gray-800 px-3 py-2 text-xs outline-none focus:ring-1 focus:ring-[#cdff8c]"
          />
        </div>

        {/* Deliberately NOT labelled "internal" or "visible to staff only":
            for a Shopify order `update()` pushes `note` straight to Shopify
            (order.service.ts — `input.note = dto.note` before the local write)
            and `upsertOrder` reads it back, so this is the customer-facing
            order note. A genuinely private field needs its own column —
            `Customer.internalNotes` is the precedent. Same wording as the
            order detail rail; keep the two in step. */}
        <div>
          <label className="text-[10px] font-medium text-gray-600 dark:text-gray-400">
            Order note
          </label>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            placeholder="Add a note to this order"
            className="mt-1 w-full rounded-lg border bg-white dark:bg-gray-800 px-3 py-2 text-xs outline-none focus:ring-1 focus:ring-[#cdff8c]"
          />
          <p className="mt-1 text-[10px] text-gray-500 dark:text-gray-400">
            {order.channel?.platform === "SHOPIFY"
              ? "Synced to Shopify — not staff-only."
              : "Stored on the order."}
          </p>
        </div>
      </div>

      <DialogFooter
        confirmLabel="Save changes"
        onConfirm={handleSubmit}
        onClose={onClose}
        pending={mutation.isPending}
      />
    </ModalShell>
  );
}

// ─── Cancel Order Dialog ────────────────────────────────────────────────────

const CANCEL_REASONS: { value: OrderCancelReason; label: string }[] = [
  { value: "CUSTOMER", label: "Customer changed/cancelled their mind" },
  { value: "FRAUD", label: "Suspected fraud" },
  { value: "INVENTORY", label: "Items out of stock" },
  { value: "DECLINED", label: "Payment declined" },
  { value: "OTHER", label: "Other" },
];

export function CancelOrderDialog({
  order,
  onClose,
}: {
  order: OrderDetail;
  onClose: () => void;
}) {
  const mutation = useCancelOrderMutation(order.id);
  const isShopify = order.channel.platform === "SHOPIFY";

  const [reason, setReason] = useState<OrderCancelReason>("CUSTOMER");
  const [refund, setRefund] = useState(false);
  const [restock, setRestock] = useState(true);
  const [notifyCustomer, setNotifyCustomer] = useState(true);
  const [staffNote, setStaffNote] = useState("");

  function handleSubmit() {
    mutation.mutate(
      {
        reason,
        refund,
        restock,
        notifyCustomer,
        staffNote: staffNote || undefined,
      },
      { onSuccess: () => onClose() },
    );
  }

  return (
    <ModalShell title="Cancel order" subtitle={`Order ${order.name}`} onClose={onClose}>
      <div className="space-y-4 px-6 py-4">
        <div>
          <label className="text-[10px] font-medium text-gray-600 dark:text-gray-400">
            Reason
          </label>
          <Select value={reason} onValueChange={(v) => setReason(v as OrderCancelReason)}>
            <SelectTrigger className="mt-1 h-9 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CANCEL_REASONS.map((r) => (
                <SelectItem key={r.value} value={r.value} className="text-xs">
                  {r.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <CheckboxRow
            checked={refund}
            onChange={setRefund}
            label="Issue refund"
            help={
            isShopify
              ? "Asks Shopify to refund the payment as part of the cancellation."
              : "Marks the order as refunded. No money moves — manual orders have no payment to reverse."
          }
          />
          <CheckboxRow
            checked={restock}
            onChange={setRestock}
            label="Restock items"
            help="Return cancelled line items to inventory."
          />
          {isShopify && (
            <CheckboxRow
              checked={notifyCustomer}
              onChange={setNotifyCustomer}
              label="Email customer"
              help="Shopify sends the cancellation email."
            />
          )}
        </div>

        <div>
          <label className="text-[10px] font-medium text-gray-600 dark:text-gray-400">
            Staff note (optional)
          </label>
          <textarea
            value={staffNote}
            onChange={(e) => setStaffNote(e.target.value)}
            rows={2}
            placeholder="Why this order is being cancelled"
            className="mt-1 w-full rounded-lg border bg-white dark:bg-gray-800 px-3 py-2 text-xs outline-none focus:ring-1 focus:ring-[#cdff8c]"
          />
        </div>

        {isShopify && (
          <p className="text-[10px] text-muted-foreground italic">
            Cancellation runs asynchronously in Shopify. The order will update once Shopify acknowledges — you may see a brief delay.
          </p>
        )}
      </div>

      <DialogFooter
        confirmLabel="Cancel order"
        confirmTone="destructive"
        onConfirm={handleSubmit}
        onClose={onClose}
        pending={mutation.isPending}
      />
    </ModalShell>
  );
}

// ─── Capture Payment Dialog (Shopify only) ─────────────────────────────────

export function CapturePaymentDialog({
  order,
  onClose,
}: {
  order: OrderDetail;
  onClose: () => void;
}) {
  const mutation = useCaptureOrderPaymentMutation(order.id);
  // This was `Number(order.totalPrice)` — it subtracted nothing, and since the
  // input is prefilled from it, the DEFAULT action was to submit too much. The
  // dialog only opens for AUTHORIZED / PARTIALLY_PAID orders, i.e. exactly the
  // states where the total is not the balance.
  //
  // Deliberately not labelled "outstanding balance": the true capturable figure
  // is the authorisation minus what has already been captured, which lives in
  // Shopify and is not on this response. This is the honest local approximation
  // — the server enforces the real ceiling.
  const totalRefunded = (order.refunds ?? []).reduce(
    (sum, r) => sum + Number(r.amount),
    0,
  );
  const totalLessRefunds = Math.max(0, Number(order.totalPrice) - totalRefunded);
  const [amount, setAmount] = useState(totalLessRefunds.toFixed(2));
  // Matches the DTO and service default. It was `true` here — the UI defaulted
  // to closing the authorisation, the more destructive of the two.
  const [finalCapture, setFinalCapture] = useState(false);

  function handleSubmit() {
    const numeric = parseFloat(amount);
    mutation.mutate(
      {
        amount: Number.isFinite(numeric) && numeric > 0 ? numeric : undefined,
        currency: order.currency,
        finalCapture,
      },
      { onSuccess: () => onClose() },
    );
  }

  return (
    <ModalShell
      title="Capture payment"
      subtitle={`Order ${order.name}`}
      onClose={onClose}
    >
      <div className="space-y-4 px-6 py-4">
        <div>
          <label className="text-[10px] font-medium text-gray-600 dark:text-gray-400">
            Amount ({order.currency})
          </label>
          <input
            type="number"
            step="0.01"
            min="0"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="mt-1 w-full rounded-lg border bg-white dark:bg-gray-800 px-3 py-2 text-xs tabular-nums outline-none focus:ring-1 focus:ring-[#cdff8c]"
          />
          <p className="mt-1 text-[10px] text-muted-foreground">
            Order total, less refunds:{" "}
            {formatCurrency(totalLessRefunds, order.currency)}
            {totalRefunded > 0 && (
              <> · {formatCurrency(totalRefunded, order.currency)} refunded</>
            )}
          </p>
        </div>

        <CheckboxRow
          checked={finalCapture}
          onChange={setFinalCapture}
          label="Close the authorization"
          help="No further captures will be possible against this auth."
        />
      </div>

      <DialogFooter
        confirmLabel="Capture"
        onConfirm={handleSubmit}
        onClose={onClose}
        pending={mutation.isPending}
      />
    </ModalShell>
  );
}

// ─── Confirm Action Dialog (Mark Paid / Close / Open) ──────────────────────

function ConfirmActionDialog({
  title,
  body,
  confirmLabel,
  mutation,
  onClose,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  mutation: { isPending: boolean; mutate: (vars: void, opts?: { onSuccess?: () => void }) => void };
  onClose: () => void;
}) {
  function handleConfirm() {
    mutation.mutate(undefined, { onSuccess: () => onClose() });
  }

  return (
    <ModalShell title={title} onClose={onClose}>
      <p className="px-6 py-4 text-xs text-muted-foreground">{body}</p>
      <DialogFooter
        confirmLabel={confirmLabel}
        onConfirm={handleConfirm}
        onClose={onClose}
        pending={mutation.isPending}
      />
    </ModalShell>
  );
}

