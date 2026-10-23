import { useState } from "react";
import { Check, Copy, Loader2, ReceiptText, Send } from "lucide-react";

import { Button } from "~/components/ui/button";
import { useDraftFromCartMutation } from "~/hooks/use-automation-mutations";
import { useSendMessageMutation } from "~/hooks/use-inbox-mutations";
import type { DraftFromCart } from "~/types/api";

/**
 * Under a cart the customer sent: make it a draft order, then send them
 * Shopify's checkout link. Without a connected Shopify store the draft stays
 * in Collabo and there is no link to send.
 */
export function CartActions({ conversationId, messageId }: { conversationId: string; messageId: string }) {
  const create = useDraftFromCartMutation(conversationId);
  const send = useSendMessageMutation(conversationId);
  const [draft, setDraft] = useState<DraftFromCart | null>(null);
  const [sent, setSent] = useState(false);

  if (!draft) {
    return (
      <Button size="xs" variant="outline" className="mt-1" disabled={create.isPending} onClick={() => create.mutate(messageId, { onSuccess: setDraft })}>
        {create.isPending ? <Loader2 className="animate-spin" /> : <ReceiptText />}
        Create draft order
      </Button>
    );
  }
  return (
    <div className="mt-1 max-w-xs space-y-1.5 rounded-lg border bg-card p-2.5 text-caption">
      <p className="font-medium">
        {draft.name ?? "Draft order"} · {draft.total}
      </p>
      {draft.missing.length > 0 && <p className="text-micro text-warning">{draft.missing.length} item(s) are no longer in the store and were left out.</p>}
      {draft.checkoutUrl ? (
        <div className="flex flex-wrap gap-1.5">
          <Button
            size="xs"
            variant="accent"
            disabled={send.isPending || sent}
            onClick={() =>
              send.mutate(
                { payload: { type: "text", text: `Your order is ready${draft.total ? ` (${draft.total})` : ""}. Complete it here: ${draft.checkoutUrl}` } },
                { onSuccess: (o) => o.ok && setSent(true) },
              )
            }
          >
            {sent ? <Check /> : <Send />}
            {sent ? "Link sent" : "Send checkout link"}
          </Button>
          <Button size="xs" variant="ghost" onClick={() => void navigator.clipboard.writeText(draft.checkoutUrl!)}>
            <Copy />
            Copy link
          </Button>
        </div>
      ) : (
        <p className="text-micro text-muted-foreground">Saved in Draft orders. Connect a Shopify store to get a checkout link.</p>
      )}
    </div>
  );
}
