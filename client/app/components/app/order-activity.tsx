import { useMemo } from "react";
import { oneOf, useSessionState } from "~/hooks/use-session-state";
import { Package } from "lucide-react";

import { cn, formatCurrency } from "~/lib/utils";
import type { OrderDetail, OrgMember } from "~/types/api";

type EventCategory = "order" | "payment" | "fulfilment";
type Filter = "all" | EventCategory;

/**
 * The complete set of `action` values any code path writes, mapped to a
 * category. Write sites live in server/src/order/order.service.ts (user
 * actions) and server/src/channel/shopify-sync.service.ts (inbound Shopify
 * changes). There is no shared enum server-side, so this map is the only place
 * the vocabulary is collected.
 *
 * The column is a free-form string, so `categoryOf` must tolerate anything.
 */
const EVENT_CATEGORY: Record<string, EventCategory> = {
  created: "order",
  updated: "order",
  cancelled: "order",
  closed: "order",
  reopened: "order",
  sync_queued: "order",
  invoice_edited: "order",
  paid: "payment",
  captured: "payment",
  capture_pending: "payment",
  payment_status_changed: "payment",
  refunded: "payment",
  fulfilled: "fulfilment",
  delivered: "fulfilment",
  item_delivered: "fulfilment",
  item_unfulfilled: "fulfilment",
  items_status_changed: "fulfilment",
  fulfillment_status_changed: "fulfilment",
  tracking_updated: "fulfilment",
  fulfillment_cancelled: "fulfilment",
  // Packing checks the parcel; it is not a shipment.
  packing_started: "fulfilment",
  packing_held: "fulfilment",
  packing_resumed: "fulfilment",
  packed: "fulfilment",
  packing_cancelled: "fulfilment",
};

const CATEGORY_LABEL: Record<EventCategory, string> = {
  order: "Order",
  payment: "Payment",
  fulfilment: "Fulfilment",
};

const CATEGORY_BADGE: Record<EventCategory, string> = {
  order: "bg-muted text-muted-foreground",
  payment: "bg-brand/30 text-brand-strong",
  fulfilment: "bg-info-subtle text-info",
};

const CATEGORY_DOT: Record<EventCategory, string> = {
  order: "bg-muted-foreground",
  payment: "bg-brand",
  fulfilment: "bg-info",
};

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "order", label: "Order" },
  { id: "payment", label: "Payment" },
  { id: "fulfilment", label: "Fulfilment" },
];

function categoryOf(action?: string | null): EventCategory {
  return (action && EVENT_CATEGORY[action]) || "order";
}

/** Cancellations read as destructive regardless of which category they sit in. */
function isDestructive(action?: string | null): boolean {
  return (
    action === "cancelled" ||
    action === "fulfillment_cancelled" ||
    action === "item_unfulfilled" ||
    action === "refunded"
  );
}

/**
 * Did this event come from Shopify rather than a user here?
 *
 * The sync path stamps `metadata.source` and leaves `actorId` null, because the
 * actor is a Shopify Admin user we hold no record of.
 */
function isFromShopify(evt: { actorId?: string | null; metadata?: Record<string, unknown> | null }) {
  return !evt.actorId && evt.metadata?.source === "shopify";
}

/** "Premium Cotton Shirt" → "PCS". Stands in for a missing product image. */
function initialsOf(title: string): string {
  return title
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");
}

/**
 * Order lifecycle feed.
 *
 * Two kinds of event land here. User actions carry an `actorId` resolved to a
 * name against the org member list. Changes made in Shopify Admin arrive through
 * the sync/webhook path with a null `actorId` and `metadata.source === "shopify"`,
 * and are attributed to Shopify instead. Chips filter by event type, since both
 * kinds can appear in any category.
 *
 * Shopify events are only recorded from the moment that path started writing
 * them — history before then was deliberately not backfilled, because
 * reconstructing it from current state would be inventing it.
 */
