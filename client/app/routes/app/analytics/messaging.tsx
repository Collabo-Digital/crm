import { Suspense, lazy, useState } from "react";
import { Link } from "react-router";
import { isAxiosError } from "axios";
import { Download, Loader2, Table2 } from "lucide-react";

import { SERIES, VIZ_COLORS } from "~/components/app/analytics/messaging-volume-chart";
import { SectionCard } from "~/components/app/section-card";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { useChannels } from "~/hooks/use-channel-queries";
import { useMessagingAnalytics } from "~/hooks/use-messaging-analytics";
import { handleMutationError } from "~/lib/handle-mutation-error";
import { cn } from "~/lib/utils";
import { messagingAnalyticsService } from "~/services/messaging-analytics.service";
import type { MessagingAnalytics } from "~/types/api";

const MessagingVolumeChart = lazy(() => import("~/components/app/analytics/messaging-volume-chart").then((m) => ({ default: m.MessagingVolumeChart })));

export function meta() {
  return [{ title: "Messaging analytics | Collabo CRM" }];
}

const PERIODS = [7, 30, 90] as const;
const SOURCE_LABEL: Record<string, string> = {
  AGENT: "Team in the inbox",
  AUTOMATION: "Automations",
  BROADCAST: "Broadcasts",
  SYSTEM: "Welcome and away messages",
  BUSINESS_APP: "WhatsApp Business app",
  OTHER_APP: "Other apps",
};
const PLATFORM_LABEL: Record<string, string> = { WHATSAPP: "WhatsApp", INSTAGRAM: "Instagram", FACEBOOK: "Messenger" };

const num = (n: number) => n.toLocaleString("en-IN");
const count = (n: number, one: string, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;
const pct = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : "—");

