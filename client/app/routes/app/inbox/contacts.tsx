import { useEffect, useMemo, useState } from "react";
import { Tag, Upload } from "lucide-react";
import { useNavigate } from "react-router";

import {
  ChannelCell,
  DataTable,
  DateCell,
  PersonCell,
  StatusPill,
  TextCell,
  useDataTableState,
  type ColumnDef,
} from "~/components/app/data-table";
import { DockButton, FloatingDock } from "~/components/app/floating-dock";
import { TagChip } from "~/components/app/inbox/tag-chip";
import { ContactImportDialog } from "~/components/app/inbox/contact-import-dialog";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { PageHeader, PageHeaderActions, PageHeaderContent, PageHeaderDescription, PageHeaderTitle } from "~/components/ui/page-header";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover";
import { useChannels } from "~/hooks/use-channel-queries";
import { orderRangeDates, type DateRangePreset, type OrderRangePreset } from "~/hooks/use-date-range-filter";
import { useBulkTagContactsMutation } from "~/hooks/use-inbox-mutations";
import { useContactTags, useInboxContacts, useInboxMe, useInboxMembers } from "~/hooks/use-inbox-queries";
import { useInboxStream } from "~/hooks/use-inbox-stream";
import { useListUrlState } from "~/hooks/use-list-url-state";
import { getInitials } from "~/lib/inbox-format";
import { useCurrentOrg } from "~/hooks/use-org-queries";
import { reportingTimeZone, todayIn } from "~/lib/reporting-date";
import type { ChannelPlatform, InboxContactQuery, InboxContactRow } from "~/types/api";
import { SOCIAL_CHANNELS_OFFERED, messagingChannelWords, platformOffered } from "~/lib/channel-providers";

export function meta() {
  return [{ title: "Contacts | Collabo CRM" }];
}

const MESSAGING_PLATFORMS: ChannelPlatform[] = (["WHATSAPP", "FACEBOOK", "INSTAGRAM"] as ChannelPlatform[]).filter(platformOffered);

