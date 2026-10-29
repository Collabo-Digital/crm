import { useMemo } from "react";
import { Link, useNavigate } from "react-router";
import { ChevronRight, Loader2, MoreHorizontal, Package, Receipt, UploadCloud } from "lucide-react";
import { Button } from "~/components/ui/button";
import { ShopifySyncCell } from "~/components/app/shopify-sync-cell";
import ShopifyIcon from "~/assests/icon/shopifyIcon";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import {
  DateCell,
  IdCell,
  MoneyCell,
  StatusPill,
  TextCell,
  type ColumnDef,
} from "~/components/app/data-table";
import { StatusBadge } from "~/components/ui/status-badge";
import { cn, formatCurrency } from "~/lib/utils";
import { formatDayMonth } from "~/lib/format-date";
import { useSyncOrderMutation } from "~/hooks/use-order-mutations";
import {
  FINANCIAL_CLASSES,
  FULFILLMENT_CLASSES,
  FINANCIAL_LABELS,
  FULFILLMENT_LABELS,
  orderPaymentBadges,
} from "~/lib/order-status";
import { ChannelBadge } from "~/components/app/channel-badge";
import { orderSourceLabel } from "~/lib/order-source";
import type { Order, ChannelPlatform } from "~/types/api";
import {
  describeOrderShopifySync,
  orderShopifySyncOf,
  shopifySyncActionLabel,
  type OrderSyncAction,
} from "~/lib/shopify-sync";

type OrderRow = Pick<
  Order,
  "id" | "name" | "financialStatus" | "fulfillmentStatus" | "currency" | "totalPrice" | "itemCount" | "createdAt" | "customer"
> &
  // The dashboard's `DashboardRecentOrder` carries neither of these, so they are
  // optional here rather than required — the compact variant degrades to no
  // channel line, and the sync menu item simply does not render.
  Partial<Pick<Order, "channel" | "metadata" | "shopifySync" | "sourceName" | "sourceLabel" | "cashOnDelivery" | "tags">>;

function customerOf(order: OrderRow) {
  const first = order.customer?.firstName?.trim() ?? "";
  const last = order.customer?.lastName?.trim() ?? "";
  const name = `${first} ${last}`.trim();
  const initials = `${first.charAt(0)}${last.charAt(0)}`.toUpperCase();
  return { name: name || "Guest", initials: initials || "G" };
}

interface OrdersTableProps {
  orders: OrderRow[];
  /**
   * Fallback only — every row renders in its own `order.currency`. A store
   * selling in USD inside an INR workspace must not get rupee signs stamped
   * on its orders, which is what passing the org currency here used to do.
   */
  currency: string;
  onViewDetail?: (orderId: string) => void;
}

/**
 * The dashboard's compact "recent orders" widget: avatar, name and order
 * number, both status pills, amount. The orders LIST page renders through the
 * shared DataTable with the column definitions below instead.
 */
