import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useMutationState } from "@tanstack/react-query";

import { voiceNoteKey, type VoiceNoteSend } from "~/hooks/use-inbox-mutations";
import { useInboxConversation } from "~/hooks/use-inbox-queries";
import { buildThreadDays } from "~/lib/inbox-format";
import { cn } from "~/lib/utils";
import { useAuthStore } from "~/stores/auth.store";
import type { InboxMessage, InboxNote } from "~/types/api";

import { MessageBubble, type CommentReplyMode } from "./message-bubble";
import { ThreadNote } from "./thread-note";
import { scrollBehavior } from "~/lib/motion";

/**
 * Which run a message belongs to: one side, and on our side or in a group one
 * author. A run's first bubble gets the tail and the name; system notices and
 * comments stand alone.
 */
function runKey(message: InboxMessage): string | null {
  if (message.kind === "SYSTEM" || (message.kind === "COMMENT" && message.direction === "INBOUND")) return null;
  if (message.direction === "INBOUND") return `in:${message.groupSender?.waId ?? ""}`;
  return `out:${message.source === "AGENT" ? (message.sentBy?.id ?? "") : message.source}`;
}

/**
 * Column 2 body — the message stream.
 *
 * Messages and notes are separate entities but share one chronological column,
 * so they are merged into a single ordered list here (buildThreadDays) rather
 * than rendered as two passes. Voice notes still uploading join the list as
 * queued messages, so they show from the moment Send is pressed.
 *
 * `role="log"` + `aria-live="polite"` so a screen reader announces an arriving
 * message without stealing focus from the composer mid-sentence.
 */