function formatDuration(sec: number | null): string {
  if (sec === null) return "—";
  if (sec < 60) return `${Math.max(1, Math.round(sec))}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m ${Math.round(sec % 60)}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function money(amount: number, currency: string) {
  try {
    return new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: amount < 10 ? 2 : 0 }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

/** Stat tile: label, value (proportional figures), optional note. */
function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <p className="text-caption text-muted-foreground">{label}</p>
      <p className="mt-1 text-section font-semibold">{value}</p>
      {sub && <p className="mt-0.5 text-micro text-muted-foreground">{sub}</p>}
    </div>
  );
}

/** One series, so one colour: thin bars from a shared baseline, value at the tip. */
function BarList({ rows, total }: { rows: Array<{ label: string; value: number; note?: string }>; total?: number }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="space-y-3">
      {rows.map((r) => (
        <li key={r.label} className="grid grid-cols-[minmax(7rem,12rem)_1fr] items-center gap-3 text-caption">
          <span className="truncate text-muted-foreground">{r.label}</span>
          <span className="flex items-center gap-2">
            <span className="h-2.5 rounded-r-[4px] bg-[var(--viz-1)]" style={{ width: `${(r.value / max) * 85}%`, minWidth: r.value ? 4 : 0 }} aria-hidden />
            <span className="whitespace-nowrap tabular-nums text-foreground">
              {num(r.value)}
              {total !== undefined && <span className="text-muted-foreground"> · {pct(r.value, total)}</span>}
              {r.note && <span className="text-muted-foreground"> · {r.note}</span>}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Who answered each waiting customer first: one bar, three parts, 2px gaps, legend with values. */
function AnsweredBar({ r }: { r: MessagingAnalytics["responses"] }) {
  const parts = [
    { label: "A person", value: r.answeredByPerson, className: "bg-[var(--viz-1)]" },
    { label: "An automation or auto-reply", value: r.firstAnswerByAutomation, className: "bg-[var(--viz-2)]" },
    { label: "Not answered yet", value: r.unanswered, className: "bg-muted-foreground/40" },
  ];
  return (
    <div className="space-y-3">
      <div className="flex h-3 w-full gap-[2px] overflow-hidden rounded-[4px]" role="img" aria-label={parts.map((p) => `${p.label}: ${p.value}`).join(", ")}>
        {r.asked === 0 ? (
          <span className="h-full w-full bg-muted" />
        ) : (
          parts.filter((p) => p.value > 0).map((p) => <span key={p.label} className={cn("h-full", p.className)} style={{ width: `${(p.value / r.asked) * 100}%` }} title={`${p.label}: ${p.value}`} />)
        )}
      </div>
      <ul className="flex flex-wrap gap-x-5 gap-y-1 text-caption">
        {parts.map((p) => (
          <li key={p.label} className="flex items-center gap-1.5">
            <span className={cn("size-2.5 rounded-sm", p.className)} aria-hidden />
            <span className="font-semibold tabular-nums">{num(p.value)}</span>
            <span className="text-muted-foreground">{p.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Analytics → Messaging: volume, response times, team, campaigns, revenue and Meta cost for one period. */
export default function MessagingAnalyticsPage() {
  const [days, setDays] = useState<(typeof PERIODS)[number]>(30);
  const [channelId, setChannelId] = useState("");
  const [asTable, setAsTable] = useState(false);
  const [downloading, setDownloading] = useState<"agents" | "daily" | null>(null);
  const params = { days, ...(channelId ? { channelId } : {}) };
  const { data, isLoading, isError, error, isPlaceholderData } = useMessagingAnalytics(params);
  const { data: channels = [] } = useChannels();
  const messaging = channels.filter((c) => ["WHATSAPP", "INSTAGRAM", "FACEBOOK"].includes(c.platform));
  const forbidden = isAxiosError(error) && error.response?.status === 403;

  const download = async (kind: "agents" | "daily") => {
    setDownloading(kind);
    try {
      await messagingAnalyticsService.download(kind, params);
    } catch (err) {
      handleMutationError(err, "The file was not downloaded.");
    } finally {
      setDownloading(null);
    }
  };

  return (
    <div className={cn("space-y-6", VIZ_COLORS)}>
      <div>
        <h1 className="text-xl font-bold text-foreground">Messaging</h1>
        <p className="text-sm text-muted-foreground">WhatsApp, Instagram and Messenger: how much comes in, how fast it is answered, and what it brings in.</p>
      </div>

      {/* One filter row; everything below follows it. */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg bg-muted p-0.5" role="tablist" aria-label="Period">
          {PERIODS.map((p) => (
            <button
              key={p}
              type="button"
              role="tab"
              aria-selected={days === p}
              onClick={() => setDays(p)}
              className={cn("rounded-md px-3 py-1 text-caption font-medium", days === p ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground")}
            >
              Last {p} days
            </button>
          ))}
        </div>
        <select className="h-8 rounded-lg border bg-background px-2 text-caption" value={channelId} onChange={(e) => setChannelId(e.target.value)} aria-label="Channel">
          <option value="">All channels</option>
          {messaging.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} ({PLATFORM_LABEL[c.platform] ?? c.platform})
            </option>
          ))}
        </select>
        <div className="ml-auto flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void download("daily")} disabled={!!downloading || forbidden}>
            {downloading === "daily" ? <Loader2 className="animate-spin" /> : <Download />}
            Daily CSV
          </Button>
          <Button variant="outline" size="sm" onClick={() => void download("agents")} disabled={!!downloading || forbidden}>
            {downloading === "agents" ? <Loader2 className="animate-spin" /> : <Download />}
            Team CSV
          </Button>
        </div>
      </div>

      {forbidden ? (
        <p className="rounded-xl border border-dashed p-6 text-center text-caption text-muted-foreground">Messaging analytics are for owners, admins and managers.</p>
      ) : isError && !data ? (
        <p className="text-caption text-danger">Messaging analytics could not be loaded.</p>
      ) : isLoading || !data ? (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-24 rounded-xl" />
            ))}
          </div>
          <Skeleton className="h-[320px] rounded-xl" />
        </div>
      ) : (
        // A new period keeps the last result on screen, dimmed, instead of flashing skeletons.
        <div className={cn("space-y-6 transition-opacity", isPlaceholderData && "opacity-60")}>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
            <Tile label="Messages in" value={num(data.volume.inbound)} sub={data.volume.comments ? `plus ${num(data.volume.comments)} comments` : undefined} />
            <Tile label="Messages out" value={num(data.volume.outbound)} />
            <Tile label="People who wrote" value={num(data.volume.activeConversations)} sub={`${num(data.volume.newPeople)} for the first time`} />
            <Tile label="First reply by a person" value={formatDuration(data.responses.medianFirstReplySec)} sub={data.responses.answeredByPerson ? `median · 90% within ${formatDuration(data.responses.p90FirstReplySec)}` : "no replies yet"} />
            <Tile label="Time to close" value={formatDuration(data.resolution.medianSec)} sub={data.resolution.timed ? `median of ${num(data.resolution.timed)} closed` : `${num(data.resolution.closed)} closed`} />
            <Tile label="Revenue after messages" value={money(data.revenue.revenue, data.revenue.currency)} sub={`${count(data.revenue.orders, "order")} within ${data.revenue.windowDays} days`} />
          </div>

          <SectionCard
            title="Messages per day"
            description={`Days in ${data.period.timeZone}. Hover a day for its numbers.`}
            action={
              <div className="flex items-center gap-3">
                <ul className="flex items-center gap-3 text-caption">
                  {SERIES.map((s) => (
                    <li key={s.key} className="flex items-center gap-1.5">
                      <span className="h-0.5 w-3.5 rounded-full" style={{ background: s.color }} aria-hidden />
                      <span className="text-muted-foreground">{s.label}</span>
                    </li>
                  ))}
                </ul>
                <Button variant={asTable ? "accent" : "ghost"} size="xs" aria-pressed={asTable} onClick={() => setAsTable(!asTable)}>
                  <Table2 />
                  Table
                </Button>
              </div>
            }
          >
            <div className="px-3 py-4 sm:px-5">
              {asTable ? (
                <div className="max-h-[260px] overflow-y-auto">
                  <table className="w-full text-caption">
                    <thead className="text-left text-muted-foreground">
                      <tr>
                        <th className="py-1 font-medium">Day</th>
                        <th className="py-1 text-right font-medium">Messages in</th>
                        <th className="py-1 text-right font-medium">Messages out</th>
                      </tr>
                    </thead>
                    <tbody className="tabular-nums">
                      {[...data.volume.daily].reverse().map((d) => (
                        <tr key={d.day} className="border-t">
                          <td className="py-1">{d.day}</td>
                          <td className="py-1 text-right">{num(d.inbound)}</td>
                          <td className="py-1 text-right">{num(d.outbound)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Suspense fallback={<Skeleton className="h-[260px] w-full" />}>
                  <MessagingVolumeChart daily={data.volume.daily} />
                </Suspense>
              )}
            </div>
          </SectionCard>

          <div className="grid gap-6 lg:grid-cols-2">
            <SectionCard title="Who answered first" description={`${data.responses.asked === 1 ? "Once" : `${num(data.responses.asked)} times`} a customer wrote and waited for an answer.`}>
              <div className="space-y-4 p-5">
                <AnsweredBar r={data.responses} />
                <p className="text-caption text-muted-foreground">
                  {num(data.responses.within1h)} of {num(data.responses.answeredByPerson)} personal replies came within an hour. Times are on the clock, not business hours.
                </p>
              </div>
            </SectionCard>
            <SectionCard title="Messages out, by sender">
              <div className="p-5">
                <BarList
                  total={data.volume.outbound}
                  rows={Object.entries(data.volume.outboundBySource)
                    .sort(([, a], [, b]) => (b ?? 0) - (a ?? 0))
                    .map(([source, value]) => ({ label: SOURCE_LABEL[source] ?? source, value: value ?? 0 }))}
                />
                {data.volume.byPlatform.length > 1 && (
                  <p className="mt-4 text-micro text-muted-foreground">
                    {data.volume.byPlatform.map((p) => `${PLATFORM_LABEL[p.platform] ?? p.platform}: ${num(p.inbound)} in, ${num(p.outbound)} out`).join(" · ")}
                  </p>
                )}
              </div>
            </SectionCard>
          </div>

          <SectionCard title="Team" description="Replies sent from the inbox, and how fast each person answered a waiting customer.">
            {data.agents.length === 0 ? (
              <p className="px-5 py-6 text-caption text-muted-foreground">No team members can reply yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[40rem] text-caption">
                  <thead className="border-b text-left text-muted-foreground">
                    <tr>
                      <th className="px-5 py-2 font-medium">Team member</th>
                      <th className="px-3 py-2 text-right font-medium">Replies</th>
                      <th className="px-3 py-2 text-right font-medium">Conversations</th>
                      <th className="px-3 py-2 text-right font-medium">Median first reply</th>
                      <th className="px-3 py-2 text-right font-medium">Closed</th>
                      <th className="px-5 py-2 text-right font-medium">Open now</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y tabular-nums">
                    {data.agents.map((a) => (
                      <tr key={a.userId}>
                        <td className="px-5 py-2">
                          <span className="font-medium">{a.name}</span>
                          <span className="ml-2 text-micro text-muted-foreground">{a.role.toLowerCase()}</span>
                        </td>
                        <td className="px-3 py-2 text-right">{num(a.replies)}</td>
                        <td className="px-3 py-2 text-right">{num(a.conversations)}</td>
                        <td className="px-3 py-2 text-right">
                          {formatDuration(a.medianFirstReplySec)}
                          {a.firstReplies > 0 && <span className="text-muted-foreground"> · {num(a.firstReplies)}</span>}
                        </td>
                        <td className="px-3 py-2 text-right">{num(a.closed)}</td>
                        <td className="px-5 py-2 text-right">{num(a.openNow)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>

          <div className="grid gap-6 lg:grid-cols-2">
            <SectionCard title="Broadcasts" description={`${num(data.broadcasts.count)} started in this period, ${count(data.broadcasts.recipients, "person", "people")} in their audiences.`}>
              <div className="space-y-4 p-5">
                <BarList
                  total={data.broadcasts.sent}
                  rows={[
                    { label: "Sent", value: data.broadcasts.sent },
                    { label: "Delivered", value: data.broadcasts.delivered },
                    { label: "Read", value: data.broadcasts.read },
                    { label: "Replied", value: data.broadcasts.replied },
                    { label: "Tapped a button", value: data.broadcasts.clicked },
                  ]}
                />
                <p className="text-micro text-muted-foreground">
                  Percentages are of messages sent. {num(data.broadcasts.failed)} failed and {num(data.broadcasts.skipped)} were left out (no consent, blocked or unreachable).
                </p>
                {data.broadcasts.items.length > 0 && (
                  <ul className="divide-y rounded-lg border text-caption">
                    {data.broadcasts.items.slice(0, 5).map((b) => (
                      <li key={b.id} className="flex items-center justify-between gap-3 px-3 py-2">
                        <Link to={`/campaigns/broadcasts/${b.id}`} className="truncate font-medium hover:underline">
                          {b.name}
                        </Link>
                        <span className="shrink-0 tabular-nums text-muted-foreground">
                          {num(b.sent)} sent · {pct(b.read, b.sent)} read
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </SectionCard>
            <SectionCard title="Automations" description="Runs started in this period.">
              {data.automations.length === 0 ? (
                <p className="px-5 py-6 text-caption text-muted-foreground">No automation ran in this period.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[28rem] text-caption">
                    <thead className="border-b text-left text-muted-foreground">
                      <tr>
                        <th className="px-5 py-2 font-medium">Automation</th>
                        <th className="px-3 py-2 text-right font-medium">Started</th>
                        <th className="px-3 py-2 text-right font-medium">Finished</th>
                        <th className="px-3 py-2 text-right font-medium">Stopped</th>
                        <th className="px-5 py-2 text-right font-medium">Messages read</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y tabular-nums">
                      {data.automations.slice(0, 10).map((a) => (
                        <tr key={a.id}>
                          <td className="max-w-[14rem] truncate px-5 py-2">
                            <Link to={`/campaigns/automations/${a.id}`} className="font-medium hover:underline">
                              {a.name}
                            </Link>
                          </td>
                          <td className="px-3 py-2 text-right">{num(a.started)}</td>
                          <td className="px-3 py-2 text-right">{num(a.completed)}</td>
                          <td className="px-3 py-2 text-right">{num(a.failed)}</td>
                          <td className="px-5 py-2 text-right">
                            {num(a.messagesRead)}
                            <span className="text-muted-foreground"> / {num(a.messagesSent)}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </SectionCard>
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <SectionCard
              title="Revenue after messages"
              description={`Store orders placed within ${data.revenue.windowDays} days of a broadcast or automation message, credited to the latest one.`}
            >
              <div className="space-y-4 p-5">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <p className="text-caption text-muted-foreground">From broadcasts</p>
                    <p className="text-section font-semibold">{money(data.revenue.bySource.broadcast.revenue, data.revenue.currency)}</p>
                    <p className="text-micro text-muted-foreground">{count(data.revenue.bySource.broadcast.orders, "order")}</p>
                  </div>
                  <div>
                    <p className="text-caption text-muted-foreground">From automations</p>
                    <p className="text-section font-semibold">{money(data.revenue.bySource.automation.revenue, data.revenue.currency)}</p>
                    <p className="text-micro text-muted-foreground">{count(data.revenue.bySource.automation.orders, "order")}</p>
                  </div>
                </div>
                <p className="text-micro text-muted-foreground">
                  Out of {count(data.revenue.ordersInPeriod, "order")} worth {money(data.revenue.revenueInPeriod, data.revenue.currency)} in the period. Orders from customers not linked to a chat contact cannot be credited.
                </p>
                {data.revenue.top.length > 0 && (
                  <ul className="divide-y rounded-lg border text-caption">
                    {data.revenue.top.map((t) => (
                      <li key={`${t.source}:${t.refId}`} className="flex items-center justify-between gap-3 px-3 py-2">
                        {t.refId ? (
                          <Link to={t.source === "broadcast" ? `/campaigns/broadcasts/${t.refId}` : `/campaigns/automations/${t.refId}`} className="truncate font-medium hover:underline">
                            {t.name}
                          </Link>
                        ) : (
                          <span className="truncate font-medium">{t.name}</span>
                        )}
                        <span className="shrink-0 tabular-nums text-muted-foreground">
                          {count(t.orders, "order")} · {money(t.revenue, data.revenue.currency)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </SectionCard>
            <SectionCard title="Meta charges (estimate)" description="From Meta’s pricing on each delivered WhatsApp message, priced with your rates.">
              <div className="space-y-4 p-5">
                <p className="text-section font-semibold">
                  {data.cost.totals.length ? data.cost.totals.map((t) => money(t.amount, t.currency)).join(" + ") : money(0, data.revenue.currency)}
                </p>
                {data.cost.categories.length === 0 ? (
                  <p className="text-caption text-muted-foreground">No priced WhatsApp messages in this period.</p>
                ) : (
                  <table className="w-full text-caption">
                    <thead className="text-left text-muted-foreground">
                      <tr>
                        <th className="py-1 font-medium">Category</th>
                        <th className="py-1 text-right font-medium">Charged</th>
                        <th className="py-1 text-right font-medium">Free</th>
                        <th className="py-1 text-right font-medium">Estimate</th>
                      </tr>
                    </thead>
                    <tbody className="tabular-nums">
                      {data.cost.categories.map((c) => (
                        <tr key={c.category} className="border-t">
                          <td className="py-1 capitalize">{c.category.replace(/_/g, " ")}</td>
                          <td className="py-1 text-right">{num(c.billable)}</td>
                          <td className="py-1 text-right">{num(c.free)}</td>
                          <td className="py-1 text-right">
                            {c.amounts.length ? c.amounts.map((a) => money(a.amount, a.currency)).join(" + ") : "—"}
                            {c.unpriced > 0 && <span className="text-muted-foreground"> · {num(c.unpriced)} without a rate</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <p className="text-micro text-muted-foreground">
                  Meta bills from its own records. Set your rates in <Link to="/campaigns" className="underline">Campaigns → Message rates</Link>.
                </p>
              </div>
            </SectionCard>
          </div>
        </div>
      )}
    </div>
  );
}
