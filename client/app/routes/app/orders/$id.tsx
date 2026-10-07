import { useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { useListReturnPath } from "~/hooks/use-list-url-state";
import {
  AlertTriangle,
  ChevronRight,
  Loader2,
  Plus,
  Printer,
  Receipt,
  Truck,
  X,
} from "lucide-react";
import { useOrder, useAdjacentOrders } from "~/hooks/use-order-queries";
import { useCustomer } from "~/hooks/use-customer-queries";
import { useCurrentOrg, useOrgMembers } from "~/hooks/use-org-queries";
import { GenerateInvoiceDialog } from "~/components/app/generate-invoice-dialog";
import { useUpdateOrderMutation } from "~/hooks/use-order-mutations";
import {
  OrderActionsMenu,
  OrderSyncButton,
  CancelOrderDialog,
  CapturePaymentDialog,
  useOrderActionGates,
} from "~/components/app/order-actions";
import { OrderFulfillmentsSection, FulfillDialog } from "~/components/app/order-fulfillments";
import {
  OrderItemsFulfillment,
  type LineGroupKey,
} from "~/components/app/order-items-fulfillment";
import { ChannelBadge } from "~/components/app/channel-badge";
import { orderSourceLabel } from "~/lib/order-source";
import { OrderActivity } from "~/components/app/order-activity";
import { VendorOrderDetail } from "~/components/app/vendor-order-detail";
import { useCurrentRole } from "~/hooks/use-current-role";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { cn, formatCurrency } from "~/lib/utils";
import {
  FINANCIAL_CLASSES,
  FINANCIAL_LABELS_FULL,
  FULFILLMENT_CLASSES,
  FULFILLMENT_LABELS_FULL,
  isLineFulfilled,
  isShipmentCancelled,
  isShipmentDelivered,
  isShipmentShipped,
  remainingUnits,
} from "~/lib/order-status";
import { QueryErrorState } from "~/components/app/query-error-state";
import type {
  ChannelPlatform,
  CustomerDetail,
  OrderDetail,
  OrderFulfillment,
} from "~/types/api";
import { orderShopifySyncOf } from "~/lib/shopify-sync";

export function meta() {
  return [{ title: "Order Detail | Collabo CRM" }];
}

/** Placeholder for a field the API does not expose yet. */
const DASH = "—";

/** Statutory GST rates. Used to decide whether an effective rate is a real slab. */
const GST_SLABS = [0, 0.25, 3, 5, 12, 18, 28];

/**
 * Role router. The vendor branch has to happen on a component boundary rather
 * than as an early return inside the owner view: `GET /orders/:id` answers a
 * vendor with a vendor-scoped projection carrying no `channel`, no
 * `financialStatus` and no `metadata` (server-side `findOneForVendor`), so
 * every owner hook below would be reading a shape that does not exist —
 * `useOrderActionGates` crashed on exactly that. Two components means two
 * independent hook orders, so neither role has to run the other's hooks.
 */
export default function OrderDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { isVendor } = useCurrentRole();

  // Vendors get a deliberately narrow, vendor-scoped view (their items only).
  if (isVendor) {
    return <VendorOrderDetail orderId={id!} />;
  }
  return <OwnerOrderDetail id={id!} />;
}

