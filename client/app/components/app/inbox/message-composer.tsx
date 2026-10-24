import { useImperativeHandle, useRef, useState, type KeyboardEvent, type Ref } from "react";
import { FileText, LayoutTemplate, ListPlus, Lock, MessageCircle, Paperclip, Plus, Send, X, Zap } from "lucide-react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover";
import { Textarea } from "~/components/ui/textarea";
import { useMediaQuery } from "~/hooks/use-media-query";
import { fillQuickReply, formatBytes, replyBlockedReason, windowPhase } from "~/lib/inbox-format";
import { cn } from "~/lib/utils";
import type {
  InboxConversationDetail,
  InboxMediaKind,
  InboxMessage,
  InboxSendPayload,
  InboxUpload,
  QuickReply,
  StoreProduct,
} from "~/types/api";

import type { CommentReplyMode } from "./message-bubble";
import { MAX_PRODUCTS, ProductPickerButton, ProductTray, productsPayload, type ProductsFormat } from "./product-picker";
import { QuickReplyPicker, matchQuickReplies } from "./quick-reply-picker";
import { ReplyWindowHint } from "./reply-window";

/** Drafts survive switching between conversations for the life of the tab. */
const drafts = new Map<string, string>();

interface StagedFile {
  storageKey: string;
  mime: string;
  filename: string;
  size: number | null;
  mediaKind: InboxMediaKind;
}

/** What the catalog panel and drops onto the chat can put in the reply box. */
export interface ComposerHandle {
  /** Stages products for the next send; returns why it cannot, if it cannot. */
  addProducts: (items: StoreProduct[], asCards: boolean, header?: string) => string | null;
  /** Uploads and stages a file; returns why it cannot, if it cannot. */
  attachFile: (file: File) => string | null;
  /** Adds text (a link, say) to the reply; returns why it cannot, if it cannot. */
  insertText: (text: string) => string | null;
}

/** WhatsApp reply buttons: up to 3. Messenger and Instagram quick replies: up to 13. */
const OPTION_LIMIT = { WHATSAPP: 3, OTHER: 13 };

const optionId = (title: string, index: number) =>
  `${title.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 40) || "option"}_${index + 1}`;

/**
 * Column 2 footer — the reply box.
 *
 * Reply and note share one input, switched by a toggle, rather than living in
 * two boxes. Two always-visible inputs is how an agent types a reply into the
 * note field; one input whose whole appearance changes with the mode makes the
 * current target unmissable. A comment reply is a third mode of the same box,
 * entered from the comment's own buttons.
 */
