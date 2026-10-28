import { useState } from "react";
import { isString, useSessionState } from "~/hooks/use-session-state";
import {
  type DateRangePreset,
  type OrderRangePreset,
  orderRangeDates,
  useDateRangeFilter,
} from "~/hooks/use-date-range-filter";
import { Link } from "react-router";
import { Search } from "lucide-react";

import { Button } from "~/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Skeleton } from "~/components/ui/skeleton";
import { DateRangeFilter } from "~/components/app/date-range-filter";
import { ChannelBadge } from "~/components/app/channel-badge";
import { EmptyState } from "~/components/app/empty-state";
import { QueryErrorState } from "~/components/app/query-error-state";
import { useChannels } from "~/hooks/use-channel-queries";
import { useDebounced } from "~/hooks/use-debounced";
import { useOrder, useOrders } from "~/hooks/use-order-queries";
import { useCurrentOrg } from "~/hooks/use-org-queries";
import { reportingTimeZone, todayIn } from "~/lib/reporting-date";
import {
  FINANCIAL_CLASSES,
  FINANCIAL_LABELS,
  FULFILLMENT_CLASSES,
  FULFILLMENT_LABELS,
} from "~/lib/order-status";
import { cn, formatCurrency } from "~/lib/utils";
import type { Order, OrderListParams } from "~/types/api";

const PAGE_SIZE = 5;

/** Same ranges as the Orders list page, so the two read alike. */
const DATE_RANGE_PRESETS: ReadonlyArray<DateRangePreset<OrderRangePreset>> = [
  { value: "all", label: "All time" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
];

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function StatusPill({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-micro font-medium",
        className,
      )}
    >
      {children}
    </span>
  );
}

/**
 * A customer's orders, as cards showing their line items.
 *
 * Sourced from `GET /orders?customerId=` rather than the `orders` array on
 * `GET /customers/:id`: that projection carries neither `channel` (so no badge)
 * nor `itemCount`, and is hard-capped at 10 with no pagination.
 *
 * The list response has no line items — only `GET /orders/:id` does — so each
 * card fires its own detail request on mount. Rendering this tab therefore costs
 * 1 list call plus PAGE_SIZE detail calls in parallel. See `OrderCard` for why
 * that is cheaper than it reads.
 */
export function CustomerOrdersPanel({
  customerId,
  currency,
}: {
  customerId: string;
  currency: string;
}) {
  const [search, setSearch] = useState("");
  // Remembered per customer for the browser session. This panel unmounts when
  // the page's tab changes, which used to wipe both filters.
  const dateRange = useDateRangeFilter<OrderRangePreset>(
    `customer-orders.${customerId}.range`,
    "all",
    DATE_RANGE_PRESETS,
  );
  const [savedChannelId, setChannelId] = useSessionState(
    `customer-orders.${customerId}.channel`,
    "all",
    isString,
  );
  const [page, setPage] = useState(1);

  const { data: channels = [], isSuccess: channelsLoaded } = useChannels();
  // A remembered channel that has since been disconnected would filter to an
  // empty list behind a blank select.
  const channelId =
    channelsLoaded && !channels.some((channel) => channel.id === savedChannelId)
      ? "all"
      : savedChannelId;
  const { data: org } = useCurrentOrg();

  // Debounced into the query key only, so typing stays instant.
  const debouncedSearch = useDebounced(search, 350);
  const timeZone = reportingTimeZone(org?.timezone);

  const params: OrderListParams = {
    customerId,
    page,
    limit: PAGE_SIZE,
    search: debouncedSearch || undefined,
    ...orderRangeDates(dateRange, timeZone),
    channelId: channelId !== "all" ? channelId : undefined,
  };

  const { data, isLoading, isError, refetch } = useOrders(params);
  const orders = data?.data ?? [];
  const meta = data?.meta;
  const totalPages = meta?.totalPages ?? 1;

  /** Every filter change invalidates the current page number. */
  function reset<T>(setter: (value: T) => void) {
    return (value: T) => {
      setter(value);
      setPage(1);
    };
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-50 flex-1">
          <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            placeholder="Search orders"
            value={search}
            onChange={(e) => reset(setSearch)(e.target.value)}
            className="h-8 w-full rounded-lg border border-input bg-card pl-8 pr-3 text-caption placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-solid focus-visible:outline-1 focus-visible:outline-offset-0 focus-visible:outline-ring"
          />
        </div>

        <DateRangeFilter
          presets={DATE_RANGE_PRESETS}
          preset={dateRange.preset}
          custom={dateRange.custom}
          label={dateRange.label}
          today={todayIn(timeZone)}
          onPresetChange={reset(dateRange.selectPreset)}
          onCustomApply={reset(dateRange.applyCustom)}
          className="shadow-none"
        />

        <Select value={channelId} onValueChange={reset(setChannelId)}>
          <SelectTrigger aria-label="Channel" className="h-8 w-32 rounded-lg bg-card text-caption">
            <SelectValue placeholder="Channels" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All channels</SelectItem>
            {channels.map((channel) => (
              <SelectItem key={channel.id} value={channel.id}>
                {channel.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Error first: a failed request leaves isLoading false and data undefined,
          so the empty branch would otherwise claim the customer has no orders. */}
      {isError && !data ? (
        <div className="rounded-xl bg-card p-8 shadow-sm ring-1 ring-border">
          <QueryErrorState resource="orders" onRetry={() => refetch()} />
        </div>
      ) : isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="rounded-xl bg-card p-4 shadow-sm ring-1 ring-border"
            >
              <div className="flex items-center gap-3">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-4 w-20" />
                <Skeleton className="ml-auto h-4 w-16" />
              </div>
            </div>
          ))}
        </div>
      ) : orders.length === 0 ? (
        <div className="rounded-xl bg-card p-8 shadow-sm ring-1 ring-border">
          <EmptyState
            title="No orders found"
            description={
              debouncedSearch || dateRange.custom || dateRange.preset !== "all" || channelId !== "all"
                ? "Try adjusting your search or filters."
                : "Orders will appear here once this customer buys something."
            }
          />
        </div>
      ) : (
        <div className="space-y-2">
          {orders.map((order) => (
            <OrderCard key={order.id} order={order} currency={currency} />
          ))}
        </div>
      )}

      {!isLoading && orders.length > 0 && totalPages > 1 && (
        <div className="flex items-center justify-between">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((prev) => Math.max(1, prev - 1))}
            disabled={page === 1}
          >
            Previous
          </Button>
          <p className="text-caption text-muted-foreground">
            Page {meta?.page ?? 1} of {totalPages} ({meta?.total ?? 0} total)
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))}
            disabled={page >= totalPages}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * One order card.
 *
 * Its own component because `useOrder` is a hook and so cannot be called inside
 * the parent's `.map()` — the same reason `OrderRowSyncItem` is split out of
 * `orders-table.tsx`.
 *
 * Line items are always visible, so the detail request fires on mount rather
 * than on expand. That makes opening the tab 1 list call + PAGE_SIZE detail
 * calls in parallel: the list endpoint carries no `lineItems`, only
 * `GET /orders/:id` does. Two things blunt the cost — react-query caches these
 * under `orderKeys.detail(id)`, so paging back is free, and that is the same key
 * the order detail page reads, so "View order" lands on a warm cache.
 */
