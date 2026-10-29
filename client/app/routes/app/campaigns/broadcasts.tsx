import { useMemo } from "react";
import { Link, useNavigate } from "react-router";
import { Plus } from "lucide-react";

import { DataTable, DateCell, NumCell, StatusPill, TextCell, useDataTableState, type ColumnDef } from "~/components/app/data-table";
import { Button } from "~/components/ui/button";
import { PageHeader, PageHeaderActions, PageHeaderContent, PageHeaderDescription, PageHeaderTitle } from "~/components/ui/page-header";
import { useBroadcasts } from "~/hooks/use-campaign-queries";
import { useCurrentRole } from "~/hooks/use-current-role";
import { useListUrlState } from "~/hooks/use-list-url-state";
import { BROADCAST_STATUS_CLASS, BROADCAST_STATUS_LABEL } from "~/lib/campaign-format";
import type { Broadcast, BroadcastStatus } from "~/types/api";

export function meta() {
  return [{ title: "Broadcasts | Collabo CRM" }];
}

const TABS: ReadonlyArray<"all" | BroadcastStatus> = ["all", "DRAFT", "SCHEDULED", "SENDING", "COMPLETED"];

const rate = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : "—");

/** Every WhatsApp broadcast, newest first, with how far each got. */
export default function BroadcastsPage() {
  const list = useListUrlState("broadcasts");
  const navigate = useNavigate();
  const { can } = useCurrentRole();

  const columns = useMemo<ColumnDef<Broadcast>[]>(
    () => [
      {
        key: "name",
        label: "Broadcast",
        width: 240,
        locked: true,
        cell: (b) => (
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-medium text-foreground">{b.name}</span>
            <span className="truncate text-caption text-muted-foreground">{[b.campaign, b.templateName].filter(Boolean).join(" · ") || "No template yet"}</span>
          </span>
        ),
      },
      {
        key: "status",
        label: "Status",
        width: 110,
        cell: (b) => <StatusPill className={BROADCAST_STATUS_CLASS[b.status]}>{BROADCAST_STATUS_LABEL[b.status]}</StatusPill>,
      },
      { key: "audience", label: "Audience", width: 100, align: "right", cell: (b) => <NumCell value={b.stats.total} /> },
      { key: "sent", label: "Sent", width: 90, align: "right", cell: (b) => <NumCell value={b.stats.sent} strong /> },
      { key: "delivered", label: "Delivered", width: 100, align: "right", cell: (b) => <TextCell muted>{rate(b.stats.delivered, b.stats.sent)}</TextCell> },
      { key: "read", label: "Read", width: 90, align: "right", cell: (b) => <TextCell muted>{rate(b.stats.read, b.stats.sent)}</TextCell> },
      { key: "replied", label: "Replied", width: 90, align: "right", cell: (b) => <NumCell value={b.stats.replied} /> },
      { key: "failed", label: "Failed", width: 80, align: "right", cell: (b) => <NumCell value={b.stats.failed} /> },
      { key: "when", label: "Date", width: 130, cell: (b) => <DateCell value={b.startedAt ?? b.scheduledAt ?? b.createdAt} /> },
    ],
    [],
  );

  const table = useDataTableState({
    key: "broadcasts",
    list,
    columns,
    tab: { param: "status", default: "all", values: TABS },
  });

  const { data, isLoading, isError, isPlaceholderData, refetch } = useBroadcasts({
    page: table.page,
    limit: table.limit,
    search: table.debouncedSearch || undefined,
    status: table.tab !== "all" ? (table.tab as BroadcastStatus) : undefined,
  });

  return (
    <div className="space-y-6">
      <PageHeader>
        <PageHeaderContent>
          <PageHeaderTitle>Broadcasts</PageHeaderTitle>
          <PageHeaderDescription>One approved template, sent to an audience on WhatsApp.</PageHeaderDescription>
        </PageHeaderContent>
        {can("campaigns.manage") && (
          <PageHeaderActions>
            <Button asChild variant="accent" size="sm">
              <Link to="/campaigns/broadcasts/new">
                <Plus />
                New broadcast
              </Link>
            </Button>
          </PageHeaderActions>
        )}
      </PageHeader>

      <DataTable
        state={table}
        rows={data?.data ?? []}
        rowKey={(b) => b.id}
        meta={data?.meta}
        status={{ isLoading, isError, isPlaceholderData, refetch }}
        noun="broadcasts"
        tabs={{
          ariaLabel: "Filter by status",
          items: TABS.map((value) => ({ value, label: value === "all" ? "All" : BROADCAST_STATUS_LABEL[value] })),
        }}
        searchPlaceholder="Search by name or campaign…"
        onRowClick={(b) => navigate(`/campaigns/broadcasts/${b.id}`)}
        emptyState={{ title: "No broadcasts yet", description: "Send an approved template to a segment of your WhatsApp contacts." }}
      />
    </div>
  );
}
