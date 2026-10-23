import { memo, useState } from "react";
import {
  AlertCircle,
  CornerUpLeft,
  Download,
  ExternalLink,
  FileText,
  Loader2,
  Lock,
  MapPin,
  MessageCircle,
  ShoppingCart,
  SmilePlus,
  UserRound,
} from "lucide-react";

import { Button } from "~/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover";
import { MESSAGE_STATUS_LABEL, SOURCE_LABEL, formatBubbleTime, formatBytes, formatDateTime } from "~/lib/inbox-format";
import { cn } from "~/lib/utils";
import type { InboxMessage } from "~/types/api";

const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "🙏", "✅"];

export type CommentReplyMode = "private" | "public";

/** Media: the file itself when stored, a placeholder while it downloads. */
function MessageMedia({ message, isOutbound }: { message: InboxMessage; isOutbound: boolean }) {
  const media = message.media!;
  if (media.error) {
    return <p className="text-caption italic opacity-80">File unavailable — {media.error}</p>;
  }
  if (!media.url) {
    return (
      <p className="flex items-center gap-1.5 text-caption opacity-80">
        <Loader2 className="size-3.5 animate-spin" />
        {media.pending ? "Downloading file…" : "File not stored"}
      </p>
    );
  }
  switch (message.kind) {
    case "IMAGE":
    case "STICKER":
      return (
        <a href={media.url} target="_blank" rel="noreferrer" className="block">
          <img
            src={media.url}
            alt={message.text ?? "Image"}
            loading="lazy"
            className={cn("max-h-72 rounded-lg object-contain", message.kind === "STICKER" ? "size-32" : "max-w-full")}
          />
        </a>
      );
    case "VIDEO":
      return <video src={media.url} controls preload="metadata" className="max-h-72 max-w-full rounded-lg" />;
    case "AUDIO":
      return (
        <div className="space-y-1">
          {media.voice && <p className="text-micro opacity-80">Voice message</p>}
          <audio src={media.url} controls preload="none" className="h-9 max-w-64" />
        </div>
      );
    default:
      return (
        <a
          href={media.url}
          target="_blank"
          rel="noreferrer"
          className={cn(
            "flex items-center gap-2.5 rounded-lg px-3 py-2 transition-colors",
            isOutbound ? "bg-brand-foreground/10 hover:bg-brand-foreground/15" : "bg-card hover:bg-card/80",
          )}
        >
          <FileText className="size-5 shrink-0" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-caption font-medium">{media.filename ?? "Document"}</span>
            <span className="block text-micro opacity-70">{[media.mime, formatBytes(media.size)].filter(Boolean).join(" · ")}</span>
          </span>
          <Download className="size-4 shrink-0 opacity-70" />
        </a>
      );
  }
}

/** Buttons, list rows or quick replies that went out with an outbound message. */
function SentOptions({ payload }: { payload: Record<string, unknown> }) {
  const titles =
    (payload.buttons as Array<{ title: string }> | undefined)?.map((b) => b.title) ??
    (payload.replies as Array<{ title: string }> | undefined)?.map((r) => r.title) ??
    (payload.sections as Array<{ rows: Array<{ title: string }> }> | undefined)?.flatMap((s) => s.rows.map((r) => r.title));
  if (!titles?.length) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1">
      {payload.buttonText ? (
        <span className="rounded-full border border-brand-foreground/30 px-2.5 py-0.5 text-micro font-medium">
          {String(payload.buttonText)} · {titles.length} options
        </span>
      ) : (
        titles.map((title) => (
          <span key={title} className="rounded-full border border-brand-foreground/30 px-2.5 py-0.5 text-micro font-medium">
            {title}
          </span>
        ))
      )}
    </div>
  );
}

