import { Link } from "react-router";
import { Plus, Trash2 } from "lucide-react";

import { EmptyState } from "~/components/app/empty-state";
import { QueryErrorState } from "~/components/app/query-error-state";
import { SectionCard } from "~/components/app/section-card";
import { ShopifySegmentsCard } from "~/components/app/campaigns/shopify-segments-card";
import { TableSkeleton } from "~/components/app/table-skeleton";
import { Button } from "~/components/ui/button";
import { PageHeader, PageHeaderActions, PageHeaderContent, PageHeaderDescription, PageHeaderTitle } from "~/components/ui/page-header";
import { useDeleteSegmentMutation } from "~/hooks/use-campaign-mutations";
import { useRfmSummary, useSegments } from "~/hooks/use-campaign-queries";
import { useCurrentRole } from "~/hooks/use-current-role";
import { RFM_LABEL } from "~/lib/campaign-format";
import { formatDateTime } from "~/lib/format-date";
import type { RfmGroup } from "~/types/api";

export function meta() {
  return [{ title: "Segments | Collabo CRM" }];
}

/** Saved audiences, and the RFM groups the store's order history falls into. */
export default function SegmentsPage() {
  const { data, isLoading, isError, refetch } = useSegments();
  const { data: rfm } = useRfmSummary();
  const remove = useDeleteSegmentMutation();
  const { can } = useCurrentRole();
  const canManage = can("campaigns.manage");

  return (
    <div className="space-y-6">
      <PageHeader>
        <PageHeaderContent>
          <PageHeaderTitle>Segments</PageHeaderTitle>
          <PageHeaderDescription>Audiences built from contact details, store orders and past broadcasts. They stay up to date by themselves.</PageHeaderDescription>
        </PageHeaderContent>
        {canManage && (
          <PageHeaderActions>
            <Button asChild variant="accent" size="sm">
              <Link to="/campaigns/segments/new">
                <Plus />
                New segment
              </Link>
            </Button>
          </PageHeaderActions>
        )}
      </PageHeader>

      <SectionCard title="Customers by RFM group" description="From order recency and frequency, recomputed daily. Use them as segment rules.">
        <div className="grid grid-cols-2 gap-3 p-5 sm:grid-cols-4 lg:grid-cols-7">
          {(Object.keys(RFM_LABEL) as RfmGroup[]).map((g) => (
            <div key={g} title={RFM_LABEL[g].hint}>
              <p className="text-caption text-muted-foreground">{RFM_LABEL[g].label}</p>
              <p className="text-section font-semibold tabular-nums">{(rfm?.[g] ?? 0).toLocaleString("en-IN")}</p>
            </div>
          ))}
        </div>
      </SectionCard>

      <ShopifySegmentsCard canManage={canManage} />

      <SectionCard title="Saved segments">
        {isError ? (
          <div className="p-5">
            <QueryErrorState resource="segments" onRetry={() => void refetch()} />
          </div>
        ) : isLoading ? (
          <TableSkeleton rows={3} columns={3} />
        ) : !data?.length ? (
          <div className="p-5">
            <EmptyState title="No segments yet" description="For example: tagged vip, ordered in the last 90 days, and not opted out." />
          </div>
        ) : (
          <div className="divide-y">
            {data.map((s) => (
              <div key={s.id} className="flex flex-wrap items-center gap-4 px-5 py-3 hover:bg-muted/50">
                <Link to={`/campaigns/segments/${s.id}`} className="min-w-0 flex-1">
                  <p className="truncate text-body font-medium">{s.name}</p>
                  <p className="truncate text-caption text-muted-foreground">
                    {s.description ?? `${s.definition.rules.length} rule${s.definition.rules.length === 1 ? "" : "s"}, matching ${s.definition.match}`}
                  </p>
                </Link>
                <span className="text-body font-semibold tabular-nums">{(s.lastCount ?? 0).toLocaleString("en-IN")}</span>
                <span className="hidden w-36 text-caption text-muted-foreground sm:inline">{s.lastCountedAt ? `Counted ${formatDateTime(s.lastCountedAt)}` : ""}</span>
                {canManage && (
                  <Button variant="ghost" size="icon-sm" onClick={() => window.confirm(`Delete ${s.name}?`) && remove.mutate(s.id)} aria-label={`Delete ${s.name}`}>
                    <Trash2 />
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}