export function OrdersTable({ orders, currency, onViewDetail }: OrdersTableProps) {
  const navigate = useNavigate();

  return (
    <>
    <div className="divide-y divide-border/60 md:hidden">
      {orders.map((order) => (
        <button
          key={order.id}
          type="button"
          onClick={() => onViewDetail ? onViewDetail(order.id) : navigate(`/orders/${order.id}`)}
          className="flex w-full items-start gap-3 px-1 py-4 text-left active:bg-muted/50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
        >
          <div className="min-w-0 flex-1"><OrderMobileSummary order={order} currency={currency} /></div>
          <ChevronRight aria-hidden className="mt-1 size-4 shrink-0 text-muted-foreground/60" />
        </button>
      ))}
    </div>
    <div className="hidden md:block">
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>Order</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">Amount</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {orders.map((order) => {
          const platform = order.channel?.platform as ChannelPlatform | undefined;
          const { name, initials } = customerOf(order);

          return (
            <TableRow
              key={order.id}
              className="cursor-pointer"
              onClick={(event) => {
                // The order link in the first cell navigates by itself.
                if ((event.target as HTMLElement).closest("a")) return;
                if (onViewDetail) onViewDetail(order.id);
                else navigate(`/orders/${order.id}`);
              }}
            >
              <TableCell>
                <div className="flex items-center gap-3">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-brand text-caption font-semibold text-brand-foreground">
                    {initials}
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-caption font-semibold text-foreground">
                      <Link to={`/orders/${order.id}`} className="hover:underline">
                        {name}
                        <span className="font-normal text-muted-foreground"> · {order.name}</span>
                      </Link>
                    </p>
                    <p className="flex items-center gap-1 text-micro text-muted-foreground">
                      <ChannelBadge platform={platform} name={orderSourceLabel(order)} /> · {order.itemCount} item
                      {order.itemCount !== 1 ? "s" : ""} · {formatDayMonth(order.createdAt)}
                    </p>
                  </div>
                </div>
              </TableCell>

              <TableCell>
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-micro font-medium", FINANCIAL_CLASSES[order.financialStatus])}>
                    {FINANCIAL_LABELS[order.financialStatus]}
                  </span>
                  <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-micro font-medium", FULFILLMENT_CLASSES[order.fulfillmentStatus])}>
                    {FULFILLMENT_LABELS[order.fulfillmentStatus]}
                  </span>
                </div>
              </TableCell>

              <TableCell className="text-right text-caption font-semibold tabular-nums text-foreground">
                {formatCurrency(order.totalPrice, order.currency || currency)}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
    </div>
    </>
  );
}

/** An order as a three-line phone card: number and total, who and when, then its statuses. */
export function OrderMobileSummary({ order, currency }: { order: OrderRow; currency: string }) {
  const { name } = customerOf(order);
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <p className="min-w-0 truncate text-sm font-semibold text-foreground">{order.name}</p>
        <p className="shrink-0 text-sm font-semibold tabular-nums tracking-tight text-foreground">
          {formatCurrency(order.totalPrice, order.currency || currency)}
        </p>
      </div>
      <div className="flex min-w-0 items-center gap-1.5 text-caption text-muted-foreground">
        <span className="min-w-0 truncate">{name}</span>
        <span aria-hidden>·</span>
        <span className="shrink-0"><DateCell value={order.createdAt} /></span>
        <span aria-hidden>·</span>
        <span className="shrink-0">{order.itemCount} item{order.itemCount !== 1 ? "s" : ""}</span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
        {orderPaymentBadges(order).map((badge) => (
          <StatusPill key={badge.label} className="h-6 px-2.5" tone={badge.tone}>
            {badge.label}
          </StatusPill>
        ))}
        <StatusPill className={cn("h-6 px-2.5", FULFILLMENT_CLASSES[order.fulfillmentStatus])}>
          {FULFILLMENT_LABELS[order.fulfillmentStatus]}
        </StatusPill>
        {order.channel && (
          <ChannelBadge platform={order.channel.platform as ChannelPlatform} name={orderSourceLabel(order)} />
        )}
      </div>
    </div>
  );
}

/**
 * Column definitions for the orders list.
 *
 * Payment is a pill in words beside Fulfilment, so the day's triage (COD to
 * confirm, unpaid, not shipped) reads straight off the list, in the Packing
 * screen's words. It was a small tick beside paid order numbers, with nothing
 * at all on unpaid ones, which said nothing to a screen reader and little at
 * a glance. Shopify is last, so a Collabo-created order can be pushed from
 * the list without opening it.
 */
