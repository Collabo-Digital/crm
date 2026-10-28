import { useMemo } from "react";
import { useNavigate } from "react-router";
import {
  PageHeader,
  PageHeaderContent,
  PageHeaderTitle,
  PageHeaderDescription,
} from "~/components/ui/page-header";
import { Separator } from "~/components/ui/separator";
import { Skeleton } from "~/components/ui/skeleton";
import { STAT_STRIP, StatCard } from "~/components/app/stat-card";
import {
  ChannelCell,
  DataTable,
  DateCell,
  MoneyCell,
  MonoCell,
  NumCell,
  PersonCell,
  StatusPill,
  useDataTableState,
  type ColumnDef,
} from "~/components/app/data-table";
import { useListUrlState } from "~/hooks/use-list-url-state";
import { useCustomers, useCustomerStats } from "~/hooks/use-customer-queries";
import { useCurrentOrg } from "~/hooks/use-org-queries";
import { cn, formatCurrency } from "~/lib/utils";
import { VIP_CLASSES, VIP_LABELS, VIP_ORDER } from "~/lib/customer-status";
import type {
  Customer,
  VipLevel,
  CustomerListParams,
  CustomerStatsResponse,
  ChangeDirection,
} from "~/types/api";

export function meta() {
  return [{ title: "Customers | Collabo CRM" }];
}

const VIP_TAB_VALUES: ReadonlyArray<"all" | VipLevel> = ["all", ...VIP_ORDER];

function getInitials(first: string | null | undefined, last: string | null | undefined) {
  const initials = `${first?.[0] ?? ""}${last?.[0] ?? ""}`.toUpperCase();
  return initials || "?";
}

function nameOf(customer: Customer): string {
  return (
    [customer.firstName, customer.lastName].filter(Boolean).join(" ") || customer.email || "—"
  );
}

/** A "down" direction is stored as a positive percentage — sign it for the badge. */
function signedChange(change: { percentage: number; direction: ChangeDirection }): number {
  return change.direction === "down" ? -change.percentage : change.percentage;
}

/**
 * Orders keys its equivalent array straight off `OrderStatsResponse` because all
 * four of its metrics share the `StatMetric` shape. `CustomerStatsResponse` is
 * heterogeneous — three plain numbers plus one `NewCustomersMetric` — so each
 * card resolves its own value instead.
 */
const STAT_CARDS: ReadonlyArray<{
  key: string;
  label: string;
  value: (stats: CustomerStatsResponse, currency: string) => string;
  /**
   * Omitted on every card but "New This Month". `StatCard` treats `change >= 0`
   * as positive, so passing 0 for a metric with no comparison period renders a
   * green up-trend badge — a failed request came out looking like four healthy
   * metrics.
   */
  change?: (stats: CustomerStatsResponse) => number;
  changeLabel?: string;
}> = [
  { key: "total", label: "Total Customers", value: (stats) => stats.totalCustomers.toLocaleString() },
  { key: "active", label: "Active Customers", value: (stats) => stats.activeCustomers.toLocaleString() },
  {
    key: "new",
    label: "New This Month",
    value: (stats) => stats.newCustomers.current.toLocaleString(),
    change: (stats) => signedChange(stats.newCustomers.change),
    changeLabel: "vs last month",
  },
  {
    key: "aov",
    label: "Avg. Order Value",
    value: (stats, currency) => formatCurrency(stats.averageOrderValue, currency),
  },
];

