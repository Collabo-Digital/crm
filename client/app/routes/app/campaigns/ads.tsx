import { useEffect, useState } from "react";
import { BarChart3, Loader2, Megaphone, Unlink } from "lucide-react";

import { ChannelBadge } from "~/components/app/channel-badge";
import { SectionCard } from "~/components/app/section-card";
import { Button } from "~/components/ui/button";
import { PageHeader, PageHeaderContent, PageHeaderDescription, PageHeaderTitle } from "~/components/ui/page-header";
import { Skeleton } from "~/components/ui/skeleton";
import { Switch } from "~/components/ui/switch";
import { useAdAccountMutation, useAdsReport, useConversionSettings, useConversionsMutation } from "~/hooks/use-ads";
import { useCurrentRole } from "~/hooks/use-current-role";
import { ensureMetaSdk } from "~/lib/meta-sdk";
import { cn, formatCurrency } from "~/lib/utils";
import { adsService } from "~/services/ads.service";
import type { AdsReport } from "~/types/api";

export function meta() {
  return [{ title: "Ads | Collabo CRM" }];
}

const PERIODS = [7, 30, 90] as const;

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <p className="text-caption text-muted-foreground">{label}</p>
      <p className="mt-1 text-section font-semibold tabular-nums">{value}</p>
      {hint && <p className="mt-0.5 text-micro text-muted-foreground">{hint}</p>}
    </div>
  );
}

function AdFigure({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-micro text-muted-foreground">{label}</dt>
      <dd className="truncate font-medium tabular-nums">{value}</dd>
    </div>
  );
}

function AdAccountCard({ report, canManage }: { report: AdsReport; canManage: boolean }) {
  const act = useAdAccountMutation();
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const account = report.account;

  // Meta's SDK loads only where it is used: here, once connecting is offered,
  // so the click does not also wait for the download before the popup.
  const offerConnect = canManage && !account.connected;
  useEffect(() => {
    if (offerConnect) void ensureMetaSdk();
  }, [offerConnect]);

  const connect = async () => {
    setError(null);
    setLaunching(true);
    try {
      const { configId, state } = await adsService.connectConfig();
      if (!(await ensureMetaSdk()) || !window.FB) throw new Error("Facebook Login could not load. Check VITE_META_APP_ID.");
      window.FB.login(
        (response) => {
          const code = response.authResponse?.code;
          if (code) act.mutate({ kind: "connect", code, state }, { onSettled: () => setLaunching(false) });
          else setLaunching(false);
        },
        { config_id: configId, response_type: "code", override_default_response_type: true },
      );
    } catch (err) {
      setLaunching(false);
      setError(err instanceof Error ? err.message : "The ad account could not be connected.");
    }
  };

  return (
    <SectionCard title="Meta ad account" icon={<BarChart3 className="size-4 text-muted-foreground" />} description="Adds spend, impressions and Meta’s conversation counts to each ad, read with Facebook Login (ads_read).">
      <div className="space-y-3 p-5">
        {!account.connected ? (
          <>
            <p className="text-caption text-muted-foreground">Not connected. Chats, orders and revenue per ad are counted from your chats either way.</p>
            {canManage && (
              <Button size="sm" variant="outline" disabled={launching || act.isPending} onClick={() => void connect()}>
                {(launching || act.isPending) && <Loader2 className="animate-spin" />}
                Connect ad account
              </Button>
            )}
          </>
        ) : (
          <>
            {account.externalId ? (
              <p className="text-caption">
                <span className="font-medium">{account.name}</span> <span className="text-muted-foreground">({account.externalId})</span>
              </p>
            ) : (
              <p className="text-caption text-warning">Choose which ad account to read.</p>
            )}
            {(account.available?.length ?? 0) > 1 && canManage && (
              <select
                aria-label="Ad account"
                className="h-9 w-full max-w-sm rounded-md border bg-background px-2 text-sm"
                value={account.externalId ?? ""}
                onChange={(e) => e.target.value && act.mutate({ kind: "choose", externalId: e.target.value })}
              >
                <option value="">Choose an ad account</option>
                {account.available!.map((a) => <option key={a.id} value={a.id}>{a.name} · {a.currency ?? ""}</option>)}
              </select>
            )}
            {report.metaError && <p className="text-caption text-warning">Meta did not return results: {report.metaError}</p>}
            {canManage && (
              <Button size="sm" variant="ghost" disabled={act.isPending} onClick={() => window.confirm("Disconnect the ad account? Spend and Meta’s counts stop showing; chats and orders per ad stay.") && act.mutate({ kind: "disconnect" })}>
                <Unlink />
                Disconnect
              </Button>
            )}
          </>
        )}
        {error && <p className="text-caption text-danger">{error}</p>}
      </div>
    </SectionCard>
  );
}

