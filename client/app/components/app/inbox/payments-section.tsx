import { useState } from "react";
import { AlertTriangle, Check, Copy, Loader2, RefreshCw, Send, X } from "lucide-react";
import { Link } from "react-router";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { useSendMessageMutation } from "~/hooks/use-inbox-mutations";
import { useConversationPayments, useCreatePaymentLinkMutation, usePaymentAccount, usePaymentLinkActionMutation } from "~/hooks/use-payments";
import { formatDateTime } from "~/lib/inbox-format";
import { cn, formatCurrency } from "~/lib/utils";
import type { PaymentLink, PaymentLinkStatus } from "~/types/api";

const STATUS: Record<PaymentLinkStatus, { label: string; className: string }> = {
  CREATED: { label: "Waiting", className: "bg-warning-subtle text-warning-strong" },
  PARTIALLY_PAID: { label: "Part paid", className: "bg-warning-subtle text-warning-strong" },
  PAID: { label: "Paid", className: "bg-success-subtle text-success" },
  EXPIRED: { label: "Expired", className: "bg-muted text-muted-foreground" },
  CANCELLED: { label: "Cancelled", className: "bg-muted text-muted-foreground" },
};

export const paymentLinkMessage = (link: Pick<PaymentLink, "description" | "amount" | "currency" | "shortUrl">) =>
  `${link.description}: ${formatCurrency(link.amount, link.currency)}. Pay securely here: ${link.shortUrl}`;

function LinkRow({ link, conversationId, canEdit }: { link: PaymentLink; conversationId: string; canEdit: boolean }) {
  const send = useSendMessageMutation(conversationId);
  const action = usePaymentLinkActionMutation(conversationId);
  const [sent, setSent] = useState(false);
  const status = STATUS[link.status];
  const open = link.status === "CREATED";
  return (
    <li className="space-y-1.5 rounded-lg border p-2.5">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-caption font-medium">{link.description}</span>
        <span className="text-caption tabular-nums">{formatCurrency(link.amount, link.currency)}</span>
        <span className={cn("rounded-full px-1.5 py-0.5 text-micro font-medium", status.className)}>{status.label}</span>
      </div>
      <p className="text-micro text-muted-foreground">
        {link.paidAt
          ? `Paid ${formatDateTime(link.paidAt)}${link.paymentMethod ? ` by ${link.paymentMethod}` : ""}`
          : open
            ? `Expires ${formatDateTime(link.expiresAt)}`
            : `Made ${formatDateTime(link.createdAt)}`}
      </p>
      {link.followUpError && (
        <p className="flex items-start gap-1.5 text-micro text-warning-strong">
          <AlertTriangle className="mt-px size-3 shrink-0" />
          Paid, but the order was not updated: {link.followUpError}
        </p>
      )}
      {open && canEdit && (
        <div className="flex flex-wrap gap-1">
          <Button
            size="xs"
            variant="accent"
            disabled={send.isPending || sent}
            onClick={() => send.mutate({ payload: { type: "text", text: paymentLinkMessage(link) } }, { onSuccess: (o) => o.ok && setSent(true) })}
          >
            {sent ? <Check /> : <Send />}
            {sent ? "Sent" : "Send in chat"}
          </Button>
          <Button size="xs" variant="ghost" aria-label="Copy link" onClick={() => void navigator.clipboard.writeText(link.shortUrl)}>
            <Copy />
          </Button>
          <Button size="xs" variant="ghost" disabled={action.isPending} aria-label="Check whether it was paid" onClick={() => action.mutate({ id: link.id, action: "refresh" })}>
            <RefreshCw />
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={action.isPending}
            aria-label="Cancel link"
            onClick={() => window.confirm("Cancel this payment link? The customer will no longer be able to pay with it.") && action.mutate({ id: link.id, action: "cancel" })}
          >
            <X />
          </Button>
        </div>
      )}
    </li>
  );
}

/**
 * Payment links for this chat's customer, from the organization's own
 * Razorpay account: one tap per unpaid order, or any amount. A paid link
 * marks the order paid by itself.
 */
export function PaymentsSection({ conversationId, canEdit }: { conversationId: string; canEdit: boolean }) {
  const { data: account } = usePaymentAccount();
  const { data, isLoading } = useConversationPayments(conversationId, !!account?.connected);
  const create = useCreatePaymentLinkMutation(conversationId);
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [custom, setCustom] = useState(false);

  if (!account) return null;
  if (!account.connected) {
    return (
      <p className="text-caption text-muted-foreground">
        Connect your Razorpay account in{" "}
        <Link to="/settings/orders" className="font-medium text-foreground underline">Settings → Orders</Link> to send payment links.
      </p>
    );
  }
  if (isLoading || !data) return <Loader2 className="size-4 animate-spin text-muted-foreground" />;

  const linked = new Set(data.links.filter((l) => l.status === "CREATED" && l.orderId).map((l) => l.orderId));
  const unpaid = data.unpaidOrders.filter((o) => !linked.has(o.id));

  return (
    <div className="space-y-2.5">
      {data.links.length > 0 && (
        <ul className="space-y-1.5">
          {data.links.map((link) => <LinkRow key={link.id} link={link} conversationId={conversationId} canEdit={canEdit} />)}
        </ul>
      )}
      {canEdit && (
        <div className="space-y-1.5">
          {unpaid.map((order) => (
            <Button key={order.id} size="xs" variant="outline" disabled={create.isPending} onClick={() => create.mutate({ orderId: order.id })}>
              Request {formatCurrency(order.totalPrice, order.currency, { maximumFractionDigits: 0 })} for {order.name}
            </Button>
          ))}
          {custom ? (
            <form
              className="space-y-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                create.mutate({ amount: Number(amount), description: description.trim() }, {
                  onSuccess: () => {
                    setCustom(false);
                    setAmount("");
                    setDescription("");
                  },
                });
              }}
            >
              <Input aria-label="Amount in rupees" inputMode="decimal" placeholder="Amount, e.g. 499" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))} />
              <Input aria-label="What it is for" placeholder="What it is for, e.g. Alteration charges" maxLength={200} value={description} onChange={(e) => setDescription(e.target.value)} />
              <div className="flex gap-1.5">
                <Button type="submit" size="xs" disabled={create.isPending || !(Number(amount) >= 1) || description.trim().length < 2}>
                  {create.isPending && <Loader2 className="animate-spin" />}
                  Make link
                </Button>
                <Button type="button" size="xs" variant="ghost" onClick={() => setCustom(false)}>Cancel</Button>
              </div>
            </form>
          ) : (
            <Button size="xs" variant="ghost" onClick={() => setCustom(true)}>Request another amount</Button>
          )}
          {data.links.length === 0 && unpaid.length === 0 && !custom && (
            <p className="text-micro text-muted-foreground">No unpaid orders for this customer.</p>
          )}
        </div>
      )}
    </div>
  );
}
