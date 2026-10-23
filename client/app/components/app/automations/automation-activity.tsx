import { useState } from "react";
import { Link } from "react-router";
import { ChevronRight, ExternalLink } from "lucide-react";

import { ChannelBadge } from "~/components/app/channel-badge";
import { QueryErrorState } from "~/components/app/query-error-state";
import { SectionCard } from "~/components/app/section-card";
import { TableSkeleton } from "~/components/app/table-skeleton";
import { Button } from "~/components/ui/button";
import { useAutomationRuns, useAutomationStats } from "~/hooks/use-automation-queries";
import { BLOCKS, RUN_STATUS_CLASS, RUN_STATUS_LABEL, SKIP_REASON_LABEL, findStep } from "~/lib/automation-blocks";
import { formatDateTime, formatRelativeTime } from "~/lib/format-date";
import { cn } from "~/lib/utils";
import type { AutomationRunRow, AutomationRunStatus, AutomationStep } from "~/types/api";

const FILTERS: Array<{ value: AutomationRunStatus | ""; label: string }> = [
  { value: "", label: "All" },
  { value: "WAITING", label: "Waiting" },
  { value: "COMPLETED", label: "Finished" },
  { value: "FAILED", label: "Stopped" },
  { value: "SKIPPED", label: "Skipped" },
];

const pct = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : "—");

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <p className="text-caption text-muted-foreground">{label}</p>
      <p className="text-section font-semibold tabular-nums">{value}</p>
      {sub && <p className="text-micro text-muted-foreground">{sub}</p>}
    </div>
  );
}