function ConversionsCard({ canManage }: { canManage: boolean }) {
  const { data = [], isLoading } = useConversionSettings();
  const toggle = useConversionsMutation();
  return (
    <SectionCard title="Report purchases to Meta" icon={<Megaphone className="size-4 text-muted-foreground" />} description="A payment made in the chat (payment link or WhatsApp Pay) by someone who came from a click-to-WhatsApp ad in the last 7 days is sent to Meta’s Conversions API once, so Meta can optimise ads for purchases.">
      <div className="space-y-3 p-5">
        {isLoading ? (
          <Skeleton className="h-10 w-full" />
        ) : data.length === 0 ? (
          <p className="text-caption text-muted-foreground">Connect a WhatsApp number first.</p>
        ) : (
          data.map((n) => (
            <div key={n.channelId} className="flex items-center justify-between gap-4">
              <div>
                <p className="text-body font-medium">{n.name}</p>
                <p className="text-micro text-muted-foreground">
                  {n.enabled ? `Dataset ${n.datasetId} · ${n.sent} sent${n.failed ? ` · ${n.failed} failed` : ""}` : "Off"}
                </p>
              </div>
              <Switch checked={n.enabled} disabled={!canManage || toggle.isPending} onCheckedChange={(enabled) => toggle.mutate({ channelId: n.channelId, enabled })} aria-label={`Report purchases for ${n.name}`} />
            </div>
          ))
        )}
        <p className="text-micro text-muted-foreground">Only payments collected in the chat are sent: Meta asks that messaging events happen in the conversation. Website orders are counted on this page, not sent.</p>
      </div>
    </SectionCard>
  );
}

