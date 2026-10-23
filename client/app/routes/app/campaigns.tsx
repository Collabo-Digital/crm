import { useState } from "react";
import { Link } from "react-router";
import { Plus, Receipt } from "lucide-react";

import { RatesDialog } from "~/components/app/campaigns/rates-dialog";
import { TemplateStatusBadge } from "~/components/app/campaigns/template-status";
import { QueryErrorState } from "~/components/app/query-error-state";
import { SectionCard } from "~/components/app/section-card";
import { StatCard } from "~/components/app/stat-card";
import { Button } from "~/components/ui/button";
import { PageHeader, PageHeaderActions, PageHeaderContent, PageHeaderDescription, PageHeaderTitle } from "~/components/ui/page-header";
import { Separator } from "~/components/ui/separator";
import { Skeleton } from "~/components/ui/skeleton";
import { useCampaignsOverview } from "~/hooks/use-campaign-queries";
import { useCurrentRole } from "~/hooks/use-current-role";
import { BROADCAST_STATUS_CLASS, BROADCAST_STATUS_LABEL, QUALITY_DOT, QUALITY_LABEL } from "~/lib/campaign-format";
import { formatDateTime } from "~/lib/format-date";
import { cn } from "~/lib/utils";

export function meta() {
  return [{ title: "Campaigns | Collabo CRM" }];
}

const TIER_LABEL: Record<string, string> = {
  TIER_250: "250 people a day",
  TIER_2K: "2,000 people a day",
  TIER_10K: "10,000 people a day",
  TIER_100K: "100,000 people a day",
  TIER_UNLIMITED: "Unlimited",
};

