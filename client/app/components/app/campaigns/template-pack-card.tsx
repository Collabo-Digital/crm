import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { CircleAlert, CircleCheck, Hourglass, Loader2, TriangleAlert, Wrench } from "lucide-react";

import { SectionCard } from "~/components/app/section-card";
import { Button } from "~/components/ui/button";
import { useRunTemplatePackMutation } from "~/hooks/use-campaign-mutations";
import { campaignKeys, useTemplatePack } from "~/hooks/use-campaign-queries";
import { useCurrentRole } from "~/hooks/use-current-role";
import { rejectionHelp } from "~/lib/campaign-format";
import { PACK_SET_LABEL, PACK_SLOT_STATE_CLASS, PACK_SLOT_STATE_LABEL, approvedAsMarketing, packProgress } from "~/lib/template-pack";
import { cn } from "~/lib/utils";
import type { PackSet, TemplatePackSlot, TemplatePackView } from "~/types/api";

const TONE = {
  info: { icon: Hourglass, text: "text-info" },
  success: { icon: CircleCheck, text: "text-success" },
  warning: { icon: TriangleAlert, text: "text-warning-strong" },
  danger: { icon: CircleAlert, text: "text-danger" },
} as const;

/** Why a slot needs the merchant: the server's own sentence when it has one, else Meta's words where Meta gave them. */
function slotProblem(slot: TemplatePackSlot): { reason: string; recommendation?: string } | null {
  const t = slot.template;
  if (slot.reason) return { reason: slot.reason, recommendation: t?.rejectionInfo?.recommendation };
  if (slot.state === "paused") return { reason: "Meta paused it because many people blocked or reported its messages. Automations wait to send it until the pause ends." };
  if (slot.state !== "attention" || !t) return null;
  if (approvedAsMarketing(t)) {
    return { reason: "Meta approved it as marketing, not utility. Marketing messages cost more, and Collabo’s recommended automations hold them between 9 PM and 9 AM (store time)." };
  }
  const reason = t.rejectionInfo?.reason ?? (t.statusReason ? rejectionHelp(t.statusReason) : null);
  const status = t.status === "DISABLED" ? "Meta disabled it" : t.status === "REJECTED" ? "Meta rejected it" : `Meta marked it ${t.status.toLowerCase().replace(/_/g, " ")}`;
  return { reason: reason ? `${status}: ${reason.replace(/\.$/, "")}.` : `${status}.`, recommendation: t.rejectionInfo?.recommendation };
}

function SlotRow({ slot }: { slot: TemplatePackSlot }) {
  const problem = slotProblem(slot);
  const body = (
    <>
      <div className="min-w-0 flex-1">
        <p className="text-body font-medium">{slot.title}</p>
        <p className="text-caption text-muted-foreground">{slot.description}</p>
        {problem && (
          <div className="mt-1 space-y-0.5 text-caption">
            <p className={slot.state === "attention" ? "text-danger" : "text-warning-strong"}>{problem.reason}</p>
            {problem.recommendation && <p className="text-muted-foreground">Meta recommends: {problem.recommendation}</p>}
          </div>
        )}
      </div>
      <span className={cn("mt-0.5 inline-flex h-5 shrink-0 items-center whitespace-nowrap rounded-full px-2 text-micro font-medium", PACK_SLOT_STATE_CLASS[slot.state])}>
        {PACK_SLOT_STATE_LABEL[slot.state]}
      </span>
    </>
  );
  return (
    <li>
      {slot.template ? (
        <Link to={`/campaigns/templates/${slot.template.id}`} className="flex items-start gap-3 px-5 py-3 hover:bg-muted/50">
          {body}
        </Link>
      ) : (
        <div className="flex items-start gap-3 px-5 py-3">{body}</div>
      )}
    </li>
  );
}