const FIRST_SEEN_PRESETS: ReadonlyArray<DateRangePreset<OrderRangePreset>> = [
  { value: "all", label: "All time" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
];

const CONSENT_OPTIONS = [
  { value: "subscribed", label: "Opted in" },
  { value: "no_consent", label: "No opt-in recorded" },
  { value: "opted_out", label: "Opted out" },
  { value: "blocked", label: "Blocked" },
];

/**
 * Contacts — everyone who has messaged the business on WhatsApp, Messenger or
 * Instagram, with their tags, owner, consent and linked store customer. A row
 * opens the person's latest conversation in the inbox.
 */
export default function InboxContactsPage() {
  const list = useListUrlState("inbox-contacts");
  const navigate = useNavigate();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [tagDraft, setTagDraft] = useState("");
  const [tagOpen, setTagOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const { data: me } = useInboxMe();
  useInboxStream();

  const { data: channels = [] } = useChannels();
  const { data: tags } = useContactTags();
  const { data: members } = useInboxMembers();
  const bulkTag = useBulkTagContactsMutation();
  const { data: org } = useCurrentOrg();
  const timeZone = reportingTimeZone(org?.timezone);

  const columns = useMemo<ColumnDef<InboxContactRow>[]>(
    () => [
      {
        key: "contact",
        label: "Contact",
        width: 240,
        locked: true,
        cell: (row) => (
          <PersonCell
            name={row.name}
            sub={row.phone ?? (row.username ? `@${row.username}` : null)}
            initials={getInitials(row.name)}
            title={row.name}
          />
        ),
      },
      {
        key: "channel",
        label: "Channel",
        width: 150,
        cell: (row) => <ChannelCell platform={row.platform} name={row.channel.name} />,
      },
      {
        key: "tags",
        label: "Tags",
        width: 200,
        cell: (row) =>
          row.tags.length ? (
            <span className="flex min-w-0 gap-1">
              {row.tags.slice(0, 3).map((tag) => (
                <TagChip key={tag} tag={tag} />
              ))}
              {row.tags.length > 3 && <span className="text-micro text-muted-foreground">+{row.tags.length - 3}</span>}
            </span>
          ) : (
            <TextCell muted>—</TextCell>
          ),
      },
      {
        key: "customer",
        label: "Store customer",
        width: 160,
        cell: (row) => <TextCell muted={!row.customer}>{row.customer?.name ?? (row.customer ? "Linked" : "—")}</TextCell>,
      },
      {
        key: "owner",
        label: "Owner",
        width: 140,
        cell: (row) => (
          <TextCell muted={!row.owner.user && !row.owner.team}>
            {[row.owner.user?.name, row.owner.team?.name].filter(Boolean).join(" · ") || "—"}
          </TextCell>
        ),
      },
      {
        key: "consent",
        label: "Consent",
        width: 120,
        cell: (row) =>
          row.blocked ? (
            <StatusPill className="bg-danger-subtle text-danger">Blocked</StatusPill>
          ) : row.optedOut ? (
            <StatusPill className="bg-warning-subtle text-warning">Opted out</StatusPill>
          ) : row.optedIn ? (
            <StatusPill className="bg-success-subtle text-success">Opted in</StatusPill>
          ) : (
            <StatusPill className="bg-muted text-muted-foreground">No opt-in</StatusPill>
          ),
      },
      {
        key: "lastInbound",
        label: "Last message",
        width: 130,
        sortKey: "lastInboundAt",
        sortType: "date",
        cell: (row) => <DateCell value={row.lastInboundAt} />,
      },
      {
        key: "firstSeen",
        label: "First seen",
        width: 120,
        sortKey: "createdAt",
        sortType: "date",
        cell: (row) => <DateCell value={row.createdAt} />,
      },
    ],
    [],
  );

  const table = useDataTableState({
    key: "inbox-contacts",
    list,
    columns,
    sort: { default: { field: "createdAt", dir: "desc" } },
    filters: [
      {
        key: "channel",
        label: "Channel",
        options: channels
          .filter((c) => MESSAGING_PLATFORMS.includes(c.platform))
          .map((c) => ({ value: c.id, label: c.name })),
      },
      { key: "tag", label: "Tag", options: tags?.map((t) => ({ value: t.tag, label: `${t.tag} (${t.count})` })) },
      { key: "consent", label: "Consent", options: CONSENT_OPTIONS },
      {
        key: "owner",
        label: "Owner",
        options: members && [{ value: "none", label: "Nobody" }, ...members.map((m) => ({ value: m.id, label: m.name }))],
      },
    ],
    date: { presets: FIRST_SEEN_PRESETS, default: "all", custom: true, today: todayIn(timeZone) },
  });

  const { dateFrom, dateTo } = orderRangeDates(
    { preset: (table.date?.preset ?? "all") as OrderRangePreset, custom: table.date?.custom ?? null },
    timeZone,
  );
  const query: InboxContactQuery = {
    page: table.page,
    limit: table.limit,
    search: table.debouncedSearch || undefined,
    channelId: table.filters.channel?.[0],
    tag: table.filters.tag?.[0],
    consent: table.filters.consent?.[0] as InboxContactQuery["consent"],
    ownerUserId: table.filters.owner?.[0],
    from: dateFrom,
    to: dateTo,
    sortBy: table.sort?.field as InboxContactQuery["sortBy"],
    sortOrder: table.sort?.dir,
  };
  const { data, isLoading, isError, isPlaceholderData, refetch } = useInboxContacts(query);
  const rows = data?.data ?? [];

  // Selection is cleared whenever the visible rows change: tagging people who
  // scrolled out of view is not something to find out about afterwards.
  const rowKey = rows.map((r) => r.id).join(",");
  useEffect(() => setSelectedIds(new Set()), [rowKey]);

  function applyTag(mode: "add" | "remove") {
    const tag = tagDraft.trim();
    if (!tag) return;
    bulkTag.mutate(
      { ids: [...selectedIds], ...(mode === "add" ? { add: [tag] } : { remove: [tag] }) },
      {
        onSuccess: () => {
          setTagDraft("");
          setTagOpen(false);
          setSelectedIds(new Set());
        },
      },
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader>
        <PageHeaderContent>
          <PageHeaderTitle>Contacts</PageHeaderTitle>
          <PageHeaderDescription>Everyone who has messaged you on {messagingChannelWords()}.</PageHeaderDescription>
        </PageHeaderContent>
        {me?.access.canManage && (
          <PageHeaderActions>
            <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
              <Upload />
              Import
            </Button>
          </PageHeaderActions>
        )}
      </PageHeader>
      <ContactImportDialog open={importOpen} onOpenChange={setImportOpen} />

      <DataTable
        state={table}
        rows={rows}
        rowKey={(row) => row.id}
        meta={data?.meta}
        status={{ isLoading, isError, isPlaceholderData, refetch }}
        noun="contacts"
        searchPlaceholder="Search name, number, username or email…"
        onRowClick={(row) => row.conversationId && navigate(`/inbox?c=${row.conversationId}`)}
        selection={{
          isSelected: (row) => selectedIds.has(row.id),
          onToggle: (row, checked) =>
            setSelectedIds((previous) => {
              const next = new Set(previous);
              if (checked) next.add(row.id);
              else next.delete(row.id);
              return next;
            }),
          onToggleAll: (pageRows, checked) =>
            setSelectedIds((previous) => {
              const next = new Set(previous);
              for (const row of pageRows) {
                if (checked) next.add(row.id);
                else next.delete(row.id);
              }
              return next;
            }),
          label: (row) => `Select ${row.name}`,
        }}
        emptyState={{
          title: "No contacts yet",
          description: SOCIAL_CHANNELS_OFFERED ? "People appear here when they message a connected WhatsApp number, Facebook Page or Instagram account." : "People appear here when they message your connected WhatsApp number, or when you add or import them.",
        }}
      />

      {selectedIds.size > 0 && (
        <FloatingDock count={selectedIds.size} noun={selectedIds.size === 1 ? "contact" : "contacts"} onClear={() => setSelectedIds(new Set())}>
          <Popover open={tagOpen} onOpenChange={setTagOpen}>
            <PopoverTrigger asChild>
              <DockButton disabled={bulkTag.isPending}>
                <Tag className="size-3.5" />
                Tag
              </DockButton>
            </PopoverTrigger>
            <PopoverContent side="top" className="w-64 space-y-2 p-3">
              <Input
                value={tagDraft}
                onChange={(event) => setTagDraft(event.target.value)}
                onKeyDown={(event) => event.key === "Enter" && applyTag("add")}
                placeholder="Tag name"
                aria-label="Tag name"
                list="contact-tag-suggestions"
                autoFocus
              />
              <datalist id="contact-tag-suggestions">
                {tags?.map((t) => <option key={t.tag} value={t.tag} />)}
              </datalist>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" size="xs" onClick={() => applyTag("remove")} disabled={!tagDraft.trim() || bulkTag.isPending}>
                  Remove tag
                </Button>
                <Button variant="accent" size="xs" onClick={() => applyTag("add")} disabled={!tagDraft.trim() || bulkTag.isPending}>
                  Add tag
                </Button>
              </div>
            </PopoverContent>
          </Popover>
        </FloatingDock>
      )}
    </div>
  );
}
