import { ExternalLink, Loader2, RefreshCw, Wrench } from "lucide-react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  useRefreshWhatsAppHealthMutation,
  useRetryWhatsAppSetupMutation,
} from "~/hooks/use-whatsapp-mutations";
import {
  coexistenceLabel,
  historySyncLabel,
  messagingLimitLabel,
  qualityMeta,
} from "~/lib/messaging-status";
import { cn } from "~/lib/utils";
import type { Channel } from "~/types/api";

const WHATSAPP_MANAGER_URL = "https://business.facebook.com/wa/manage/home/";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <span className="shrink-0 text-caption text-muted-foreground">{label}</span>
      <span className="min-w-0 text-right text-caption text-foreground">{children}</span>
    </div>
  );
}

/**
 * Messaging health on the channel dialog: for a WhatsApp number its quality,
 * limit, Business app link and history import, with the two actions that fix
 * most problems; for a Page or Instagram account, whether its messages reach
 * Collabo at all.
 */
export function MessagingStatusPanel({ channel, canManage }: { channel: Channel; canManage: boolean }) {
  const status = channel.messaging;
  const retry = useRetryWhatsAppSetupMutation();
  const refresh = useRefreshWhatsAppHealthMutation();
  if (!status || channel.connectionState === "DISCONNECTED") return null;

  if (channel.platform !== "WHATSAPP") {
    if (status.webhooksOk !== false) return null;
    return (
      <p className="rounded-lg bg-warning-subtle p-3 text-caption text-warning-strong">
        Messages from this account are not reaching Collabo yet. Re-authorize it with a
        Facebook account that has full control of the Page.
      </p>
    );
  }

  const quality = qualityMeta(status.quality);
  const limit = messagingLimitLabel(status.messagingLimit);
  const history = historySyncLabel(status.historySync);
  const coexistence = coexistenceLabel(status.coexistence);
  const setupIncomplete = status.setup?.webhooks === "failed" || status.setup?.registration === "failed";

  return (
    <div className="space-y-3">
      <div className="divide-y divide-border rounded-lg border border-border px-3">
        <Row label="Number type">
          {status.isOnBizApp ? "WhatsApp Business app + Collabo" : "Collabo only (Cloud API)"}
        </Row>
        {coexistence && <Row label="Business app">{coexistence}</Row>}
        {quality && (
          <Row label="Quality">
            <Badge className={cn("align-middle", quality.className)}>{quality.label}</Badge>
          </Row>
        )}
        {limit && <Row label="Messaging limit">{limit}</Row>}
        {status.isOnBizApp && <Row label="Sending speed">Up to 20 messages a second</Row>}
        {status.nameStatus && <Row label="Display name">{status.nameStatus.replaceAll("_", " ").toLowerCase()}</Row>}
        {history && (
          <Row label="Chat history">
            <span
              className={cn(
                history.tone === "problem" && "text-danger",
                history.tone === "done" && "text-success",
              )}
            >
              {history.label}
            </span>
          </Row>
        )}
      </div>

      {status.historySync?.status === "importing" && status.historySync.progress != null && (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
          <div className="h-full rounded-full bg-success" style={{ width: `${status.historySync.progress}%` }} />
        </div>
      )}

      <p className="text-caption text-muted-foreground">
        Meta bills your business directly for messages. Check that a payment method is added in{" "}
        <a
          href={WHATSAPP_MANAGER_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-0.5 text-brand-strong underline hover:text-brand-strong-hover"
        >
          WhatsApp Manager
          <ExternalLink className="size-3" />
        </a>
        .
      </p>

      {canManage && (
        <div className="flex flex-wrap gap-2">
          {setupIncomplete && (
            <Button size="sm" variant="accent" disabled={retry.isPending} onClick={() => retry.mutate(channel.id)}>
              {retry.isPending ? <Loader2 className="animate-spin" /> : <Wrench />}
              Retry setup
            </Button>
          )}
          <Button size="sm" variant="outline" disabled={refresh.isPending} onClick={() => refresh.mutate(channel.id)}>
            {refresh.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            Refresh status
          </Button>
        </div>
      )}
    </div>
  );
}
