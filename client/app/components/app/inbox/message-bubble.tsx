import { memo, useState, type ReactNode } from "react";
import {
  AlertCircle,
  Check,
  CheckCheck,
  Clock,
  CornerUpLeft,
  Download,
  ExternalLink,
  FileText,
  List,
  Loader2,
  Lock,
  MapPin,
  MessageCircle,
  MoreHorizontal,
  Phone,
  RotateCw,
  ShoppingCart,
  SmilePlus,
  UserRound,
  type LucideIcon,
} from "lucide-react";

import { Button } from "~/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover";
import { MEDIA_KINDS, MESSAGE_STATUS_LABEL, SOURCE_LABEL, formatBubbleTime, formatBytes, formatDateTime } from "~/lib/inbox-format";
import { apiUrl } from "~/lib/api-client";
import { useResendMessageMutation } from "~/hooks/use-inbox-mutations";
import { cn } from "~/lib/utils";
import { CartActions } from "./cart-actions";
import { ConversationAvatar } from "./conversation-avatar";
import { VoiceNotePlayer } from "./voice-note-player";
import type { InboxMessage, InboxMessageKind, InboxMessageStatus } from "~/types/api";

const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "🙏", "✅"];

export type CommentReplyMode = "private" | "public";

/** Where the time and ticks go: after the last line of text, over a picture, or in a voice note's own row. */
type MetaPlacement = "float" | "overlay" | "inline";

/** The receipt as WhatsApp shows it: a clock, one grey tick, two, two blue; red when it failed. */
function StatusIcon({ status }: { status: InboxMessageStatus }) {
  const icon =
    status === "QUEUED" ? (
      <Clock className="size-3.5" />
    ) : status === "SENT" ? (
      <Check className="size-4" />
    ) : status === "DELIVERED" ? (
      <CheckCheck className="size-4" />
    ) : status === "FAILED" ? (
      <AlertCircle className="size-3.5 text-danger" />
    ) : (
      <CheckCheck className="size-4 text-chat-read" />
    );
  return (
    <span className="inline-flex" title={MESSAGE_STATUS_LABEL[status]}>
      {icon}
      <span className="sr-only">{MESSAGE_STATUS_LABEL[status]}</span>
    </span>
  );
}

/** Time, and for what we sent the receipt, in the bubble's bottom corner. */
function BubbleMeta({ message, placement }: { message: InboxMessage; placement: MetaPlacement }) {
  return (
    <span
      className={cn(
        "flex items-center gap-1 whitespace-nowrap text-[11px] leading-4 not-italic",
        // A float after the last word sits on that line when there is room, and drops below it when not.
        placement === "float" && "relative top-[5px] float-right ml-3 text-chat-meta",
        placement === "inline" && "text-chat-meta",
        placement === "overlay" && "absolute right-1.5 bottom-1.5 rounded-full bg-black/40 px-1.5 py-0.5 text-white",
      )}
    >
      {message.imported && <span title="Imported from the WhatsApp Business app">Imported</span>}
      {message.editedAt && !message.revokedAt && <span title={formatDateTime(message.editedAt)}>Edited</span>}
      <time dateTime={message.createdAt} title={formatDateTime(message.createdAt)}>
        {formatBubbleTime(message.createdAt)}
      </time>
      {message.direction === "OUTBOUND" && !message.imported && <StatusIcon status={message.status} />}
    </span>
  );
}

/** The small curl on the first bubble of a run, pointing at the side it came from. */
function BubbleTail({ isOutbound }: { isOutbound: boolean }) {
  return (
    <svg
      viewBox="0 0 8 12"
      aria-hidden
      className={cn("absolute top-0 h-3 w-2", isOutbound ? "-right-2 -scale-x-100 fill-chat-bubble-out" : "-left-2 fill-chat-bubble-in")}
    >
      <path d="M8 0v12L.9 2.2C.3 1.3.8 0 1.9 0z" />
    </svg>
  );
}

