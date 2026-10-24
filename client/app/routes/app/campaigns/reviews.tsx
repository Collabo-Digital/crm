import { useState } from "react";
import { Link } from "react-router";
import { Loader2, MessageSquareQuote, Star, Unlink } from "lucide-react";

import { CreateAutomationDialog } from "~/components/app/automations/create-automation-dialog";
import { SectionCard } from "~/components/app/section-card";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { PageHeader, PageHeaderContent, PageHeaderDescription, PageHeaderTitle } from "~/components/ui/page-header";
import { Skeleton } from "~/components/ui/skeleton";
import { useChannels } from "~/hooks/use-channel-queries";
import { useCurrentRole } from "~/hooks/use-current-role";
import { useJudgemeAccount, useJudgemeMutation, useReviews } from "~/hooks/use-reviews";
import { PLAYBOOKS } from "~/lib/automation-blocks";
import { formatDateTime } from "~/lib/format-date";
import { canEditAutomations } from "~/lib/permissions";
import { cn } from "~/lib/utils";
import type { ProductReviewStatus, ProductReviewView } from "~/types/api";

export function meta() {
  return [{ title: "Reviews | Collabo CRM" }];
}

const selectClass = "h-8 rounded-lg border bg-background px-2 text-body";

const STATUS: Record<ProductReviewStatus, { label: string; className: string }> = {
  POSTED: { label: "Published to Judge.me", className: "bg-success-subtle text-success" },
  SAVED: { label: "Kept in Collabo", className: "bg-muted text-muted-foreground" },
  FAILED: { label: "Not published", className: "bg-danger-subtle text-danger" },
};

const REVIEW_PLAYBOOK = PLAYBOOKS.find((p) => p.key === "review_request") ?? null;

function Stars({ rating }: { rating: number }) {
  return (
    <span role="img" aria-label={`${rating} out of 5`} className="whitespace-nowrap tracking-tight">
      <span className="text-warning">{"★".repeat(rating)}</span>
      <span className="text-muted-foreground/30">{"★".repeat(5 - rating)}</span>
    </span>
  );
}

function StatusChip({ review }: { review: ProductReviewView }) {
  const s = STATUS[review.status];
  return (
    <span title={review.reason ?? undefined} className={cn("inline-flex rounded-full px-2 py-0.5 text-micro font-medium", s.className)}>
      {s.label}
    </span>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <p className="text-caption text-muted-foreground">{label}</p>
      <p className="mt-1 text-section font-semibold tabular-nums">{value}</p>
      {hint && <p className="mt-0.5 text-micro text-muted-foreground">{hint}</p>}
    </div>
  );
}

const hostOf = (url: string | null | undefined) => {
  try {
    return url ? new URL(url).hostname : "";
  } catch {
    return "";
  }
};

