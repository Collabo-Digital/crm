import { useState } from "react";
import { Loader2, RefreshCw, ShoppingBag, Unlink } from "lucide-react";

import { SectionCard } from "~/components/app/section-card";
import { Button } from "~/components/ui/button";
import { useShopifySegmentMutation, useShopifySegments } from "~/hooks/use-shopify-segments";
import { formatDateTime } from "~/lib/format-date";

const selectClass = "h-9 min-w-56 rounded-md border bg-background px-2 text-sm";

/**
 * Customer segments built in the Shopify admin, linked as audiences: their
 * members are read from Shopify (and again every day) and matched to the
 * store customers Collabo has; a segment rule "Shopify segment is …" uses them.
 */
export function ShopifySegmentsCard({ canManage }: { canManage: boolean }) {
  const { data, isLoading } = useShopifySegments();
  const act = useShopifySegmentMutation();
  const [choice, setChoice] = useState("");
  if (isLoading || !data) return null;
  if (!data.connected && !data.linked.length) return null;

  return (
    <SectionCard title="Shopify segments" icon={<ShoppingBag className="size-4 text-muted-foreground" />} description="Segments from your Shopify admin, as audiences. Use them in a segment rule: “Shopify segment is …”. Members are re-read every day.">
      <div className="space-y-3 p-5">
        {data.error && <p className="text-caption text-warning">Shopify did not list its segments: {data.error}</p>}
        {data.linked.length > 0 && (
          <ul className="divide-y rounded-lg border">
            {data.linked.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5 text-caption">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body font-medium">{s.name}</span>
                  {s.query && <code className="block truncate text-micro text-muted-foreground">{s.query}</code>}
                  {s.lastError && <span className="block text-micro text-warning">{s.lastError}</span>}
                </span>
                <span className="tabular-nums" title="Customers Collabo has, of the members Shopify reported">
                  {(s.matchedCount ?? 0).toLocaleString("en-IN")} of {(s.memberCount ?? 0).toLocaleString("en-IN")} customers
                </span>
                <span className="w-40 text-micro text-muted-foreground">{s.syncedAt ? `Synced ${formatDateTime(s.syncedAt)}` : "Not synced yet"}</span>
                {canManage && (
                  <span className="flex gap-1">
                    <Button size="xs" variant="ghost" disabled={act.isPending} onClick={() => act.mutate({ kind: "sync", id: s.id })} aria-label={`Sync ${s.name} now`}>
                      <RefreshCw />
                    </Button>
                    <Button size="xs" variant="ghost" disabled={act.isPending} onClick={() => window.confirm(`Unlink ${s.name}? Segment rules that use it will match no one.`) && act.mutate({ kind: "unlink", id: s.id })} aria-label={`Unlink ${s.name}`}>
                      <Unlink />
                    </Button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        {canManage && data.available.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <select aria-label="Shopify segment" className={selectClass} value={choice} onChange={(e) => setChoice(e.target.value)}>
              <option value="">Choose a Shopify segment</option>
              {data.available.map((a) => <option key={a.externalId} value={a.externalId}>{a.name}</option>)}
            </select>
            <Button size="sm" variant="outline" disabled={!choice || act.isPending} onClick={() => act.mutate({ kind: "link", externalId: choice }, { onSuccess: () => setChoice("") })}>
              {act.isPending && <Loader2 className="animate-spin" />}
              Link and sync
            </Button>
          </div>
        )}
        {data.connected && !data.linked.length && !data.available.length && !data.error && (
          <p className="text-caption text-muted-foreground">Your Shopify store has no customer segments yet. Make them in Shopify → Customers → Segments.</p>
        )}
      </div>
    </SectionCard>
  );
}
