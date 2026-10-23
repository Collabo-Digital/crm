import { Lock } from "lucide-react";

import { formatBubbleTime } from "~/lib/inbox-format";
import { cn } from "~/lib/utils";
import type { InboxNote } from "~/types/api";

/**
 * An internal note, rendered inline in the thread.
 *
 * Amber and full-width on purpose: it must not be mistakable for either bubble
 * style, because the whole risk with notes is an agent believing the customer
 * can see one — or worse, believing a note was sent when it was not. The lock
 * icon and the "Internal note" label say so twice.
 */
export function ThreadNote({ note, className }: { note: InboxNote; className?: string }) {
  return (
    <div className={cn("rounded-lg border-l-2 border-warning bg-warning-subtle px-4 py-3", className)}>
      <div className="flex items-center gap-1.5 text-micro font-medium text-warning">
        <Lock className="size-3" />
        Internal note
      </div>
      <p className="mt-1 text-body whitespace-pre-wrap break-words text-foreground">{note.body}</p>
      <p className="mt-1 text-micro text-muted-foreground">
        {note.author?.name ?? "Former member"} · {formatBubbleTime(note.createdAt)}
      </p>
    </div>
  );
}