function MessageBody({ message, isOutbound }: { message: InboxMessage; isOutbound: boolean }) {
  const { details } = message;
  if (message.revokedAt) {
    return <p className="text-caption italic opacity-80">This message was deleted.</p>;
  }
  // Inbound locations arrive as `location`; ones we sent are in the payload.
  const location = (details?.location ?? (details?.payload?.type === "location" ? details.payload : null)) as
    | { latitude: number; longitude: number; name?: string; address?: string }
    | null;
  const media = message.media && ["IMAGE", "VIDEO", "AUDIO", "DOCUMENT", "STICKER"].includes(message.kind);

  return (
    <div className="space-y-2">
      {message.kind === "TEMPLATE" && message.templateName && (
        <p className="text-micro font-medium opacity-75">Template · {message.templateName}</p>
      )}
      {message.kind === "INTERACTIVE" && !isOutbound && (
        <p className="text-micro font-medium opacity-75">Tapped a button</p>
      )}
      {message.kind === "PRIVATE_REPLY" && (
        <p className="flex items-center gap-1 text-micro font-medium opacity-75">
          <Lock className="size-3" />
          Private reply to their comment
        </p>
      )}
      {message.kind === "COMMENT" && isOutbound && (
        <p className="flex items-center gap-1 text-micro font-medium opacity-75">
          <MessageCircle className="size-3" />
          Public reply
        </p>
      )}

      {media && <MessageMedia message={message} isOutbound={isOutbound} />}

      {location && (
        <a
          href={`https://www.google.com/maps?q=${location.latitude},${location.longitude}`}
          target="_blank"
          rel="noreferrer"
          className="flex items-start gap-2 hover:underline"
        >
          <MapPin className="mt-0.5 size-4 shrink-0" />
          <span className="text-caption">
            {location.name ?? "Shared location"}
            {location.address && <span className="block opacity-75">{location.address}</span>}
          </span>
        </a>
      )}

      {message.kind === "CONTACTS" && details?.contacts && (
        <div className="space-y-1">
          {details.contacts.map((card, index) => (
            <p key={index} className="flex items-center gap-2 text-caption">
              <UserRound className="size-4 shrink-0" />
              {card.name?.formatted_name ?? "Contact"}
              {card.phones?.[0]?.phone && <span className="opacity-75">{card.phones[0].phone}</span>}
            </p>
          ))}
        </div>
      )}

      {message.kind === "ORDER" && details?.order && (
        <div className="flex items-center gap-2 text-caption">
          <ShoppingCart className="size-4 shrink-0" />
          {(() => {
            const items = details.order.product_items ?? [];
            const quantity = items.reduce((sum, item) => sum + item.quantity, 0);
            const total = items.reduce((sum, item) => sum + item.quantity * item.item_price, 0);
            const currency = items[0]?.currency ?? "";
            return `Cart · ${quantity} item${quantity === 1 ? "" : "s"}${total ? ` · ${currency} ${total.toLocaleString("en-IN")}` : ""}`;
          })()}
        </div>
      )}

      {/* Media captions and location names are already shown above. */}
      {message.text && !location && <p className="whitespace-pre-wrap break-words">{message.text}</p>}
      {!message.text && !media && !location && message.kind === "UNSUPPORTED" && (
        <p className="text-caption italic opacity-80">This message type cannot be shown here. Open it on the phone.</p>
      )}

      {isOutbound && details?.payload && <SentOptions payload={details.payload} />}
    </div>
  );
}

/** An inbound comment: the post it is on, the text, and the two ways to answer. */
function CommentCard({
  message,
  canReply,
  onCommentReply,
}: {
  message: InboxMessage;
  canReply: boolean;
  onCommentReply: (message: InboxMessage, mode: CommentReplyMode) => void;
}) {
  const comment = message.details?.comment;
  const where = comment?.mediaProductType === "REELS" ? "reel" : comment?.mediaProductType === "STORY" ? "story" : "post";
  return (
    <div className="w-full max-w-[min(34rem,85%)] rounded-xl border bg-card px-4 py-3">
      <div className="flex items-start gap-3">
        {comment?.post?.thumbnailUrl && (
          <img src={comment.post.thumbnailUrl} alt="" className="size-12 shrink-0 rounded-md object-cover" loading="lazy" />
        )}
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-micro font-medium text-muted-foreground">
            <MessageCircle className="size-3" />
            {comment?.parentId ? "Replied to a comment on your" : "Commented on your"} {where}
            {comment?.post?.permalink && (
              <a href={comment.post.permalink} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-foreground hover:underline">
                View <ExternalLink className="size-3" />
              </a>
            )}
          </p>
          {message.revokedAt ? (
            <p className="mt-1 text-caption italic text-muted-foreground">This comment was deleted.</p>
          ) : (
            <p className="mt-1 whitespace-pre-wrap break-words text-body text-foreground">{message.text}</p>
          )}
          {comment?.post?.caption && <p className="mt-1 truncate text-micro text-muted-foreground">“{comment.post.caption}”</p>}
        </div>
      </div>
      {canReply && !message.revokedAt && (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t pt-2.5">
          <Button
            variant="outline"
            size="xs"
            disabled={comment?.privateReplied}
            onClick={() => onCommentReply(message, "private")}
            title={comment?.privateReplied ? "Meta allows one private reply per comment" : "Answer in their inbox"}
          >
            <Lock />
            {comment?.privateReplied ? "Replied privately" : "Reply privately"}
          </Button>
          <Button variant="outline" size="xs" onClick={() => onCommentReply(message, "public")}>
            <MessageCircle />
            {comment?.publicReplied ? "Reply publicly again" : "Reply publicly"}
          </Button>
        </div>
      )}
      <p className="mt-1.5 text-micro text-muted-foreground">{formatBubbleTime(message.createdAt)}</p>
    </div>
  );
}

/**
 * One message in the thread.
 *
 * Outbound sits right on brand, inbound sits left on muted. The asymmetric
 * corner (`rounded-tr-sm` / `rounded-tl-sm`) is what makes direction readable
 * at a glance without reading the alignment.
 */
