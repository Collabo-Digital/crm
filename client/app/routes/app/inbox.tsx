import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Bell, BellOff, MessageSquarePlus } from "lucide-react";
import { NewChatDialog } from "~/components/app/inbox/new-chat-dialog";
import { useAlertsSwitch } from "~/hooks/use-new-message-alerts";
import { useSearchParams } from "react-router";
import { toast } from "sonner";

import { AvailabilityMenu } from "~/components/app/inbox/availability-menu";
import { AppBarActions } from "~/components/app/app-bar-actions";
import { CatalogPanel, type CatalogDrop } from "~/components/app/inbox/catalog-panel";
import { ChatDropZone } from "~/components/app/inbox/chat-drop-zone";
import { ContactPanel } from "~/components/app/inbox/contact-panel";
import { GroupSidePanel } from "~/components/app/inbox/group-side-panel";
import { ConversationEmpty } from "~/components/app/inbox/conversation-empty";
import { ConversationList } from "~/components/app/inbox/conversation-list";
import { ThreadSkeleton } from "~/components/app/inbox/conversation-skeletons";
import { ConversationThread } from "~/components/app/inbox/conversation-thread";
import type { CommentReplyMode } from "~/components/app/inbox/message-bubble";
import { MessageComposer, type ComposerHandle } from "~/components/app/inbox/message-composer";
import { productsPayload } from "~/components/app/inbox/product-picker";
import { SaveViewDialog } from "~/components/app/inbox/save-view-dialog";
import { TemplatePickerDialog } from "~/components/app/inbox/template-picker-dialog";
import { ThreadHeader } from "~/components/app/inbox/thread-header";
import { QueryErrorState } from "~/components/app/query-error-state";
import { Button } from "~/components/ui/button";
import { PageHeader, PageHeaderActions, PageHeaderContent, PageHeaderTitle } from "~/components/ui/page-header";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "~/components/ui/sheet";
import { useChannels } from "~/hooks/use-channel-queries";
import { usePageActive } from "~/hooks/use-page-active";
import {
  useAddNoteMutation,
  useBulkConversationsMutation,
  useCreateViewMutation,
  useDeleteViewMutation,
  useMarkReadMutation,
  useSendMessageMutation,
  useSetAvailabilityMutation,
  useUpdateConversationMutation,
  useUploadMutation,
} from "~/hooks/use-inbox-mutations";
import {
  useInboxConversation,
  useInboxConversations,
  useInboxCounts,
  useInboxMe,
  useInboxMembers,
  useInboxMessages,
  useInboxTeams,
  useInboxViews,
  useQuickReplies,
} from "~/hooks/use-inbox-queries";
import { useInboxStream } from "~/hooks/use-inbox-stream";
import { useDebounced } from "~/hooks/use-debounced";
import { PANEL_DEFAULT_OPEN_QUERY, useMediaQuery } from "~/hooks/use-media-query";
import { useCurrentOrg } from "~/hooks/use-org-queries";
import { replyBlockedReason } from "~/lib/inbox-format";
import { cn } from "~/lib/utils";
import { useAuthStore } from "~/stores/auth.store";
import type {
  ChannelPlatform,
  InboxBulkRequest,
  InboxFilters,
  InboxListStatus,
  InboxListView,
  InboxMessage,
  InboxSavedView,
} from "~/types/api";
import { platformOffered } from "~/lib/channel-providers";
import { pageTitle } from "~/lib/page-title";

export function meta() {
  return [{ title: "Inbox | Collabo CRM" }];
}

const VIEWS: InboxListView[] = ["all", "mine", "unassigned"];
const STATUSES: InboxListStatus[] = ["open", "snoozed", "closed"];
const MESSAGING_PLATFORMS: ChannelPlatform[] = (["WHATSAPP", "FACEBOOK", "INSTAGRAM"] as ChannelPlatform[]).filter(platformOffered);

