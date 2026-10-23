import { useEffect, useState } from "react";
import { AlertTriangle, Loader2, RefreshCw, ShoppingBag, Unlink } from "lucide-react";

import { ChannelBadge } from "~/components/app/channel-badge";
import { SectionCard } from "~/components/app/section-card";
import { WhatsAppPayCard } from "~/components/app/campaigns/whatsapp-pay-card";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { PageHeader, PageHeaderContent, PageHeaderDescription, PageHeaderTitle } from "~/components/ui/page-header";
import { Skeleton } from "~/components/ui/skeleton";
import { Switch } from "~/components/ui/switch";
import { useCatalogMutation } from "~/hooks/use-automation-mutations";
import { useCatalog } from "~/hooks/use-automation-queries";
import { useChannels } from "~/hooks/use-channel-queries";
import { useCurrentRole } from "~/hooks/use-current-role";
import { formatDateTime } from "~/lib/format-date";
import { cn } from "~/lib/utils";

export function meta() {
  return [{ title: "Catalog | Collabo CRM" }];
}

const STATUS_LABEL: Record<string, string> = { SYNCED: "In the catalog", SKIPPED: "Need attention", ERROR: "Refused by Meta", REMOVED: "Removed" };

/**
 * A WhatsApp number's catalog: which Meta catalog it uses, whether customers
 * see it and can send carts, and the store's products kept in it.
 */