export const MessageBubble = memo(function MessageBubble({
  message,
  canReply,
  onQuote,
  onReact,
  onCommentReply,
}: {
  message: InboxMessage;
  canReply: boolean;
  onQuote: (message: InboxMessage) => void;
  onReact: (message: InboxMessage, emoji: string) => void;
  onCommentReply: (message: InboxMessage, mode: CommentReplyMode) => void;
}) {
  const [reactOpen, setReactOpen] = useState(false);
  const isOutbound = message.direction === "OUTBOUND";
  const isFailed = message.status === "FAILED";
  const isPending = message.status === "QUEUED";

  if (message.kind === "SYSTEM") {
    return (
      <div className="flex justify-center">
        <p className="max-w-[80%] rounded-full bg-muted px-3 py-1 text-center text-micro text-muted-foreground">
          {message.text ?? "Account update"} · {formatBubbleTime(message.createdAt)}
        </p>
      </div>
    );
  }
  if (message.kind === "COMMENT" && !isOutbound) {
    return (
      <div className="flex justify-start">
        <CommentCard message={message} canReply={canReply} onCommentReply={onCommentReply} />
      </div>
    );
  }

  const reactions = Object.entries(message.reactions ?? {}).filter(([, emoji]) => !!emoji) as Array<[string, string]>;
  const sentBy = isOutbound ? (message.source === "AGENT" ? message.sentBy?.name : SOURCE_LABEL[message.source]) : null;
  const canAct = canReply && !message.revokedAt && !isPending && !isFailed;

  return (
    <div className={cn("group flex items-center gap-1", isOutbound ? "flex-row-reverse" : "flex-row")}>
      <div className={cn("flex max-w-[min(34rem,78%)] flex-col gap-1", isOutbound ? "items-end" : "items-start")}>
        <div
          className={cn(
            // 14px, not 12px. `text-caption` is meta-text size — timestamps and
            // labels. Message bodies are the thing being read on this page.
            "rounded-xl px-4 py-3 text-body",
            isOutbound ? "rounded-tr-sm bg-brand text-brand-foreground" : "rounded-tl-sm bg-muted text-foreground",
            // The queued bubble is dimmed rather than hidden — the agent needs
            // to see their own words land the instant they hit send.
            isPending && "opacity-70",
            isFailed && "bg-danger-subtle text-danger",
          )}
        >
          {message.replyTo && (
            <div
              className={cn(
                "mb-2 border-l-2 pl-2 text-caption opacity-80",
                isOutbound ? "border-brand-foreground/40" : "border-foreground/30",
              )}
            >
              <p className="text-micro font-medium">{message.replyTo.direction === "INBOUND" ? "Customer" : "You"}</p>
              <p className="line-clamp-2">{message.replyTo.text ?? message.replyTo.kind.toLowerCase()}</p>
            </div>
          )}
          <MessageBody message={message} isOutbound={isOutbound} />
        </div>

        {reactions.length > 0 && (
          <div className="-mt-2 flex gap-0.5 px-2">
            {reactions.map(([who, emoji]) => (
              <span
                key={who}
                className="rounded-full bg-card px-1.5 py-0.5 text-caption shadow-sm ring-1 ring-border"
                title={who === "business" ? "Your reaction" : "Customer’s reaction"}
              >
                {emoji}
              </span>
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-1.5 px-1 text-micro text-muted-foreground">
          {sentBy && <span>{sentBy}</span>}
          {message.imported && <span title="Imported from the WhatsApp Business app">Imported</span>}
          {message.editedAt && !message.revokedAt && <span title={formatDateTime(message.editedAt)}>Edited</span>}
          <span title={formatDateTime(message.createdAt)}>{formatBubbleTime(message.createdAt)}</span>
          {isOutbound && !message.imported && (
            <span
              className={cn("inline-flex items-center gap-1", isFailed && "text-danger", message.status === "READ" && "text-brand-strong")}
              title={isFailed && message.errorMessage ? message.errorMessage : undefined}
            >
              {isFailed && <AlertCircle className="size-3" />}
              {MESSAGE_STATUS_LABEL[message.status]}
            </span>
          )}
        </div>
        {isFailed && message.errorMessage && <p className="max-w-full px-1 text-micro text-danger">{message.errorMessage}</p>}
      </div>

      {canAct && (
        <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <Button variant="ghost" size="icon-xs" onClick={() => onQuote(message)} aria-label="Reply to this message" title="Reply">
            <CornerUpLeft />
          </Button>
          <Popover open={reactOpen} onOpenChange={setReactOpen}>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="icon-xs" aria-label="React to this message" title="React">
                <SmilePlus />
              </Button>
            </PopoverTrigger>
            <PopoverContent side="top" className="flex w-auto gap-1 p-1.5">
              {QUICK_REACTIONS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  onClick={() => {
                    onReact(message, emoji);
                    setReactOpen(false);
                  }}
                  className="rounded-md px-1.5 py-1 text-body hover:bg-muted"
                  aria-label={`React with ${emoji}`}
                >
                  {emoji}
                </button>
              ))}
            </PopoverContent>
          </Popover>
        </div>
      )}
    </div>
  );
});
