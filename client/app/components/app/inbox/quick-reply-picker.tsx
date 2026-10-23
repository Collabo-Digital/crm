import { Paperclip, Zap } from "lucide-react";

import { cn } from "~/lib/utils";
import type { QuickReply } from "~/types/api";

/** Quick replies matching what was typed after "/": shortcut first, then keywords and body. */
export function matchQuickReplies(replies: QuickReply[], query: string): QuickReply[] {
  const q = query.trim().toLowerCase();
  if (!q) return replies;
  const starts = replies.filter((r) => r.shortcut.startsWith(q));
  const rest = replies.filter(
    (r) =>
      !r.shortcut.startsWith(q) &&
      (r.shortcut.includes(q) || r.keywords.some((k) => k.includes(q)) || r.body.toLowerCase().includes(q)),
  );
  return [...starts, ...rest];
}

/**
 * The list that opens above the composer on "/". Keyboard-driven from the
 * textarea (arrows, Enter, Escape) so the agent never leaves the keyboard;
 * clicking works too.
 */
export function QuickReplyPicker({
  replies,
  activeIndex,
  onPick,
  onHover,
}: {
  replies: QuickReply[];
  activeIndex: number;
  onPick: (reply: QuickReply) => void;
  onHover: (index: number) => void;
}) {
  return (
    <div
      role="listbox"
      aria-label="Quick replies"
      className="absolute inset-x-4 bottom-full z-20 mb-2 max-h-64 overflow-y-auto rounded-lg border bg-popover p-1 shadow-lg"
    >
      {replies.length === 0 ? (
        <p className="px-3 py-2 text-caption text-muted-foreground">
          No quick reply matches. Add them in Settings → Inbox.
        </p>
      ) : (
        replies.map((reply, index) => (
          <button
            key={reply.id}
            type="button"
            role="option"
            aria-selected={index === activeIndex}
            // mousedown, not click: the textarea must keep focus.
            onMouseDown={(event) => {
              event.preventDefault();
              onPick(reply);
            }}
            onMouseEnter={() => onHover(index)}
            className={cn("flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left", index === activeIndex && "bg-muted")}
          >
            <Zap className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5 text-caption font-medium text-foreground">
                /{reply.shortcut}
                {reply.attachment && <Paperclip className="size-3 text-muted-foreground" />}
                <span className="text-micro font-normal text-muted-foreground">
                  {reply.scope === "PERSONAL" ? "Personal" : reply.scope === "TEAM" ? reply.team?.name : "Everyone"}
                </span>
              </span>
              <span className="line-clamp-2 text-micro text-muted-foreground">{reply.body}</span>
            </span>
          </button>
        ))
      )}
    </div>
  );
}
