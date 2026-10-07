import { Link } from "react-router";
import { ArrowLeft, Loader2, Printer } from "lucide-react";
import { useOrder } from "~/hooks/use-order-queries";
import { useListReturnPath } from "~/hooks/use-list-url-state";
import { OrderItemsFulfillment } from "~/components/app/order-items-fulfillment";
import { cn } from "~/lib/utils";
import { fulfillmentStatusLabel, hasOutstandingUnits } from "~/lib/order-status";
import type { VendorOrderDetail as VendorOrder } from "~/types/api";
import { QueryErrorState } from "~/components/app/query-error-state";

const STATUS_CLASS: Record<string, string> = {
  fulfilled: "bg-[#CEF17B]/30 text-[#084734]",
  delivered: "bg-emerald-100 text-emerald-700",
  in_progress: "bg-blue-100 text-blue-700",
  on_hold: "bg-amber-100 text-amber-700",
  partial: "bg-blue-100 text-blue-700",
};

/** A VENDOR's view of an order — only their items, ship-to, and fulfilment actions. */
export function VendorOrderDetail({ orderId }: { orderId: string }) {
  const { data, isLoading, isError, refetch } = useOrder(orderId);
  // Back to the list as it was left: same page and search.
  const ordersPath = useListReturnPath("orders", "/orders");
  const order = data as unknown as VendorOrder | undefined;

  // Before the spinner: a failed request left isLoading false and order
  // undefined, so the spinner arm below never resolved.
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

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link
            to={ordersPath}
            className="mb-1 inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-gray-900 dark:hover:text-gray-100"
          >
            <ArrowLeft className="size-3.5" /> Back to orders
          </Link>
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">
              Order {order.name}
            </h1>
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-[10px] font-medium",
                STATUS_CLASS[order.fulfillmentStatus?.toLowerCase()] ??
                  "bg-orange-100 text-orange-600",
              )}
            >
              {order.fulfillmentStatus}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            {new Date(order.createdAt).toLocaleString("en-IN", {
              day: "2-digit",
              month: "long",
              year: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            to={`/orders/${orderId}/packing-slip`}
            target="_blank"
            className="inline-flex items-center gap-1.5 rounded-lg border border-input bg-white px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800/60"
          >
            <Printer className="size-3.5" /> Packing slip
          </Link>
          <Link
            to={`/orders/${orderId}/pick-slip`}
            target="_blank"
            className="inline-flex items-center gap-1.5 rounded-lg border border-input bg-white px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800/60"
          >
            <Printer className="size-3.5" /> Pick slip
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {/* Items + per-product fulfilment actions (shared with the owner view). */}
          <OrderItemsFulfillment
            orderId={orderId}
            items={order.lineItems}
            currency={order.currency}
            title="Your items"
            showSubtotal
            allowInProgress
            /* This component renders only for a VENDOR (see the role router in
               routes/app/orders/$id.tsx), and every fulfilment endpoint accepts
               vendors, so acting is always allowed here. Passed explicitly
               because both props are required — omitting the old single flag
               silently granted the full action set. */
            canActOnItems
            canCreateFulfillment={hasOutstandingUnits(order.lineItems)}
          />

          {/* Shipments — read-only tracking. */}
          {order.fulfillments.length > 0 && (
            <Section title="Shipments">
              <ul className="space-y-2">
                {order.fulfillments.map((f) => (
                  <li
                    key={f.id}
                    className="rounded-lg border bg-gray-50 px-3 py-2 dark:bg-gray-800/50"
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-xs font-medium capitalize">
                          {fulfillmentStatusLabel(f.status)}
                        </p>
                        {f.trackingNumber && (
                          <p className="text-[10px] text-muted-foreground">
                            {f.trackingCompany ? `${f.trackingCompany} · ` : ""}
                            {f.trackingUrl ? (
                              <a
                                href={f.trackingUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="underline"
                              >
                                {f.trackingNumber}
                              </a>
                            ) : (
                              f.trackingNumber
                            )}
                          </p>
                        )}
                      </div>
                      <p className="text-[10px] text-muted-foreground">
                        {new Date(f.createdAt).toLocaleDateString("en-IN")}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </div>

        {/* Sidebar */}
        <div className="space-y-6">
          <Section title="Ship to">
            {order.shipTo ? (
              <div className="space-y-0.5 text-xs text-gray-900 dark:text-gray-100">
                {order.shipTo.name && <p className="font-medium">{order.shipTo.name}</p>}
                {order.shipTo.company && <p>{order.shipTo.company}</p>}
                {order.shipTo.address1 && <p>{order.shipTo.address1}</p>}
                {order.shipTo.address2 && <p>{order.shipTo.address2}</p>}
                <p>
                  {[order.shipTo.city, order.shipTo.province, order.shipTo.zip]
                    .filter(Boolean)
                    .join(", ")}
                </p>
                {order.shipTo.country && <p>{order.shipTo.country}</p>}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground italic">No shipping address.</p>
            )}
          </Section>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl bg-white dark:bg-gray-900 shadow-sm ring-1 ring-border">
      <h2 className="border-b px-5 py-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h2>
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}
