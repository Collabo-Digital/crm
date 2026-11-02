import { AlertTriangle, ExternalLink } from "lucide-react";
import type { WhatsAppSendingHealth } from "~/types/api";

const WHATSAPP_MANAGER_URL = "https://business.facebook.com/wa/manage/home/";

/**
 * Meta's own verdict on whether the number may send. A block (often the
 * payment method) stops templates, broadcasts and automations from reaching
 * anyone outside the 24-hour reply window; nothing in Collabo can fix it.
 */
export function SendingHealthAlert({ sending }: { sending: WhatsAppSendingHealth | null | undefined }) {
  if (!sending || sending.state === "AVAILABLE") return null;
  const blocked = sending.state === "BLOCKED";
  return (
    <div role="alert" className={blocked ? "space-y-1.5 rounded-lg bg-danger-subtle p-3 text-caption text-danger" : "space-y-1.5 rounded-lg bg-warning-subtle p-3 text-caption text-warning-strong"}>
      <p className="flex items-center gap-1.5 font-semibold">
        <AlertTriangle className="size-3.5 shrink-0" />
        {blocked ? "Meta is blocking messages you start" : "Meta is limiting messages you start"}
      </p>
      <p>Replies inside the 24-hour window still go. Templates, broadcasts and automations to anyone else do not until this is fixed in WhatsApp Manager.</p>
      {sending.problems.map((p, i) => (
        <p key={i}>
          {p.description}
          {p.solution ? ` ${p.solution}` : ""}
        </p>
      ))}
      <a href={WHATSAPP_MANAGER_URL} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium underline">
        Open WhatsApp Manager <ExternalLink className="size-3" />
      </a>
    </div>
  );
}