const pct = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}% of sent` : undefined);

/**
 * Campaigns — the last 30 days of WhatsApp broadcasts, template health, and
 * the number's quality and messaging limit, which decide how much it can send.
 */
export default function CampaignsOverviewPage() {
  const { data, isLoading, isError, refetch } = useCampaignsOverview();
  const { can } = useCurrentRole();
  const [ratesOpen, setRatesOpen] = useState(false);
  const stats = data?.last30Days;

  const tiles = stats
    ? [
        { label: "Messages sent", value: stats.sent.toLocaleString("en-IN"), sub: `${stats.broadcasts} broadcasts` },
        { label: "Delivered", value: stats.delivered.toLocaleString("en-IN"), sub: pct(stats.delivered, stats.sent) },
        { label: "Read", value: stats.read.toLocaleString("en-IN"), sub: pct(stats.read, stats.sent) },
        { label: "Replied", value: stats.replied.toLocaleString("en-IN"), sub: pct(stats.replied, stats.sent) },
      ]
    : [];

  return (
    <div className="space-y-6">
      <PageHeader>
        <PageHeaderContent>
          <PageHeaderTitle>Campaigns</PageHeaderTitle>
          <PageHeaderDescription>WhatsApp broadcasts and templates, and how they are landing. Last 30 days.</PageHeaderDescription>
        </PageHeaderContent>
        <PageHeaderActions>
          <Button variant="outline" size="sm" onClick={() => setRatesOpen(true)}>
            <Receipt />
            Message rates
          </Button>
          {can("campaigns.manage") && (
            <Button asChild variant="accent" size="sm">
              <Link to="/campaigns/broadcasts/new">
                <Plus />
                New broadcast
              </Link>
            </Button>
          )}
        </PageHeaderActions>
      </PageHeader>

      {isError ? (
        <QueryErrorState resource="campaigns" onRetry={() => void refetch()} />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-5 rounded-xl bg-card p-3 sm:grid-cols-2 lg:grid-cols-4">
            {isLoading
              ? Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="p-5">
                    <Skeleton className="mb-4 h-3 w-24" />
                    <Skeleton className="h-7 w-20" />
                  </div>
                ))
              : tiles.map((t, i, all) => (
                  <div key={t.label} className="flex items-center gap-4">
                    <StatCard variant="inline" label={t.label} value={t.value} changeLabel={t.sub} className="flex-1" />
                    {i < all.length - 1 && <Separator orientation="vertical" className="hidden h-15 md:block" />}
                  </div>
                ))}
          </div>

          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
            <SectionCard
              title="Recent broadcasts"
              action={
                <Link to="/campaigns/broadcasts" className="text-caption font-medium text-brand-strong hover:text-brand-strong-hover">
                  View all
                </Link>
              }
            >
              {data && data.recent.length === 0 ? (
                <p className="px-5 py-6 text-caption text-muted-foreground">No broadcasts yet.</p>
              ) : (
                <div className="divide-y">
                  {data?.recent.map((b) => (
                    <Link key={b.id} to={`/campaigns/broadcasts/${b.id}`} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5 hover:bg-muted/50">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-body font-medium">{b.name}</p>
                        <p className="text-caption text-muted-foreground">
                          {[b.templateName, formatDateTime(b.startedAt ?? b.scheduledAt ?? b.createdAt)].filter(Boolean).join(" · ")}
                        </p>
                      </div>
                      <span className={cn("rounded-full px-2 py-0.5 text-micro font-medium", BROADCAST_STATUS_CLASS[b.status])}>{BROADCAST_STATUS_LABEL[b.status]}</span>
                    </Link>
                  ))}
                </div>
              )}
            </SectionCard>

            <div className="space-y-6">
              <SectionCard title="WhatsApp number">
                <div className="space-y-3 px-5 py-4 text-caption">
                  {!data?.number ? (
                    <p className="text-muted-foreground">
                      No WhatsApp number connected.{" "}
                      <Link to="/settings/channels" className="font-medium text-foreground underline">
                        Connect one
                      </Link>
                    </p>
                  ) : (
                    <>
                      <p className="font-medium text-foreground">{data.number.name}</p>
                      <div className="flex justify-between gap-2">
                        <span className="text-muted-foreground">Quality</span>
                        <span className="inline-flex items-center gap-1.5">
                          <span className={cn("size-2 rounded-full", QUALITY_DOT[data.number.quality ?? "UNKNOWN"])} />
                          {QUALITY_LABEL[data.number.quality ?? "UNKNOWN"]}
                        </span>
                      </div>
                      <div className="flex justify-between gap-2">
                        <span className="text-muted-foreground">Messaging limit</span>
                        <span>{data.number.messagingLimit ? (TIER_LABEL[data.number.messagingLimit] ?? data.number.messagingLimit) : "Not read yet"}</span>
                      </div>
                      <div className="flex justify-between gap-2">
                        <span className="text-muted-foreground">Marketing Messages API</span>
                        <span>{data.number.marketingMessagesApi === "ONBOARDED" ? "In use" : data.number.marketingMessagesApi ? data.number.marketingMessagesApi.toLowerCase() : "Not set up"}</span>
                      </div>
                      <p className="text-micro text-muted-foreground">
                        Meta is moving marketing messages to the Marketing Messages API. Accept its terms in WhatsApp Manager and Collabo switches over by itself.
                      </p>
                    </>
                  )}
                </div>
              </SectionCard>
              <SectionCard
                title="Templates"
                action={
                  <Link to="/campaigns/templates" className="text-caption font-medium text-brand-strong hover:text-brand-strong-hover">
                    Manage
                  </Link>
                }
              >
                <div className="flex flex-wrap gap-2 px-5 py-4">
                  {data && Object.keys(data.templates).length === 0 && <p className="text-caption text-muted-foreground">No templates synced yet.</p>}
                  {Object.entries(data?.templates ?? {}).map(([status, count]) => (
                    <span key={status} className="inline-flex items-center gap-1.5">
                      <TemplateStatusBadge status={status} />
                      <span className="text-caption tabular-nums">{count}</span>
                    </span>
                  ))}
                </div>
              </SectionCard>
            </div>
          </div>
        </>
      )}
      <RatesDialog open={ratesOpen} onOpenChange={setRatesOpen} />
    </div>
  );
}
