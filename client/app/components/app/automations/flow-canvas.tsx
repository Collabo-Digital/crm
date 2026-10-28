import { ChevronDown, ChevronUp, Plus, Trash2 } from "lucide-react";

import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { BLOCKS, BLOCK_GROUPS, BRANCH_LABEL, MAX_DEPTH, stepSummary, type Slot } from "~/lib/automation-blocks";
import { cn } from "~/lib/utils";
import type { AutomationBlockType, AutomationChannelKey, AutomationIssue, AutomationRunStatus, AutomationStep } from "~/types/api";

interface CanvasProps {
  steps: AutomationStep[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onInsert: (slot: Slot, type: AutomationBlockType) => void;
  onMove: (id: string, by: -1 | 1) => void;
  onRemove: (id: string) => void;
  issues: AutomationIssue[];
  /** Per step, how many runs reached it — shown once the automation has run. */
  counts?: Record<string, Partial<Record<AutomationRunStatus, number>>>;
  channel: AutomationChannelKey;
  triggerEvent: string;
  full: boolean;
  readOnly: boolean;
  templateName: (id: string) => string | undefined;
}

const BRANCHING = new Set<AutomationBlockType>(["condition", "wait_for_reply"]);

function Connector({ className }: { className?: string }) {
  return <div className={cn("mx-auto h-4 w-px bg-border", className)} aria-hidden />;
}

/** "+" between steps: pick the block to put there. */
function InsertPoint({ slot, depth, props }: { slot: Slot; depth: number; props: CanvasProps }) {
  if (props.readOnly) return <Connector />;
  const available = (type: AutomationBlockType) => {
    const spec = BLOCKS[type];
    if (spec.unavailable) return spec.unavailable;
    if (spec.channels && !spec.channels.includes(props.channel)) return "Not on this channel";
    if (spec.commentsOnly && props.triggerEvent !== "comment") return "Comment triggers only";
    if (BRANCHING.has(type) && depth >= MAX_DEPTH) return `Branches nest at most ${MAX_DEPTH} deep`;
    return null;
  };
  return (
    <div className="flex flex-col items-center">
      <Connector className="h-2" />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={props.full}
            title={props.full ? "An automation can have at most 40 steps" : "Add a step here"}
            className="flex size-6 items-center justify-center rounded-full border bg-background text-muted-foreground outline-none transition-colors hover:border-brand hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-40 max-md:size-11 pointer-coarse:size-11"
            aria-label="Add a step here"
          >
            <Plus className="size-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-72" align="center">
          {BLOCK_GROUPS.map((group, gi) => {
            const types = (Object.keys(BLOCKS) as AutomationBlockType[]).filter((t) => t !== "trigger" && BLOCKS[t].group === group);
            if (!types.length) return null;
            return (
              <DropdownMenuGroup key={group}>
                {gi > 0 && <DropdownMenuSeparator />}
                <DropdownMenuLabel className="text-micro uppercase tracking-wide text-muted-foreground">{group}</DropdownMenuLabel>
                {types.map((type) => {
                  const spec = BLOCKS[type];
                  const reason = available(type);
                  const Icon = spec.icon;
                  return (
                    <DropdownMenuItem key={type} disabled={!!reason} onSelect={() => props.onInsert(slot, type)} className="items-start gap-2">
                      <Icon className="mt-0.5 size-4 text-muted-foreground" />
                      <span className="flex flex-col">
                        <span className="text-body">{spec.label}</span>
                        <span className="text-micro text-muted-foreground">{reason ?? spec.hint}</span>
                      </span>
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuGroup>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
      <Connector className="h-2" />
    </div>
  );
}

function StepCard({ step, index, listLength, top, props }: { step: AutomationStep; index: number; listLength: number; top: boolean; props: CanvasProps }) {
  const spec = BLOCKS[step.type];
  const Icon = spec.icon;
  const issues = props.issues.filter((i) => i.stepId === step.id);
  const counts = props.counts?.[step.id];
  const reached = counts ? Object.values(counts).reduce((a, b) => a + (b ?? 0), 0) : 0;
  const selected = props.selectedId === step.id;
  const isTrigger = step.type === "trigger";
  const minIndex = top ? 1 : 0;

  return (
    <div
      className={cn(
        "group relative w-full max-w-sm rounded-xl border bg-card shadow-xs transition-colors",
        selected ? "border-brand ring-2 ring-brand/30" : issues.length ? "border-danger/50" : "hover:border-foreground/30",
      )}
    >
      <button type="button" onClick={() => props.onSelect(step.id)} className="flex w-full items-start gap-3 rounded-xl p-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
        <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg", isTrigger ? "bg-brand text-brand-foreground" : "bg-muted text-foreground")}>
          <Icon className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-caption font-semibold">{spec.label}</span>
          <span className="block break-words text-caption text-muted-foreground">{stepSummary(step, props.templateName)}</span>
          {(issues.length > 0 || reached > 0) && (
            <span className="mt-1 flex flex-wrap gap-x-3 text-micro">
              {issues.length > 0 && <span className="font-medium text-danger">{issues[0].title}{issues.length > 1 ? ` +${issues.length - 1}` : ""}</span>}
              {reached > 0 && (
                <span className="tabular-nums text-muted-foreground">
                  {reached.toLocaleString("en-IN")} reached{counts?.FAILED ? ` · ${counts.FAILED} stopped here` : ""}
                  {counts?.WAITING ? ` · ${counts.WAITING} waiting` : ""}
                </span>
              )}
            </span>
          )}
        </span>
      </button>
      {!isTrigger && !props.readOnly && (
        <div className="absolute -right-2 top-1/2 flex -translate-y-1/2 translate-x-full flex-col opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 max-sm:static max-sm:translate-x-0 max-sm:translate-y-0 max-sm:flex-row max-sm:justify-end max-sm:px-2 max-sm:pb-1 max-sm:opacity-100">
          <Button variant="ghost" size="icon-xs" disabled={index <= minIndex} onClick={() => props.onMove(step.id, -1)} aria-label="Move up">
            <ChevronUp />
          </Button>
          <Button variant="ghost" size="icon-xs" disabled={index >= listLength - 1} onClick={() => props.onMove(step.id, 1)} aria-label="Move down">
            <ChevronDown />
          </Button>
          <Button variant="ghost" size="icon-xs" onClick={() => props.onRemove(step.id)} aria-label={`Remove ${spec.label}`}>
            <Trash2 />
          </Button>
        </div>
      )}
    </div>
  );
}

function StepList({ list, parentId, branch, depth, props }: { list: AutomationStep[]; parentId: string | null; branch: string | null; depth: number; props: CanvasProps }) {
  const top = parentId === null;
  return (
    <div className="flex w-full flex-col items-center">
      {list.map((step, index) => (
        <div key={step.id} className="flex w-full flex-col items-center">
          {!(top && index === 0) && <InsertPoint slot={{ parentId, branch, index }} depth={depth} props={props} />}
          <StepCard step={step} index={index} listLength={list.length} top={top} props={props} />
          {step.branches && (
            <div className="mt-0 flex w-full flex-col items-center">
              <Connector />
              {/* Columns keep a readable width; deep nesting scrolls sideways rather than squeezing. */}
              <div className="grid w-full gap-3 rounded-xl border border-dashed p-2 sm:grid-cols-[repeat(2,minmax(15rem,1fr))]">
                {Object.keys(BRANCH_LABEL[step.type] ?? step.branches).map((name) => (
                  <div key={name} className="flex min-w-0 flex-col items-center rounded-lg bg-muted/40 p-2">
                    <span className="rounded-full bg-background px-2 py-0.5 text-micro font-semibold text-muted-foreground shadow-xs">
                      {BRANCH_LABEL[step.type]?.[name] ?? name}
                    </span>
                    <StepList list={step.branches![name] ?? []} parentId={step.id} branch={name} depth={depth + 1} props={props} />
                    {(step.branches![name] ?? []).length === 0 && <span className="pb-1 text-micro text-muted-foreground">Goes straight on</span>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      ))}
      <InsertPoint slot={{ parentId, branch, index: list.length }} depth={depth} props={props} />
    </div>
  );
}

/**
 * The flow, top to bottom. Branching steps split into columns; when a branch
 * runs out the flow carries on below it, so a branch holds only what differs.
 */
export function FlowCanvas(props: CanvasProps) {
  return (
    <div className="mx-auto flex w-full flex-col items-center px-2 pb-6 pt-2 sm:w-max sm:min-w-full sm:px-10">
      <StepList list={props.steps} parentId={null} branch={null} depth={0} props={props} />
      <span className="rounded-full bg-muted px-3 py-1 text-micro font-medium text-muted-foreground">End</span>
    </div>
  );
}
