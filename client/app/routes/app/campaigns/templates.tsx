import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";

import { PackTemplateDeleteDialog } from "~/components/app/campaigns/pack-template-delete-dialog";
import { TemplatePackCard } from "~/components/app/campaigns/template-pack-card";
import { ManagedBadge, QualityDot, TemplateCategoryLabel, TemplateStatusBadge } from "~/components/app/campaigns/template-status";
import { EmptyState } from "~/components/app/empty-state";
import { QueryErrorState } from "~/components/app/query-error-state";
import { SectionCard } from "~/components/app/section-card";
import { TableSkeleton } from "~/components/app/table-skeleton";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { PageHeader, PageHeaderActions, PageHeaderContent, PageHeaderDescription, PageHeaderTitle } from "~/components/ui/page-header";
import { useDeleteTemplateMutation, useSyncTemplatesMutation } from "~/hooks/use-campaign-mutations";
import { useTemplates } from "~/hooks/use-campaign-queries";
import { useCurrentRole } from "~/hooks/use-current-role";
import { useDebounced } from "~/hooks/use-debounced";
import { TEMPLATE_STATUS_LABEL, rejectionHelp } from "~/lib/campaign-format";
import { formatDateTime } from "~/lib/format-date";
import { cn } from "~/lib/utils";
import type { MessageTemplate } from "~/types/api";

export function meta() {
  return [{ title: "Templates | Collabo CRM" }];
}

const FILTERS = ["", "APPROVED", "PENDING", "REJECTED", "PAUSED"];

/** WhatsApp message templates on the connected number, as Meta last reported them. */
export default function TemplatesPage() {
  const navigate = useNavigate();
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const debounced = useDebounced(search);
  const { data, isLoading, isError, refetch, isPlaceholderData } = useTemplates({ status: status || undefined, search: debounced || undefined });
  const sync = useSyncTemplatesMutation();
  const remove = useDeleteTemplateMutation();
  const { can } = useCurrentRole();
  const canEdit = can("templates.manage");
  const [deletingManaged, setDeletingManaged] = useState<MessageTemplate | null>(null);

  return (
    <div className="space-y-6">
      <PageHeader>
        <PageHeaderContent>
          <PageHeaderTitle>Templates</PageHeaderTitle>
          <PageHeaderDescription>Messages Meta has approved for starting a conversation on WhatsApp.</PageHeaderDescription>
        </PageHeaderContent>
        <PageHeaderActions>
          {can("campaigns.manage") && (
            <Button variant="outline" size="sm" disabled={sync.isPending} onClick={() => sync.mutate()}>
              {sync.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              Sync from WhatsApp
            </Button>
          )}
          {canEdit && (
            <Button asChild variant="accent" size="sm">
              <Link to="/campaigns/templates/new">
                <Plus />
                New template
              </Link>
            </Button>
          )}
        </PageHeaderActions>
      </PageHeader>

      <TemplatePackCard />

      <SectionCard
        title="All templates"
        action={
          <div className="flex flex-wrap items-center gap-1.5">
            {FILTERS.map((f) => (
              <Button key={f || "all"} size="xs" variant={status === f ? "secondary" : "ghost"} onClick={() => setStatus(f)}>
                {f ? TEMPLATE_STATUS_LABEL[f] : "All"}
              </Button>
            ))}
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by name" className="h-7 w-44" aria-label="Search templates" />
          </div>
        }
      >
        {isError ? (
          <div className="p-5">
            <QueryErrorState resource="templates" onRetry={() => void refetch()} />
          </div>
        ) : isLoading ? (
          <TableSkeleton rows={5} columns={5} />
        ) : !data?.length ? (
          <div className="p-5">
            <EmptyState
              title={status || search ? "No templates match" : "No templates yet"}
              description={status || search ? "Try another filter." : "Sync the ones already on your WhatsApp account, or create one from a starter."}
              action={
                !status && !search && can("campaigns.manage") ? (
                  <Button variant="outline" size="sm" onClick={() => sync.mutate()} disabled={sync.isPending}>
                    <RefreshCw />
                    Sync from WhatsApp
                  </Button>
                ) : undefined
              }
            />
          </div>
        ) : (
          <div className={cn("divide-y transition-opacity", isPlaceholderData && "opacity-60")}>
            {data.map((t) => {
              const rejection = t.status === "REJECTED" && (t.rejectionInfo?.reason || t.rejectionInfo?.recommendation) ? t.rejectionInfo : null;
              return (
                <div
                  key={t.id}
                  role="link"
                  tabIndex={0}
                  onClick={() => navigate(`/campaigns/templates/${t.id}`)}
                  onKeyDown={(e) => e.key === "Enter" && navigate(`/campaigns/templates/${t.id}`)}
                  className="flex cursor-pointer flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 hover:bg-muted/50"
                >
                  <div className="min-w-0 basis-full md:basis-0 md:flex-1">
                    <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="min-w-0 truncate font-mono text-body font-medium">{t.name}</span>
                      {t.packSlot && <ManagedBadge />}
                    </p>
                    <p className="truncate text-caption text-muted-foreground">{t.preview.body}</p>
                  </div>
                  <TemplateCategoryLabel template={t} />
                  <span className="w-14 text-caption text-muted-foreground">{t.language}</span>
                  <span className="hidden w-24 md:inline-flex">
                    <QualityDot score={t.qualityScore} />
                  </span>
                  <div className="flex min-w-0 flex-col items-start gap-0.5 md:w-36">
                    <TemplateStatusBadge status={t.status} />
                    {t.statusReason && !rejection && <span className="max-w-full truncate text-micro text-danger" title={rejectionHelp(t.statusReason)}>{rejectionHelp(t.statusReason)}</span>}
                  </div>
                  <span className="hidden w-32 text-caption text-muted-foreground lg:inline">{formatDateTime(t.updatedAt)}</span>
                  {canEdit && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="ml-auto md:ml-0"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (t.packSlot) setDeletingManaged(t);
                        else if (window.confirm(`Delete ${t.name} (${t.language}) at Meta? Its name cannot be reused for 30 days.`)) remove.mutate(t.id);
                      }}
                      aria-label={`Delete ${t.name}`}
                    >
                      <Trash2 />
                    </Button>
                  )}
                  {rejection && (
                    <div className="basis-full space-y-0.5 rounded-lg bg-danger-subtle px-3 py-2 text-caption">
                      {rejection.reason && <p className="text-danger">Meta’s reason: {rejection.reason}</p>}
                      {rejection.recommendation && <p className="text-foreground">Meta recommends: {rejection.recommendation}</p>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </SectionCard>

      <PackTemplateDeleteDialog template={deletingManaged} onOpenChange={(open) => !open && setDeletingManaged(null)} />
    </div>
  );
}
