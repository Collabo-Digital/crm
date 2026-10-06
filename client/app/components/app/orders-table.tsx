import { useNavigate } from "react-router";
import { Loader2, MoreHorizontal, Package, Receipt, UploadCloud } from "lucide-react";
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
import { cn, formatCurrency } from "~/lib/utils";
import { useSyncOrderMutation } from "~/hooks/use-order-mutations";
import {
  FINANCIAL_CLASSES,
  FULFILLMENT_CLASSES,
  FINANCIAL_LABELS,
  FULFILLMENT_LABELS,
} from "~/lib/order-status";
import { ChannelBadge } from "~/components/app/channel-badge";
import { orderSourceLabel } from "~/lib/order-source";
import { useCurrentRole } from "~/hooks/use-current-role";
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
  Partial<Pick<Order, "channel" | "metadata" | "shopifySync" | "sourceName" | "sourceLabel">>;


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
  showCustomerName?: boolean;
  onViewDetail?: (orderId: string) => void;
  gstEnabled?: boolean;
  variant?: "compact" | "default";
  /**
   * Row selection, for bulk actions. All three are optional and are read as a
   * set: omit them and the checkbox column does not render at all, so the
   * dashboard's compact usage and the vendor page are untouched.
   */
  selectedIds?: Set<string>;
  onToggleRow?: (orderId: string) => void;
  onToggleAll?: () => void;
}

/**
 * Select-all checkbox for the page of rows.
 *
 * `indeterminate` is a DOM property with no HTML attribute, so React cannot
 * set it declaratively — it has to be written through a ref.
 */
function SelectAllCheckbox({
  checked,
  indeterminate,
  onChange,
}: {
  checked: boolean;
  indeterminate: boolean;
  onChange: () => void;
}) {
  return (
    <input
      type="checkbox"
      className="accent-[#CEF17B]"
      checked={checked}
      ref={(el) => {
        if (el) el.indeterminate = indeterminate;
      }}
      onChange={onChange}
      aria-label="Select all orders on this page"
    />
  );
}

/** Renders a data table of orders with financial/fulfillment status badges and row-level actions.
 *  Row click navigates to /orders/:id. Cells with their own click handlers
 *  (checkbox, dropdown menu) stop propagation. */
