import { useState } from "react";
import { Check, Copy, KeyRound, Loader2 } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { useCurrentRole } from "~/hooks/use-current-role";
import { useConnectRazorpayMutation, useDisconnectRazorpayMutation, usePaymentAccount, useRotateWebhookSecretMutation } from "~/hooks/use-payments";
import { formatDateTime } from "~/lib/format-date";

const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) || "/api/v1";

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-1">
      <p className="text-[11px] font-medium text-muted-foreground">{label}</p>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-1.5 text-xs">{value}</code>
        <Button
          size="xs"
          variant="ghost"
          aria-label={`Copy ${label.toLowerCase()}`}
          onClick={() => {
            void navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? <Check /> : <Copy />}
        </Button>
      </div>
    </div>
  );
}

/**
 * The organization's own Razorpay account, so payment links sent in chat are
 * paid straight to the merchant. Owners and admins connect it; the webhook
 * secret is shown when it is made, to paste into Razorpay.
 */
export function PaymentsCard() {
  const { role } = useCurrentRole();
  const canManage = role === "OWNER" || role === "ADMIN";
  const { data: account, isLoading } = usePaymentAccount();
  const connect = useConnectRazorpayMutation();
  const rotate = useRotateWebhookSecretMutation();
  const disconnect = useDisconnectRazorpayMutation();
  const [keyId, setKeyId] = useState("");
  const [keySecret, setKeySecret] = useState("");
  const [editing, setEditing] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);

  const webhookUrl = account?.webhookToken
    ? `${API_BASE.startsWith("http") ? API_BASE : `${window.location.origin}${API_BASE}`}/webhooks/razorpay/merchant/${account.webhookToken}`
    : null;

  return (
    <section className="rounded-xl bg-white dark:bg-gray-900 shadow-sm ring-1 ring-border">
      <div className="px-5 py-4">
        <p className="text-sm font-medium text-gray-900 dark:text-gray-100">Payments with your Razorpay account</p>
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
          Payment links sent in chat, by your team or by automations, are made in your own Razorpay account, so customers pay you directly. A paid link marks the order paid, in Shopify too, or turns a cart’s draft order into an order.
        </p>
      </div>

      {isLoading ? (
        <div className="flex justify-center px-5 pb-5"><Loader2 className="size-4 animate-spin text-muted-foreground" /></div>
      ) : account?.connected && !editing ? (
        <div className="space-y-4 border-t px-5 py-4">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <span className="font-medium">{account.keyId}</span>
            <span className={account.livemode ? "text-success" : "text-warning"}>{account.livemode ? "Live keys" : "Test keys — no real money moves"}</span>
            <span className="text-xs text-muted-foreground">
              {account.lastWebhookAt ? `Last update from Razorpay ${formatDateTime(account.lastWebhookAt)}` : "No update from Razorpay yet"}
            </span>
          </div>
          {canManage && webhookUrl && (
            <div className="space-y-3 rounded-lg border border-dashed p-3">
              <p className="text-xs text-muted-foreground">
                In Razorpay → Account & Settings → Webhooks, add a webhook with this URL, the secret below, and the events{" "}
                {account.webhookEvents.map((e) => <code key={e} className="mx-0.5 rounded bg-muted px-1">{e}</code>)}.
                Without it, payments are still picked up, but only every ten minutes or when someone checks a link.
              </p>
              <CopyField label="Webhook URL" value={webhookUrl} />
              {secret ? (
                <CopyField label="Webhook secret (shown only now)" value={secret} />
              ) : (
                <Button size="xs" variant="outline" disabled={rotate.isPending} onClick={() => rotate.mutate(undefined, { onSuccess: (r) => setSecret(r.webhookSecret) })}>
                  <KeyRound />
                  Make a new webhook secret
                </Button>
              )}
            </div>
          )}
          {canManage && (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => setEditing(true)}>Change keys</Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={disconnect.isPending}
                onClick={() => {
                  if (window.confirm("Disconnect Razorpay? Links already sent can still be paid in Razorpay, but Collabo will no longer see those payments.")) disconnect.mutate();
                }}
              >
                Disconnect
              </Button>
            </div>
          )}
        </div>
      ) : canManage ? (
        <form
          className="space-y-3 border-t px-5 py-4"
          onSubmit={(e) => {
            e.preventDefault();
            connect.mutate({ keyId, keySecret }, {
              onSuccess: (r) => {
                setSecret(r.webhookSecret);
                setEditing(false);
                setKeySecret("");
              },
            });
          }}
        >
          <p className="text-xs text-muted-foreground">
            In Razorpay → Account & Settings → API keys, generate a key and paste both parts here. The secret is stored encrypted and never shown again. Use test keys first if you want to try it.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="rzp-key-id">Key id</Label>
              <Input id="rzp-key-id" placeholder="rzp_live_…" autoComplete="off" value={keyId} onChange={(e) => setKeyId(e.target.value.trim())} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rzp-key-secret">Key secret</Label>
              <Input id="rzp-key-secret" type="password" autoComplete="new-password" value={keySecret} onChange={(e) => setKeySecret(e.target.value)} />
            </div>
          </div>
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={connect.isPending || !keyId || keySecret.length < 8}>
              {connect.isPending && <Loader2 className="animate-spin" />}
              {account?.connected ? "Save new keys" : "Connect Razorpay"}
            </Button>
            {editing && <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>}
          </div>
        </form>
      ) : (
        <p className="border-t px-5 py-4 text-xs text-muted-foreground">Not connected. An owner or admin can connect your Razorpay account here.</p>
      )}
    </section>
  );
}