export function ConversationThread({
  conversationId,
  messages,
  notes,
  canReply,
  hasEarlier,
  isLoadingEarlier,
  onLoadEarlier,
  onQuote,
  onReact,
  onCommentReply,
  className,
}: {
  conversationId: string;
  messages: InboxMessage[];
  notes: InboxNote[];
  canReply: boolean;
  hasEarlier: boolean;
  isLoadingEarlier: boolean;
  onLoadEarlier: () => void;
  onQuote: (message: InboxMessage) => void;
  onReact: (message: InboxMessage, emoji: string) => void;
  onCommentReply: (message: InboxMessage, mode: CommentReplyMode) => void;
  className?: string;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  /** Scroll height before older messages were prepended, to keep the reader's place. */
  const heightBeforeEarlier = useRef<number | null>(null);
  // Already loaded by the page; read here for the customer's name and picture.
  const contact = useInboxConversation(conversationId).data?.contact;
  const user = useAuthStore((s) => s.user);

  const sending = useMutationState({
    filters: { mutationKey: voiceNoteKey(conversationId), status: "pending" },
    select: (mutation) => ({ id: mutation.mutationId, at: mutation.state.submittedAt, send: mutation.state.variables as VoiceNoteSend }),
  });
  const pendingVoice = useMemo(
    () =>
      sending.map(({ id, at, send }): { message: InboxMessage; file: File } => {
        const quoted = send.replyToMessageId ? messages.find((m) => m.id === send.replyToMessageId) : undefined;
        return {
          file: send.file,
          message: {
            id: `voice-note-${id}`,
            direction: "OUTBOUND",
            kind: "AUDIO",
            source: "AGENT",
            text: null,
            status: "QUEUED",
            createdAt: new Date(at).toISOString(),
            sentAt: null,
            deliveredAt: null,
            readAt: null,
            failedAt: null,
            errorMessage: null,
            imported: false,
            editedAt: null,
            revokedAt: null,
            reactions: null,
            templateName: null,
            sentBy: user ? { id: user.id, name: [user.firstName, user.lastName].filter(Boolean).join(" ") } : null,
            groupSender: null,
            replyTo: quoted ? { id: quoted.id, text: quoted.text, kind: quoted.kind, direction: quoted.direction } : null,
            media: { mime: send.file.type, filename: null, size: send.file.size, voice: true, durationMs: send.durationMs, url: null, pending: false, error: null },
            details: null,
          },
        };
      }),
    [sending, messages, user],
  );
  const newestId = pendingVoice.at(-1)?.message.id ?? messages[messages.length - 1]?.id;

  // Jump (not smooth-scroll) to the bottom when the thread changes: an
  // animation on switching conversations reads as the page still loading.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [conversationId]);

  /**
   * Follow new messages only when the agent is already at the bottom.
   *
   * Yanking someone back down while they are scrolled up reading history is
   * the single most irritating bug in a chat UI, and it fires exactly when
   * they are busiest.
   */
  useEffect(() => {
    const container = containerRef.current;
    if (!container || heightBeforeEarlier.current !== null) return;
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    if (distanceFromBottom < 160) bottomRef.current?.scrollIntoView({ behavior: scrollBehavior(), block: "end" });
  }, [newestId, notes.length]);

  // After older messages land above, hold the view where the reader was.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || heightBeforeEarlier.current === null || isLoadingEarlier) return;
    container.scrollTop += container.scrollHeight - heightBeforeEarlier.current;
    heightBeforeEarlier.current = null;
  }, [messages.length, isLoadingEarlier]);

  // `now` is read once per render, not ticked: day separators change at
  // midnight, and re-rendering the whole stream every minute to catch that is
  // a bad trade.
  const days = buildThreadDays(pendingVoice.length ? [...messages, ...pendingVoice.map((p) => p.message)] : messages, notes, Date.now());

  return (
    <div className={cn("chat-wallpaper flex min-h-0 flex-1 flex-col", className)}>
      <div
        ref={containerRef}
        role="log"
        aria-live="polite"
        aria-label="Message thread"
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pt-2 pb-4 md:px-[6%]"
      >
        {hasEarlier && (
          <div className="flex justify-center py-2">
            <button
              type="button"
              disabled={isLoadingEarlier}
              onClick={() => {
                heightBeforeEarlier.current = containerRef.current?.scrollHeight ?? null;
                onLoadEarlier();
              }}
              className="min-h-11 rounded-lg px-3 text-[12.5px] text-chat-pill-foreground disabled:opacity-60 md:min-h-0"
            >
              <span className="rounded-lg bg-chat-pill px-3 py-1.5 shadow-chat">{isLoadingEarlier ? "Loading…" : "Load earlier messages"}</span>
            </button>
          </div>
        )}
        {days.length === 0 ? (
          <div className="flex justify-center py-8">
            <p className="rounded-lg bg-chat-pill px-3 py-1.5 text-[12.5px] text-chat-pill-foreground shadow-chat">No messages in this conversation yet.</p>
          </div>
        ) : (
          days.map((day) => (
            <section key={day.key} className="pb-1">
              {/* Sticky within its own day, so the date of what is on screen stays in view. */}
              <div className="sticky top-2 z-10 flex justify-center py-2">
                <span className="rounded-lg bg-chat-pill px-3 py-1.5 text-[12.5px] leading-4 text-chat-pill-foreground shadow-chat">{day.label}</span>
              </div>

              {day.items.map((item, index) => {
                if (item.kind === "note") return <ThreadNote key={item.note.id} note={item.note} className="my-3" />;
                const previous = day.items[index - 1];
                const key = runKey(item.message);
                const firstInRun = !(key && previous?.kind === "message" && runKey(previous.message) === key);
                return (
                  <MessageBubble
                    key={item.message.id}
                    message={item.message}
                    conversationId={conversationId}
                    canReply={canReply}
                    firstInRun={firstInRun}
                    customerName={contact?.name}
                    customerAvatarUrl={contact?.avatarUrl}
                    localAudio={pendingVoice.find((p) => p.message === item.message)?.file}
                    onQuote={onQuote}
                    onReact={onReact}
                    onCommentReply={onCommentReply}
                  />
                );
              })}
            </section>
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
