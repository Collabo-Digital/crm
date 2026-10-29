import { useState } from "react";
import { Check, Copy, Loader2, ReceiptText, Send } from "lucide-react";

import { Button } from "~/components/ui/button";
import { useDraftFromCartMutation } from "~/hooks/use-automation-mutations";
import { useSendMessageMutation } from "~/hooks/use-inbox-mutations";
import { useConversationPayments, useCreatePaymentLinkMutation, usePaymentAccount, useRequestWhatsAppPayMutation } from "~/hooks/use-payments";
import type { DraftFromCart } from "~/types/api";

import { paymentLinkMessage } from "./payments-section";

/**
 * Under a cart the customer sent: make it a draft order, then send them
 * Shopify's checkout link, or a payment link from the organization's own
 * Razorpay account (paying it turns the draft into an order). Without a
 * connected Shopify store there is no checkout link, but a payment link still works.
 */
export function CartActions({ conversationId, messageId }: { conversationId: string; messageId: string }) {
  const create = useDraftFromCartMutation(conversationId);
  const send = useSendMessageMutation(conversationId);
  const { data: payments } = usePaymentAccount();
  const { data: chatPayments } = useConversationPayments(conversationId);
  const payLink = useCreatePaymentLinkMutation(conversationId);
  const inApp = useRequestWhatsAppPayMutation(conversationId);
  const [inAppSent, setInAppSent] = useState(false);
  const [draft, setDraft] = useState<DraftFromCart | null>(null);
  const [sent, setSent] = useState(false);
  const [paySent, setPaySent] = useState(false);
  const sendPaymentLink = () =>
    payLink.mutate({ draftOrderId: draft!.draftId }, {
      onSuccess: (link) => send.mutate({ payload: { type: "text", text: paymentLinkMessage(link) } }, { onSuccess: (o) => o.ok && setPaySent(true) }),
    });
  const linkButton = payments?.connected ? (
    <Button size="xs" variant={draft?.checkoutUrl ? "outline" : "accent"} disabled={payLink.isPending || send.isPending || paySent} onClick={sendPaymentLink}>
      {paySent ? <Check /> : payLink.isPending ? <Loader2 className="animate-spin" /> : <Send />}
      {paySent ? "Payment link sent" : "Send payment link"}
    </Button>
  ) : null;
  // A Review and Pay bill in the chat; the draft needs a delivery address in India.
  const inAppButton = chatPayments?.whatsappPay ? (
    <Button size="xs" variant="outline" disabled={inApp.isPending || inAppSent} onClick={() => inApp.mutate({ draftOrderId: draft!.draftId }, { onSuccess: () => setInAppSent(true) })}>
      {inAppSent ? <Check /> : inApp.isPending ? <Loader2 className="animate-spin" /> : <Send />}
      {inAppSent ? "WhatsApp Pay sent" : "Request in WhatsApp Pay"}
    </Button>
  ) : null;
  const payButton = linkButton || inAppButton ? <>{linkButton}{inAppButton}</> : null;

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
      {draft.existing && <p className="text-micro text-muted-foreground">This cart already had a draft order, so it was not made twice.</p>}
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
          {payButton}
        </div>
      ) : payButton ? (
        <div className="flex flex-wrap gap-1.5">{payButton}</div>
      ) : (
        <p className="text-micro text-muted-foreground">Saved in Draft orders. Connect a Shopify store to get a checkout link, or Razorpay to send a payment link.</p>
      )}
    </div>
  );
}
