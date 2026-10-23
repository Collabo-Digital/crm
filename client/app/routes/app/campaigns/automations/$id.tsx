import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { Archive, ArrowLeft, CircleAlert, Copy, FlaskConical, Loader2, MoreHorizontal, Pause, Pencil, Play, Rocket } from "lucide-react";

import { AutomationActivity } from "~/components/app/automations/automation-activity";
import { FlowCanvas } from "~/components/app/automations/flow-canvas";
import { StepEditor, type EditorContext } from "~/components/app/automations/step-editor";
import { TestRunDialog } from "~/components/app/automations/test-run-dialog";
import { ChannelBadge } from "~/components/app/channel-badge";
import { SectionCard } from "~/components/app/section-card";
import { Button } from "~/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "~/components/ui/dropdown-menu";
import { Input } from "~/components/ui/input";
import { PageHeader, PageHeaderActions, PageHeaderContent, PageHeaderTitle } from "~/components/ui/page-header";
import { Skeleton } from "~/components/ui/skeleton";
import {
  useArchiveAutomationMutation,
  useAutomationLifecycleMutation,
  useDuplicateAutomationMutation,
  useRenameAutomationMutation,
} from "~/hooks/use-automation-mutations";
import { automationKeys, useAutomation, useAutomationStats } from "~/hooks/use-automation-queries";
import { useTemplates } from "~/hooks/use-campaign-queries";
import { useCurrentRole } from "~/hooks/use-current-role";
import { useContactTags, useInboxMembers, useInboxTeams } from "~/hooks/use-inbox-queries";
import { useSectionAccess } from "~/hooks/use-section-access";
import {
  AUTOMATION_STATUS_CLASS,
  AUTOMATION_STATUS_LABEL,
  MAX_STEPS,
  allSteps,
  channelKeyOf,
  countSteps,
  findStep,
  insertStep,
  moveStep,
  newStep,
  removeStep,
  updateStep,
} from "~/lib/automation-blocks";
import { formatDateTime } from "~/lib/format-date";
import { cn } from "~/lib/utils";
import { automationsService } from "~/services/automations.service";
import type { AutomationDetail, AutomationIssue, AutomationSettings, AutomationStep } from "~/types/api";

export function meta() {
  return [{ title: "Automation | Collabo CRM" }];
}

const ONCE: Array<[NonNullable<AutomationSettings["oncePerContact"]>, string, string]> = [
  ["ever", "Once", "Each person goes through it one time."],
  ["perDay", "Once a day", "At most one run per person in 24 hours."],
  ["never", "Every time", "Every matching message or comment starts it."],
];