/** URL parameter for each filter. Short, because they end up in shared links. */
const PARAM = {
  view: "view",
  status: "status",
  teamId: "team",
  channelId: "channel",
  tag: "tag",
  assigneeId: "assignee",
  unread: "unread",
  comments: "comments",
  search: "q",
} as const;

function readFilters(params: URLSearchParams): InboxFilters {
  const view = params.get(PARAM.view) as InboxListView | null;
  const status = params.get(PARAM.status) as InboxListStatus | null;
  return {
    view: view && VIEWS.includes(view) ? view : "all",
    status: status && STATUSES.includes(status) ? status : "open",
    teamId: params.get(PARAM.teamId) ?? undefined,
    channelId: params.get(PARAM.channelId) ?? undefined,
    tag: params.get(PARAM.tag) ?? undefined,
    assigneeId: params.get(PARAM.assigneeId) ?? undefined,
    unread: params.get(PARAM.unread) === "1" || undefined,
    comments: params.get(PARAM.comments) === "1" || undefined,
    search: params.get(PARAM.search) ?? undefined,
  };
}

/**
 * Inbox — the shared team inbox for WhatsApp, Messenger and Instagram.
 *
 * Three columns: list, thread, and a contact panel the thread header collapses
 * inline. The folder, filters, saved view and selected conversation live in
 * the URL so a thread is linkable and a filtered view is shareable. The
 * composer draft and the panel's open state stay local — they belong to this
 * tab, not to the address.
 */
