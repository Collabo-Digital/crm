import { Lock } from "lucide-react";

import { formatBubbleTime, noteAuthor } from "~/lib/inbox-format";
import { cn } from "~/lib/utils";
import type { InboxNote } from "~/types/api";

/**
 * An internal note, rendered inline in the thread.
 *
 * Amber, centred and dashed on purpose: it must not be mistakable for either
 * bubble, because the whole risk with notes is an agent believing the customer
 * can see one — or worse, believing a note was sent when it was not. The lock
 * icon and the "Internal note" label say so twice.
 */
export function ThreadNote({ note, className }: { note: InboxNote; className?: string }) {
  return (
    // The amber tint is laid over the card colour so the wallpaper never shows through it.
    <div
      className={cn(
        "mx-auto w-full max-w-[min(36rem,92%)] rounded-lg border border-dashed border-warning/70 bg-card bg-linear-to-b from-warning-subtle to-warning-subtle px-4 py-3 shadow-chat",
        className,
      )}
    >
      <div className="flex items-center gap-1.5 text-micro font-medium text-warning-strong">
        <Lock className="size-3" />
        Internal note
      </div>
      <p className="mt-1 text-body whitespace-pre-wrap break-words text-foreground">{note.body}</p>
      <p className="mt-1 text-micro text-muted-foreground">
        {noteAuthor(note)} · {formatBubbleTime(note.createdAt)}
      </p>
    </div>
  );
}
