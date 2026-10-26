import { Link } from "react-router";

import { Button } from "~/components/ui/button";
import { useTemplatePack } from "~/hooks/use-campaign-queries";
import { useCurrentRole } from "~/hooks/use-current-role";
import { packProgress } from "~/lib/template-pack";
import { cn } from "~/lib/utils";

const TONE_TEXT = { info: "text-foreground", success: "text-success", warning: "text-warning-strong", danger: "text-danger" } as const;

/**
 * On the WhatsApp card: how Collabo's recommended messages are coming along on
 * the connected number. They set themselves up after connecting, so this is
 * the follow-up rather than a screen to confirm. Nothing for a role that
 * cannot read Campaigns (the API answers 403), or where there is no pack.
 */
export function WhatsAppMessagesCard() {
  const { can } = useCurrentRole();
  const { data: view } = useTemplatePack({ enabled: can("campaigns.view"), untilSettled: true });
  if (!view?.pack) return null;

  const progress = packProgress(view, "messages");
  // Slots the server explains (a template Meta refused, one the merchant deleted).
  const explained = view.slots.filter((s) => s.reason);
  return (
    <div className="mt-4 space-y-1 border-t border-border pt-3">
      <p className="text-caption font-medium text-foreground">WhatsApp messages</p>
      <p className={cn("text-caption", TONE_TEXT[progress.tone])}>{progress.title}</p>
      {progress.detail && <p className="text-caption text-muted-foreground">{progress.detail}</p>}
      {explained.length > 0 && (
        <ul className="space-y-0.5">
          {explained.map((s) => (
            <li key={s.slot} className={cn("text-caption", s.state === "attention" ? "text-danger" : "text-warning-strong")}>
              <span className="font-medium">{s.title}:</span> {s.reason}
            </li>
          ))}
        </ul>
      )}
      <p className="text-caption text-muted-foreground">Meta charges per message.</p>
      <div className="pt-2">
        <Button asChild variant="outline" size="sm">
          <Link to="/campaigns/templates">Templates</Link>
        </Button>
      </div>
    </div>
  );
}