function OwnerOrderDetail({ id }: { id: string }) {
  const { data: order, isLoading, isError, refetch } = useOrder(id);
  // Back to the list as it was left: same page and search, even after walking
  // Previous/Next through other orders.
  const ordersPath = useListReturnPath("orders", "/orders");
  const { data: org } = useCurrentOrg();

  const { data: adjacent } = useAdjacentOrders(id);
  const {
    data: customer,
    isError: customerError,
    refetch: refetchCustomer,
  } = useCustomer(order?.customer?.id);
  // Only source of a display name for the order's owner — `OrderTimelineEvent.actorId`
  // and `metadata.createdByUserId` are bare user ids with no Prisma relation to User.
  const { data: orgMembers } = useOrgMembers(org?.id);
  const [showInvoiceDialog, setShowInvoiceDialog] = useState(false);
  const [dialog, setDialog] = useState<"fulfill" | "capture" | "cancel" | null>(null);
  // Same gates the Actions menu uses, so the rail below can't offer a button
  // the menu deliberately hides.
  const { canManage, canCapture, canCancel, canFulfill, canActOnItems, canEdit } =
    useOrderActionGates(order);

  const currency = order?.currency ?? org?.currency ?? "INR";
  const gstEnabled = org?.gstEnabled ?? false;

  // The order's live invoice comes embedded in the order response (at most
  // one — enforced server-side). No list-scan: correct at any invoice count,
  // and vendors never trigger a forbidden /invoices request.
  const invoice = order?.invoices?.[0] ?? null;

  // Must precede the spinner below: on failure `isLoading` is false and
  // `order` undefined, so `isLoading || !order` held the spinner on screen
  // for ever with no retry and no way out. `!order` keeps a failed background
  // refetch from replacing an order that is already rendered.
  if (isError && !order) {
    return (
      <div className="p-8">
        <QueryErrorState resource="this order" onRetry={() => refetch()} />
      </div>
    );
  }

  if (isLoading || !order) {
    return (
      <div className="flex h-96 items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const metadata = (order.metadata ?? {}) as Record<string, unknown>;
  const paymentMethod = typeof metadata.paymentMethod === "string" ? metadata.paymentMethod : null;
  const source = typeof metadata.source === "string" ? metadata.source : null;
  // Through the one reader every page uses, not a cast on the blob.
  const shopifySync = orderShopifySyncOf(order) ?? null;

  // `findOne` returns the raw row, so `createdAt` is the local insert time.
  // The list endpoint shows `externalCreatedAt` — match it or the two pages
  // disagree about when the same order was placed.
  const placedAt = order.externalCreatedAt ?? order.createdAt;

  const fulfilledCount = order.lineItems.filter((li) =>
    isLineFulfilled(li.fulfillmentStatus),
  ).length;
  // Units still owed, not "lines whose status is not fulfilled". A line that is
  // on hold with everything already shipped is not outstanding, and a Shopify
  // line carrying no `fulfilledQuantity` must not be counted as unshipped.
  const outstanding = order.lineItems.filter((li) => remainingUnits(li) > 0);

  // Prefer the fulfilment record; fall back to the tracking the server already
  // flattens onto each line.
  const primaryFulfilment: OrderFulfillment | undefined = order.fulfillments?.[0];
  const trackedLine = order.lineItems.find((li) => li.trackingNumber || li.trackingCompany);
  const carrier = primaryFulfilment?.trackingCompany ?? trackedLine?.trackingCompany ?? null;
  const awb = primaryFulfilment?.trackingNumber ?? trackedLine?.trackingNumber ?? null;

  // Captions for the fulfilled / delivered groups on the line-items card. Only
  // facts the order actually carries — a shipment date and its tracking ref.
  // A group with nothing to say is left out entirely, and the card falls back
  // to the tracking it can read off the lines themselves.
  //
  // Shipment membership is NOT derivable (`metadata.lineItemIds` is only
  // written for CRM-created fulfilments — see the note on OrderFulfillment), so
  // these describe the order's shipments, not one group's lines. That holds for
  // the single-shipment case, which is nearly all of them; multi-shipment
  // orders fall through to the per-line summary instead.
  const lineGroupCaptions = (() => {
    const live = (order.fulfillments ?? []).filter((f) => !isShipmentCancelled(f));
    if (live.length !== 1) return undefined;
    const [f] = live;
    const ref = [f.trackingCompany, f.trackingNumber ? `AWB ${f.trackingNumber}` : null]
      .filter(Boolean)
      .join(" ");
    const captions: Partial<Record<LineGroupKey, string | null>> = {};

    const shippedAt = f.shippedAt ?? f.createdAt;
    if (shippedAt) {
      captions.fulfilled =
        [`Shipped ${shortDate(shippedAt)}`, ref || null].filter(Boolean).join(" · ") || null;
    }
    if (f.deliveredAt) {
      captions.delivered = `Delivered ${shortDateTime(f.deliveredAt)}`;
    }
    return captions;
  })();

  const subtotal = Number(order.subtotalPrice);
  const tax = Number(order.totalTax);
  const total = Number(order.totalPrice);
  const shipping = Number(order.totalShippingPrice);
  const discounts = Number(order.totalDiscounts);
  // Derived, not stored — the real per-line rate lives on the invoice, which the
  // order payload does not carry. tax/subtotal is the *effective* rate, so a cart
  // mixing 5% and 18% lines used to print a blended "GST 11%" that matches no
  // line and no slab. Only claim a rate when the effective rate lands on an
  // actual GST slab, which a mixed cart essentially never does; otherwise show
  // the tax amount with no rate rather than an invented one.
  const gstRate = (() => {
    if (subtotal <= 0 || tax <= 0) return null;
    const effective = (tax / subtotal) * 100;
    return GST_SLABS.find((slab) => Math.abs(effective - slab) < 0.05) ?? null;
  })();

  const balance = deriveBalance(order, total);
  const balanceCaption = balanceCaptionFor(order, balance, currency);

  const orderState = deriveOrderState(order);
  const shippingState = deriveShippingState(order.fulfillments ?? []);

  // A CRM-native order's `externalId` is a synthetic `manual_<uuid>`, not a
  // channel id — only the push-sync blob carries a real Shopify id for those.
  const syncedId = shopifySync?.shopifyOrderId ?? shopifySync?.shopifyOrderName ?? null;
  const nativeId = order.externalId?.startsWith("manual_") ? null : order.externalId ?? null;
  const shopifyOrderRef =
    shopifySync?.status === "FAILED" ? "Sync failed" : (syncedId ?? nativeId ?? DASH);

  const ownerId =
    typeof metadata.createdByUserId === "string"
      ? metadata.createdByUserId
      : (order.timeline.find((e) => e.action === "created")?.actorId ?? null);
  // Join on `member.user.id` — `member.id` is the membership row, not the user.
  const owner = ownerId ? orgMembers?.find((m) => m.user.id === ownerId) : undefined;
  const ownerName = owner
    ? `${owner.user.firstName} ${owner.user.lastName?.charAt(0) ?? ""}.`.trim()
    : null;

  const weightLabel = totalWeightLabel(order.lineItems);

  // Prev/next comes from GET /orders/:id/adjacent, which walks ALL orders
  // newest-first and is exact at any position.
  //
  // This used to fetch the first 100 UNFULFILLED orders and search them, which
  // failed two ways: opening a FULFILLED order found nothing and disabled BOTH
  // buttons (a third of orders on the dev data), and any order past the first
  // 100 did the same. It also pulled 100 hydrated orders on every page view.
  const prevId = adjacent?.previousId ?? null;
  const nextId = adjacent?.nextId ?? null;

  // The customer query carries a phone; the order's embedded customer only has
  // one on the detail endpoint. Neither is guaranteed.
  const phone = customer?.phone ?? order.customer?.phone ?? null;

  return (
    <div className="space-y-5">
      {/* Breadcrumb + prev/next rail */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-caption">
          <Link to={ordersPath} className="text-muted-foreground hover:text-foreground">
            Orders
          </Link>
          <ChevronRight className="size-3 text-muted-foreground" />
          <span className="font-medium text-foreground">{order.name}</span>
        </nav>
        <div className="flex items-center gap-2">
          {adjacent && adjacent.total > 0 && (
            <span className="text-caption text-muted-foreground">
              {adjacent.position} of {adjacent.total}
            </span>
          )}
          <Button asChild={!!prevId} variant="outline" size="sm" disabled={!prevId}>
            {prevId ? <Link to={`/orders/${prevId}`}>Previous</Link> : <span>Previous</span>}
          </Button>
          <Button asChild={!!nextId} variant="outline" size="sm" disabled={!nextId}>
            {nextId ? <Link to={`/orders/${nextId}`}>Next order</Link> : <span>Next order</span>}
          </Button>
          <OrderSyncButton order={order} />
          <OrderActionsMenu order={order} />
        </div>
      </div>

      <div className="flex gap-4">
        {/* ── Left rail: order meta ─────────────────────────────────────── */}
        {/* Sticky like the right rail. It runs taller than short screens, so
            cap it to the viewport and let it scroll itself — otherwise its
            bottom (metadata) would be unreachable while pinned. */}
        <aside className="flex flex-1 flex-col gap-4.5 rounded-xl bg-card p-4 lg:sticky lg:top-6 lg:self-start lg:max-h-[calc(100vh-3rem)] lg:overflow-y-auto">
          {/* Header */}
          <div className="flex flex-col gap-2">
            <h1 className="text-subhead text-foreground">{order.name}</h1>
            <p className="text-caption text-muted-foreground">
              {new Date(placedAt).toLocaleString("en-IN", {
                day: "2-digit",
                month: "short",
                year: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </p>
            <ChannelBadge
              variant="chip"
              size={13}
              platform={order.channel?.platform as ChannelPlatform | undefined}
              name={
                [...new Set([orderSourceLabel(order), order.channel?.name])]
                  .filter(Boolean)
                  .join(" · ") || undefined
              }
            />
          </div>

          {/* Status rows */}
          <div className="flex flex-col gap-2 border-t pt-3">
            <StatusRow label="Order">
              <StatusPill className={orderState.className}>{orderState.label}</StatusPill>
            </StatusRow>
            <StatusRow label="Payment">
              <StatusPill className={FINANCIAL_CLASSES[order.financialStatus]}>
                {FINANCIAL_LABELS_FULL[order.financialStatus]}
              </StatusPill>
            </StatusRow>
            <StatusRow label="Fulfilment">
              <StatusPill className={FULFILLMENT_CLASSES[order.fulfillmentStatus]}>
                {FULFILLMENT_LABELS_FULL[order.fulfillmentStatus]}
              </StatusPill>
            </StatusRow>
            <StatusRow label="Shipping">
              <StatusPill className={shippingState.className}>{shippingState.label}</StatusPill>
            </StatusRow>
            {source === "offline" && (
              <StatusRow label="Source">
                <StatusPill className="bg-info-subtle text-info">In-Store</StatusPill>
              </StatusRow>
            )}
          </div>

          {/* Tags */}
          <RailSection label="Tags">
            <OrderTags order={order} canEdit={canEdit} />
          </RailSection>

          {/* Metadata */}
          <RailSection label="Metadata">
            <div className="flex flex-col gap-1.5">
              <MetaRow label="Shopify order" value={shopifyOrderRef} mono />
              <MetaRow label="Invoice" value={invoice?.invoiceNumber ?? DASH} mono />
              {/* No transactions table and no gateway column — a payment
                  reference is not stored anywhere. */}
              <MetaRow label="Payment ref" value={DASH} mono />
              <MetaRow label="Owner" value={ownerName ?? DASH} />
              {/* Recorded only when it is a FACT — an operator's explicit
                  choice on an offline sale, or Shopify's own fulfilment
                  location. The invoice falls back to the default warehouse
                  itself, so a dash here does not mean the invoice has no
                  dispatch block. */}
              <MetaRow
                label="Dispatch warehouse"
                value={order.dispatchWarehouse?.name ?? DASH}
              />
              <MetaRow label="Weight" value={weightLabel ?? DASH} />
              {paymentMethod && <MetaRow label="Payment method" value={paymentMethod} />}
              {order.placeOfSupplyCode && (
                <MetaRow label="Place of supply" value={order.placeOfSupplyCode} />
              )}
            </div>
          </RailSection>

          {/* Order total */}
          <RailSection label="Order total">
            <p className="text-stat tabular-nums text-foreground">
              {formatCurrency(total, currency)}
            </p>
            <p className="text-micro text-muted-foreground">{balanceCaption}</p>
          </RailSection>
        </aside>

        {/* ── Center: line items, fulfilment, activity ───────────────────── */}
        <div className="flex-3 space-y-5">
          <OrderItemsFulfillment
            orderId={order.id}
            items={order.lineItems}
            currency={currency}
            variant="detail"
            title="Line items"
            allowInProgress
            canActOnItems={canActOnItems}
            canCreateFulfillment={canFulfill}
            groupCaptions={lineGroupCaptions}
            headerAction={
              /* Labelled for what it does — this opens FulfillDialog, not the
                 Actions menu's Edit details dialog.

                 A standalone Restock button used to sit beside it, permanently
                 disabled — there is no restock endpoint. Restocking is real,
                 but it is a checkbox on Cancel order, which is where it
                 belongs; a dead control is worse than no control.

                 Gated: this and the rail button below both used to render
                 unconditionally while only the third entry point checked
                 `canFulfill`, so a VIEWER got two buttons that could only 403. */
              canFulfill ? (
                <Button variant="accent" size="sm" onClick={() => setDialog("fulfill")}>
                  Fulfil items
                </Button>
              ) : null
            }
            footer={
              <div className="flex justify-end rounded-b-xl border-t bg-[#f5f5f5] px-5 py-3 dark:bg-muted/40">
                {/* Order of rows matters here. Shopify's `subtotalPrice` is
                    already NET of discounts, so printing it as "Subtotal" and
                    then a separate "-Discounts" row read as if the discount came
                    off twice and never reconciled to the Total. Worse, the line
                    rows above show gross (price x qty), so on a discounted order
                    the visible rows didn't add up to the Subtotal either — e.g.
                    #1002: rows 785.95, subtotal 628.76, discount -157.19,
                    total 628.76.

                    Gross is derived from the order's own numbers rather than by
                    summing the rows, so it stays exact when a line carries its
                    own `totalDiscount`. */}
                <dl className="flex w-full max-w-56 flex-col gap-1.5 text-caption">
                  <TotalRow
                    label="Subtotal"
                    value={formatCurrency(subtotal + discounts, currency)}
                  />
                  {discounts > 0 && (
                    <TotalRow
                      label="Discounts"
                      value={`-${formatCurrency(discounts, currency)}`}
                      negative
                    />
                  )}
                  <TotalRow
                    label={gstRate !== null ? `GST ${gstRate}%` : "GST"}
                    value={formatCurrency(tax, currency)}
                  />
                  {shipping > 0 && (
                    <TotalRow label="Shipping" value={formatCurrency(shipping, currency)} />
                  )}
                  <TotalRow label="Total" value={formatCurrency(total, currency)} bold />
                </dl>
              </div>
            }
          />

          {/* Fulfilment summary — carrier, progress, what is still outstanding. */}
          <section className="rounded-xl bg-card shadow-sm ring-1 ring-border">
            <h2 className="border-b px-5 py-3 text-micro font-semibold uppercase tracking-wider text-muted-foreground">
              Fulfilment · {fulfilledCount} shipped, {outstanding.length} outstanding
            </h2>
            <div className="grid grid-cols-1 divide-y md:grid-cols-2 md:divide-x md:divide-y-0">
              <div className="px-5 py-4">
                <p className="text-caption font-medium text-foreground">{carrier ?? DASH}</p>
                <p className="mt-0.5 font-mono text-micro text-muted-foreground">
                  {awb ? `AWB ${awb}` : DASH}
                </p>
                <ShipmentStepper fulfillment={primaryFulfilment} />
              </div>
              <div className="space-y-2 px-5 py-4">
                {outstanding.length > 0 ? (
                  <ul className="space-y-1.5">
                    {outstanding.map((li) => (
                      <li key={li.id} className="flex items-start gap-2 text-caption">
                        <span
                          className={cn(
                            "mt-1.5 size-1.5 shrink-0 rounded-full",
                            li.fulfillmentStatus === "on_hold" ? "bg-muted-foreground" : "bg-warning",
                          )}
                        />
                        <span className="min-w-0 text-foreground">
                          <span className="truncate">{li.title}</span>
                          <span className="text-muted-foreground">
                            {" "}
                            — {li.fulfillmentStatus === "on_hold" ? "on hold" : "ready to ship"}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-caption text-muted-foreground">
                    Every item on this order has been fulfilled.
                  </p>
                )}
                {/* `canFulfill` already requires outstanding units, so this is
                    absent rather than present-but-dead once everything ships. */}
                {canFulfill && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full"
                    onClick={() => setDialog("fulfill")}
                  >
                    <Truck className="size-3.5" />
                    Create fulfilment
                  </Button>
                )}
              </div>
            </div>
          </section>

          {/* Existing shipments, with edit-tracking / cancel. Self-nulls when empty. */}
          <OrderFulfillmentsSection order={order} canAct={canActOnItems} />

          {/* Activity — `orgMembers` is already fetched above for the Owner row. */}
          <OrderActivity order={order} currency={currency} members={orgMembers} />

          {/* Refunds */}
          {order.refunds.length > 0 && (
            <section className="rounded-xl bg-card shadow-sm ring-1 ring-border">
              <h2 className="border-b px-5 py-3 text-micro font-semibold uppercase tracking-wider text-muted-foreground">
                Refunds ({order.refunds.length})
              </h2>
              <ul className="divide-y">
                {order.refunds.map((r) => (
                  <li key={r.id} className="flex items-center justify-between px-5 py-3">
                    <div>
                      <p className="text-caption font-medium tabular-nums text-danger">
                        -{formatCurrency(Number(r.amount), currency)}
                      </p>
                      {r.reason && <p className="text-micro text-muted-foreground">{r.reason}</p>}
                    </div>
                    <p className="text-micro text-muted-foreground">
                      {new Date(r.createdAt).toLocaleDateString("en-IN")}
                    </p>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        {/* ── Right rail: money, actions, customer, note ─────────────────── */}
        <aside className="flex flex-1 flex-col gap-1.5 rounded-xl bg-card p-4 lg:sticky lg:top-6 lg:self-start">
          {/* The order total lives in the left rail now — this rail opens with
              the actions rather than repeating the same figure. */}
          <div className="space-y-2">
            {/* No Fulfil items button here on purpose — fulfilment belongs to the
                Line Items card, which groups by state and can act per line. This
                rail carried a third copy of the same setDialog("fulfill") call. */}
            {canCapture && (
              <Button variant="brand" className="w-full" onClick={() => setDialog("capture")}>
                Capture payment
              </Button>
            )}
            {invoice ? (
              <Button asChild variant="outline" className="w-full">
                <Link to={`/orders/invoices/${invoice.id}/print`} target="_blank">
                  <Receipt className="size-3.5" />
                  View GST invoice
                </Link>
              </Button>
            ) : (
              /* POST /invoices is ORG_MANAGERS-only, so this carried no gate
                 and handed a VIEWER or AGENT a guaranteed 403. */
              canManage && (
                <Button
                  variant="brand"
                  className="w-full"
                  disabled={!gstEnabled}
                  title={gstEnabled ? undefined : "GST is not enabled for this organization"}
                  onClick={() => setShowInvoiceDialog(true)}
                >
                  <Receipt className="size-3.5" />
                  Generate GST invoice
                </Button>
              )
            )}
            {/* Why automatic invoicing did not produce one. The server has
                always recorded this; showing it only in the aggregate banner
                on the invoices tab meant the one place you would look — the
                order itself — said nothing. */}
            {!invoice && order.invoiceError && (
              <p className="flex items-start gap-1.5 rounded-lg bg-warning-subtle px-3 py-2 text-[10px] leading-relaxed text-warning">
                <AlertTriangle className="mt-px size-3 shrink-0" />
                <span>{order.invoiceError}</span>
              </p>
            )}
            <Button asChild variant="outline" className="w-full">
              <Link to={`/orders/${order.id}/packing-slip`} target="_blank">
                <Printer className="size-3.5" />
                Packing slip
              </Link>
            </Button>
            {canCancel && (
              <Button
                variant="ghost"
                className="w-full text-muted-foreground"
                onClick={() => setDialog("cancel")}
              >
                Cancel order
              </Button>
            )}
          </div>

          <CustomerRail
            order={order}
            customer={customer}
            customerError={customerError}
            onRetryCustomer={refetchCustomer}
            currency={currency}
            phone={phone}
          />

          <InternalNote key={order.id} order={order} canEdit={canEdit} />
        </aside>
      </div>

      {/* Dialogs — all reused from the actions menu so behaviour stays identical. */}
      {dialog === "fulfill" && <FulfillDialog order={order} onClose={() => setDialog(null)} />}
      {dialog === "capture" && (
        <CapturePaymentDialog order={order} onClose={() => setDialog(null)} />
      )}
      {dialog === "cancel" && <CancelOrderDialog order={order} onClose={() => setDialog(null)} />}
      <GenerateInvoiceDialog
        order={order}
        currency={currency}
        open={showInvoiceDialog}
        onClose={() => setShowInvoiceDialog(false)}
      />
    </div>
  );
}

/**
 * Outstanding balance.
 *
 * There is no transactions table and no `amountCaptured` column, so the amount
 * outstanding is only knowable where `financialStatus` makes it unambiguous.
 * `PARTIALLY_PAID` / `PARTIALLY_REFUNDED` return null rather than inventing a
 * number. (A `captured` figure was computed here too and never read by anything
 * — dropped rather than left as a second source of truth.)
 */
/** "27 Aug" — for group captions, where the year is noise. */
function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
}

/** "28 Aug, 11:30 am". */
function shortDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function deriveBalance(order: OrderDetail, total: number): { due: number | null } {
  const refunded = (order.refunds ?? []).reduce((sum, r) => sum + Number(r.amount), 0);
  switch (order.financialStatus) {
    case "PAID":
      return { due: 0 };
    case "REFUNDED":
    case "VOIDED":
      return { due: 0 };
    case "PENDING":
    case "AUTHORIZED":
      return { due: total - refunded };
    default:
      // PARTIALLY_PAID, PARTIALLY_REFUNDED — genuinely unknowable.
      return { due: null };
  }
}

function StatusPill({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-micro font-medium",
        className ?? "bg-muted text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

/**
 * Order lifecycle pill.
 *
 * There is no state column on `Order` — the whole vocabulary is
 * `financialStatus`, `fulfillmentStatus`, `cancelledAt`, `closedAt`. This pill
 * deliberately does NOT derive a "Completed" state from `fulfillmentStatus`:
 * fulfilment has its own pill in the rail, and an order that is fully shipped
 * is still open to refunds, notes and archiving until someone closes it.
 */
function deriveOrderState(order: OrderDetail): { label: string; className: string } {
  if (order.cancelledAt) return { label: "Cancelled", className: "bg-danger-subtle text-danger" };
  if (order.closedAt) return { label: "Archived", className: "bg-muted text-muted-foreground" };
  return { label: "Processing", className: "bg-muted text-muted-foreground" };
}

/**
 * Shipping pill.
 *
 * `OrderFulfillment.status` is a free-form string carrying TWO vocabularies:
 * the CRM's (`pending` / `fulfilled` / `delivered` / `cancelled`) and Shopify's
 * lowercased enum, where a completed shipment reads `success`. Compare through
 * the helpers in `lib/order-status` — a direct `=== "delivered"` silently
 * misread every synced shipment. An order with no fulfilment rows has not
 * shipped at all.
 */
function deriveShippingState(fulfillments: OrderFulfillment[]): {
  label: string;
  className: string;
} {
  const live = fulfillments.filter((f) => !isShipmentCancelled(f));
  if (live.length === 0) return { label: "Pending", className: "bg-warning-subtle text-warning" };
  if (live.some(isShipmentDelivered)) {
    return { label: "Delivered", className: "bg-brand/30 text-brand-strong" };
  }
  if (live.some(isShipmentShipped)) {
    return { label: "In transit", className: "bg-info-subtle text-info" };
  }
  return { label: "Packed", className: "bg-muted text-muted-foreground" };
}

/** Grams per unit for the free-form `weightUnit` string. Unknown units are skipped. */
const WEIGHT_TO_KG: Record<string, number> = {
  kg: 1,
  g: 0.001,
  lb: 0.453592,
  oz: 0.0283495,
};

/**
 * Total shipping weight.
 *
 * Line items never snapshot weight, so this reads the live variant. Returns null
 * — rather than "0 kg" — when no line contributes, which is the common case for
 * catalogues that never filled weight in.
 */
function totalWeightLabel(lineItems: OrderDetail["lineItems"]): string | null {
  let kg = 0;
  let counted = 0;
  for (const li of lineItems) {
    const raw = li.variant?.weight;
    if (raw == null) continue;
    const factor = WEIGHT_TO_KG[(li.variant?.weightUnit ?? "kg").toLowerCase()];
    if (!factor) continue;
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    kg += value * factor * li.quantity;
    counted += 1;
  }
  if (counted === 0) return null;
  return `${kg.toFixed(kg < 1 ? 3 : 1).replace(/\.0+$/, "")} kg`;
}

function balanceCaptionFor(
  order: OrderDetail,
  balance: { due: number | null },
  currency: string,
): string {
  switch (order.financialStatus) {
    case "PAID":
      return "Paid in full · nothing outstanding";
    case "REFUNDED":
      return "Refunded in full";
    case "VOIDED":
      return "Voided";
    case "PENDING":
    case "AUTHORIZED":
      return `${formatCurrency(balance.due ?? 0, currency)} outstanding`;
    default:
      // No captured amount is stored anywhere, so any figure here is invented.
      return "Partially paid · balance not tracked";
  }
}

/** A label/pill row in the left rail's status block. */
function StatusRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-caption text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

/** A label/value row in the left rail's metadata block. */
function MetaRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="shrink-0 text-caption text-muted-foreground">{label}</span>
      <span
        className={cn("truncate text-caption text-foreground", mono && "font-mono text-micro")}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

/** A titled section in the left rail. */
function RailSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2.5 border-t pt-4">
      <p className="text-micro font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
      {children}
    </div>
  );
}

/**
 * Tag chips with an inline add field.
 *
 * `PATCH /orders/:id` takes the full tag array — there is no add/remove delta
 * endpoint — so every edit sends the whole list.
 */
function OrderTags({ order, canEdit }: { order: OrderDetail; canEdit: boolean }) {
  const mutation = useUpdateOrderMutation(order.id);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const tags = order.tags ?? [];

  function commit() {
    const next = draft.trim();
    setDraft("");
    setAdding(false);
    if (!next || tags.includes(next)) return;
    mutation.mutate({ tags: [...tags, next] });
  }

  function remove(tag: string) {
    mutation.mutate({ tags: tags.filter((t) => t !== tag) });
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {tags.map((tag) => (
        <span
          key={tag}
          className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-micro font-medium text-foreground"
        >
          {tag}
          {/* Tags write through PATCH /orders/:id (ORG_OPERATORS). Without this
              a VIEWER got remove buttons and an Add control that only 403. */}
          {canEdit && (
            <button
              type="button"
              onClick={() => remove(tag)}
              disabled={mutation.isPending}
              aria-label={`Remove tag ${tag}`}
              className="text-muted-foreground hover:text-danger disabled:opacity-50"
            >
              <X className="size-2.5" />
            </button>
          )}
        </span>
      ))}

      {!canEdit ? null : adding ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") {
              setDraft("");
              setAdding(false);
            }
          }}
          placeholder="Tag name"
          className="h-6 w-24 rounded-full border border-border bg-background px-2 text-micro outline-none focus:ring-1 focus:ring-brand"
        />
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          disabled={mutation.isPending}
          className="inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-micro font-medium text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
        >
          <Plus className="size-2.5" />
          Add
        </button>
      )}
    </div>
  );
}

/** A labelled block in the right action rail. */
function RailBlock({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5 border-t pt-4">
      <p className="text-micro uppercase tracking-wider text-muted-foreground">{label}</p>
      {children}
    </div>
  );
}

function TotalRow({
  label,
  value,
  bold,
  negative,
}: {
  label: string;
  value: string;
  bold?: boolean;
  negative?: boolean;
}) {
  return (
    <div className={cn("flex justify-between gap-4", bold && "border-t pt-1")}>
      <dt className={cn("text-muted-foreground", bold && "font-semibold text-foreground")}>
        {label}
      </dt>
      <dd
        className={cn(
          "tabular-nums text-foreground",
          bold && "font-semibold",
          negative && "text-danger",
        )}
      >
        {value}
      </dd>
    </div>
  );
}


/**
 * Shipment progress.
 *
 * One step per timestamp `OrderFulfillment` actually carries — `createdAt`,
 * `shippedAt`, `deliveredAt` (or `status === "delivered"`).
 *
 * This used to show four steps including "Packed" and "In transit", neither of
 * which is observed: "Packed" was just `!!fulfillment` (the same fact as step
 * one) and "In transit" was `shipped && !delivered`, so it *un-completed* when
 * the parcel arrived. Both implied carrier scan events that nothing ingests.
 * Add steps back when there is a carrier feed to back them.
 */
function ShipmentStepper({ fulfillment }: { fulfillment?: OrderFulfillment }) {
  const steps = useMemo(() => {
    const delivered = !!fulfillment && isShipmentDelivered(fulfillment);
    const shipped = !!fulfillment && (isShipmentShipped(fulfillment) || delivered);
    return [
      { label: "Fulfilled", done: !!fulfillment },
      { label: "Shipped", done: shipped },
      { label: "Delivered", done: delivered },
    ];
  }, [fulfillment]);

  return (
    <ol className="mt-4 flex items-start">
      {steps.map((step, i) => (
        <li key={step.label} className="flex flex-1 flex-col items-center gap-1.5">
          <div className="flex w-full items-center">
            <span className={cn("h-px flex-1", i === 0 ? "bg-transparent" : "bg-border")} />
            <span
              className={cn(
                "size-2 shrink-0 rounded-full",
                step.done ? "bg-brand ring-2 ring-brand/30" : "bg-muted",
              )}
            />
            <span
              className={cn(
                "h-px flex-1",
                i === steps.length - 1 ? "bg-transparent" : "bg-border",
              )}
            />
          </div>
          <span
            className={cn(
              "text-micro",
              step.done ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {step.label}
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * Address bags are untyped `Record<string, unknown>` on the wire — Shopify's
 * snake_case shape for synced orders, `OrderAddressInput` for CRM-native ones.
 * Read the keys defensively and drop anything absent.
 */
function readAddress(address?: Record<string, unknown> | null) {
  const pick = (k: string) =>
    typeof address?.[k] === "string" ? (address[k] as string).trim() : "";
  const street = [pick("address1"), pick("address2")].filter(Boolean).join(", ");
  const region = [
    [pick("city"), pick("zip")].filter(Boolean).join(" "),
    pick("province"),
  ]
    .filter(Boolean)
    .join(", ");
  return {
    lines: [street, region, pick("country")].filter(Boolean),
    phone: pick("phone") || null,
  };
}

/** The fields that actually identify an address — name and phone are not part of it. */
const ADDRESS_KEYS = ["address1", "address2", "city", "province", "zip", "country"] as const;

function sameAddress(
  a?: Record<string, unknown> | null,
  b?: Record<string, unknown> | null,
): boolean {
  if (!a || !b) return false;
  return ADDRESS_KEYS.every((k) => (a[k] ?? "") === (b[k] ?? ""));
}

/**
 * Customer panel in the right rail — identity, contact, lifetime value and the
 * shipping address.
 *
 * `createdAt`, `ordersCount` and `totalSpent` come from the separate
 * `useCustomer` query; the order's own `customer` object carries only
 * id/name/email/phone.
 */
function CustomerRail({
  order,
  customer,
  customerError,
  onRetryCustomer,
  currency,
  phone,
}: {
  order: OrderDetail;
  customer?: CustomerDetail;
  /** The customer lookup failed — distinct from the order having no customer. */
  customerError?: boolean;
  onRetryCustomer?: () => void;
  currency: string;
  phone: string | null;
}) {
  const name = order.customer
    ? `${order.customer.firstName ?? ""} ${order.customer.lastName ?? ""}`.trim()
    : "";

  if (!name) {
    return (
      <RailBlock label="Customer">
        <p className="text-caption italic text-muted-foreground">Guest order</p>
      </RailBlock>
    );
  }

  const since = customer?.createdAt
    ? new Date(customer.createdAt).toLocaleDateString("en-IN", {
      month: "short",
      year: "numeric",
    })
    : null;
  const ship = readAddress(order.shippingAddress);
  const billingMatchesShipping = sameAddress(order.shippingAddress, order.billingAddress);

  return (
    <div className="flex flex-col gap-3 border-t pt-4">
      {/* Identity */}
      <div className="flex items-center gap-2.5">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-brand text-caption font-semibold text-brand-strong">
          {name.charAt(0).toUpperCase()}
        </span>
        <div className="min-w-0">
          <p className="truncate text-body font-semibold text-foreground">{name}</p>
          <p className="truncate text-micro text-muted-foreground">
            {since ? `Since ${since}` : DASH}
            {customer ? ` · ${customer.ordersCount} orders` : ""}
          </p>
        </div>
      </div>

      {/* Contact */}
      <div className="flex flex-col gap-0.5">
        {order.customer?.email && (
          <a
            href={`mailto:${order.customer.email}`}
            className="truncate text-caption text-info hover:underline"
          >
            {order.customer.email}
          </a>
        )}
        {phone && (
          <a href={`tel:${phone}`} className="truncate text-caption text-info hover:underline">
            {phone}
          </a>
        )}
      </div>

      {/* Lifetime value. A failed lookup used to render the same em dash as a
          customer with no spend — "unknown" shown as "zero". */}
      <div className="flex items-baseline justify-between gap-2  pt-3">
        <span className="text-caption text-muted-foreground">Lifetime value</span>
        {customerError ? (
          <button
            type="button"
            onClick={onRetryCustomer}
            className="text-caption font-medium text-danger underline"
          >
            Couldn't load — retry
          </button>
        ) : (
          <span className="text-caption font-semibold tabular-nums text-foreground">
            {customer ? formatCurrency(Number(customer.totalSpent), currency) : DASH}
          </span>
        )}
      </div>

      {/* Walk-in sales carry no customer record, so there is nothing to link to. */}
      {order.customer && (
        <Link
          to={`/orders/customers/${order.customer.id}`}
          className=" pt-3 text-center text-caption font-medium text-foreground hover:underline"
        >
          View customer →
        </Link>
      )}

      {/* Shipping */}
      <div className="flex flex-col gap-2.5 border-t pt-3">
        <p className="text-micro font-semibold uppercase tracking-wider text-muted-foreground">
          Shipping
        </p>
        {ship.lines.length > 0 ? (
          ship.lines.map((line) => (
            <p key={line} className="text-caption leading-snug text-foreground">
              {line}
            </p>
          ))
        ) : (
          <p className="text-caption text-muted-foreground">{DASH}</p>
        )}
        {ship.phone && <p className="text-caption text-foreground">{ship.phone}</p>}
        {/* Only claimed when the two bags genuinely match — a missing or
            different billing address must not read as "same as shipping". */}
        {billingMatchesShipping && (
          <p className="mt-1 text-micro text-muted-foreground">
            Billing address same as shipping
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Order note.
 *
 * Deliberately NOT labelled "internal" or "visible to staff only": for a
 * Shopify order `update()` pushes `note` straight to Shopify and `upsertOrder`
 * reads it back, so this is the customer-facing order note. A genuinely private
 * field needs its own column — `Customer.internalNotes` is the precedent.
 */
function InternalNote({ order, canEdit }: { order: OrderDetail; canEdit: boolean }) {
  const mutation = useUpdateOrderMutation(order.id);
  const serverNote = order.note ?? "";
  const [note, setNote] = useState(serverNote);
  const [baseline, setBaseline] = useState(serverNote);
  // The server value moved (refetch, webhook, Edit dialog, our own save).
  // Adopt it unless the user is mid-edit — otherwise a stale empty box makes
  // "Save note" live and one click wipes the real note (on Shopify too).
  if (serverNote !== baseline) {
    if (note === baseline) setNote(serverNote);
    setBaseline(serverNote);
  }
  const dirty = note !== serverNote;

  // Read-only roles still see the note — they just cannot write it. An empty
  // block would hide real order context from a VIEWER for no reason.
  if (!canEdit) {
    return (
      <RailBlock label="Order note">
        <p className="whitespace-pre-wrap text-caption text-muted-foreground">
          {order.note?.trim() || "No note on this order."}
        </p>
      </RailBlock>
    );
  }

  return (
    <RailBlock label="Order note">
      <Textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={3}
        placeholder="Add a note to this order"
        className="text-caption"
      />
      <p className="text-micro text-muted-foreground">
        {order.channel?.platform === "SHOPIFY"
          ? "Synced to Shopify — not staff-only."
          : "Stored on the order."}
      </p>
      <Button
        variant="outline"
        size="sm"
        className="w-full"
        disabled={!dirty || mutation.isPending}
        onClick={() => mutation.mutate({ note })}
      >
        {mutation.isPending && <Loader2 className="size-3.5 animate-spin" />}
        Save note
      </Button>
    </RailBlock>
  );
}
