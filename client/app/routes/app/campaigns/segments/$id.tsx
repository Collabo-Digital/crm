import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ArrowLeft, Loader2, Users } from "lucide-react";

import { SegmentBuilder, isComplete } from "~/components/app/campaigns/segment-builder";
import { ChannelBadge } from "~/components/app/channel-badge";
import { TagChip } from "~/components/app/inbox/tag-chip";
import { SectionCard } from "~/components/app/section-card";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { PageHeader, PageHeaderContent, PageHeaderTitle } from "~/components/ui/page-header";
import { Skeleton } from "~/components/ui/skeleton";
import { useSaveSegmentMutation } from "~/hooks/use-campaign-mutations";
import { useBroadcasts, useRfmSummary, useSegment, useSegmentPreview } from "~/hooks/use-campaign-queries";
import { useChannels } from "~/hooks/use-channel-queries";
import { useDebounced } from "~/hooks/use-debounced";
import { useContactTags } from "~/hooks/use-inbox-queries";
import { useShopifySegments } from "~/hooks/use-shopify-segments";
import type { SegmentDefinition } from "~/types/api";

export function meta() {
  return [{ title: "Segment | Collabo CRM" }];
}

const START: SegmentDefinition = { match: "all", rules: [{ field: "consent", op: "is", value: "not_opted_out" }] };

/** Build or edit a segment, with a live count and a sample of who is in it. */
export default function SegmentPage() {
  const { id } = useParams();
  const isNew = !id;
  const navigate = useNavigate();
  const { data: segment, isLoading } = useSegment(id);
  const save = useSaveSegmentMutation();
  const { data: tagRows = [] } = useContactTags();
  const { data: channels = [] } = useChannels();
  const { data: past } = useBroadcasts({ status: "COMPLETED", limit: 50 });
  const { data: rfm } = useRfmSummary();
  const { data: shopifySegments } = useShopifySegments();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [definition, setDefinition] = useState<SegmentDefinition>(START);
  useEffect(() => {
    if (segment) {
      setName(segment.name);
      setDescription(segment.description ?? "");
      setDefinition(segment.definition);
    }
  }, [segment]);

  const complete = isComplete(definition);
  const debounced = useDebounced(definition, 400);
  const preview = useSegmentPreview(complete ? debounced : null);

  if (!isNew && (isLoading || !segment)) return <Skeleton className="h-96 w-full rounded-xl" />;

  return (
    <div className="space-y-6">
      <Link to="/campaigns/segments" className="inline-flex items-center gap-1 text-caption text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-3.5" />
        Segments
      </Link>
      <PageHeader>
        <PageHeaderContent>
          <PageHeaderTitle>{isNew ? "New segment" : segment!.name}</PageHeaderTitle>
        </PageHeaderContent>
      </PageHeader>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-6">
          <SectionCard title="Name">
            <div className="grid gap-3 p-5 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="seg-name">Name</Label>
                <Input id="seg-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="Repeat buyers in Pune" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="seg-desc">Description</Label>
                <Input id="seg-desc" value={description} maxLength={300} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" />
              </div>
            </div>
          </SectionCard>
          <SectionCard title="Rules">
            <div className="p-5">
              <SegmentBuilder
                definition={definition}
                onChange={setDefinition}
                tags={tagRows.map((t) => t.tag)}
                channels={channels.filter((c) => ["WHATSAPP", "FACEBOOK", "INSTAGRAM"].includes(c.platform)).map((c) => ({ id: c.id, name: `${c.name} (${c.platform.toLowerCase()})` }))}
                broadcasts={(past?.data ?? []).map((b) => ({ id: b.id, name: b.name }))}
                rfmCounts={rfm}
                shopifySegments={(shopifySegments?.linked ?? []).map((x) => ({ id: x.id, name: x.name }))}
              />
            </div>
          </SectionCard>
        </div>

        <div className="space-y-4 lg:sticky lg:top-6 lg:self-start">
          <SectionCard title="Who is in it">
            <div className="space-y-3 p-5">
              <p className="flex items-center gap-2 text-section font-semibold tabular-nums">
                <Users className="size-5 text-muted-foreground" />
                {!complete ? "—" : preview.isFetching && !preview.data ? <Loader2 className="size-4 animate-spin" /> : (preview.data?.count ?? 0).toLocaleString("en-IN")}
                <span className="text-caption font-normal text-muted-foreground">contacts</span>
              </p>
              {!complete && <p className="text-caption text-muted-foreground">Fill in every rule to see the count.</p>}
              {preview.isError && <p className="text-caption text-danger">These rules could not be counted.</p>}
              <div className="space-y-2">
                {preview.data?.sample.map((c) => (
                  <div key={c.id} className="flex items-center justify-between gap-2 text-caption">
                    <span className="min-w-0 truncate">{c.name}</span>
                    <span className="flex shrink-0 items-center gap-1">
                      {c.tags.slice(0, 1).map((t) => (
                        <TagChip key={t} tag={t} />
                      ))}
                      <ChannelBadge platform={c.platform} size={11} className="text-micro text-muted-foreground" />
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </SectionCard>
          <Button
            variant="accent"
            className="w-full"
            disabled={!name.trim() || !complete || save.isPending}
            onClick={() =>
              save.mutate(
                { id, name: name.trim(), description: description.trim() || null, definition },
                { onSuccess: (s) => isNew && navigate(`/campaigns/segments/${s.id}`, { replace: true }) },
              )
            }
          >
            {save.isPending && <Loader2 className="animate-spin" />}
            Save segment
          </Button>
        </div>
      </div>
    </div>
  );
}