export function OrderActivity({
  order,
  currency,
  members,
}: {
  order: OrderDetail;
  currency: string;
  /** From `useOrgMembers` — already fetched by the page for the Owner row. */
  members?: OrgMember[];
}) {
  const [filter, setFilter] = useSessionState<Filter>(
    "order-activity.filter",
    "all",
    oneOf(["all", "order", "payment", "fulfilment"]),
  );
  const timeline = order.timeline ?? [];

  const counts = useMemo(() => {
    const tally: Record<EventCategory, number> = { order: 0, payment: 0, fulfilment: 0 };
    for (const evt of timeline) tally[categoryOf(evt.action)] += 1;
    return tally;
  }, [timeline]);

  const visible = useMemo(
    () => (filter === "all" ? timeline : timeline.filter((e) => categoryOf(e.action) === filter)),
    [timeline, filter],
  );

  /** Join on `user.id` — `member.id` is the membership row, not the user. */
  function actorName(actorId?: string | null): string | null {
    if (!actorId) return null;
    const member = members?.find((m) => m.user.id === actorId);
    if (!member) return null;
    return `${member.user.firstName} ${member.user.lastName?.charAt(0) ?? ""}.`.trim();
  }

  const units = order.lineItems.reduce((sum, li) => sum + li.quantity, 0);
  const subtotal = Number(order.subtotalPrice);
  const discounts = Number(order.totalDiscounts);
  const tax = Number(order.totalTax);
  const total = Number(order.totalPrice);

  return (
    <section className="rounded-xl bg-card shadow-sm ring-1 ring-border">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-3">
        <h2 className="text-micro font-semibold uppercase tracking-wider text-muted-foreground">
          Order lifecycle · {timeline.length} event{timeline.length === 1 ? "" : "s"}
        </h2>
        <div role="tablist" className="flex gap-1 rounded-full bg-muted p-1">
          {FILTERS.map(({ id, label }) => {
            const count = id === "all" ? timeline.length : counts[id];
            return (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={filter === id}
                onClick={() => setFilter(id)}
                className={cn(
                  "rounded-full px-3 py-1 text-micro font-medium transition-colors",
                  filter === id
                    ? "bg-ink font-semibold text-brand"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
                {count > 0 && ` (${count})`}
              </button>
            );
          })}
        </div>
      </div>

      {timeline.length === 0 ? (
        <p className="px-5 py-4 text-caption text-muted-foreground">
          No activity recorded yet. Changes made here and in Shopify both appear on
          this feed from the point they happen.
        </p>
      ) : (
        <div className="px-5 py-4">
          {visible.length === 0 ? (
            <p className="text-caption text-muted-foreground">
              No {CATEGORY_LABEL[filter as EventCategory].toLowerCase()} events on this order.
            </p>
          ) : (
            <ol>
              {visible.map((evt, i) => {
                const category = categoryOf(evt.action);
                const actor = actorName(evt.actorId);
                const isLast = i === visible.length - 1;
                return (
                  <li key={evt.id} className={cn("relative flex gap-3", !isLast && "pb-4")}>
                    {!isLast && (
                      <span
                        aria-hidden
                        className="absolute bottom-0 left-[4px] top-4 w-px bg-border"
                      />
                    )}
                    <span
                      className={cn(
                        "relative z-10 mt-1.5 size-2.5 shrink-0 rounded-full",
                        isDestructive(evt.action) ? "bg-danger" : CATEGORY_DOT[category],
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        {/* Stored messages are already descriptive — rendered verbatim. */}
                        <p className="text-caption font-medium text-foreground">{evt.message}</p>
                        <span
                          className={cn(
                            "inline-flex items-center rounded-full px-1.5 py-0.5 text-micro font-medium uppercase tracking-wider",
                            CATEGORY_BADGE[category],
                          )}
                        >
                          {CATEGORY_LABEL[category]}
                        </span>
                      </div>
                      <p className="mt-0.5 text-micro text-muted-foreground">
                        {new Date(evt.createdAt).toLocaleString("en-IN", {
                          day: "2-digit",
                          month: "short",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                        {/* A Shopify event has no actor we can name, so say
                            where it came from rather than leaving it blank and
                            looking like a failed name lookup. */}
                        {actor
                          ? ` · ${actor}`
                          : isFromShopify(evt)
                            ? " · Shopify"
                            : ""}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}

          {/* Order contents — the oldest entry in the feed. */}
          <div className="mt-5 border-t pt-4">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                <Package className="size-3.5" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-caption font-medium text-foreground">
                  Order contents at creation
                </p>
                <p className="mt-0.5 text-micro text-muted-foreground">
                  {order.lineItems.length} line{order.lineItems.length === 1 ? "" : "s"} · {units}{" "}
                  unit{units === 1 ? "" : "s"}
                </p>
              </div>
            </div>

            <div className="mt-3 overflow-hidden rounded-lg ring-1 ring-border">
              <ul className="divide-y">
                {order.lineItems.map((li) => (
                  <li key={li.id} className="flex items-center gap-3 px-3 py-2.5">
                    {li.imageUrl ? (
                      <img
                        src={li.imageUrl}
                        alt=""
                        className="size-8 shrink-0 rounded-md object-cover ring-1 ring-border"
                      />
                    ) : (
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-micro font-semibold text-muted-foreground">
                        {initialsOf(li.title)}
                      </span>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-caption font-medium text-foreground">
                        {li.title}
                      </p>
                      <p className="truncate text-micro text-muted-foreground">
                        {[li.variantTitle, li.sku].filter(Boolean).join(" · ") || "—"}
                      </p>
                    </div>
                    <p className="shrink-0 text-micro tabular-nums text-muted-foreground">
                      {li.quantity} × {formatCurrency(Number(li.price), currency)}
                    </p>
                    <p className="w-24 shrink-0 text-right text-caption font-medium tabular-nums text-foreground">
                      {formatCurrency(Number(li.price) * li.quantity, currency)}
                    </p>
                  </li>
                ))}
              </ul>
              <div className="flex flex-wrap items-center justify-between gap-2 border-t bg-surface-sunken px-3 py-2 dark:bg-muted/40">
                <p className="text-micro text-muted-foreground">
                  Subtotal {formatCurrency(subtotal, currency)}
                  {discounts > 0 && ` · discount -${formatCurrency(discounts, currency)}`}
                  {tax > 0 && ` · GST ${formatCurrency(tax, currency)}`}
                </p>
                <p className="text-caption font-semibold tabular-nums text-foreground">
                  {formatCurrency(total, currency)}
                </p>
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