export default function CustomersPage() {
  // The whole view — page, search, VIP tab, sort, page size — lives in the
  // URL so Back from a customer returns to the exact list it was opened from.
  const list = useListUrlState("customers");
  const navigate = useNavigate();

  const { data: org } = useCurrentOrg();
  const gstEnabled = org?.gstEnabled ?? false;
  const orgCurrency = org?.currency ?? "USD";

  const columns = useMemo<ColumnDef<Customer>[]>(
    () => [
      {
        key: "customer",
        label: "Customer",
        width: 250,
        locked: true,
        sortKey: "firstName",
        sortType: "text",
        cell: (customer) => (
          <PersonCell
            name={nameOf(customer)}
            sub={customer.email}
            initials={getInitials(customer.firstName, customer.lastName)}
            title={`${nameOf(customer)}\n${customer.email ?? ""}`}
          />
        ),
      },
      {
        key: "channel",
        label: "Channel",
        width: 130,
        cell: (customer) => (
          <ChannelCell platform={customer.channel?.platform} name={customer.channel?.name} />
        ),
      },
      {
        key: "orders",
        label: "Orders",
        width: 90,
        align: "right",
        sortKey: "ordersCount",
        sortType: "number",
        cell: (customer) => <NumCell value={customer.ordersCount} strong />,
      },
      {
        key: "spent",
        label: "Total spent",
        width: 130,
        align: "right",
        sortKey: "totalSpent",
        sortType: "number",
        cell: (customer) => <MoneyCell amount={customer.totalSpent} currency={orgCurrency} strong />,
      },
      ...(gstEnabled
        ? [
            {
              key: "gstin",
              label: "GSTIN",
              width: 170,
              cell: (customer: Customer) => <MonoCell value={customer.gstin} />,
            } satisfies ColumnDef<Customer>,
          ]
        : []),
      {
        key: "vip",
        label: "VIP level",
        width: 110,
        sortKey: "vipLevel",
        sortType: "text",
        cell: (customer) => (
          <StatusPill className={VIP_CLASSES[customer.vipLevel]}>
            {VIP_LABELS[customer.vipLevel]}
          </StatusPill>
        ),
      },
      {
        key: "joined",
        label: "Joined",
        width: 120,
        hiddenByDefault: true,
        sortKey: "createdAt",
        sortType: "date",
        cell: (customer) => <DateCell value={customer.createdAt} />,
      },
    ],
    [gstEnabled, orgCurrency],
  );

  const table = useDataTableState({
    key: "customers",
    list,
    columns,
    tab: { param: "vip", default: "all", values: VIP_TAB_VALUES },
    sort: { default: { field: "createdAt", dir: "desc" } },
  });

  const params: CustomerListParams = {
    page: table.page,
    limit: table.limit,
    search: table.debouncedSearch || undefined,
    vipLevel: table.tab !== "all" ? (table.tab as VipLevel) : undefined,
    sortBy: table.sort?.field,
    sortOrder: table.sort?.dir,
  };

  const { data, isLoading, isError, isPlaceholderData, refetch } = useCustomers(params);
  const { data: stats, isLoading: statsLoading } = useCustomerStats();

  return (
    <div className="space-y-6">
      {/* Page header */}
      <PageHeader>
        <PageHeaderContent>
          <PageHeaderTitle>Customers</PageHeaderTitle>
          <PageHeaderDescription>
            View and manage your customer database, segments, and activity.
          </PageHeaderDescription>
        </PageHeaderContent>
      </PageHeader>

      {/* Stat cards */}
      <div className={cn("grid grid-cols-1 gap-5 rounded-xl bg-card p-3 sm:grid-cols-2 lg:grid-cols-4", STAT_STRIP)}>
        {statsLoading ? (
          Array.from({ length: STAT_CARDS.length }).map((_, i) => (
            <div key={i} className="p-5">
              <Skeleton className="h-3 w-24 mb-4" />
              <Skeleton className="h-7 w-20" />
            </div>
          ))
        ) : stats ? (
          STAT_CARDS.map(({ key, label, value, change, changeLabel }, i, arr) => (
            <div key={key} className="flex items-center gap-4">
              <StatCard
                variant="inline"
                label={label}
                value={value(stats, orgCurrency)}
                change={change?.(stats)}
                changeLabel={changeLabel}
                className="flex-1"
              />
              {i < arr.length - 1 && (
                <Separator orientation="vertical" className="hidden md:block h-15" />
              )}
            </div>
          ))
        ) : (
          /* No `change` on this branch — see the STAT_CARDS comment. */
          STAT_CARDS.map(({ key, label }) => (
            <StatCard key={key} variant="inline" label={label} value="—" />
          ))
        )}
      </div>

      <DataTable
        state={table}
        rows={data?.data ?? []}
        rowKey={(customer) => customer.id}
        meta={data?.meta}
        status={{ isLoading, isError, isPlaceholderData, refetch }}
        noun="customers"
        tabs={{
          ariaLabel: "Filter by VIP level",
          items: VIP_TAB_VALUES.map((value) => ({
            value,
            label: value === "all" ? "All" : VIP_LABELS[value],
          })),
        }}
        searchPlaceholder="Search by name, email, or phone…"
        onRowClick={(customer) => navigate(`/orders/customers/${customer.id}`)}
        emptyState={{
          title: "No customers yet",
          description: "Customers will appear here once synced from your channels.",
        }}
      />
    </div>
  );
}