const HEADER_FILE: Record<"image" | "video" | "document", InboxMessageKind> = { image: "IMAGE", video: "VIDEO", document: "DOCUMENT" };

/** What a file is drawn as: its message's kind, or for a template the header it was sent in. */
const fileKind = (message: InboxMessage): InboxMessageKind =>
  message.kind === "TEMPLATE" ? HEADER_FILE[message.media?.kind ?? "document"] : message.kind;

/** Media: the file itself when stored, a placeholder while it downloads. */
function MessageMedia({
  message,
  isOutbound,
  meta,
  voiceAvatar,
  localAudio,
}: {
  message: InboxMessage;
  isOutbound: boolean;
  meta: ReactNode;
  voiceAvatar: ReactNode;
  localAudio?: Blob;
}) {
  const media = message.media!;
  const voice = (src: string | Blob) => (
    <VoiceNotePlayer
      src={src}
      durationMs={media.durationMs}
      isOutbound={isOutbound}
      played={message.status === "PLAYED"}
      avatar={voiceAvatar}
      footer={meta}
    />
  );
  if (localAudio && media.voice) return voice(localAudio);
  if (media.error) {
    return <p className="text-caption italic text-chat-meta">File unavailable — {media.error}</p>;
  }
  if (!media.url) {
    return (
      <p className="flex items-center gap-1.5 text-caption text-chat-meta">
        <Loader2 className="size-3.5 animate-spin" />
        {media.pending ? "Downloading file…" : "File not stored"}
      </p>
    );
  }
  const url = apiUrl(media.url);
  switch (fileKind(message)) {
    case "IMAGE":
    case "STICKER":
      return (
        <div className="relative w-fit">
          <a href={url} target="_blank" rel="noreferrer" className="block">
            <img
              src={url}
              alt={message.text ?? "Image"}
              loading="lazy"
              className={cn("max-h-72 rounded-md object-contain", message.kind === "STICKER" ? "size-32" : "max-w-full")}
            />
          </a>
          {meta}
        </div>
      );
    case "VIDEO":
      return (
        <div className="relative w-fit">
          <video src={url} controls preload="metadata" className="max-h-72 max-w-full rounded-md" />
          {meta}
        </div>
      );
    case "AUDIO":
      return media.voice ? voice(url) : <audio src={url} controls preload="none" className="h-9 w-64 max-w-full" />;
    default:
      return (
        <a href={url} target="_blank" rel="noreferrer" className="flex items-center gap-2.5 rounded-md bg-chat-quote px-3 py-2 transition-opacity hover:opacity-80">
          <FileText className="size-5 shrink-0 text-chat-icon" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-caption font-medium">{media.filename ?? "Document"}</span>
            <span className="block text-micro text-chat-meta">{[media.mime, formatBytes(media.size)].filter(Boolean).join(" · ")}</span>
          </span>
          <Download className="size-4 shrink-0 text-chat-icon" />
        </a>
      );
  }
}

/**
 * Buttons, list rows, quick replies or catalog products that went out with an
 * outbound message, as the segments WhatsApp draws under the bubble.
 */
function sentOptions(payload: Record<string, unknown>): Array<{ icon: LucideIcon; label: string }> {
  if (payload.type === "product" || payload.type === "product_list" || payload.type === "product_carousel" || payload.type === "catalog") {
    const count =
      payload.type === "product_list"
        ? ((payload.sections as Array<{ productRetailerIds?: string[] }> | undefined) ?? []).reduce((n, s) => n + (s.productRetailerIds?.length ?? 0), 0)
        : payload.type === "product_carousel"
          ? ((payload.productRetailerIds as string[] | undefined) ?? []).length
          : 1;
    const label = payload.type === "catalog" ? "Catalog" : payload.type === "product" ? "Product card" : payload.type === "product_carousel" ? `${count} product cards` : `${count} products`;
    return [{ icon: ShoppingCart, label }];
  }
  // WhatsApp shows the customer its own "Allow calls" buttons under this text.
  if (payload.type === "call_permission_request") return [{ icon: Phone, label: "Allow calls" }];
  const titles =
    (payload.buttons as Array<{ title: string }> | undefined)?.map((b) => b.title) ??
    (payload.replies as Array<{ title: string }> | undefined)?.map((r) => r.title) ??
    (payload.sections as Array<{ rows?: Array<{ title: string }> }> | undefined)?.flatMap((s) => (s.rows ?? []).map((r) => r.title));
  if (!titles?.length) return [];
  if (payload.buttonText) return [{ icon: List, label: `${String(payload.buttonText)} · ${titles.length} options` }];
  return titles.map((title) => ({ icon: CornerUpLeft, label: title }));
}