export function MessageComposer({
  conversation,
  quickReplies,
  agentName,
  quote,
  commentTarget,
  isSending,
  onClearQuote,
  onClearCommentTarget,
  onSend,
  onAddNote,
  onUpload,
  onOpenTemplates,
  ref,
}: {
  conversation: InboxConversationDetail;
  quickReplies: QuickReply[];
  agentName: string;
  quote: InboxMessage | null;
  commentTarget: { message: InboxMessage; mode: CommentReplyMode } | null;
  isSending: boolean;
  onClearQuote: () => void;
  onClearCommentTarget: () => void;
  /** Resolves true when the server accepted the message. */
  onSend: (payload: InboxSendPayload, replyToMessageId?: string) => Promise<boolean>;
  onAddNote: (body: string) => Promise<unknown>;
  onUpload: (file: File) => Promise<InboxUpload>;
  /** WhatsApp only: open the approved-template picker. */
  onOpenTemplates?: () => void;
  ref?: Ref<ComposerHandle>;
}) {
  const [draft, setDraftState] = useState(() => drafts.get(conversation.id) ?? "");
  const [isNoteMode, setIsNoteMode] = useState(false);
  const [staged, setStaged] = useState<StagedFile | null>(null);
  const [uploading, setUploading] = useState(false);
  const [options, setOptions] = useState<string[]>([]);
  const [pickerIndex, setPickerIndex] = useState(0);
  const [pickerDismissed, setPickerDismissed] = useState(false);
  const [products, setProducts] = useState<StoreProduct[]>([]);
  const [productsAsCards, setProductsAsCards] = useState(false);
  const [productsHeader, setProductsHeader] = useState<string | undefined>();
  const [productsFormat, setProductsFormat] = useState<ProductsFormat>("cards");
  const [toolsOpen, setToolsOpen] = useState(false);
  const isMobile = useMediaQuery("(max-width: 767px)");
  const fileRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  const setDraft = (value: string) => {
    setDraftState(value);
    drafts.set(conversation.id, value);
    setPickerDismissed(false);
  };

  const { platform, contact } = conversation;
  const phase = windowPhase(platform, conversation.window, Date.now());
  const canReply = conversation.reply.canReply;
  const commentMode = !!commentTarget;
  /** Why free-form replies are not possible right now, if they are not. */
  const blockedReason = replyBlockedReason(conversation, Date.now(), commentMode);
  const replyLocked = !!blockedReason && !isNoteMode;

  const slash = !isNoteMode && !commentMode && draft.startsWith("/") && !draft.includes("\n") ? draft.slice(1) : null;
  const matches = slash !== null && !pickerDismissed ? matchQuickReplies(quickReplies, slash) : null;

  const trimmed = draft.trim();
  const optionLimit = platform === "WHATSAPP" ? OPTION_LIMIT.WHATSAPP : OPTION_LIMIT.OTHER;
  const cleanOptions = options.map((o) => o.trim()).filter(Boolean);
  const canSubmit =
    !isSending &&
    !uploading &&
    (isNoteMode ? trimmed.length > 0 : !replyLocked && (trimmed.length > 0 || (!!staged && !commentMode) || (products.length > 0 && !commentMode)));

  /** Why products or a file cannot join this message right now, if they cannot. */
  const productsBlocked = replyLocked
    ? blockedReason
    : isNoteMode
      ? "Notes cannot carry products."
      : commentMode
        ? "Products cannot go in a comment reply."
        : staged
          ? "A message carries a file or products, not both. Remove the file first."
          : options.length
            ? "Reply buttons cannot go with products. Remove them first."
            : null;
  const fileBlocked = replyLocked
    ? blockedReason
    : isNoteMode
      ? "Notes cannot carry files."
      : commentMode
        ? "Files cannot go in a comment reply."
        : uploading
          ? "A file is still uploading."
          : products.length
            ? "A message carries a file or products, not both. Remove the products first."
            : null;

  useImperativeHandle(ref, () => ({
    addProducts(items, asCards, header) {
      if (productsBlocked) return productsBlocked;
      setProductsAsCards(asCards);
      setProducts((list) => [...list, ...items.filter((p) => !list.some((x) => x.variantId === p.variantId))].slice(0, MAX_PRODUCTS));
      // A collection goes as a list under its name.
      if (header !== undefined) {
        setProductsHeader(header);
        setProductsFormat("list");
      }
      return null;
    },
    attachFile(file) {
      if (fileBlocked) return fileBlocked;
      void attach(file);
      return null;
    },
    insertText(text) {
      if (replyLocked) return blockedReason;
      if (commentMode) return "Finish or cancel the comment reply first.";
      setDraft(draft.trim() ? `${draft.trimEnd()}\n${text}` : text);
      textRef.current?.focus();
      return null;
    },
  }));

  function clearProducts() {
    setProducts([]);
    setProductsHeader(undefined);
    setProductsFormat("cards");
  }

  function pickQuickReply(reply: QuickReply) {
    setDraft(fillQuickReply(reply.body, { name: contact.name, agent: agentName }));
    if (reply.attachment) {
      setStaged({ ...reply.attachment, filename: reply.attachment.filename ?? "Attachment", size: null });
    }
    setPickerIndex(0);
    textRef.current?.focus();
  }

  async function attach(file: File) {
    setUploading(true);
    try {
      const upload = await onUpload(file);
      setStaged({ ...upload });
    } catch {
      // The upload mutation already showed why.
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  function payloadFor(): InboxSendPayload {
    if (commentTarget) {
      return {
        type: commentTarget.mode === "private" ? "private_reply" : "comment_reply",
        commentMessageId: commentTarget.message.id,
        text: trimmed,
      };
    }
    if (products.length) return productsPayload(products, trimmed, productsAsCards, { header: productsHeader, format: productsFormat });
    if (staged) {
      return {
        type: "media",
        mediaKind: staged.mediaKind,
        storageKey: staged.storageKey,
        mime: staged.mime,
        filename: staged.filename,
        ...(trimmed ? { caption: trimmed } : {}),
      };
    }
    if (cleanOptions.length) {
      return platform === "WHATSAPP"
        ? { type: "buttons", text: trimmed, buttons: cleanOptions.map((title, i) => ({ id: optionId(title, i), title })) }
        : { type: "quick_replies", text: trimmed, replies: cleanOptions.map((title, i) => ({ title, payload: optionId(title, i) })) };
    }
    return { type: "text", text: trimmed };
  }

  async function submit() {
    if (!canSubmit) return;
    if (isNoteMode) {
      await onAddNote(trimmed);
      setDraft("");
      return;
    }
    const ok = await onSend(payloadFor(), quote?.id);
    if (!ok) return;
    setDraft("");
    setStaged(null);
    setOptions([]);
    clearProducts();
    onClearQuote();
    onClearCommentTarget();
  }

  /**
   * Desktop Enter sends; on mobile, Return adds a line and the send button
   * submits. While the quick-reply list is open, arrows and Enter drive it.
   */
  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing) return;
    if (matches) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setPickerIndex((i) => (matches.length ? (i + step + matches.length) % matches.length : 0));
        return;
      }
      if (event.key === "Enter" && matches[pickerIndex]) {
        event.preventDefault();
        pickQuickReply(matches[pickerIndex]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setPickerDismissed(true);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey && !isMobile) {
      event.preventDefault();
      void submit();
    }
  }

  const placeholder = isNoteMode
    ? "Add a note — only your team sees it"
    : commentTarget
      ? commentTarget.mode === "private"
        ? "Write a private message to the commenter"
        : "Write a public reply under the comment"
      : staged
        ? "Add a caption, or send the file on its own"
        : isMobile ? "Message…" : "Write a reply… type / for quick replies";

  return (
    <div className={cn("relative shrink-0 border-t border-border/60 bg-card px-3 pt-3 pb-[max(.75rem,env(safe-area-inset-bottom))] transition-colors md:px-4 md:py-3", isNoteMode && "bg-warning-subtle")}>
      {matches && (
        <QuickReplyPicker replies={matches} activeIndex={Math.min(pickerIndex, Math.max(0, matches.length - 1))} onPick={pickQuickReply} onHover={setPickerIndex} />
      )}

      {commentTarget && !isNoteMode && (
        <div className="mb-2 flex items-start gap-2 rounded-lg bg-muted px-3 py-2">
          {commentTarget.mode === "private" ? <Lock className="mt-0.5 size-3.5 shrink-0" /> : <MessageCircle className="mt-0.5 size-3.5 shrink-0" />}
          <div className="min-w-0 flex-1">
            <p className="text-micro font-medium text-foreground">
              {commentTarget.mode === "private" ? "Private reply — goes to their inbox, once per comment" : "Public reply — everyone on the post can see it"}
            </p>
            <p className="truncate text-micro text-muted-foreground">“{commentTarget.message.text}”</p>
          </div>
          <Button variant="ghost" size="icon-xs" onClick={onClearCommentTarget} aria-label="Cancel comment reply">
            <X />
          </Button>
        </div>
      )}

      {quote && !commentTarget && !isNoteMode && (
        <div className="mb-2 flex items-start gap-2 rounded-lg border-l-2 border-brand bg-muted px-3 py-2">
          <div className="min-w-0 flex-1">
            <p className="text-micro font-medium text-foreground">Replying to {quote.direction === "INBOUND" ? contact.name : "your message"}</p>
            <p className="truncate text-micro text-muted-foreground">{quote.text ?? quote.kind.toLowerCase()}</p>
          </div>
          <Button variant="ghost" size="icon-xs" onClick={onClearQuote} aria-label="Cancel quoted reply">
            <X />
          </Button>
        </div>
      )}

      {staged && !isNoteMode && !commentMode && (
        <div className="mb-2 flex w-fit max-w-full items-center gap-2 rounded-lg border bg-card px-3 py-1.5">
          <FileText className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate text-caption">{staged.filename}</span>
          {staged.size && <span className="text-micro text-muted-foreground">{formatBytes(staged.size)}</span>}
          <Button variant="ghost" size="icon-xs" onClick={() => setStaged(null)} aria-label="Remove attachment">
            <X />
          </Button>
        </div>
      )}

      {!isNoteMode && !commentMode && (
        <ProductTray
          items={products}
          asCards={productsAsCards}
          header={productsHeader}
          format={productsFormat}
          onFormat={setProductsFormat}
          onRemove={(id) => (products.length === 1 ? clearProducts() : setProducts((list) => list.filter((p) => p.variantId !== id)))}
          onClear={clearProducts}
        />
      )}

      {options.length > 0 && !isNoteMode && !commentMode && !staged && (
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          {options.map((option, index) => (
            <div key={index} className="flex items-center">
              <Input
                value={option}
                maxLength={20}
                onChange={(event) => setOptions((list) => list.map((o, i) => (i === index ? event.target.value : o)))}
                placeholder={`Option ${index + 1}`}
                aria-label={`Reply option ${index + 1}`}
                className="h-7 w-32 text-caption"
              />
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => setOptions((list) => list.filter((_, i) => i !== index))}
                aria-label={`Remove option ${index + 1}`}
              >
                <X />
              </Button>
            </div>
          ))}
          {options.length < optionLimit && (
            <Button variant="ghost" size="xs" onClick={() => setOptions((list) => [...list, ""])}>
              <Plus />
              Option
            </Button>
          )}
        </div>
      )}

      <div className={cn("flex-wrap items-center gap-1 rounded-2xl bg-muted/50 p-1 md:flex md:gap-0.5 md:rounded-none md:bg-transparent md:p-0 max-md:[&_button]:min-h-11 max-md:[&_button]:min-w-11 max-md:[&_button]:rounded-xl", toolsOpen ? "flex" : "hidden")}>
        <input
          ref={fileRef}
          type="file"
          className="hidden"
          accept="image/jpeg,image/png,image/webp,video/mp4,video/3gpp,audio/mpeg,audio/mp4,audio/aac,audio/ogg,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void attach(file);
          }}
        />
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => fileRef.current?.click()}
          disabled={replyLocked || isNoteMode || commentMode || uploading}
          aria-label="Attach a file"
          title={uploading ? "Uploading…" : "Attach a file"}
        >
          <Paperclip className={cn("size-3.5", uploading && "animate-pulse")} />
        </Button>

        <Popover>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon-sm" disabled={replyLocked || isNoteMode || commentMode} aria-label="Quick replies" title="Quick replies">
              <Zap className="size-3.5" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" side="top" className="max-h-72 w-80 overflow-y-auto p-1">
            {quickReplies.length === 0 ? (
              <p className="px-3 py-2 text-caption text-muted-foreground">No quick replies yet. Add them in Settings → Inbox.</p>
            ) : (
              quickReplies.map((reply) => (
                <button
                  key={reply.id}
                  type="button"
                  onClick={() => pickQuickReply(reply)}
                  className="flex w-full flex-col rounded-md px-2.5 py-2 text-left hover:bg-muted"
                >
                  <span className="text-caption font-medium">/{reply.shortcut}</span>
                  <span className="line-clamp-2 text-micro text-muted-foreground">{reply.body}</span>
                </button>
              ))
            )}
          </PopoverContent>
        </Popover>

        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setOptions((list) => (list.length ? [] : ["", ""]))}
          disabled={replyLocked || isNoteMode || commentMode || !!staged}
          aria-pressed={options.length > 0}
          aria-label={platform === "WHATSAPP" ? "Add reply buttons" : "Add quick reply options"}
          title={platform === "WHATSAPP" ? "Reply buttons (up to 3)" : "Quick reply options (up to 13)"}
        >
          <ListPlus className="size-3.5" />
        </Button>

        <ProductPickerButton
          conversationId={conversation.id}
          selected={products}
          disabled={replyLocked || isNoteMode || commentMode || !!staged || options.length > 0}
          onToggle={(product, asCards) => {
            setProductsAsCards(asCards);
            setProducts((list) =>
              list.some((p) => p.variantId === product.variantId)
                ? list.filter((p) => p.variantId !== product.variantId)
                : [...list, product].slice(0, MAX_PRODUCTS),
            );
          }}
        />

        {onOpenTemplates && canReply && !contact.blockedAt && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onOpenTemplates}
            disabled={isNoteMode || commentMode}
            aria-label="Send a template"
            title="Send a template"
          >
            <LayoutTemplate className="size-3.5" />
          </Button>
        )}

        {canReply && (
          <Button
            variant={isNoteMode ? "accent" : "ghost"}
            size="sm"
            aria-pressed={isNoteMode}
            onClick={() => setIsNoteMode((previous) => !previous)}
          >
            <Lock className="size-3.5" />
            Note
          </Button>
        )}

        <div className="ml-auto hidden min-w-0 text-right md:block">
          {isNoteMode ? (
            <p className="text-micro font-medium text-warning">Internal note — the customer will not see this</p>
          ) : (
            !blockedReason && !commentMode && <ReplyWindowHint platform={platform} window={conversation.window} />
          )}
        </div>
      </div>

      {isNoteMode && <p className="mb-1 mt-2 px-1 text-xs font-medium text-warning-strong md:hidden">Internal note · Only your team can see this</p>}

      {replyLocked ? (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted px-3 py-2.5">
          <p className="text-caption text-muted-foreground">{blockedReason}</p>
          {canReply && <Button size="sm" variant="ghost" onClick={() => setIsNoteMode(true)} className="min-h-11 md:hidden"><Lock className="size-4" />Add internal note</Button>}
          {phase.phase === "template_only" && canReply && !contact.blockedAt && onOpenTemplates && (
            <Button size="sm" variant="accent" onClick={onOpenTemplates}>
              <LayoutTemplate className="size-3.5" />
              Send a template
            </Button>
          )}
        </div>
      ) : (
        <div className={cn("flex items-end gap-2 md:mt-2", toolsOpen && "mt-2")}>
          <Button
            variant={toolsOpen ? "secondary" : "ghost"}
            size="icon"
            onClick={() => setToolsOpen((previous) => !previous)}
            aria-label={toolsOpen ? "Hide message tools" : "Show message tools"}
            aria-expanded={toolsOpen}
            className="size-12 shrink-0 rounded-full md:hidden"
          >
            {toolsOpen ? <X className="size-5" /> : <Plus className="size-5" />}
          </Button>
          <Textarea
            ref={textRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
            aria-label={isNoteMode ? "Write an internal note" : "Write a reply"}
            placeholder={placeholder}
            className="max-h-40 min-h-12 min-w-0 flex-1 resize-none rounded-[22px] border-transparent bg-muted/70 px-4 py-3 text-base leading-6 shadow-none md:min-h-10 md:rounded-lg md:border-input md:bg-transparent md:px-3 md:py-2 md:text-body"
          />
          <Button
            variant="accent"
            size="icon"
            onClick={() => void submit()}
            disabled={!canSubmit}
            aria-label={isNoteMode ? "Save note" : "Send message"}
            className="size-12 shrink-0 rounded-full md:size-10 md:rounded-lg"
          >
            {isNoteMode ? <Lock className="size-3.5" /> : <Send className="size-3.5" />}
          </Button>
        </div>
      )}
    </div>
  );
}