export default function CatalogPage() {
  const { data: channels = [] } = useChannels();
  const numbers = channels.filter((c) => c.platform === "WHATSAPP" && c.status === "CONNECTED");
  const [channelId, setChannelId] = useState("");
  useEffect(() => {
    if (!channelId && numbers[0]) setChannelId(numbers[0].id);
  }, [numbers, channelId]);
  const { data, isLoading, isError } = useCatalog(channelId || undefined);
  const act = useCatalogMutation(channelId);
  const { role } = useCurrentRole();
  // Catalog and commerce settings are the number's configuration on Meta: managers only, like on the server.
  const canManage = role === "OWNER" || role === "ADMIN" || role === "MANAGER"; // ORG_MANAGERS
  const [catalogId, setCatalogId] = useState("");

  return (
    <div className="space-y-6">
      <PageHeader>
        <PageHeaderContent>
          <PageHeaderTitle>WhatsApp catalog</PageHeaderTitle>
          <PageHeaderDescription>Let customers browse your products and send carts in WhatsApp, and share products from the inbox and automations.</PageHeaderDescription>
        </PageHeaderContent>
      </PageHeader>

      {numbers.length === 0 ? (
        <p className="rounded-xl border border-dashed p-6 text-center text-caption text-muted-foreground">Connect a WhatsApp number in Settings → Channels first.</p>
      ) : (
        <>
          {numbers.length > 1 && (
            <div className="flex flex-wrap gap-2">
              {numbers.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setChannelId(c.id)}
                  className={cn("flex items-center gap-2 rounded-full border px-3 py-1.5 text-caption", c.id === channelId ? "border-brand bg-brand/10 font-medium" : "hover:bg-muted")}
                >
                  <ChannelBadge platform={c.platform} size={12} />
                  {c.name}
                </button>
              ))}
            </div>
          )}

          {isError ? (
            <p className="text-caption text-danger">The catalog could not be loaded.</p>
          ) : isLoading || !data ? (
            <Skeleton className="h-72 w-full rounded-xl" />
          ) : (
            <div className="grid gap-6 lg:grid-cols-2">
              {data.onBusinessApp && (
                <p className="flex items-start gap-2 rounded-lg bg-warning-subtle p-3 text-caption text-warning lg:col-span-2">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                  This number is shared with the WhatsApp Business app. Meta does not let numbers like this send catalog messages through the API, so products from the inbox go as links. The catalog itself still works in the Business app.
                </p>
              )}

              <SectionCard title="Catalog" icon={<ShoppingBag className="size-4 text-muted-foreground" />}>
                <div className="space-y-4 p-5">
                  {data.catalog ? (
                    <>
                      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-caption">
                        <dt className="text-muted-foreground">Name</dt>
                        <dd>{data.catalog.name ?? "—"}</dd>
                        <dt className="text-muted-foreground">Catalog id</dt>
                        <dd className="font-mono">{data.catalog.catalogId}</dd>
                        <dt className="text-muted-foreground">Items at Meta</dt>
                        <dd>{data.catalog.productCount ?? "—"}</dd>
                        <dt className="text-muted-foreground">Connected</dt>
                        <dd>{formatDateTime(data.catalog.connectedAt)}</dd>
                      </dl>
                      {canManage && (
                        <Button variant="outline" size="sm" disabled={act.isPending} onClick={() => window.confirm("Stop using this catalog here? Products stay in it at Meta.") && act.mutate({ kind: "disconnect" })}>
                          <Unlink />
                          Disconnect
                        </Button>
                      )}
                    </>
                  ) : (
                    <>
                      <ol className="list-decimal space-y-1 pl-4 text-caption text-muted-foreground">
                        <li>Create a catalog in Meta Commerce Manager, or use the one you have.</li>
                        <li>Connect it to this WhatsApp account in WhatsApp Manager (one catalog per account).</li>
                        <li>Paste its catalog id here.</li>
                      </ol>
                      {canManage && (
                        <form
                          className="flex gap-2"
                          onSubmit={(e) => {
                            e.preventDefault();
                            act.mutate({ kind: "connect", catalogId: catalogId.trim() });
                          }}
                        >
                          <Label htmlFor="catalog-id" className="sr-only">
                            Catalog id
                          </Label>
                          <Input id="catalog-id" value={catalogId} onChange={(e) => setCatalogId(e.target.value)} placeholder="Catalog id, e.g. 1234567890123456" inputMode="numeric" />
                          <Button type="submit" variant="accent" disabled={!catalogId.trim() || act.isPending}>
                            {act.isPending && <Loader2 className="animate-spin" />}
                            Connect
                          </Button>
                        </form>
                      )}
                    </>
                  )}
                </div>
              </SectionCard>

              <SectionCard title="In the chat" description="Per number, at Meta.">
                <div className="space-y-4 p-5">
                  {data.commerce ? (
                    <>
                      <div className="flex items-start justify-between gap-4">
                        <Label htmlFor="cat-visible" className="flex flex-col items-start gap-0.5 font-normal">
                          <span className="text-body font-medium">Show the catalog</span>
                          <span className="text-micro text-muted-foreground">A storefront button in the chat header.</span>
                        </Label>
                        <Switch id="cat-visible" checked={data.commerce.catalogVisible} disabled={!canManage || act.isPending} onCheckedChange={(v) => act.mutate({ kind: "settings", catalogVisible: v })} />
                      </div>
                      <div className="flex items-start justify-between gap-4">
                        <Label htmlFor="cat-cart" className="flex flex-col items-start gap-0.5 font-normal">
                          <span className="text-body font-medium">Let customers send carts</span>
                          <span className="text-micro text-muted-foreground">A cart arrives in the inbox and can become a draft order.</span>
                        </Label>
                        <Switch id="cat-cart" checked={data.commerce.cartEnabled} disabled={!canManage || act.isPending} onCheckedChange={(v) => act.mutate({ kind: "settings", cartEnabled: v })} />
                      </div>
                    </>
                  ) : (
                    <p className="text-caption text-muted-foreground">These settings could not be read from Meta{data.commerceError ? `: ${data.commerceError}` : "."}</p>
                  )}
                </div>
              </SectionCard>

              <SectionCard
                className="lg:col-span-2"
                title="Products"
                description="Active store products, one catalog item per variant. Unchanged items are not sent again."
                action={
                  canManage &&
                  data.catalog && (
                    <Button variant="outline" size="sm" disabled={act.isPending} onClick={() => act.mutate({ kind: "sync" })}>
                      {act.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                      Sync products
                    </Button>
                  )
                }
              >
                <div className="space-y-4 p-5">
                  <div className="flex flex-wrap gap-6">
                    {(["SYNCED", "SKIPPED", "ERROR", "REMOVED"] as const).map((k) => (
                      <div key={k}>
                        <p className="text-caption text-muted-foreground">{STATUS_LABEL[k]}</p>
                        <p className="text-section font-semibold tabular-nums">{(data.items[k] ?? 0).toLocaleString("en-IN")}</p>
                      </div>
                    ))}
                  </div>
                  {data.catalog?.lastSync && (
                    <p className="text-caption text-muted-foreground">
                      Last sync {formatDateTime(data.catalog.lastSync.at)}: {data.catalog.lastSync.sent} sent, {data.catalog.lastSync.removed} removed.
                    </p>
                  )}
                  {!data.catalog && <p className="text-caption text-muted-foreground">Connect a catalog to sync products.</p>}
                  {data.problems.length > 0 && (
                    <ul className="divide-y rounded-lg border">
                      {data.problems.map((p) => (
                        <li key={p.variantId} className="flex flex-wrap items-baseline justify-between gap-2 px-3 py-2 text-caption">
                          <span className="font-medium">{p.name}</span>
                          <span className={cn(p.status === "ERROR" ? "text-danger" : "text-warning")}>{p.error ?? STATUS_LABEL[p.status]}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </SectionCard>

              <WhatsAppPayCard className="lg:col-span-2" channelId={channelId} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