/** Inbound locations arrive as `location`; ones we sent are in the payload. */
function locationOf(message: InboxMessage) {
  const details = message.details;
  return (details?.location ?? (details?.payload?.type === "location" ? details.payload : null)) as
    | { latitude: number; longitude: number; name?: string; address?: string }
    | null;
}

function MessageBody({
  message,
  isOutbound,
  framed,
  meta,
  voiceAvatar,
  localAudio,
}: {
  message: InboxMessage;
  isOutbound: boolean;
  /** A picture or video edge to edge: text inside needs its own padding. */
  framed: boolean;
  meta: (placement: MetaPlacement) => ReactNode;
  voiceAvatar: ReactNode;
  localAudio?: Blob;
}) {
  const { details } = message;
  if (message.revokedAt) {
    return (
      <p className="italic text-chat-meta">
        This message was deleted.
        {meta("float")}
      </p>
    );
  }
  const location = locationOf(message);
  // A template's header file (a bill's PDF, an invoice) sits above its text, whatever Meta did with the message.
  const media = !!message.media && (MEDIA_KINDS.includes(message.kind) || message.kind === "TEMPLATE");
  const isVoice = media && message.kind === "AUDIO" && message.media!.voice && (!!message.media!.url || !!localAudio);
  const overlay = media && !message.text && !!message.media!.url && ["IMAGE", "VIDEO", "STICKER"].includes(message.kind);
  const showText = !!message.text && !location;
  const unsupported = !message.text && !media && !location && message.kind === "UNSUPPORTED";
  const metaAtEnd = !isVoice && !overlay && !showText && !unsupported;
  const label = cn("text-[11.5px] font-medium leading-4 text-chat-meta", framed && "px-1.5 pt-0.5");

  return (
    <div className="space-y-1">
      {message.kind === "TEMPLATE" && message.templateName && <p className={label}>Template · {message.templateName}</p>}
      {message.kind === "INTERACTIVE" && !isOutbound && <p className={label}>Tapped a button</p>}
      {message.kind === "PRIVATE_REPLY" && (
        <p className={cn(label, "flex items-center gap-1")}>
          <Lock className="size-3" />
          Private reply to their comment
        </p>
      )}
      {message.kind === "COMMENT" && isOutbound && (
        <p className={cn(label, "flex items-center gap-1")}>
          <MessageCircle className="size-3" />
          Public reply
        </p>
      )}

      {media && (
        <MessageMedia
          message={message}
          isOutbound={isOutbound}
          meta={isVoice ? meta("inline") : overlay ? meta("overlay") : null}
          voiceAvatar={voiceAvatar}
          localAudio={localAudio}
        />
      )}

      {location && (
        <a
          href={`https://www.google.com/maps?q=${location.latitude},${location.longitude}`}
          target="_blank"
          rel="noreferrer"
          className="flex items-start gap-2 rounded-md bg-chat-quote px-2.5 py-2 hover:underline"
        >
          <MapPin className="mt-0.5 size-4 shrink-0 text-chat-recording" />
          <span className="text-caption">
            {location.name ?? "Shared location"}
            {location.address && <span className="block text-chat-meta">{location.address}</span>}
          </span>
        </a>
      )}

      {message.kind === "CONTACTS" && details?.contacts && (
        <div className="space-y-1">
          {details.contacts.map((card, index) => (
            <p key={index} className="flex items-center gap-2 text-caption">
              <UserRound className="size-4 shrink-0 text-chat-icon" />
              {card.name?.formatted_name ?? "Contact"}
              {card.phones?.[0]?.phone && <span className="text-chat-meta">{card.phones[0].phone}</span>}
            </p>
          ))}
        </div>
      )}

      {message.kind === "ORDER" && details?.order && (
        <div className="flex items-center gap-2 rounded-md bg-chat-quote px-2.5 py-2 text-caption">
          <ShoppingCart className="size-4 shrink-0 text-chat-icon" />
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
      {showText && (
        <p className={cn("whitespace-pre-wrap [overflow-wrap:anywhere]", framed && "px-1.5 pb-1")}>
          {message.text}
          {!isVoice && meta("float")}
        </p>
      )}
      {unsupported && (
        <p className="text-caption italic text-chat-meta">
          This message type cannot be shown here. Open it on the phone.
          {meta("float")}
        </p>
      )}
      {metaAtEnd && meta("float")}
    </div>
  );
}

/** The message this one answers, as a tinted strip at the top of the bubble. */
function QuotedMessage({ replyTo, customerName }: { replyTo: NonNullable<InboxMessage["replyTo"]>; customerName?: string }) {
  const fromCustomer = replyTo.direction === "INBOUND";
  return (
    <div className="mb-1 flex min-w-0 overflow-hidden rounded-md bg-chat-quote">
      <span aria-hidden className={cn("w-1 shrink-0", fromCustomer ? "bg-chat-accent" : "bg-chat-send")} />
      <div className="min-w-0 px-2 py-1">
        <p className={cn("truncate text-[12.5px] font-medium leading-4", fromCustomer ? "text-chat-accent" : "text-chat-send")}>
          {fromCustomer ? (customerName ?? "Customer") : "You"}
        </p>
        <p className="line-clamp-2 text-[13px] leading-[18px] text-chat-meta">{replyTo.text ?? replyTo.kind.toLowerCase()}</p>
      </div>
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
    <div className="w-full max-w-[min(34rem,85%)] rounded-lg bg-chat-bubble-in px-4 py-3 text-chat-bubble-foreground shadow-chat">
      <div className="flex items-start gap-3">
        {comment?.post?.thumbnailUrl && (
          <img src={comment.post.thumbnailUrl} alt="" className="size-12 shrink-0 rounded-md object-cover" loading="lazy" />
        )}
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-micro font-medium text-chat-meta">
            <MessageCircle className="size-3" />
            {comment?.parentId ? "Replied to a comment on your" : "Commented on your"} {where}
            {comment?.post?.permalink && (
              <a href={comment.post.permalink} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-chat-accent hover:underline">
                View <ExternalLink className="size-3" />
              </a>
            )}
          </p>
          {message.revokedAt ? (
            <p className="mt-1 text-caption italic text-chat-meta">This comment was deleted.</p>
          ) : (
            <p className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere] text-body">{message.text}</p>
          )}
          {comment?.post?.caption && <p className="mt-1 truncate text-micro text-chat-meta">“{comment.post.caption}”</p>}
        </div>
      </div>
      {canReply && !message.revokedAt && (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t border-chat-divider pt-2.5">
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
      <p className="mt-1.5 text-right text-[11px] text-chat-meta">{formatBubbleTime(message.createdAt)}</p>
    </div>
  );
}

/** Sends a failed message again; the new one appears below it. */
function ResendButton({ conversationId, messageId }: { conversationId: string; messageId: string }) {
  const resend = useResendMessageMutation(conversationId);
  return (
    <Button variant="ghost" size="xs" disabled={resend.isPending} onClick={() => resend.mutate(messageId)} className="text-chat-icon">
      {resend.isPending ? <Loader2 className="animate-spin" /> : <RotateCw />}
      Send again
    </Button>
  );
}

/**
 * One message in the thread, drawn the way WhatsApp draws it.
 *
 * Outbound sits right on green, inbound left on white. The first bubble of a
 * run from one side carries the tail and, where it matters, who wrote it; the
 * rest of the run tucks in under it.
 */
export const MessageBubble = memo(function MessageBubble({
  message,
  conversationId,
  canReply,
  firstInRun = true,
  customerName,
  customerAvatarUrl,
  localAudio,
  onQuote,
  onReact,
  onCommentReply,
}: {
  message: InboxMessage;
  conversationId: string;
  canReply: boolean;
  firstInRun?: boolean;
  customerName?: string;
  customerAvatarUrl?: string | null;
  /** A voice note still uploading: the recording itself, to play meanwhile. */
  localAudio?: Blob;
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
      <div className="my-2 flex justify-center">
        <p className="max-w-[85%] rounded-lg bg-chat-system px-3 py-1.5 text-center text-[12.5px] leading-[17px] text-chat-system-foreground shadow-chat">
          {message.text ?? "Account update"} · {formatBubbleTime(message.createdAt)}
        </p>
      </div>
    );
  }
  if (message.kind === "COMMENT" && !isOutbound) {
    return (
      <div className="mt-2 flex justify-start">
        <CommentCard message={message} canReply={canReply} onCommentReply={onCommentReply} />
      </div>
    );
  }

  const reactions = Object.entries(message.reactions ?? {}).filter(([, emoji]) => !!emoji) as Array<[string, string]>;
  const sentBy = isOutbound ? (message.source === "AGENT" ? message.sentBy?.name : SOURCE_LABEL[message.source]) : null;
  const author = isOutbound ? sentBy : message.groupSender ? (message.groupSender.name ?? `+${message.groupSender.waId}`) : null;
  const canAct = canReply && !message.revokedAt && !isPending && !isFailed;
  const hasFile = !!message.media?.url && !message.revokedAt;
  const isSticker = message.kind === "STICKER" && hasFile;
  const framed = hasFile && (message.kind === "IMAGE" || message.kind === "VIDEO");
  const segments = isOutbound && message.details?.payload && !message.revokedAt ? sentOptions(message.details.payload) : [];
  const tone = isOutbound ? "bg-chat-bubble-out" : "bg-chat-bubble-in";
  const person = isOutbound ? (message.source === "AGENT" ? message.sentBy?.name : null) : (message.groupSender?.name ?? customerName);
  const voiceAvatar = person ? (
    <ConversationAvatar name={person} avatarUrl={isOutbound || message.groupSender ? null : customerAvatarUrl} size="lg" />
  ) : (
    <span className="flex size-10 items-center justify-center rounded-full bg-chat-quote text-chat-icon">
      <UserRound className="size-5" />
    </span>
  );

  return (
    <div
      className={cn(
        "group flex items-center gap-1",
        isOutbound ? "flex-row-reverse" : "flex-row",
        firstInRun ? "mt-2" : "mt-0.5",
        reactions.length > 0 && "mb-4",
      )}
    >
      <div className={cn("flex min-w-0 max-w-[85%] flex-col gap-1 md:max-w-[65%]", isOutbound ? "items-end" : "items-start")}>
        <div className={cn("relative grid w-fit max-w-full", !isSticker && "drop-shadow-chat")}>
          <div
            className={cn(
              "relative flow-root min-w-0 rounded-lg text-[15px] leading-[21px] text-chat-bubble-foreground md:text-[14.5px] md:leading-[19px]",
              isSticker ? "p-0" : framed ? "p-1" : "px-2.5 pt-1.5 pb-2",
              !isSticker && tone,
              firstInRun && !isSticker && (isOutbound ? "rounded-tr-none" : "rounded-tl-none"),
              segments.length > 0 && "rounded-b-none",
            )}
          >
            {firstInRun && !isSticker && <BubbleTail isOutbound={isOutbound} />}
            {firstInRun && author && (
              <p className={cn("mb-0.5 truncate text-[12.5px] font-medium leading-4", isOutbound ? "text-chat-meta" : "text-chat-accent", framed && "px-1.5 pt-0.5")}>
                {author}
              </p>
            )}
            {message.replyTo && <QuotedMessage replyTo={message.replyTo} customerName={customerName} />}
            <MessageBody
              message={message}
              isOutbound={isOutbound}
              framed={framed}
              meta={(placement) => <BubbleMeta message={message} placement={placement} />}
              voiceAvatar={voiceAvatar}
              localAudio={localAudio}
            />
          </div>
          {segments.map((segment, index) => (
            <div
              key={index}
              className={cn(
                "flex min-w-0 items-center justify-center gap-1.5 border-t border-chat-divider px-3 py-2 text-[14px] font-medium leading-5 text-chat-accent",
                tone,
                index === segments.length - 1 && "rounded-b-lg",
              )}
            >
              <segment.icon className="size-4 shrink-0" />
              <span className="truncate">{segment.label}</span>
            </div>
          ))}
          {reactions.length > 0 && (
            <div className={cn("absolute -bottom-4 flex gap-0.5", isOutbound ? "right-2" : "left-2")}>
              {reactions.map(([who, emoji]) => (
                <span
                  key={who}
                  className="rounded-full bg-chat-bubble-in px-1.5 py-0.5 text-[13px] leading-4 ring-1 ring-chat-divider"
                  title={who === "business" ? "Your reaction" : "Customer’s reaction"}
                >
                  {emoji}
                </span>
              ))}
            </div>
          )}
        </div>
        {message.kind === "ORDER" && !isOutbound && canAct && <CartActions conversationId={conversationId} messageId={message.id} />}

        {isFailed && message.errorMessage && (
          <p className={cn("max-w-full px-1 text-micro text-danger [overflow-wrap:anywhere]", isOutbound && "text-right")}>{message.errorMessage}</p>
        )}
        {isFailed && isOutbound && canReply && !message.imported && message.source !== "BUSINESS_APP" && message.source !== "OTHER_APP" && (
          <ResendButton conversationId={conversationId} messageId={message.id} />
        )}
      </div>

      {canAct && (
        <div className="flex shrink-0 items-center text-chat-icon transition-opacity md:opacity-0 md:group-hover:opacity-100 focus-within:opacity-100">
          <Button variant="ghost" size="icon-xs" onClick={() => onQuote(message)} aria-label="Reply to this message" title="Reply" className="hidden md:inline-flex">
            <CornerUpLeft />
          </Button>
          <Popover open={reactOpen} onOpenChange={setReactOpen}>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="icon-xs" aria-label="Message actions" title="Message actions" className="size-11 rounded-full opacity-60 md:size-6 md:rounded-md md:opacity-100">
                <MoreHorizontal className="size-4 md:hidden" />
                <SmilePlus className="hidden md:block" />
              </Button>
            </PopoverTrigger>
            <PopoverContent side="top" className="w-auto rounded-2xl p-2 md:rounded-lg md:p-1.5">
              <Button variant="ghost" onClick={() => { onQuote(message); setReactOpen(false); }} className="mb-1 h-11 w-full justify-start rounded-xl md:hidden">
                <CornerUpLeft className="size-4" />Reply to message
              </Button>
              <div className="flex gap-0.5 md:gap-1">
              {QUICK_REACTIONS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  onClick={() => {
                    onReact(message, emoji);
                    setReactOpen(false);
                  }}
                  className="flex size-11 items-center justify-center rounded-xl text-xl hover:bg-muted md:size-auto md:rounded-md md:px-1.5 md:py-1 md:text-body"
                  aria-label={`React with ${emoji}`}
                >
                  {emoji}
                </button>
              ))}
              </div>
            </PopoverContent>
          </Popover>
        </div>
      )}
    </div>
  );
});