export function useOrderColumns({
  currency,
  showShopifyColumn,
  showPaymentColumn,
}: {
  /** Fallback only — every row renders in its own `order.currency`. */
  currency: string;
  /** The vendor projection of the list carries no payment status. */
  showPaymentColumn: boolean;
  /**
   * The vendor projection of the list carries neither `channel` nor the push
   * record, and a vendor cannot sync anyway, so the column would only ever
   * read "Unknown" for them.
   */
  showShopifyColumn: boolean;
}): ColumnDef<Order>[] {
  return useMemo(() => {
    const columns: ColumnDef<Order>[] = [
      {
        key: "order",
        label: "Order",
        width: 130,
        locked: true,
        sortKey: "orderNumber",
        sortType: "number",
        cell: (order) => <IdCell>{order.name}</IdCell>,
      },
      {
        key: "items",
        label: "Items",
        width: 110,
        // Icon box + "12 items" never fits the shrink floor.
        minWidth: 116,
        cell: (order) => (
          <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted">
              <Package className="size-3.5" />
            </span>
            <span className="truncate">
              {order.itemCount} item{order.itemCount !== 1 ? "s" : ""}
            </span>
          </span>
        ),
      },
      {
        key: "customer",
        label: "Customer",
        width: 180,
        cell: (order) => {
          const { name } = customerOf(order);
          return <TextCell muted={!order.customer}>{name}</TextCell>;
        },
      },
      {
        key: "date",
        label: "Date",
        width: 130,
        sortKey: "externalCreatedAt",
        sortType: "date",
        cell: (order) => <DateCell value={order.createdAt} />,
      },
      {
        key: "amount",
        label: "Amount",
        width: 120,
        align: "right",
        sortKey: "totalPrice",
        sortType: "number",
        cell: (order) => (
          <MoneyCell amount={order.totalPrice} currency={order.currency || currency} strong />
        ),
      },
      ...(showPaymentColumn
        ? [
          {
            key: "payment",
            label: "Payment",
            width: 150,
            cell: (order: Order) => (
              <span className="flex min-w-0 flex-wrap items-center gap-1">
                {orderPaymentBadges(order).map((badge) => (
                  <StatusBadge key={badge.label} tone={badge.tone}>
                    {badge.label}
                  </StatusBadge>
                ))}
              </span>
            ),
          },
        ]
        : []),
      {
        key: "fulfillment",
        label: "Fulfilment",
        width: 120,
        cell: (order) => (
          <StatusPill className={FULFILLMENT_CLASSES[order.fulfillmentStatus]}>
            {FULFILLMENT_LABELS[order.fulfillmentStatus]}
          </StatusPill>
        ),
      },
    ];
    if (showShopifyColumn) {
      columns.push({
        key: "shopify",
        label: "Shopify",
        width: 150,
        headerTooltip: (
          <span className="inline-flex items-center gap-1.5">
            <ShopifyIcon width={14} height={14} />
            Whether the order has been pushed to Shopify
          </span>
        ),
        cell: (order) => {
          const summary = describeOrderShopifySync(order);
          const shopifyOrderName = orderShopifySyncOf(order)?.shopifyOrderName;
          return (
            <ShopifySyncCell
              summary={summary}
              title={shopifyOrderName ? `Shopify order ${shopifyOrderName}` : undefined}
            />
          );
        },
      });
    }
    return columns;
  }, [currency, showShopifyColumn, showPaymentColumn]);
}

const SYNC_ACTION_LABEL: Record<OrderSyncAction, string> = {
  sync: "Sync",
  retry: "Retry",
};

/**
 * The right-hand cell of an order row: a Sync / Retry button when the order
 * has something to push, and the ⋯ menu.
 *
 * `canOperate` mirrors ORG_OPERATORS — the tier the sync route admits. A Viewer
 * or a Vendor gets no button rather than a "Failed to sync" toast. `canManage`
 * mirrors ORG_MANAGERS — the tier that may issue a GST invoice.
 */
export function OrderRowActions({
  order,
  canOperate,
  canManage,
  gstEnabled,
  showShopifyColumn,
  onViewDetail,
}: {
  order: Order;
  canOperate: boolean;
  canManage: boolean;
  gstEnabled: boolean;
  showShopifyColumn: boolean;
  onViewDetail: (orderId: string) => void;
}) {
  const navigate = useNavigate();
  // Not computed at all for a vendor, whose rows carry no channel and who gets
  // neither the column nor the button.
  const syncSummary = showShopifyColumn ? describeOrderShopifySync(order) : null;

  return (
    <>
      {canOperate && syncSummary?.action != null && (
        <OrderRowSyncButton order={order} action={syncSummary.action} />
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={`Actions for order ${order.name}`}>
            <MoreHorizontal className="text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => onViewDetail(order.id)}>View details</DropdownMenuItem>
          {/* Issuing an invoice is ORG_MANAGERS-only server-side, so this item
              only ever led somewhere useful for a manager. It navigates to the
              order, where the gated Generate button lives — there is no
              standalone create route. */}
          {gstEnabled && canManage && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => navigate(`/orders/${order.id}`)}>
                <Receipt className="mr-1.5 size-3.5" />
                Generate GST Invoice
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

/**
 * Per-row "Sync" / "Retry" button, labelled so the row reads "Not on Shopify
 * → Sync" and "Sync failed → Retry". Only a MANUAL order with something to push
 * gets one — `describeOrderShopifySync` decides, so the pill and the button
 * agree. Owns its own mutation hook so each row shows its own loading state.
 */
function OrderRowSyncButton({ order, action }: { order: Order; action: OrderSyncAction }) {
  const mutation = useSyncOrderMutation(order.id);
  return (
    <Button
      type="button"
      variant="outline"
      size="xs"
      title={shopifySyncActionLabel(orderShopifySyncOf(order))}
      disabled={mutation.isPending}
      onClick={() => mutation.mutate()}
      className="text-brand-strong"
    >
      {mutation.isPending ? (
        <Loader2 className="size-3 animate-spin" />
      ) : (
        <UploadCloud className="size-3" />
      )}
      {SYNC_ACTION_LABEL[action]}
    </Button>
  );
}
