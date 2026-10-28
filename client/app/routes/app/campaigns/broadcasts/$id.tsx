import { useMemo } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ArrowLeft, Copy, RotateCcw, Trash2, XCircle } from "lucide-react";

import { BroadcastComposer } from "~/components/app/campaigns/broadcast-composer";
import { DeliveryFunnel } from "~/components/app/campaigns/delivery-funnel";
import { TemplatePreview } from "~/components/app/campaigns/template-preview";
import { DataTable, DateCell, PersonCell, StatusPill, TextCell, useDataTableState, type ColumnDef } from "~/components/app/data-table";
import { QueryErrorState } from "~/components/app/query-error-state";
import { SectionCard } from "~/components/app/section-card";
import { Button } from "~/components/ui/button";
import { PageHeader, PageHeaderActions, PageHeaderContent, PageHeaderDescription, PageHeaderTitle } from "~/components/ui/page-header";
import { Skeleton } from "~/components/ui/skeleton";
import {
  useCancelBroadcastMutation,
  useDeleteBroadcastMutation,
  useDuplicateBroadcastMutation,
  useRetryBroadcastMutation,
} from "~/hooks/use-campaign-mutations";
import { useBroadcast, useBroadcastRecipients } from "~/hooks/use-campaign-queries";
import { useCurrentRole } from "~/hooks/use-current-role";
import { useListUrlState } from "~/hooks/use-list-url-state";
import { BROADCAST_STATUS_CLASS, BROADCAST_STATUS_LABEL, RECIPIENT_STATUS_CLASS, RECIPIENT_STATUS_LABEL, renderBroadcast } from "~/lib/campaign-format";
import { formatDateTime } from "~/lib/format-date";
import { getInitials } from "~/lib/inbox-format";
import { cn } from "~/lib/utils";
import type { BroadcastDetail, BroadcastRecipientRow, BroadcastRecipientStatus } from "~/types/api";
import { pageTitle } from "~/lib/page-title";

export function meta() {
  return [{ title: "Broadcast | Collabo CRM" }];
}

const RECIPIENT_TABS: ReadonlyArray<"all" | BroadcastRecipientStatus> = ["all", "READ", "DELIVERED", "SENT", "FAILED", "SKIPPED"];

function Recipients({ broadcast }: { broadcast: BroadcastDetail }) {
  const list = useListUrlState("broadcast-recipients");
  const navigate = useNavigate();
  const columns = useMemo<ColumnDef<BroadcastRecipientRow>[]>(
    () => [
      {
        key: "contact",
        label: "Recipient",
        width: 220,
        locked: true,
        cell: (r) => <PersonCell name={r.contact.name} sub={r.contact.phone} initials={getInitials(r.contact.name)} />,
      },
      { key: "status", label: "Status", width: 110, cell: (r) => <StatusPill className={RECIPIENT_STATUS_CLASS[r.status]}>{RECIPIENT_STATUS_LABEL[r.status]}</StatusPill> },
      {
        key: "detail",
        label: "Detail",
        width: 260,
        cell: (r) => (
          <TextCell muted title={r.errorMessage ?? r.skipLabel ?? undefined}>
            {r.status === "FAILED"
              ? `${r.errorMessage ?? "Failed"}${r.errorCode ? ` (${r.errorCode})` : ""}`
              : r.status === "SKIPPED"
                ? r.skipLabel ?? r.skipReason
                : [r.repliedAt && "Replied", r.clickedAt && "Tapped a button"].filter(Boolean).join(" · ") || "—"}
          </TextCell>
        ),
      },
      { key: "sent", label: "Sent", width: 130, cell: (r) => <DateCell value={r.sentAt} time /> },
      { key: "read", label: "Read", width: 130, cell: (r) => <DateCell value={r.readAt} time /> },
    ],
    [],
  );
  const table = useDataTableState({ key: "broadcast-recipients", list, columns, tab: { param: "who", default: "all", values: RECIPIENT_TABS } });
  const { data, isLoading, isError, isPlaceholderData, refetch } = useBroadcastRecipients(broadcast.id, {
    page: table.page,
    limit: table.limit,
    status: table.tab !== "all" ? (table.tab as BroadcastRecipientStatus) : undefined,
  });
  return (
    <DataTable
      state={table}
      rows={data?.data ?? []}
      rowKey={(r) => r.id}
      meta={data?.meta}
      status={{ isLoading, isError, isPlaceholderData, refetch }}
      noun="recipients"
      searchable={false}
      tabs={{
        ariaLabel: "Filter recipients",
        items: RECIPIENT_TABS.map((value) => ({
          value,
          label: value === "all" ? "All" : RECIPIENT_STATUS_LABEL[value],
          count: value === "all" ? broadcast.stats.total : broadcast.stats.byStatus[value] ?? 0,
        })),
      }}
      onRowClick={(r) => r.contact.conversationId && navigate(`/inbox?c=${r.contact.conversationId}`)}
      emptyState={{ title: "Nobody yet", description: "Recipients appear here once sending starts." }}
    />
  );
}

