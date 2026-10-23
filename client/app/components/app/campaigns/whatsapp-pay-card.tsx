import { useState } from "react";
import { ExternalLink, Loader2, Wallet } from "lucide-react";

import { SectionCard } from "~/components/app/section-card";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { useCurrentRole } from "~/hooks/use-current-role";
import { useWhatsAppPay, useWhatsAppPayMutation } from "~/hooks/use-payments";
import { cn } from "~/lib/utils";

const selectClass = "h-9 rounded-md border bg-background px-2 text-sm";
const PROVIDERS: Array<[string, string]> = [["razorpay", "Razorpay"], ["payu", "PayU"], ["billdesk", "BillDesk"], ["zaakpay", "Zaakpay"]];

/**
 * WhatsApp Pay (India) for one number: the payment configurations its
 * WhatsApp account has in WhatsApp Manager, each linked to the merchant's own
 * gateway, and which one "Review and Pay" bills use.
 */
export function WhatsAppPayCard({ channelId, className }: { channelId: string; className?: string }) {
  const { role } = useCurrentRole();
  const canManage = role === "OWNER" || role === "ADMIN";
  const { data, isLoading } = useWhatsAppPay(channelId || undefined);
  const act = useWhatsAppPayMutation(channelId);
  const [name, setName] = useState("");
  const [provider, setProvider] = useState("razorpay");
  const [oauthUrl, setOauthUrl] = useState<string | null>(null);

  const openLink = (result: { link?: { oauthUrl: string | null } }) => {
    const url = result.link?.oauthUrl ?? null;
    setOauthUrl(url);
    if (url) window.open(url, "_blank", "noopener");
  };

  return (
    <SectionCard
      className={className}
      title="WhatsApp Pay"
      icon={<Wallet className="size-4 text-muted-foreground" />}
      description="India only. Customers review the bill and pay inside WhatsApp, through your own gateway linked in WhatsApp Manager."
    >
      <div className="space-y-4 p-5">
        {isLoading || !data ? (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        ) : (
          <>
            {data.selected ? (
              <p className="text-caption">
                Bills use <span className="font-medium">{data.selected.configurationName}</span> ({data.selected.provider}) ·{" "}
                <span className={data.selected.active ? "text-success" : "text-warning"}>{data.selected.active ? "Active" : data.selected.status.replace("_", " ")}</span>
              </p>
            ) : (
              <p className="text-caption text-muted-foreground">Off. Choose an active payment configuration to send WhatsApp Pay bills from the inbox and from automations.</p>
            )}
            {data.error && <p className="text-caption text-warning">Meta did not list this account’s payment configurations: {data.error}</p>}
            {data.configurations.length > 0 && (
              <ul className="divide-y rounded-lg border">
                {data.configurations.map((c) => {
                  const chosen = data.selected?.configurationName === c.name;
                  return (
                    <li key={c.name} className="flex flex-wrap items-center gap-2 px-3 py-2 text-caption">
                      <span className="font-medium">{c.name}</span>
                      <span className="text-muted-foreground">{c.provider ?? "UPI"}</span>
                      <span className={cn("rounded-full px-1.5 py-0.5 text-micro font-medium", c.active ? "bg-success-subtle text-success" : "bg-warning-subtle text-warning-strong")}>
                        {c.active ? "Active" : c.status.replace("_", " ")}
                      </span>
                      {canManage && (
                        <span className="ml-auto flex gap-1.5">
                          {!c.active && c.provider && (
                            <Button size="xs" variant="ghost" disabled={act.isPending} onClick={() => act.mutate({ kind: "link", name: c.name }, { onSuccess: openLink })}>
                              <ExternalLink />
                              Connect gateway
                            </Button>
                          )}
                          {chosen ? (
                            <Button size="xs" variant="ghost" disabled={act.isPending} onClick={() => act.mutate({ kind: "select", name: null })}>Turn off</Button>
                          ) : (
                            <Button size="xs" variant="outline" disabled={act.isPending || !c.active} onClick={() => act.mutate({ kind: "select", name: c.name })}>Use for bills</Button>
                          )}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {canManage && (
              <form
                className="flex flex-wrap items-end gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  act.mutate({ kind: "create", name: name.trim(), provider }, { onSuccess: (r) => { openLink(r); setName(""); } });
                }}
              >
                <div className="w-full space-y-1.5 sm:w-auto">
                  <Label htmlFor="wp-name">New configuration</Label>
                  <Input id="wp-name" placeholder="acme-razorpay" value={name} maxLength={60} onChange={(e) => setName(e.target.value.replace(/[^A-Za-z0-9_-]/g, "-"))} />
                </div>
                <select aria-label="Gateway" className={selectClass} value={provider} onChange={(e) => setProvider(e.target.value)}>
                  {PROVIDERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
                <Button type="submit" size="sm" variant="outline" disabled={act.isPending || name.trim().length < 3}>
                  {act.isPending && <Loader2 className="animate-spin" />}
                  Create and connect
                </Button>
              </form>
            )}
            {oauthUrl && (
              <p className="text-micro text-muted-foreground">
                Finish linking your gateway account in the tab that opened (or{" "}
                <a href={oauthUrl} target="_blank" rel="noreferrer" className="underline">open it again</a>), then test the configuration in WhatsApp Manager. It shows as Active here once Meta reports it.
              </p>
            )}
            <p className="text-micro text-muted-foreground">
              Needs a verified business with WhatsApp’s payments terms accepted. A bill can be sent within 24 hours of the customer’s last message and needs a delivery address in India; payment links work any time, without one.
            </p>
          </>
        )}
      </div>
    </SectionCard>
  );
}
