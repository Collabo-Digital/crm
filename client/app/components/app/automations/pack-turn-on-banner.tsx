import { useState } from "react";
import { CircleCheck, Loader2, Sparkles, X } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { useTurnOnPackMutation } from "~/hooks/use-automation-mutations";
import { PACK_OFF_BY_DEFAULT } from "~/lib/template-pack";
import type { AutomationListItem } from "~/types/api";

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What turning them on did, in a sentence or two. */
function summary(turned: AutomationListItem[]): string {
  const live = turned.filter((a) => a.packState === "live").length;
  const waiting = turned.filter((a) => a.packState === "waiting").length;
  const held = turned.filter((a) => a.packState === "duplicate").length;
  const attention = turned.filter((a) => a.packState === "attention").length;
  const parts = [
    live && `${count(live, "is", "are")} live now`,
    waiting && `${count(waiting, "goes", "go")} live by ${waiting === 1 ? "itself" : "themselves"} when Meta approves ${waiting === 1 ? "its" : "their"} templates`,
  ].filter(Boolean);
  const notes = [
    held && `${count(held, "was", "were")} held back because one of your automations already does the same job.`,
    attention && `${count(attention, "needs", "need")} attention: open ${attention === 1 ? "it" : "them"} to see why.`,
  ].filter(Boolean);
  const text = [parts.length ? `${parts.join(", and ")}.` : "", ...notes].join(" ").trim();
  return text ? text.replace(/^./, (c) => c.toUpperCase()) : "Each one goes live by itself once Meta approves its templates.";
}

/**
 * For an account connected before Collabo set its recommended messages up by
 * itself: its pack automations were created switched off. One click turns on
 * the ones that are on by default and were never turned on (a draft, not one
 * the merchant paused); each goes live once Meta approves its templates.
 * Afterwards it says what happened, until dismissed.
 */
export function PackTurnOnBanner({ rows, autoActivate }: { rows: AutomationListItem[]; autoActivate: boolean }) {
  const turnOn = useTurnOnPackMutation();
  const [result, setResult] = useState<string | null>(null);
  const off = rows.filter(
    (a) => a.packKey && a.status === "DRAFT" && !PACK_OFF_BY_DEFAULT.has(a.packKey) && (a.packState === "ready" || a.packState === "off" || a.packState === "attention"),
  );

  if (result) {
    return (
      <Alert variant="success">
        <CircleCheck />
        <div className="min-w-0 flex-1 space-y-0.5">
          <AlertTitle>Your recommended WhatsApp messages are on.</AlertTitle>
          <AlertDescription>{result}</AlertDescription>
        </div>
        <Button variant="ghost" size="icon-xs" className="-mr-1 -mt-0.5" aria-label="Dismiss" onClick={() => setResult(null)}>
          <X />
        </Button>
      </Alert>
    );
  }
  if (autoActivate || off.length === 0) return null;

  const keys = off.map((a) => a.packKey!);
  return (
    <Alert variant="info">
      <Sparkles />
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1 basis-64 space-y-0.5">
          <AlertTitle>Your recommended WhatsApp messages are ready.</AlertTitle>
          <AlertDescription>
            {count(off.length, "automation is", "automations are")} ready to send your order updates and Collabo’s other recommended messages. Turned on, each one goes
            live by itself once Meta approves its templates.
          </AlertDescription>
          <AlertDescription>Meta charges per message.</AlertDescription>
        </div>
        <Button
          variant="accent"
          size="sm"
          disabled={turnOn.isPending}
          onClick={() => turnOn.mutate(keys, { onSuccess: ({ automations }) => setResult(summary(automations.filter((a) => a.packKey && keys.includes(a.packKey)))) })}
        >
          {turnOn.isPending && <Loader2 className="animate-spin" />}
          Turn on
        </Button>
      </div>
    </Alert>
  );
}