/** One broadcast: the composer while it is a draft, its results after. */
export default function BroadcastPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data: broadcast, isLoading, isError, refetch } = useBroadcast(id);
  const { can } = useCurrentRole();
  const duplicate = useDuplicateBroadcastMutation();
  const remove = useDeleteBroadcastMutation();
  const cancel = useCancelBroadcastMutation(id ?? "");
  const retry = useRetryBroadcastMutation(id ?? "");

  if (isError) return <QueryErrorState resource="this broadcast" onRetry={() => void refetch()} />;
  if (isLoading || !broadcast) return <Skeleton className="h-96 w-full rounded-xl" />;

  const isDraft = broadcast.status === "DRAFT";
  const canSend = can("broadcasts.send");
  const canManage = can("campaigns.manage");

  return (
    <div className="space-y-6">
      <Link to="/campaigns/broadcasts" className="inline-flex items-center gap-1 text-caption text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-3.5" />
        Broadcasts
      </Link>
      <PageHeader data-mobile-title>
        <PageHeaderContent>
          <title>{pageTitle(broadcast.name, "Broadcast")}</title>
          <PageHeaderTitle className="flex flex-wrap items-center gap-3">
            {broadcast.name}
            <span className={cn("rounded-full px-2 py-0.5 text-caption font-semibold", BROADCAST_STATUS_CLASS[broadcast.status])}>{BROADCAST_STATUS_LABEL[broadcast.status]}</span>
          </PageHeaderTitle>
          <PageHeaderDescription>
            {isDraft
              ? "Draft — saved as you go."
              : broadcast.status === "SCHEDULED"
                ? `Goes out ${formatDateTime(broadcast.scheduledAt)}.`
                : [broadcast.campaign, broadcast.templateName, broadcast.startedAt && `Started ${formatDateTime(broadcast.startedAt)}`].filter(Boolean).join(" · ")}
            {broadcast.failureReason && ` ${broadcast.failureReason}`}
          </PageHeaderDescription>
        </PageHeaderContent>
        <PageHeaderActions>
          {canManage && !isDraft && (
            <Button variant="outline" size="sm" disabled={duplicate.isPending} onClick={() => duplicate.mutate(broadcast.id, { onSuccess: (b) => navigate(`/campaigns/broadcasts/${b.id}`) })}>
              <Copy />
              Duplicate
            </Button>
          )}
          {canSend && (broadcast.status === "SCHEDULED" || broadcast.status === "SENDING") && (
            <Button
              variant="outline"
              size="sm"
              disabled={cancel.isPending}
              onClick={() =>
                window.confirm(broadcast.status === "SENDING" ? "Stop sending? Messages not yet sent are cancelled; the few being sent right now may still arrive." : "Cancel the schedule?") &&
                cancel.mutate()
              }
            >
              <XCircle />
              {broadcast.status === "SENDING" ? "Stop" : "Cancel schedule"}
            </Button>
          )}
          {canSend && (broadcast.status === "COMPLETED" || broadcast.status === "CANCELLED" || broadcast.status === "FAILED") && broadcast.stats.failed > 0 && (
            <Button variant="outline" size="sm" disabled={retry.isPending} onClick={() => retry.mutate()}>
              <RotateCcw />
              Retry failed
            </Button>
          )}
          {canManage && isDraft && (
            <Button
              variant="ghost"
              size="sm"
              disabled={remove.isPending}
              onClick={() => window.confirm("Delete this draft?") && remove.mutate(broadcast.id, { onSuccess: () => navigate("/campaigns/broadcasts") })}
            >
              <Trash2 />
              Delete draft
            </Button>
          )}
        </PageHeaderActions>
      </PageHeader>

      {isDraft ? (
        canManage ? (
          <BroadcastComposer broadcast={broadcast} />
        ) : (
          <p className="text-body text-muted-foreground">This draft is being prepared by your team.</p>
        )
      ) : (
        <>
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
            <SectionCard title="Delivery" description="Updates as WhatsApp reports back. Read receipts depend on each person’s privacy settings.">
              <div className="p-5">
                <DeliveryFunnel stats={broadcast.stats} />
              </div>
            </SectionCard>
            <SectionCard title="Message">
              <div className="p-5">
                {broadcast.template ? (
                  <TemplatePreview render={renderBroadcast(broadcast.template, broadcast.variables)} buttonKinds={broadcast.template.draft.buttons?.map((b) => b.type)} />
                ) : (
                  <p className="text-caption text-muted-foreground">{broadcast.templateName ?? "The template was deleted."}</p>
                )}
              </div>
            </SectionCard>
          </div>
          <Recipients broadcast={broadcast} />
        </>
      )}
    </div>
  );
}