/** Campaigns → Ads: what each click-to-message ad brought in. */
export default function AdsPage() {
  const [days, setDays] = useState<(typeof PERIODS)[number]>(30);
  const { data, isLoading, isError } = useAdsReport(days);
  const { role, can } = useCurrentRole();
  const canManage = role === "OWNER" || role === "ADMIN" || role === "MANAGER";
  const canReport = role === "OWNER" || role === "ADMIN";
  const money = (n: number | null | undefined) => (n === null || n === undefined ? "—" : formatCurrency(n, data?.currency ?? "INR", { maximumFractionDigits: 0 }));
  const roas = data?.totals.spend ? data.totals.revenue / data.totals.spend : null;

  return (
    <div className="space-y-6">
      <PageHeader>
        <PageHeaderContent>
          <PageHeaderTitle>Ads</PageHeaderTitle>
          <PageHeaderDescription>Chats, orders and revenue from your click-to-WhatsApp, Messenger and Instagram ads.</PageHeaderDescription>
        </PageHeaderContent>
      </PageHeader>

      <div className="flex gap-1.5" role="group" aria-label="Period">
        {PERIODS.map((p) => (
          <Button key={p} size="sm" variant={p === days ? "default" : "outline"} onClick={() => setDays(p)}>
            Last {p} days
          </Button>
        ))}
      </div>

      {isError ? (
        <p className="text-caption text-danger">The ads report could not be loaded.</p>
      ) : isLoading || !data ? (
        <Skeleton className="h-72 w-full rounded-xl" />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Chats from ads" value={data.totals.chats.toLocaleString("en-IN")} hint="People, counted once per ad" />
            <Stat label="Orders" value={data.totals.orders.toLocaleString("en-IN")} hint="Within 7 days of the chat" />
            <Stat label="Revenue" value={money(data.totals.revenue)} />
            <Stat label="Spend" value={money(data.totals.spend)} hint={roas !== null ? `${roas.toFixed(1)}× return on ad spend` : data.account.connected ? undefined : "Connect the ad account"} />
          </div>

          <SectionCard title="Per ad" description={`The ${days} days to now, in ${data.period.timeZone}. Revenue is what those people ordered within 7 days of starting the chat.`}>
            {data.ads.length === 0 ? (
              <p className="p-5 text-caption text-muted-foreground">No chats from ads in this period yet. They appear here as soon as someone taps a click-to-message ad.</p>
            ) : (
              <>
                <ul className="divide-y md:hidden">
                  {data.ads.map((a) => (
                    <li key={a.adId} className="space-y-2 px-5 py-3 text-caption">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          {a.platform && <ChannelBadge platform={a.platform} size={11} />}
                          <span className="truncate font-medium">{a.name ?? a.headline ?? `Ad ${a.adId}`}</span>
                        </div>
                        <p className="truncate text-micro text-muted-foreground">{[a.campaign, a.name && a.headline ? a.headline : null, a.adId].filter(Boolean).join(" · ")}</p>
                      </div>
                      <dl className="grid grid-cols-3 gap-x-3 gap-y-2">
                        <AdFigure label="Chats" value={a.chats.toLocaleString("en-IN")} />
                        <AdFigure label="Orders" value={a.orders.toLocaleString("en-IN")} />
                        <AdFigure label="Revenue" value={money(a.revenue)} />
                        {a.spend !== null && (
                          <>
                            <AdFigure label="Spend" value={money(a.spend)} />
                            <AdFigure label="Cost per chat" value={a.spend && a.chats ? money(a.spend / a.chats) : "—"} />
                            <AdFigure label="Return" value={a.spend ? `${(a.revenue / a.spend).toFixed(1)}×` : "—"} />
                          </>
                        )}
                      </dl>
                    </li>
                  ))}
                </ul>
                <div className="hidden overflow-x-auto md:block">
                  <table className="w-full text-caption">
                    <thead className="text-left text-muted-foreground">
                      <tr className="border-b">
                        <th className="px-4 py-2 font-medium">Ad</th>
                        <th className="px-3 py-2 text-right font-medium">Chats</th>
                        <th className="px-3 py-2 text-right font-medium">Orders</th>
                        <th className="px-3 py-2 text-right font-medium">Revenue</th>
                        <th className="px-3 py-2 text-right font-medium">Spend</th>
                        <th className="px-3 py-2 text-right font-medium" title="Meta's “Messaging conversations started”">Meta conversations</th>
                        <th className="px-3 py-2 text-right font-medium">Cost per chat</th>
                        <th className="px-4 py-2 text-right font-medium">Return</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.ads.map((a) => (
                        <tr key={a.adId} className="border-b last:border-0">
                          <td className="max-w-xs px-4 py-2.5">
                            <div className="flex items-center gap-1.5">
                              {a.platform && <ChannelBadge platform={a.platform} size={11} />}
                              <span className="truncate font-medium">{a.name ?? a.headline ?? `Ad ${a.adId}`}</span>
                            </div>
                            <p className="truncate text-micro text-muted-foreground">{[a.campaign, a.name && a.headline ? a.headline : null, a.adId].filter(Boolean).join(" · ")}</p>
                          </td>
                          <td className="px-3 py-2.5 text-right tabular-nums">{a.chats.toLocaleString("en-IN")}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums">{a.orders.toLocaleString("en-IN")}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums">{money(a.revenue)}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums">{money(a.spend)}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums">{a.conversationsStarted === null ? "—" : a.conversationsStarted.toLocaleString("en-IN")}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums">{a.spend && a.chats ? money(a.spend / a.chats) : "—"}</td>
                          <td className={cn("px-4 py-2.5 text-right tabular-nums", a.spend && a.revenue >= a.spend ? "text-success" : "")}>{a.spend ? `${(a.revenue / a.spend).toFixed(1)}×` : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </SectionCard>

          <div className="grid gap-6 lg:grid-cols-2">
            <AdAccountCard report={data} canManage={canManage && can("campaigns.view")} />
            <ConversionsCard canManage={canReport} />
          </div>
        </>
      )}
    </div>
  );
}