export default function InboxPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const panelOpensByDefault = useMediaQuery(PANEL_DEFAULT_OPEN_QUERY);
  const hasRoomForPanel = useMediaQuery("(min-width: 1024px)");
  const [isPanelOpen, setIsPanelOpen] = useState(panelOpensByDefault);
  const [mobileDetailsOpen, setMobileDetailsOpen] = useState(false);
  const [sidePanel, setSidePanel] = useState<"contact" | "products">("contact");
  const composerRef = useRef<ComposerHandle>(null);
  const [selecting, setSelecting] = useState(false);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [quote, setQuote] = useState<InboxMessage | null>(null);
  const [commentTarget, setCommentTarget] = useState<{ message: InboxMessage; mode: CommentReplyMode } | null>(null);
  const [saveViewOpen, setSaveViewOpen] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);

  const connected = useInboxStream();
  const { data: me } = useInboxMe();
  const { data: counts } = useInboxCounts();
  const { data: members = [] } = useInboxMembers();
  const { data: teamsFull = [] } = useInboxTeams();
  const { data: savedViews = [] } = useInboxViews();
  const { data: quickReplies = [] } = useQuickReplies();
  const { data: channels = [] } = useChannels();
  const { data: org } = useCurrentOrg();
  const user = useAuthStore((s) => s.user);

  const teams = useMemo(() => teamsFull.map((t) => ({ id: t.id, name: t.name })), [teamsFull]);
  const messagingChannels = channels.filter((c) => MESSAGING_PLATFORMS.includes(c.platform));

  const activeViewId = searchParams.get("sv");
  const savedView = savedViews.find((v) => v.id === activeViewId);
  const urlFilters = readFilters(searchParams);
  // A saved view is a preset: its filters apply as stored, the search box on top.
  const filters: InboxFilters = savedView ? { ...savedView.filters, search: urlFilters.search } : urlFilters;
  // The input keeps the raw value so typing stays responsive; only the query is debounced.
  const debouncedSearch = useDebounced(filters.search);
  const queryFilters: InboxFilters = { ...filters, search: debouncedSearch?.trim() || undefined };

  /**
   * `replace: true` throughout. Selecting a conversation is a view change, not
   * a destination — without it, Back walks the last twenty threads the agent
   * glanced at instead of leaving the inbox.
   */
  function patchParams(patch: Record<string, string | null>) {
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        for (const [key, value] of Object.entries(patch)) {
          if (value === null) next.delete(key);
          else next.set(key, value);
        }
        return next;
      },
      { replace: true },
    );
  }

  /** Write a full filter set to the URL, in one update. Any edit leaves the saved view. */
  function writeFilters(next: InboxFilters, savedViewId: string | null = null) {
    const patch: Record<string, string | null> = { sv: savedViewId };
    for (const [key, param] of Object.entries(PARAM) as Array<[keyof InboxFilters, string]>) {
      const value = next[key];
      const isDefault = (key === "view" && value === "all") || (key === "status" && value === "open");
      patch[param] = value === undefined || value === false || value === "" || isDefault ? null : value === true ? "1" : String(value);
    }
    patchParams(patch);
    setCheckedIds(new Set());
  }

  function changeFilters(patch: Partial<InboxFilters>, replace = false) {
    const base: InboxFilters = replace ? { status: filters.status, search: filters.search } : filters;
    writeFilters({ ...base, ...patch });
  }

  function openSavedView(view: InboxSavedView) {
    writeFilters({ ...view.filters, search: filters.search }, view.id);
  }

  const listQuery = useInboxConversations(queryFilters);
  const conversations = useMemo(() => listQuery.data?.pages.flatMap((p) => p.items) ?? [], [listQuery.data]);

  // Nothing opens until the agent picks a row: opening marks it read.
  const selectedId = searchParams.get("c");
  const [newChatOpen, setNewChatOpen] = useState(false);
  const alerts = useAlertsSwitch();
  const detailQuery = useInboxConversation(selectedId);
  const conversation = detailQuery.data;
  const messagesQuery = useInboxMessages(selectedId);
  const pages = messagesQuery.data?.pages ?? [];
  const messages = useMemo(() => [...pages].reverse().flatMap((p) => p.messages), [pages]);
  const notes = pages[0]?.notes ?? [];

  const update = useUpdateConversationMutation();
  const bulk = useBulkConversationsMutation();
  const send = useSendMessageMutation(selectedId ?? "");
  const addNote = useAddNoteMutation(selectedId ?? "");
  const upload = useUploadMutation();
  const markRead = useMarkReadMutation();
  const setAvailability = useSetAvailabilityMutation();
  const createView = useCreateViewMutation();
  const deleteView = useDeleteViewMutation();

  /**
   * Clear the unread badge once a thread is open and someone is looking at
   * it: marking read sends the customer blue ticks and clears the badge for
   * the whole team, so a background tab or a viewer never does. Keyed on the
   * id and the count, NOT on the conversation object, which changes on every
   * refetch.
   */
  const pageActive = usePageActive();
  const unreadCount = conversation?.unreadCount ?? 0;
  const openId = conversation?.id;
  const canMarkRead = !!conversation?.reply.canReply;
  const markReadMutate = markRead.mutate;
  useEffect(() => {
    if (openId && unreadCount > 0 && pageActive && canMarkRead) markReadMutate(openId);
  }, [openId, unreadCount, pageActive, canMarkRead, markReadMutate]);

  // A quote or comment target belongs to the thread it was picked in.
  useEffect(() => {
    setQuote(null);
    setCommentTarget(null);
    setMobileDetailsOpen(false);
  }, [selectedId]);

  /** Closing or snoozing moves the conversation out of this list; keep the agent moving. */
  function nextAfter(id: string): string | null {
    const index = conversations.findIndex((c) => c.id === id);
    return conversations[index + 1]?.id ?? conversations[index - 1]?.id ?? null;
  }

  function runBulk(action: Omit<InboxBulkRequest, "ids">) {
    bulk.mutate({ ...action, ids: [...checkedIds] }, { onSuccess: () => setCheckedIds(new Set()) });
  }

  async function sendPayload(payload: Parameters<typeof send.mutateAsync>[0]["payload"], replyToMessageId?: string) {
    try {
      const outcome = await send.mutateAsync({ payload, replyToMessageId });
      return outcome.ok;
    } catch {
      return false;
    }
  }

  /** A product, collection or link from the catalog panel, into the reply box. */
  function addToReply(drop: CatalogDrop) {
    const composer = composerRef.current;
    if (!composer) return;
    const reason = drop.kind === "link" ? composer.insertText(drop.text) : composer.addProducts(drop.items, drop.asCards, drop.header);
    if (reason) toast.error(reason);
    else if (!hasRoomForPanel) setMobileDetailsOpen(false);
  }

  function sendFromCatalog(drop: CatalogDrop) {
    void sendPayload(drop.kind === "link" ? { type: "text", text: drop.text } : productsPayload(drop.items, "", drop.asCards, { header: drop.header }));
  }

  function attachDropped(file: File) {
    const reason = composerRef.current?.attachFile(file);
    if (reason) toast.error(reason);
  }

  const showPanel = Boolean(conversation) && isPanelOpen;
  const catalogBlocked = conversation ? replyBlockedReason(conversation, Date.now()) : null;
  const sideTabs = (
    <div role="tablist" aria-label="Beside the conversation" className="flex shrink-0 gap-1 border-b p-2">
      {(["contact", "products"] as const).map((tab) => (
        <button
          key={tab}
          type="button"
          role="tab"
          aria-selected={sidePanel === tab}
          onClick={() => setSidePanel(tab)}
          className={cn(
            "flex-1 rounded-md px-2 py-1.5 text-caption max-md:min-h-11",
            sidePanel === tab ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {tab === "contact" ? "Contact" : "Products"}
        </button>
      ))}
    </div>
  );
  const seesOthers = !!me?.access.seesAll;

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 md:gap-2">
      {/* An open chat names its contact in the tab. */}
      {conversation && <title>{pageTitle(conversation.contact.customer?.name ?? conversation.contact.name, "Inbox")}</title>}
      <NewChatDialog
        open={newChatOpen}
        onOpenChange={setNewChatOpen}
        mode="chat"
        onDone={(result) => {
          setNewChatOpen(false);
          patchParams({ c: result.conversationId });
        }}
      />
      {/* Phones: alerts and status sit in the app bar, and New chat floats above the tab bar. */}
      <AppBarActions>
        <Button
          variant="ghost"
          size="icon"
          onClick={alerts.toggle}
          aria-label={alerts.on ? "Turn off new-message alerts" : "Turn on new-message alerts"}
          className="rounded-full"
        >
          {alerts.on ? <Bell /> : <BellOff />}
        </Button>
        <AvailabilityMenu
          compact
          status={me?.status}
          connected={connected}
          disabled={setAvailability.isPending || !me?.access.canReply}
          onChange={(status) => setAvailability.mutate(status)}
        />
      </AppBarActions>
      {me?.access.canReply && !selectedId && (
        <Button
          variant="accent"
          size="icon"
          onClick={() => setNewChatOpen(true)}
          aria-label="New chat"
          className="fixed right-4 bottom-[calc(var(--mobile-nav-height)+16px)] z-30 size-14 rounded-2xl shadow-lg md:hidden [&_svg]:size-6"
        >
          <MessageSquarePlus />
        </Button>
      )}
      <PageHeader className="shrink-0 items-center max-md:hidden">
        <PageHeaderContent>
          <PageHeaderTitle>Inbox</PageHeaderTitle>
        </PageHeaderContent>
        <PageHeaderActions>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={alerts.toggle}
            aria-label={alerts.on ? "Turn off new-message alerts" : "Turn on new-message alerts"}
            title={alerts.on ? "New-message alerts are on" : "New-message alerts are off"}
          >
            {alerts.on ? <Bell /> : <BellOff />}
          </Button>
          {me?.access.canReply && (
            <Button size="sm" variant="accent" onClick={() => setNewChatOpen(true)}>
              <MessageSquarePlus />
              New chat
            </Button>
          )}
          <AvailabilityMenu
            status={me?.status}
            connected={connected}
            disabled={setAvailability.isPending || !me?.access.canReply}
            onChange={(status) => setAvailability.mutate(status)}
          />
        </PageHeaderActions>
      </PageHeader>

      {/*
        Grid rather than flex, with minmax(0,1fr) on the thread: a bare 1fr
        track takes its min-content width from the widest message bubble, which
        pushes the panel off-screen instead of wrapping the text.

        Below md the list and thread share one column and swap on selection —
        in CSS, not JS, because a JS breakpoint would flash the wrong pane on
        first paint.
      */}
      <div
        className={cn(
          "grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] overflow-hidden bg-card max-md:rounded-none md:rounded-xl md:shadow-sm md:ring-1 md:ring-border",
          // Phones: the list runs edge to edge under the section tabs, like an app.
          !selectedId && "max-md:-mx-4 max-md:-mt-4",
          "md:grid-cols-[300px_minmax(0,1fr)]",
          showPanel && "lg:grid-cols-[300px_minmax(0,1fr)_288px]",
        )}
      >
        <ConversationList
          conversations={conversations}
          counts={counts}
          filters={filters}
          activeViewId={savedView ? savedView.id : null}
          teams={teams}
          savedViews={savedViews}
          members={members}
          channels={messagingChannels}
          meId={me?.userId}
          canAssignOthers={!!me?.access.canAssignOthers}
          seesOthers={seesOthers}
          selectedId={selectedId}
          checkedIds={checkedIds}
          selecting={selecting || checkedIds.size > 0}
          isLoading={listQuery.isLoading}
          isPlaceholder={listQuery.isPlaceholderData}
          isError={listQuery.isError}
          hasMore={!!listQuery.hasNextPage}
          isLoadingMore={listQuery.isFetchingNextPage}
          isBulkPending={bulk.isPending}
          onLoadMore={() => void listQuery.fetchNextPage()}
          onRetry={() => void listQuery.refetch()}
          onFiltersChange={changeFilters}
          onSavedView={openSavedView}
          onSaveView={() => setSaveViewOpen(true)}
          onDeleteView={(view) => {
            if (window.confirm(`Delete the view “${view.name}”?`)) {
              deleteView.mutate(view.id);
              if (view.id === activeViewId) patchParams({ sv: null });
            }
          }}
          onSelect={(id) => patchParams({ c: id })}
          onCheck={(id, checked) =>
            setCheckedIds((previous) => {
              const next = new Set(previous);
              if (checked) next.add(id);
              else next.delete(id);
              return next;
            })
          }
          onToggleSelecting={() => {
            setSelecting((previous) => !previous && checkedIds.size === 0);
            setCheckedIds(new Set());
          }}
          onBulk={runBulk}
          className={cn("md:flex md:border-r", selectedId ? "hidden" : "flex")}
        />

        <div className={cn("relative min-h-0 min-w-0 flex-col", selectedId ? "flex" : "hidden md:flex")}>
          {selectedId && !conversation && (
            <div className="flex shrink-0 items-center gap-2 border-b px-3 py-3 md:hidden">
              <Button variant="ghost" size="icon" className="size-11 rounded-full" onClick={() => patchParams({ c: null })} aria-label="Back to conversations"><ArrowLeft className="size-5" /></Button>
              <span className="font-semibold">Conversation</span>
            </div>
          )}
          {detailQuery.isError ? (
            <div className="p-6">
              <QueryErrorState resource="this conversation" onRetry={() => void detailQuery.refetch()} />
            </div>
          ) : !selectedId ? (
            <ConversationEmpty />
          ) : !conversation ? (
            <ThreadSkeleton />
          ) : (
              <>
                  <ThreadHeader
                    conversation={conversation}
                    members={members}
                    teams={teams}
                    me={me}
                    isPanelOpen={hasRoomForPanel ? isPanelOpen : mobileDetailsOpen}
                    isMutating={update.isPending}
                    onTogglePanel={() => hasRoomForPanel ? setIsPanelOpen((previous) => !previous) : setMobileDetailsOpen(true)}
                    onBack={() => patchParams({ c: null })}
                    onAssign={(assignedUserId) =>
                      update.mutate(
                        { id: conversation.id, assignedUserId, done: assignedUserId ? "Assigned." : "Unassigned." },
                        { onSuccess: (result) => "visible" in result && patchParams({ c: null }) },
                      )
                    }
                    onTeam={(teamId) => update.mutate({ id: conversation.id, teamId, done: teamId ? "Moved to team." : "Removed from team." })}
                    onSnooze={(snoozedUntil, label) =>
                      update.mutate(
                        { id: conversation.id, status: "SNOOZED", snoozedUntil, done: `Snoozed until ${label.toLowerCase()}.` },
                        { onSuccess: () => filters.status === "open" && patchParams({ c: nextAfter(conversation.id) }) },
                      )
                    }
                    onClose={() =>
                      update.mutate(
                        { id: conversation.id, status: "CLOSED", done: "Conversation closed." },
                        { onSuccess: () => filters.status === "open" && patchParams({ c: nextAfter(conversation.id) }) },
                      )
                    }
                    onReopen={() => update.mutate({ id: conversation.id, status: "OPEN", done: "Conversation reopened." })}
                  />

                  <ChatDropZone className="flex min-h-0 flex-1 flex-col" disabled={!conversation.reply.canReply} onCatalog={addToReply} onFile={attachDropped}>
                    {messagesQuery.isError ? (
                      <div className="flex-1 p-6">
                        <QueryErrorState resource="messages" onRetry={() => void messagesQuery.refetch()} />
                      </div>
                    ) : messagesQuery.isLoading ? (
                      <ThreadSkeleton />
                    ) : (
                      <ConversationThread
                        conversationId={conversation.id}
                        messages={messages}
                        notes={notes}
                        canReply={conversation.reply.canReply}
                        hasEarlier={!!messagesQuery.hasNextPage}
                        isLoadingEarlier={messagesQuery.isFetchingNextPage}
                        onLoadEarlier={() => void messagesQuery.fetchNextPage()}
                        onQuote={(message) => {
                          setCommentTarget(null);
                          setQuote(message);
                        }}
                        onReact={(message, emoji) => void sendPayload({ type: "reaction", messageId: message.id, emoji })}
                        onCommentReply={(message, mode) => {
                          setQuote(null);
                          setCommentTarget({ message, mode });
                        }}
                      />
                    )}

                    <MessageComposer
                      key={conversation.id}
                      conversation={conversation}
                      quickReplies={quickReplies}
                      agentName={user?.firstName ?? ""}
                      quote={quote}
                      commentTarget={commentTarget}
                      isSending={send.isPending}
                      onClearQuote={() => setQuote(null)}
                      onClearCommentTarget={() => setCommentTarget(null)}
                      onSend={sendPayload}
                      onAddNote={(body) => addNote.mutateAsync(body)}
                      onUpload={(file) => upload.mutateAsync(file)}
                      onOpenTemplates={conversation.platform === "WHATSAPP" ? () => setTemplatesOpen(true) : undefined}
                      ref={composerRef}
                    />
                  </ChatDropZone>
                  <TemplatePickerDialog
                    open={templatesOpen}
                    onOpenChange={setTemplatesOpen}
                    contactName={conversation.contact.customer?.name ?? conversation.contact.name}
                    isSending={send.isPending}
                    onSend={(payload) => sendPayload(payload)}
                  />
              </>
          )}
        </div>

        {/* The docked desktop panel and mobile sheet leave the composer mounted. */}
        {conversation && (
          <div className={cn("min-h-0 flex-col border-l", showPanel ? "hidden lg:flex" : "hidden")}>
            {conversation.contact.isGroup ? (
              <GroupSidePanel groupId={conversation.group?.id} className="flex-1" />
            ) : (
              <>
                {sideTabs}
                {sidePanel === "contact" ? (
                  <ContactPanel
                    key={conversation.contact.id}
                    contact={conversation.contact}
                    conversationId={conversation.id}
                    notes={notes}
                    members={members}
                    teams={teams}
                    canEdit={conversation.reply.canReply}
                    canAssignOthers={!!me?.access.canAssignOthers}
                    meId={me?.userId}
                    defaultCurrency={org?.currency ?? "INR"}
                    isSavingNote={addNote.isPending}
                    onAddNote={(body) => addNote.mutate(body)}
                    className="flex-1"
                  />
                ) : (
                  <CatalogPanel
                    key={conversation.id}
                    conversationId={conversation.id}
                    blockedReason={catalogBlocked}
                    isSending={send.isPending}
                    onAdd={addToReply}
                    onSend={sendFromCatalog}
                    className="flex-1"
                  />
                )}
              </>
            )}
          </div>
        )}
      </div>

      {conversation && (
        <Sheet open={mobileDetailsOpen && !hasRoomForPanel} onOpenChange={setMobileDetailsOpen}>
          <SheetContent className="max-w-md pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] [&>button]:top-[max(1rem,env(safe-area-inset-top))] [&>button]:size-11 [&>button]:rounded-full">
            <SheetHeader className="shrink-0 px-5 py-6 pr-16">
              <SheetTitle className="text-xl">{conversation.contact.name}</SheetTitle>
              <SheetDescription>
                {conversation.contact.isGroup ? "WhatsApp group" : sidePanel === "contact" ? "Contact details, orders and team notes" : "Products to share in this chat"}
              </SheetDescription>
            </SheetHeader>
            {conversation.contact.isGroup ? (
              <GroupSidePanel groupId={conversation.group?.id} className="min-h-0 flex-1" />
            ) : (
              <>
                {sideTabs}
                {sidePanel === "products" ? (
                  <CatalogPanel
                    key={conversation.id}
                    conversationId={conversation.id}
                    blockedReason={catalogBlocked}
                    isSending={send.isPending}
                    onAdd={addToReply}
                    onSend={sendFromCatalog}
                    className="min-h-0 flex-1 [&_button]:min-h-11 [&_button]:min-w-11 [&_input]:min-h-11 [&_input]:text-base"
                  />
                ) : (
                  <ContactPanel
                    key={conversation.contact.id}
                    contact={conversation.contact}
                    conversationId={conversation.id}
                    notes={notes}
                    members={members}
                    teams={teams}
                    canEdit={conversation.reply.canReply}
                    canAssignOthers={!!me?.access.canAssignOthers}
                    meId={me?.userId}
                    defaultCurrency={org?.currency ?? "INR"}
                    isSavingNote={addNote.isPending}
                    onAddNote={(body) => addNote.mutate(body)}
                    className="min-h-0 flex-1 overscroll-contain bg-muted/30 [&>section]:mx-3 [&>section]:my-3 [&>section]:rounded-2xl [&>section]:border-0 [&>section]:bg-card [&>section]:p-5 [&_button]:min-h-11 [&_input]:min-h-11 [&_input]:text-base [&_h3]:text-xs [&_dl]:space-y-3 [&_dl]:text-sm"
                  />
                )}
              </>
            )}
          </SheetContent>
        </Sheet>
      )}

      <SaveViewDialog
        key={saveViewOpen ? "open" : "closed"}
        open={saveViewOpen}
        filters={{ ...filters, search: filters.search?.trim() || undefined }}
        canShare={!!me?.access.canManage}
        teams={teams}
        isSaving={createView.isPending}
        onOpenChange={setSaveViewOpen}
        onSave={(data) =>
          createView.mutate(data, {
            onSuccess: (view) => {
              setSaveViewOpen(false);
              patchParams({ sv: view.id });
            },
          })
        }
      />
    </div>
  );
}