function RunRow({ run, steps }: { run: AutomationRunRow; steps: AutomationStep[] }) {
  const [open, setOpen] = useState(false);
  const waitingAt = run.status === "WAITING" && run.currentStepKey ? findStep(steps, run.currentStepKey) : null;
  return (
    <div>
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3 text-left hover:bg-muted/50" aria-expanded={open}>
        <ChevronRight className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate text-body font-medium">{run.contact?.name ?? "Unknown contact"}</span>
          {run.contact && <ChannelBadge platform={run.contact.platform} size={11} className="shrink-0 text-micro text-muted-foreground" />}
        </span>
        <span className="hidden min-w-0 max-w-xs truncate text-caption text-muted-foreground md:inline">
          {run.status === "SKIPPED"
            ? (SKIP_REASON_LABEL[run.skipReason ?? ""] ?? run.skipReason)
            : run.status === "FAILED"
              ? run.error
              : waitingAt
                ? `At “${BLOCKS[waitingAt.type].label}”${run.waitingForReply ? " for their reply" : ""}${run.resumeAt ? ` until ${formatDateTime(run.resumeAt)}` : ""}`
                : `${run.steps.length} step${run.steps.length === 1 ? "" : "s"}`}
        </span>
        <span className="w-24 text-right text-caption text-muted-foreground" title={formatDateTime(run.createdAt)}>
          {formatRelativeTime(run.createdAt)}
        </span>
        <span className={cn("rounded-full px-2 py-0.5 text-micro font-medium", RUN_STATUS_CLASS[run.status])}>{RUN_STATUS_LABEL[run.status]}</span>
      </button>
      {open && (
        <div className="space-y-1.5 bg-muted/30 px-5 pb-4 pl-12 pt-1">
          {run.steps.length === 0 && <p className="text-caption text-muted-foreground">{run.status === "SKIPPED" ? "Nothing ran." : "No steps yet."}</p>}
          {run.steps.map((s) => {
            const branch = typeof s.output?.branch === "string" ? s.output.branch : null;
            return (
              <div key={s.stepKey} className="flex flex-wrap items-baseline gap-x-2 text-caption">
                <span className={cn("size-1.5 shrink-0 translate-y-[-1px] rounded-full", s.status === "FAILED" ? "bg-danger" : s.status === "WAITING" ? "bg-brand" : "bg-success")} />
                <span className="font-medium">{BLOCKS[s.blockType]?.label ?? s.blockType}</span>
                {branch && <span className="text-muted-foreground">→ {branch.replace("_", " ")}</span>}
                {s.error && <span className="text-danger">{s.error}</span>}
                <span className="ml-auto text-micro text-muted-foreground">{formatDateTime(s.finishedAt ?? s.startedAt)}</span>
              </div>
            );
          })}
          {run.conversationId && (
            <Button asChild variant="link" size="xs" className="px-0">
              <Link to={`/inbox?c=${run.conversationId}`}>
                Open the conversation
                <ExternalLink />
              </Link>
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** How it is doing: totals, message delivery, and every run with what each step did. */
export function AutomationActivity({ automationId, steps, canOpenInbox }: { automationId: string; steps: AutomationStep[]; canOpenInbox: boolean }) {
  const { data: stats } = useAutomationStats(automationId);
  const [status, setStatus] = useState<AutomationRunStatus | "">("");
  const [page, setPage] = useState(1);
  const { data: runs, isLoading, isError, refetch } = useAutomationRuns(automationId, { page, ...(status ? { status } : {}) });
  const started = stats ? stats.total - stats.runs.SKIPPED : 0;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Tile label="Started" value={(started || 0).toLocaleString("en-IN")} sub={stats?.runs.SKIPPED ? `${stats.runs.SKIPPED} skipped` : undefined} />
        <Tile label="Finished" value={(stats?.runs.COMPLETED ?? 0).toLocaleString("en-IN")} sub={stats ? pct(stats.runs.COMPLETED, started) : undefined} />
        <Tile label="Waiting now" value={(stats?.runs.WAITING ?? 0).toLocaleString("en-IN")} />
        <Tile label="Stopped" value={(stats?.runs.FAILED ?? 0).toLocaleString("en-IN")} sub={stats?.runs.CANCELLED ? `${stats.runs.CANCELLED} cancelled` : undefined} />
        <Tile
          label="Messages sent"
          value={(stats?.messages.sent ?? 0).toLocaleString("en-IN")}
          sub={stats?.messages.sent ? `${pct(stats.messages.read, stats.messages.sent)} read${stats.messages.failed ? ` · ${stats.messages.failed} failed` : ""}` : undefined}
        />
      </div>

      <SectionCard
        title="Runs"
        description="One per person per trigger. Open one to see each step."
        action={
          <div className="flex rounded-lg bg-muted p-0.5" role="tablist" aria-label="Filter runs">
            {FILTERS.map((f) => (
              <button
                key={f.value}
                type="button"
                role="tab"
                aria-selected={status === f.value}
                onClick={() => {
                  setStatus(f.value);
                  setPage(1);
                }}
                className={cn("rounded-md px-2.5 py-1 text-caption font-medium", status === f.value ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground")}
              >
                {f.label}
              </button>
            ))}
          </div>
        }
      >
        {isError ? (
          <div className="p-5">
            <QueryErrorState resource="runs" onRetry={() => void refetch()} />
          </div>
        ) : isLoading ? (
          <TableSkeleton rows={4} columns={4} />
        ) : !runs?.data.length ? (
          <p className="px-5 py-8 text-center text-caption text-muted-foreground">No runs {status ? "like that " : ""}yet.</p>
        ) : (
          <>
            <div className="divide-y">
              {runs.data.map((r) => (
                <RunRow key={r.id} run={canOpenInbox ? r : { ...r, conversationId: null }} steps={steps} />
              ))}
            </div>
            {runs.meta.totalPages > 1 && (
              <div className="flex items-center justify-between border-t px-5 py-2 text-caption text-muted-foreground">
                <span>
                  Page {runs.meta.page} of {runs.meta.totalPages}
                </span>
                <div className="flex gap-1">
                  <Button variant="outline" size="xs" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                    Previous
                  </Button>
                  <Button variant="outline" size="xs" disabled={page >= runs.meta.totalPages} onClick={() => setPage(page + 1)}>
                    Next
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </SectionCard>
    </div>
  );
}