/** Whether the pack wants the merchant's "Repair", and what to call it. */
function repairLabel(view: TemplatePackView): string | null {
  const pack = view.pack!;
  const running = pack.status === "running";
  const created = view.slots.some((s) => s.state !== "not_created");
  const missing = view.slots.some((s) => s.state === "not_created");
  if (!created && !running) return "Set up recommended templates";
  if (pack.status === "stopped" || view.counts.attention > 0 || (missing && !running && pack.status !== "pending")) return "Repair";
  return null;
}

/**
 * Collabo's recommended templates on this number: how far Meta has got, each
 * one's state, and a way to set them up again or repair them. Shows nothing
 * where there is no pack, as the page was before it.
 */
export function TemplatePackCard() {
  const queryClient = useQueryClient();
  const { can } = useCurrentRole();
  const { data: view } = useTemplatePack({ untilSettled: true });
  const run = useRunTemplatePackMutation();
  const [showAll, setShowAll] = useState(false);

  // The list below polls only for 15 minutes; when the pack moves on, it follows.
  const signature = view?.pack ? `${view.pack.status}:${view.counts.approved}:${view.counts.pending}:${view.counts.attention}` : null;
  const seen = useRef<string | null>(null);
  useEffect(() => {
    if (!signature) return;
    if (seen.current && seen.current !== signature) void queryClient.invalidateQueries({ queryKey: [...campaignKeys.templates(), "list"] });
    seen.current = signature;
  }, [signature, queryClient]);

  if (!view?.pack) return null;

  const progress = packProgress(view, "templates");
  const Tone = TONE[progress.tone];
  const action = can("templates.manage") ? repairLabel(view) : null;
  // While the pack is being created, the ones not created yet are counted in the summary instead of
  // listed, unless there is a reason to show (one the merchant deleted is not created again).
  const creating = view.pack.status === "pending" || view.pack.status === "running";
  const open = view.slots.filter((s) => s.state !== "approved" && !(creating && s.state === "not_created" && !s.reason));
  const rows = showAll ? view.slots : open;
  const sets = [...new Set(rows.map((s) => s.set))] as PackSet[];

  return (
    <SectionCard
      title="Recommended templates"
      description="Order, payment and cart messages Collabo creates on your WhatsApp account and sends from its automations."
      action={
        action && (
          <Button variant="outline" size="sm" disabled={run.isPending} onClick={() => run.mutate()}>
            {run.isPending ? <Loader2 className="animate-spin" /> : <Wrench />}
            {action}
          </Button>
        )
      }
    >
      <div className={cn("space-y-1 px-5 py-4", rows.length > 0 && "border-b")}>
        <p className={cn("flex items-start gap-2 text-body font-medium", Tone.text)}>
          <Tone.icon className="mt-0.5 size-4 shrink-0" />
          <span>{progress.title}</span>
        </p>
        {progress.detail && <p className="pl-6 text-caption text-muted-foreground">{progress.detail}</p>}
      </div>
      {rows.length > 0 && (
        <div className="divide-y">
          {sets.map((set) => (
            <div key={set}>
              {view.sets.length > 1 && <p className="border-b bg-muted/40 px-5 py-1.5 text-micro font-medium uppercase tracking-wide text-muted-foreground">{PACK_SET_LABEL[set]}</p>}
              <ul className="divide-y">
                {rows
                  .filter((s) => s.set === set)
                  .map((s) => (
                    <SlotRow key={s.slot} slot={s} />
                  ))}
              </ul>
            </div>
          ))}
        </div>
      )}
      {open.length < view.slots.length && (
        <div className={cn("px-3 py-2", rows.length > 0 && "border-t")}>
          <Button variant="ghost" size="xs" onClick={() => setShowAll(!showAll)} aria-expanded={showAll}>
            {showAll ? (open.length ? "Show fewer" : "Hide the list") : `Show all ${view.slots.length}`}
          </Button>
        </div>
      )}
    </SectionCard>
  );
}
