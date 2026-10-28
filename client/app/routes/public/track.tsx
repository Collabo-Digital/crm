import { useEffect, type ReactNode } from "react";
import { useParams } from "react-router";
import { isAxiosError } from "axios";
import { Check, ExternalLink, Loader2, PackageX } from "lucide-react";

import { PublicLinkMessage } from "~/components/app/public-link-message";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { usePublicOrderLink } from "~/hooks/use-public-links";
import { trackingStep } from "~/lib/tracking-link";
import { cn } from "~/lib/utils";
import type { PublicOrderLink, PublicOrderStatus } from "~/types/api";

export function meta() {
  return [{ title: "Your order" }, { name: "robots", content: "noindex" }];
}

const STEPS: Array<{ status: PublicOrderStatus; label: string }> = [
  { status: "confirmed", label: "Confirmed" },
  { status: "shipped", label: "Shipped" },
  { status: "out_for_delivery", label: "Out for delivery" },
  { status: "delivered", label: "Delivered" },
];

const HEADLINE: Record<PublicOrderStatus, { title: string; body: string }> = {
  confirmed: { title: "Order confirmed", body: "The store is getting your order ready." },
  shipped: { title: "On its way", body: "Your order has shipped." },
  out_for_delivery: { title: "Out for delivery", body: "Your order should reach you today. Please keep your phone reachable." },
  delivered: { title: "Delivered", body: "Your order has been delivered." },
  cancelled: { title: "Order cancelled", body: "This order was cancelled." },
};

/**
 * Where a customer's order is, from the "Track order" button in a WhatsApp
 * message. Public, outside the app and its sign-in: the token in the link is
 * the only key. A known courier's tracking page opens straight away; any
 * other tracking address is named under the order's status, for the
 * customer to continue to. No name, phone or address.
 */
export default function PublicOrderPage() {
  const { token } = useParams<{ token: string }>();
  const { data, error, isLoading, refetch, isFetching } = usePublicOrderLink(token);
  const step = data ? trackingStep(data.order) : null;
  const courier = step?.kind === "open" ? step.url : null;

  useEffect(() => {
    if (courier) window.location.replace(courier);
  }, [courier]);
  useEffect(() => {
    if (data) document.title = `Order ${data.order.name} · ${data.storeName}`;
  }, [data]);

  const status = isAxiosError(error) ? (error.response?.status ?? 0) : 0;

  return (
    <div className="min-h-dvh bg-surface-sunken px-4 py-10">
      <main className="mx-auto max-w-md">
        {isLoading ? (
          <div className="space-y-3 rounded-2xl bg-card p-6 ring-1 ring-border">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-7 w-48" />
            <Skeleton className="h-28 w-full" />
          </div>
        ) : !data ? (
          <PublicLinkMessage
            icon={PackageX}
            title={status >= 400 && status < 500 ? "This link isn't valid." : "The order couldn't be loaded"}
            body={status >= 400 && status < 500 ? "It may have expired, or part of it is missing. Ask the store to send it again." : "Check your internet connection and try again."}
            retry={status >= 400 && status < 500 ? undefined : { onClick: () => void refetch(), busy: isFetching }}
          />
        ) : courier ? (
          <div className="flex flex-col items-center gap-3 pt-16 text-center">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
            <p className="text-body">Opening the courier’s tracking page for order {data.order.name}…</p>
            <a href={courier} className="text-caption text-muted-foreground underline">
              Open it now
            </a>
          </div>
        ) : (
          <OrderStatus link={data} next={step?.kind === "confirm" ? step : null} />
        )}
      </main>
    </div>
  );
}

function OrderStatus({ link, next }: { link: PublicOrderLink; next: { url: string; host: string } | null }) {
  const { order } = link;
  const headline = HEADLINE[order.status] ?? HEADLINE.confirmed;
  const current = STEPS.findIndex((s) => s.status === order.status);
  return (
    <div className="space-y-4">
      <p className="text-center text-caption text-muted-foreground">{link.storeName}</p>
      <article className="space-y-6 rounded-2xl bg-card p-6 text-card-foreground shadow-sm ring-1 ring-border">
        <header className="space-y-1">
          <p className="text-caption text-muted-foreground">Order {order.name}</p>
          <h1 className="font-heading text-subhead">{headline.title}</h1>
          <p className="text-body text-muted-foreground">{headline.body}</p>
        </header>

        {order.status !== "cancelled" && (
          <ol className="space-y-3" aria-label="Progress">
            {STEPS.map((step, i) => {
              const done = i <= current;
              return (
                <li key={step.status} className="flex items-center gap-3" aria-current={i === current ? "step" : undefined}>
                  <span className={cn("flex size-6 shrink-0 items-center justify-center rounded-full", done ? "bg-success-subtle text-success" : "border border-border bg-background")}>
                    {done && <Check className="size-3.5" />}
                  </span>
                  <span className={cn("text-body", i === current ? "font-medium text-foreground" : done ? "text-foreground" : "text-muted-foreground")}>{step.label}</span>
                </li>
              );
            })}
          </ol>
        )}

        {(order.carrier || order.trackingNumber) && (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 border-t pt-4 text-caption">
            {order.carrier && <Detail label="Courier" value={order.carrier} />}
            {order.trackingNumber && <Detail label="Tracking number" value={<span className="font-mono">{order.trackingNumber}</span>} />}
          </dl>
        )}

        {next && (
          <div className="space-y-3 border-t pt-4">
            <p className="text-body">
              Tracking for this order is on <span className="break-all font-medium">{next.host}</span>.
            </p>
            <Button asChild className="h-11 w-full">
              <a href={next.url} rel="noopener noreferrer">
                <span className="truncate">Continue to {next.host}</span>
                <ExternalLink />
              </a>
            </Button>
          </div>
        )}
      </article>
      <p className="text-center text-caption text-muted-foreground">Questions about your order? Reply to {link.storeName} on WhatsApp.</p>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="break-words font-medium">{value}</dd>
    </div>
  );
}