/** The builder: the flow, the selected step's form, and how it has been running. */
export default function AutomationPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: detail, isLoading, isError } = useAutomation(id);
  const { can, isInfluencer } = useCurrentRole();
  const { canAccess } = useSectionAccess();
  const inbox = canAccess("/inbox") && !isInfluencer;
  const editor = can("campaigns.manage");
  const lifecycle = useAutomationLifecycleMutation();
  const duplicate = useDuplicateAutomationMutation();
  const archive = useArchiveAutomationMutation();
  const rename = useRenameAutomationMutation();
  const { data: tagRows = [] } = useContactTags(inbox);
  const { data: members = [] } = useInboxMembers(inbox);
  const { data: teams = [] } = useInboxTeams(inbox);
  const storeTools = !isInfluencer && editor;
  const { data: templates = [] } = useTemplates({ status: "APPROVED" }, storeTools && detail?.platform === "WHATSAPP");

  const [tab, setTab] = useState<"flow" | "activity">("flow");
  const [steps, setSteps] = useState<AutomationStep[]>([]);
  const [settings, setSettings] = useState<AutomationSettings>({ oncePerContact: "ever" });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "error">("saved");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [publishIssues, setPublishIssues] = useState<AutomationIssue[] | null>(null);
  const [testing, setTesting] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [name, setName] = useState("");
  const saved = useRef<string>("");
  const loadedFor = useRef<string | null>(null);

  // Load the draft once per automation; later refetches must not undo edits in progress.
  useEffect(() => {
    if (!detail || loadedFor.current === detail.id) return;
    loadedFor.current = detail.id;
    setSteps(detail.definition.steps);
    setSettings({ oncePerContact: detail.settings?.oncePerContact ?? "ever" });
    saved.current = JSON.stringify({ steps: detail.definition.steps, settings: { oncePerContact: detail.settings?.oncePerContact ?? "ever" } });
    setSelectedId(detail.definition.steps[0]?.id ?? null);
    setName(detail.name);
  }, [detail]);

  const readOnly = !editor || detail?.status === "ARCHIVED";
  const snapshot = JSON.stringify({ steps, settings });
  const dirty = !!detail && loadedFor.current === detail.id && snapshot !== saved.current;

  // Drafts save themselves shortly after each change, which also re-checks them.
  useEffect(() => {
    if (!dirty || readOnly || !id) return;
    const timer = setTimeout(async () => {
      setSaveState("saving");
      try {
        const next = await automationsService.saveDefinition(id, steps, settings);
        saved.current = snapshot;
        queryClient.setQueryData(automationKeys.detail(id), next);
        setSaveState("saved");
        setSaveError(null);
        setPublishIssues(null);
      } catch (err) {
        setSaveState("error");
        setSaveError(isAxiosError(err) ? ((err.response?.data as { message?: string })?.message ?? err.message) : "Not saved.");
      }
    }, 700);
    return () => clearTimeout(timer);
  }, [snapshot, dirty, readOnly, id, steps, settings, queryClient]);

  const live = detail?.status === "ACTIVE" || detail?.status === "PAUSED";
  const { data: stats } = useAutomationStats(id, !!detail?.publishedAt);
  const issues = publishIssues ?? detail?.issues ?? [];
  const selected = selectedId ? findStep(steps, selectedId) : null;
  const channel = channelKeyOf(detail?.platform);
  const changedSincePublish = live && !!detail?.unpublishedChanges;
  const templateName = useMemo(() => {
    const byId = new Map(templates.map((t) => [t.id, t.name]));
    return (tid: string) => byId.get(tid);
  }, [templates]);

  if (isError) return <p className="text-body text-muted-foreground">This automation could not be loaded.</p>;
  if (isLoading || !detail) return <Skeleton className="h-[32rem] w-full rounded-xl" />;

  const ctx: EditorContext = {
    channel,
    channelId: detail.channel?.id ?? null,
    steps,
    issues,
    tags: tagRows.map((t) => t.tag),
    members: members.filter((m) => m.role !== "VIEWER").map((m) => ({ id: m.id, name: m.name })),
    teams: teams.map((t) => ({ id: t.id, name: t.name })),
    storeTools,
    readOnly,
  };

  const publish = async () => {
    if (dirty) {
      try {
        const next = await automationsService.saveDefinition(detail.id, steps, settings);
        saved.current = snapshot;
        queryClient.setQueryData(automationKeys.detail(detail.id), next);
      } catch {
        return;
      }
    }
    lifecycle.mutate(
      { id: detail.id, action: "publish" },
      {
        onSuccess: (next: AutomationDetail) => {
          setPublishIssues(null);
          setSteps(next.definition.steps);
          saved.current = JSON.stringify({ steps: next.definition.steps, settings });
        },
        onError: (err) => {
          const body = isAxiosError(err) ? (err.response?.data as { issues?: AutomationIssue[] } | undefined) : undefined;
          if (body?.issues?.length) {
            setPublishIssues(body.issues);
            setSelectedId(body.issues[0].stepId || selectedId);
            setTab("flow");
          }
        },
      },
    );
  };

  const hasReplyStep = allSteps(steps).some((s) => s.type === "wait_for_reply");

  return (
    <div className="space-y-6">
      <Link to="/campaigns/automations" className="inline-flex items-center gap-1 text-caption text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-3.5" />
        Automations
      </Link>
      <PageHeader>
        <PageHeaderContent>
          {editingName ? (
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (name.trim()) rename.mutate({ id: detail.id, name: name.trim() }, { onSuccess: () => setEditingName(false) });
              }}
            >
              <Input value={name} maxLength={120} autoFocus onChange={(e) => setName(e.target.value)} className="h-9 max-w-sm text-base font-semibold" aria-label="Name" />
              <Button type="submit" size="sm" variant="outline" disabled={rename.isPending}>
                Save
              </Button>
            </form>
          ) : (
            <PageHeaderTitle className="flex items-center gap-2">
              {detail.name}
              {!readOnly && (
                <Button variant="ghost" size="icon-xs" onClick={() => setEditingName(true)} aria-label="Rename">
                  <Pencil />
                </Button>
              )}
            </PageHeaderTitle>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-2 text-caption text-muted-foreground">
            <span className={cn("rounded-full px-2 py-0.5 text-micro font-medium", AUTOMATION_STATUS_CLASS[detail.status])}>{AUTOMATION_STATUS_LABEL[detail.status]}</span>
            <ChannelBadge platform={detail.channel?.platform ?? detail.platform} name={detail.channel?.name} size={12} />
            {detail.publishedAt && <span>Version {detail.version}, published {formatDateTime(detail.publishedAt)}</span>}
            {!readOnly && (
              <span className={cn(saveState === "error" && "text-danger")}>
                {saveState === "saving" || dirty ? "Saving…" : saveState === "error" ? `Not saved: ${saveError}` : "Draft saved"}
              </span>
            )}
          </div>
        </PageHeaderContent>
        <PageHeaderActions>
          <Button variant="outline" size="sm" onClick={() => setTesting(true)} disabled={dirty || countSteps(steps) < 2}>
            <FlaskConical />
            Try it
          </Button>
          {!readOnly && detail.status === "ACTIVE" && (
            <Button variant="outline" size="sm" disabled={lifecycle.isPending} onClick={() => lifecycle.mutate({ id: detail.id, action: "pause" })}>
              <Pause />
              Pause
            </Button>
          )}
          {!readOnly && detail.status === "PAUSED" && (
            <Button variant="outline" size="sm" disabled={lifecycle.isPending} onClick={() => lifecycle.mutate({ id: detail.id, action: "resume" })}>
              <Play />
              Resume
            </Button>
          )}
          {!readOnly && (detail.status === "DRAFT" || detail.status === "ERROR" || changedSincePublish || dirty) && (
            <Button variant="accent" size="sm" disabled={lifecycle.isPending || saveState === "error"} onClick={() => void publish()}>
              {lifecycle.isPending ? <Loader2 className="animate-spin" /> : <Rocket />}
              {detail.publishedAt ? "Publish changes" : "Publish"}
            </Button>
          )}
          {editor && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="More">
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => duplicate.mutate(detail.id, { onSuccess: (copy) => navigate(`/campaigns/automations/${copy.id}`) })}>
                  <Copy />
                  Duplicate
                </DropdownMenuItem>
                {detail.status !== "ARCHIVED" && (
                  <DropdownMenuItem
                    onSelect={() =>
                      window.confirm(`Archive ${detail.name}? It stops running; its history stays.`) &&
                      archive.mutate(detail.id, { onSuccess: () => navigate("/campaigns/automations") })
                    }
                  >
                    <Archive />
                    Archive
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </PageHeaderActions>
      </PageHeader>

      {detail.status === "ARCHIVED" && <p className="rounded-lg bg-muted p-3 text-caption text-muted-foreground">Archived automations cannot change. Duplicate it to keep working on it.</p>}
      {changedSincePublish && !dirty && <p className="rounded-lg bg-info-subtle p-3 text-caption text-info">The draft has changes that are not live yet. People already in a run finish the version they started.</p>}
      {detail.lastError && live && (
        <p className="flex items-start gap-2 rounded-lg bg-danger-subtle p-3 text-caption text-danger">
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          <span>
            Last stop {detail.lastErrorAt ? formatDateTime(detail.lastErrorAt) : ""}: {detail.lastError}
          </span>
        </p>
      )}

      {detail.publishedAt && (
        <div className="flex w-fit rounded-lg bg-muted p-0.5" role="tablist">
          {(["flow", "activity"] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={cn("rounded-md px-3 py-1 text-caption font-medium", tab === t ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground")}
            >
              {t === "flow" ? "Flow" : `Activity${stats?.total ? ` · ${stats.total.toLocaleString("en-IN")}` : ""}`}
            </button>
          ))}
        </div>
      )}

      {tab === "activity" && detail.publishedAt ? (
        <AutomationActivity automationId={detail.id} steps={steps} canOpenInbox={inbox} />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="space-y-4">
            {issues.length > 0 && (
              <SectionCard title={`${issues.length} thing${issues.length === 1 ? "" : "s"} to fix before publishing`} icon={<CircleAlert className="size-4 text-danger" />}>
                <ul className="divide-y">
                  {issues.map((i, n) => (
                    <li key={`${i.stepId}-${i.code}-${n}`}>
                      <button type="button" onClick={() => i.stepId && setSelectedId(i.stepId)} className="w-full px-5 py-2 text-left text-caption hover:bg-muted/50">
                        <span className="font-semibold">{i.title}.</span> <span className="text-muted-foreground">{i.body}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </SectionCard>
            )}
            <div className="overflow-x-auto rounded-xl border bg-muted/20">
              <FlowCanvas
                steps={steps}
                selectedId={selectedId}
                onSelect={(sid) => {
                  setSelectedId(sid);
                  // On one-column layouts the form sits below the flow.
                  if (window.innerWidth < 1024) requestAnimationFrame(() => document.getElementById("step-editor")?.scrollIntoView({ behavior: "smooth", block: "start" }));
                }}
                onInsert={(slot, type) => {
                  const step = newStep(type, channel);
                  setSteps((s) => insertStep(s, slot, step));
                  setSelectedId(step.id);
                }}
                onMove={(sid, by) => setSteps((s) => moveStep(s, sid, by))}
                onRemove={(sid) => {
                  const step = findStep(steps, sid);
                  const nested = step?.branches ? Object.values(step.branches).reduce((n, l) => n + countSteps(l), 0) : 0;
                  if (nested && !window.confirm(`Remove this step and the ${nested} inside its branches?`)) return;
                  setSteps((s) => removeStep(s, sid));
                  if (selectedId === sid) setSelectedId(steps[0]?.id ?? null);
                }}
                issues={issues}
                counts={stats?.steps}
                channel={channel}
                triggerEvent={String(steps[0]?.config.event ?? "")}
                full={countSteps(steps) >= MAX_STEPS}
                readOnly={readOnly}
                templateName={templateName}
              />
            </div>
          </div>

          <div id="step-editor" className="scroll-mt-4 space-y-4 lg:sticky lg:top-6 lg:self-start">
            <SectionCard title="Edit step">
              <div className="p-5">
                {selected ? (
                  <StepEditor key={selected.id} step={selected} ctx={ctx} onChange={(config) => setSteps((s) => updateStep(s, selected.id, config))} />
                ) : (
                  <p className="text-caption text-muted-foreground">Choose a step to change it.</p>
                )}
              </div>
            </SectionCard>
            <SectionCard title="The same person can go through it">
              <div className="space-y-1 p-3">
                {ONCE.map(([value, label, hint]) => (
                  <label key={value} className={cn("flex cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5", settings.oncePerContact === value ? "bg-brand/10" : "hover:bg-muted")}>
                    <input
                      type="radio"
                      name="once"
                      className="mt-1 accent-[var(--color-brand)]"
                      checked={settings.oncePerContact === value}
                      disabled={readOnly}
                      onChange={() => setSettings({ oncePerContact: value })}
                    />
                    <span>
                      <span className="block text-body">{label}</span>
                      <span className="block text-micro text-muted-foreground">{hint}</span>
                    </span>
                  </label>
                ))}
              </div>
            </SectionCard>
          </div>
        </div>
      )}

      {testing && <TestRunDialog automationId={detail.id} hasReplyStep={hasReplyStep} onClose={() => setTesting(false)} />}
    </div>
  );
}