function OrderCard({ order, currency }: { order: Order; currency: string }) {
  const { data: detail, isLoading } = useOrder(order.id);

  const lineItems = detail?.lineItems ?? [];
  // Only the Shopify sync writes OrderRefund rows — cancelling with
  // `refund: true` just flips financialStatus — so a refunded CRM-native order
  // has none, and this stays empty rather than showing a zero.
  const refunds = detail?.refunds ?? [];

  // `itemCount` comes from the list response, so the placeholder is already the
  // right height and the card does not jump when detail lands. Capped so a
  // 40-line order does not render 40 skeletons.
  const skeletonRows = Math.min(Math.max(order.itemCount, 1), 4);

  return (
    <div className="rounded-xl bg-card p-4 shadow-sm ring-1 ring-border">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="text-caption font-medium text-foreground">
          Order {order.name}
        </span>
        <ChannelBadge
          platform={order.channel?.platform}
          name={order.channel?.name}
          className="text-caption text-muted-foreground"
        />
        <span className="text-caption text-warning">
          {formatDate(order.createdAt)}
        </span>

        <span className="ml-auto flex items-center gap-2">
          <StatusPill className={FINANCIAL_CLASSES[order.financialStatus]}>
            {FINANCIAL_LABELS[order.financialStatus]}
          </StatusPill>
          <StatusPill className={FULFILLMENT_CLASSES[order.fulfillmentStatus]}>
            {FULFILLMENT_LABELS[order.fulfillmentStatus]}
          </StatusPill>
          <span className="text-caption font-semibold tabular-nums text-foreground">
            {formatCurrency(order.totalPrice, order.currency || currency)}
          </span>
        </span>
      </div>

      <div className="mt-3 border-l-2 pl-3">
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: skeletonRows }).map((_, i) => (
              <div key={i} className="flex items-center justify-between gap-3">
                <Skeleton className="h-2.5 w-40" />
                <Skeleton className="h-2.5 w-14" />
              </div>
            ))}
          </div>
        ) : (
          <>
            <ul className="space-y-1.5">
              {lineItems.map((item) => (
                <li
                  key={item.id}
                  className="flex items-baseline justify-between gap-3"
                >
                  <span className="min-w-0 truncate text-caption text-warning">
                    {item.title}
                    {item.variantTitle && `, ${item.variantTitle}`} ×{" "}
                    {item.quantity}
                  </span>
                  <span className="shrink-0 text-caption tabular-nums text-muted-foreground">
                    {formatCurrency(
                      item.price * item.quantity,
                      order.currency || currency,
                    )}
                  </span>
                </li>
              ))}
            </ul>

            {refunds.map((refund) => (
              <div
                key={refund.id}
                className="mt-1.5 flex items-baseline justify-between gap-3 text-caption"
              >
                <span className="text-muted-foreground">
                  Refunded {formatDate(refund.createdAt)}
                  {refund.reason && ` · ${refund.reason}`}
                </span>
                <span className="shrink-0 tabular-nums text-danger">
                  −{formatCurrency(refund.amount, order.currency || currency)}
                </span>
              </div>
            ))}
          </>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button asChild variant="outline" size="sm">
          <Link to={`/orders/${order.id}`}>View order</Link>
        </Button>
      </div>
    </div>
  );
}
