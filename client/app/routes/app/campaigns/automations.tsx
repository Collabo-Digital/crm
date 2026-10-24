import { useState } from "react";
import { Link } from "react-router";
import { CircleAlert, FileSpreadsheet, MessagesSquare, Plus, Search, Workflow } from "lucide-react";

import { CreateAutomationDialog } from "~/components/app/automations/create-automation-dialog";
import { ChannelBadge } from "~/components/app/channel-badge";
import { EmptyState } from "~/components/app/empty-state";
import { QueryErrorState } from "~/components/app/query-error-state";
import { SectionCard } from "~/components/app/section-card";
import { TableSkeleton } from "~/components/app/table-skeleton";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { PageHeader, PageHeaderActions, PageHeaderContent, PageHeaderDescription, PageHeaderTitle } from "~/components/ui/page-header";
import { useAutomations } from "~/hooks/use-automation-queries";
import { useCurrentRole } from "~/hooks/use-current-role";
import { canEditAutomations } from "~/lib/permissions";
import { useDebounced } from "~/hooks/use-debounced";
import { AUTOMATION_STATUS_CLASS, AUTOMATION_STATUS_LABEL, CHANNEL_LABEL, PLAYBOOKS, type Playbook } from "~/lib/automation-blocks";
import { formatRelativeTime } from "~/lib/format-date";
import { cn } from "~/lib/utils";
import type { AutomationStatus } from "~/types/api";

export function meta() {
  return [{ title: "Automations | Collabo CRM" }];
}

const FILTERS: Array<{ value: AutomationStatus | ""; label: string }> = [
  { value: "", label: "All" },
  { value: "ACTIVE", label: "Live" },
  { value: "DRAFT", label: "Drafts" },
  { value: "PAUSED", label: "Paused" },
  { value: "ARCHIVED", label: "Archived" },
];

/** Every automation, how often it ran, and playbooks to start a new one from. */
export default function AutomationsPage() {
  const [status, setStatus] = useState<AutomationStatus | "">("");
  const [search, setSearch] = useState("");
  const debounced = useDebounced(search, 300);
  const { data, isLoading, isError, refetch } = useAutomations({ ...(status ? { status } : {}), ...(debounced.trim() ? { search: debounced.trim() } : {}) });
  const { role, permissions, isInfluencer } = useCurrentRole();
  const canManage = canEditAutomations(role, permissions);
  const [creating, setCreating] = useState<Playbook | null | "blank">(null);
  const rows = data?.data ?? [];

  return (
    <div className="space-y-6">
      <PageHeader>
        <PageHeaderContent>
          <PageHeaderTitle>Automations</PageHeaderTitle>
          <PageHeaderDescription>Answer comments, DMs and WhatsApp messages by themselves, follow up, tag and route — on every channel from one builder.</PageHeaderDescription>
        </PageHeaderContent>
        <PageHeaderActions>
          {!isInfluencer && (
            <Button asChild variant="outline" size="sm">
              <Link to="/campaigns/automations/starters">
                <MessagesSquare />
                Conversation starters
              </Link>
            </Button>
          )}
          {!isInfluencer && (
            <Button asChild variant="outline" size="sm">
              <Link to="/campaigns/automations/sheets">
                <FileSpreadsheet />
                Google Sheets
              </Link>
            </Button>
          )}
          {canManage && (
            <Button variant="accent" size="sm" onClick={() => setCreating("blank")}>
              <Plus />
              New automation
            </Button>
          )}
        </PageHeaderActions>
      </PageHeader>

      <SectionCard
        title="Your automations"
        action={
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex rounded-lg bg-muted p-0.5" role="tablist" aria-label="Filter by status">
              {FILTERS.map((f) => (
                <button
                  key={f.value}
                  type="button"
                  role="tab"
                  aria-selected={status === f.value}
                  onClick={() => setStatus(f.value)}
                  className={cn("rounded-md px-2.5 py-1 text-caption font-medium", status === f.value ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground")}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search" className="h-8 w-40 pl-7" aria-label="Search automations" />
            </div>
          </div>
        }
      >
        {isError ? (
          <div className="p-5">
            <QueryErrorState resource="automations" onRetry={() => void refetch()} />
          </div>
        ) : isLoading ? (
          <TableSkeleton rows={3} columns={4} />
        ) : rows.length === 0 ? (
          <div className="p-8">
            <EmptyState
              icon={Workflow}
              title={status || debounced ? "Nothing matches" : "No automations yet"}
              description={status || debounced ? "Try another filter." : "Start from a playbook below, or build one from scratch."}
            />
          </div>
        ) : (
          <div className="divide-y">
            {rows.map((a) => (
              <Link key={a.id} to={`/campaigns/automations/${a.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 hover:bg-muted/50">
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 truncate text-body font-medium">
                    {a.name}
                    {a.lastError && a.status === "ACTIVE" && <CircleAlert className="size-3.5 shrink-0 text-danger" aria-label="Last run stopped" />}
                  </p>
                  <p className="mt-0.5 flex items-center gap-2 truncate text-caption text-muted-foreground">
                    <ChannelBadge platform={a.channel?.platform ?? a.platform} name={a.channel?.name} size={11} />
                    {a.version > 0 && <span>v{a.version}</span>}
                  </p>
                </div>
                <span className="w-24 text-right text-caption tabular-nums text-muted-foreground">
                  {a.triggeredCount.toLocaleString("en-IN")} run{a.triggeredCount === 1 ? "" : "s"}
                </span>
                <span className="hidden w-28 text-caption text-muted-foreground sm:inline">{a.lastTriggeredAt ? `Last ${formatRelativeTime(a.lastTriggeredAt)}` : "Not run yet"}</span>
                <span className={cn("rounded-full px-2 py-0.5 text-micro font-medium", AUTOMATION_STATUS_CLASS[a.status])}>{AUTOMATION_STATUS_LABEL[a.status]}</span>
              </Link>
            ))}
          </div>
        )}
      </SectionCard>

      {canManage && (
        <SectionCard title="Start from a playbook" description="Each opens as a draft with our suggested wording, to adjust before you publish.">
          <div className="grid gap-3 p-5 sm:grid-cols-2 lg:grid-cols-3">
            {PLAYBOOKS.filter((p) => !isInfluencer || p.channels.includes("instagram")).map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => setCreating(p)}
                className="flex flex-col items-start gap-1.5 rounded-xl border bg-card p-4 text-left outline-none transition-colors hover:border-brand hover:bg-brand/5 focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <span className="text-body font-semibold">{p.name}</span>
                <span className="text-caption text-muted-foreground">{p.description}</span>
                <span className="mt-auto pt-1 text-micro text-muted-foreground">{p.channels.map((c) => CHANNEL_LABEL[c]).join(" · ")}</span>
              </button>
            ))}
          </div>
        </SectionCard>
      )}

      {creating && <CreateAutomationDialog playbook={creating === "blank" ? null : creating} onClose={() => setCreating(null)} />}
    </div>
  );
}