/** Connect with the shop's private API token, which Judge.me checks and Collabo does not keep. */
function JudgemeCard({ canManage }: { canManage: boolean }) {
  const { data: account, isLoading } = useJudgemeAccount();
  const { data: channels = [] } = useChannels();
  const act = useJudgemeMutation();
  const shopHost = hostOf(channels.find((c) => c.platform === "SHOPIFY" && c.externalStoreUrl)?.externalStoreUrl);
  const [shopDomain, setShopDomain] = useState("");
  const [apiToken, setApiToken] = useState("");
  const domain = shopDomain || (shopHost.endsWith(".myshopify.com") ? shopHost : "");

  return (
    <SectionCard
      title="Judge.me"
      icon={<Star className="size-4 text-muted-foreground" />}
      description="Reviews collected on WhatsApp are published to your Judge.me. Its own settings decide what shows on your store."
    >
      {isLoading ? (
        <Skeleton className="m-5 h-16" />
      ) : account?.connected ? (
        <div className="space-y-3 px-5 py-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-body font-medium">{account.shopName ?? account.shopDomain}</p>
              <p className="truncate text-micro text-muted-foreground">{account.shopDomain}</p>
            </div>
            {canManage && (
              <Button size="sm" variant="outline" disabled={act.isPending} onClick={() => act.mutate({ kind: "disconnect" })}>
                <Unlink />
                Disconnect
              </Button>
            )}
          </div>
          <p className="text-caption text-muted-foreground">
            {account.autopublish === true
              ? "Judge.me publishes new reviews right away."
              : account.autopublish === false
                ? "New reviews wait for your approval in Judge.me."
                : "Judge.me’s own settings decide whether new reviews need your approval."}{" "}
            They arrive as web reviews, not marked as verified buyers, and not at all if your store has web reviews turned off.
          </p>
        </div>
      ) : canManage ? (
        <form
          className="space-y-3 px-5 py-4"
          onSubmit={(e) => {
            e.preventDefault();
            act.mutate({ kind: "connect", shopDomain: domain, apiToken }, { onSuccess: () => setApiToken("") });
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="jm-shop">Shop address</Label>
              <Input id="jm-shop" value={domain} onChange={(e) => setShopDomain(e.target.value)} placeholder="your-store.myshopify.com" autoComplete="off" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="jm-token">Private API token</Label>
              <Input id="jm-token" type="password" value={apiToken} onChange={(e) => setApiToken(e.target.value)} autoComplete="off" />
            </div>
          </div>
          <p className="text-micro text-muted-foreground">
            In Judge.me, open Settings → Integrations → View API tokens and copy the private one. Collabo checks it with Judge.me to make sure the shop is yours, and does not keep it.
          </p>
          <Button type="submit" size="sm" disabled={act.isPending || !domain.trim() || apiToken.trim().length < 10}>
            {act.isPending && <Loader2 className="animate-spin" />}
            Connect Judge.me
          </Button>
        </form>
      ) : (
        <p className="px-5 py-4 text-caption text-muted-foreground">Judge.me is not connected. An owner or admin can connect it here.</p>
      )}
    </SectionCard>
  );
}

/** Campaigns → Reviews: ratings and reviews customers gave on WhatsApp, and where they went. */
export default function ReviewsPage() {
  const [rating, setRating] = useState<number | undefined>();
  const [status, setStatus] = useState<ProductReviewStatus | undefined>();
  const [page, setPage] = useState(1);
  const { data, isLoading, isError } = useReviews({ rating, status, page });
  const { role, permissions } = useCurrentRole();
  const canManage = role === "OWNER" || role === "ADMIN";
  const canAutomate = canEditAutomations(role, permissions);
  const [creating, setCreating] = useState(false);
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const filter = (next: { rating?: number; status?: ProductReviewStatus }) => {
    setRating(next.rating);
    setStatus(next.status);
    setPage(1);
  };

  return (
    <div className="space-y-6">
      <PageHeader>
        <PageHeaderContent>
          <PageHeaderTitle>Reviews</PageHeaderTitle>
          <PageHeaderDescription>Ratings and reviews customers give on WhatsApp after delivery, published to your Judge.me.</PageHeaderDescription>
        </PageHeaderContent>
      </PageHeader>

      {isError ? (
        <p className="text-caption text-danger">The reviews could not be loaded.</p>
      ) : isLoading || !data ? (
        <Skeleton className="h-72 w-full rounded-xl" />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
            <Stat label="Average rating" value={data.stats.average === null ? "—" : `${data.stats.average.toFixed(1)} ★`} hint={`From ${data.stats.count.toLocaleString("en-IN")} ${data.stats.count === 1 ? "review" : "reviews"}`} />
            <Stat label="Published to Judge.me" value={data.stats.published.toLocaleString("en-IN")} />
            <Stat label="Rated 1 to 3" value={([1, 2, 3] as const).reduce((a, r) => a + (data.stats.byRating[r] ?? 0), 0).toLocaleString("en-IN")} hint="Passed to the team by the review automation" />
          </div>

          {data.stats.count === 0 && REVIEW_PLAYBOOK && (
            <div className="flex flex-col items-start gap-3 rounded-xl border border-dashed p-5 sm:flex-row sm:items-center">
              <MessageSquareQuote className="size-5 shrink-0 text-muted-foreground" />
              <p className="flex-1 text-caption text-muted-foreground">
                No reviews yet. The “{REVIEW_PLAYBOOK.name}” automation asks for a 1 to 5 rating two days after delivery, then for a few words, and publishes them here and to Judge.me.
              </p>
              {canAutomate && (
                <Button size="sm" onClick={() => setCreating(true)}>
                  Set it up
                </Button>
              )}
            </div>
          )}

          <SectionCard
            title="Collected reviews"
            action={
              <select aria-label="Status" className={selectClass} value={status ?? ""} onChange={(e) => filter({ rating, status: (e.target.value || undefined) as ProductReviewStatus | undefined })}>
                <option value="">Any status</option>
                <option value="POSTED">Published to Judge.me</option>
                <option value="SAVED">Kept in Collabo</option>
                <option value="FAILED">Not published</option>
              </select>
            }
          >
            <div className="flex gap-1.5 overflow-x-auto px-5 py-3" role="group" aria-label="Rating">
              <Button size="sm" variant={rating === undefined ? "default" : "outline"} onClick={() => filter({ status })}>
                All
              </Button>
              {[5, 4, 3, 2, 1].map((r) => (
                <Button key={r} size="sm" variant={rating === r ? "default" : "outline"} onClick={() => filter({ rating: r, status })} aria-label={`${r} stars, ${data.stats.byRating[r] ?? 0} reviews`}>
                  {r} ★ <span className="tabular-nums text-muted-foreground">{data.stats.byRating[r] ?? 0}</span>
                </Button>
              ))}
            </div>
            {data.reviews.length === 0 ? (
              <p className="border-t p-5 text-caption text-muted-foreground">{data.stats.count ? "No reviews match these filters." : "Reviews appear here as customers answer."}</p>
            ) : (
              <>
                <ul className="divide-y border-t md:hidden">
                  {data.reviews.map((r) => (
                    <li key={r.id} className="space-y-1.5 px-5 py-3 text-caption">
                      <div className="flex items-center justify-between gap-2">
                        <Stars rating={r.rating} />
                        <span className="text-micro text-muted-foreground">{formatDateTime(r.createdAt)}</span>
                      </div>
                      {r.body && <p className="text-body">“{r.body}”</p>}
                      <p className="text-micro text-muted-foreground">
                        {r.conversationId ? <Link to={`/inbox?c=${r.conversationId}`} className="font-medium text-foreground underline-offset-2 hover:underline">{r.contactName}</Link> : r.contactName}
                        {" · "}
                        {r.productTitle ?? "The shop"}
                        {r.order ? ` · ${r.order.name}` : ""}
                      </p>
                      <div className="flex flex-wrap items-center gap-2">
                        <StatusChip review={r} />
                        {r.status !== "POSTED" && r.reason && <span className="text-micro text-muted-foreground">{r.reason}</span>}
                      </div>
                    </li>
                  ))}
                </ul>
                <div className="hidden overflow-x-auto border-t md:block">
                  <table className="w-full text-caption">
                    <thead className="text-left text-muted-foreground">
                      <tr className="border-b">
                        <th className="px-4 py-2 font-medium">Rating</th>
                        <th className="px-3 py-2 font-medium">Review</th>
                        <th className="px-3 py-2 font-medium">Customer</th>
                        <th className="px-3 py-2 font-medium">Product</th>
                        <th className="px-3 py-2 font-medium">Status</th>
                        <th className="px-4 py-2 text-right font-medium">When</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.reviews.map((r) => (
                        <tr key={r.id} className="border-b align-top last:border-0">
                          <td className="px-4 py-2.5">
                            <Stars rating={r.rating} />
                          </td>
                          <td className="max-w-sm px-3 py-2.5">{r.body ? `“${r.body}”` : <span className="text-muted-foreground">No words</span>}</td>
                          <td className="px-3 py-2.5">
                            {r.conversationId ? (
                              <Link to={`/inbox?c=${r.conversationId}`} className="font-medium underline-offset-2 hover:underline">
                                {r.contactName}
                              </Link>
                            ) : (
                              <span className="font-medium">{r.contactName}</span>
                            )}
                            {r.order && <p className="text-micro text-muted-foreground">{r.order.name}</p>}
                          </td>
                          <td className="px-3 py-2.5">{r.productTitle ?? "The shop"}</td>
                          <td className="px-3 py-2.5">
                            <StatusChip review={r} />
                            {r.status !== "POSTED" && r.reason && <p className="mt-1 max-w-56 text-micro text-muted-foreground">{r.reason}</p>}
                          </td>
                          <td className="whitespace-nowrap px-4 py-2.5 text-right text-muted-foreground">{formatDateTime(r.createdAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {pages > 1 && (
                  <div className="flex items-center justify-between gap-2 border-t px-5 py-3 text-caption">
                    <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                      Previous
                    </Button>
                    <span className="text-muted-foreground">
                      Page {page} of {pages}
                    </span>
                    <Button size="sm" variant="outline" disabled={page >= pages} onClick={() => setPage(page + 1)}>
                      Next
                    </Button>
                  </div>
                )}
              </>
            )}
          </SectionCard>

          <JudgemeCard canManage={canManage} />
        </>
      )}

      {creating && REVIEW_PLAYBOOK && <CreateAutomationDialog playbook={REVIEW_PLAYBOOK} onClose={() => setCreating(false)} />}
    </div>
  );
}