export function OrdersTable({ orders, currency, showCustomerName = false, onViewDetail, gstEnabled = false, variant = "default", selectedIds, onToggleRow, onToggleAll }: OrdersTableProps) {
  // Mirrors ORG_MANAGERS — the tier that may issue a GST invoice.
  const { role } = useCurrentRole();
  const canManage = role === "OWNER" || role === "ADMIN" || role === "MANAGER";
  // Mirrors ORG_OPERATORS — the tier the sync route admits. A Viewer or a
  // Vendor gets no button rather than a "Failed to sync" toast.
  const canOperate = canManage || role === "AGENT";
  // The vendor projection of the list carries neither `channel` nor the push
  // record, and a vendor cannot sync anyway, so the column would only ever
  // read "Unknown" for them. It is not rendered at all.
  const showShopifyColumn = role !== "VENDOR";
  const navigate = useNavigate();

  const selectable = Boolean(selectedIds && onToggleRow);
  // Scoped to the rows currently on screen, not the whole result set — "select
  // all" cannot mean rows the user cannot see.
  const allOnPageSelected =
    orders.length > 0 && orders.every((o) => selectedIds?.has(o.id));
  const someOnPageSelected = orders.some((o) => selectedIds?.has(o.id));

  if (variant === "compact") {
    return (
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
                onClick={() =>
                  onViewDetail ? onViewDetail(order.id) : navigate(`/orders/${order.id}`)
                }
              >
                <TableCell>
                  <div className="flex items-center gap-3">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-brand text-caption font-semibold text-brand-foreground">
                      {initials}
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-caption font-semibold text-foreground">
                        {name}
                        <span className="font-normal text-muted-foreground"> · {order.name}</span>
                      </p>
                      <p className="flex items-center gap-1 text-micro text-muted-foreground">
                        <ChannelBadge platform={platform} name={orderSourceLabel(order)} /> · {order.itemCount} item
                        {order.itemCount !== 1 ? "s" : ""} ·{" "}
                        {new Date(order.createdAt).toLocaleDateString("en-US", {
                          month: "short",
                          day: "2-digit",
                        })}
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
    );
  }

  return (
    // NOTE: the row-level Sync-to-Shopify button is wired per-row below via
    // `OrderRowSyncButton` (so each row can own its own mutation hook).
    // Top-level hooks like `useSyncOrderMutation` are not called here.
    <Table>
      <TableHeader>
        {/* The checkbox column renders only when the caller passes selection
            props. It used to be uncontrolled inputs with no state and no bulk
            action behind them; it is now driven by the orders page, which
            feeds the batch package-slip print. */}
        <TableRow className="hover:bg-transparent">
          {selectable && (
            <TableHead className="w-10">
              {onToggleAll && (
                <SelectAllCheckbox
                  checked={allOnPageSelected}
                  indeterminate={someOnPageSelected && !allOnPageSelected}
                  onChange={onToggleAll}
                />
              )}
            </TableHead>
          )}
          <TableHead>Order</TableHead>
          <TableHead>Items</TableHead>
          {showCustomerName && <TableHead>Customer</TableHead>}
          <TableHead>Date</TableHead>
          <TableHead>Amount</TableHead>
          {/* The Payment column used to sit here. The paid tick beside the
              order name is the payment signal now; the column became the
              Shopify one so a Collabo-created order can be pushed from the
              list without opening it. */}
          <TableHead>Fulfillment</TableHead>
          {showShopifyColumn && (
            <TableHead>
              <span className="inline-flex items-center gap-1.5">
                <ShopifyIcon width={14} height={14} />
                Shopify
              </span>
            </TableHead>
          )}
          <TableHead className="text-right">Action</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {orders.map((order) => {
          // Once per row: the Shopify cell and the row's button both read it,
          // so they cannot disagree. Not computed at all for a vendor, whose
          // rows carry no channel and who gets neither the column nor the
          // button.
          const syncSummary = showShopifyColumn ? describeOrderShopifySync(order) : null;
          const shopifyOrderName = showShopifyColumn
            ? orderShopifySyncOf(order)?.shopifyOrderName
            : undefined;
          return (
          <TableRow
            key={order.id}
            className="cursor-pointer"
            onClick={() => {
              if (onViewDetail) {
                onViewDetail(order.id);
              } else {
                navigate(`/orders/${order.id}`);
              }
            }}
          >
            {selectable && (
              // stopPropagation so ticking a box does not also navigate to the
              // order, which the row's own onClick would otherwise do.
              <TableCell onClick={(e) => e.stopPropagation()}>
                <input
                  type="checkbox"
                  className="accent-[#CEF17B]"
                  checked={selectedIds!.has(order.id)}
                  onChange={() => onToggleRow!(order.id)}
                  aria-label={`Select order ${order.name}`}
                />
              </TableCell>
            )}
            <TableCell className="font-medium text-gray-900 dark:text-gray-100">
              {order.financialStatus === "PAID" && (
                <span className="mr-1.5 inline-block size-4 rounded-full bg-[#CEF17B]/30 text-[#084734] text-center text-[10px] leading-4">✓</span>
              )}
              {order.name}
            </TableCell>
            <TableCell>
              <div className="flex items-center gap-2">
                <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-gray-100 dark:bg-gray-800">
                  <Package className="size-4 text-muted-foreground" />
                </div>
                <span className="text-sm text-muted-foreground">
                  {order.itemCount} item{order.itemCount !== 1 ? "s" : ""}
                </span>
              </div>
            </TableCell>
            {showCustomerName && (
              <TableCell className="text-sm">
                {order.customer
                  ? `${order.customer.firstName ?? ""} ${order.customer.lastName ?? ""}`.trim() || "Guest"
                  : <span className="text-muted-foreground">Guest</span>}
              </TableCell>
            )}
            <TableCell className="text-sm text-muted-foreground">
              {new Date(order.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
            </TableCell>
            <TableCell className="text-sm font-medium">
              {formatCurrency(order.totalPrice, order.currency || currency)}
            </TableCell>
            <TableCell>
              <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium", FULFILLMENT_CLASSES[order.fulfillmentStatus])}>
                {FULFILLMENT_LABELS[order.fulfillmentStatus]}
              </span>
            </TableCell>
            {syncSummary && (
              <TableCell>
                <ShopifySyncCell
                  summary={syncSummary}
                  title={shopifyOrderName ? `Shopify order ${shopifyOrderName}` : undefined}
                />
              </TableCell>
            )}
            <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
              <div className="inline-flex items-center justify-end gap-1">
              {canOperate && syncSummary?.action != null && (
                <OrderRowSyncButton order={order} action={syncSummary.action} />
              )}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button className="flex size-7 items-center justify-center rounded-md hover:bg-gray-100 dark:hover:bg-gray-800">
                    <MoreHorizontal className="size-4 text-muted-foreground" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onClick={() => (onViewDetail ? onViewDetail(order.id) : navigate(`/orders/${order.id}`))}
                  >
                    View details
                  </DropdownMenuItem>
                  {/* Issuing an invoice is ORG_MANAGERS-only server-side, so
                      this item only ever led somewhere useful for a manager.
                      It navigates to the order, where the gated Generate button
                      lives — there is no standalone create route. */}
                  {gstEnabled && canManage && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onClick={() => navigate(`/orders/${order.id}`)}
                      >
                        <Receipt className="mr-1.5 size-3.5" />
                        Generate GST Invoice
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
              </div>
            </TableCell>
          </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

const SYNC_ACTION_LABEL: Record<OrderSyncAction, string> = {
  sync: "Sync",
  retry: "Retry",
};

/**
 * Per-row "Sync" / "Retry" button, labelled so the row reads "Not on Shopify
 * → Sync" and "Sync failed → Retry". It used to be an item inside the row's
 * dropdown, where nobody found it. Only a MANUAL order with something to push
 * gets one — `describeOrderShopifySync` decides, so the pill and the button
 * agree. Owns its own mutation hook so each row shows its own loading state.
 */
function OrderRowSyncButton({ order, action }: { order: OrderRow; action: OrderSyncAction }) {
  const mutation = useSyncOrderMutation(order.id);
  return (
    <Button
      type="button"
      variant="outline"
      size="xs"
      title={shopifySyncActionLabel(orderShopifySyncOf(order))}
      disabled={mutation.isPending}
      onClick={() => mutation.mutate()}
      className="text-[#084734] dark:text-[#CEF17B]"
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
