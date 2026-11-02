import { MessagesSquare } from "lucide-react";

/**
 * The thread column with nothing selected.
 *
 * Deliberately not EmptyState: that component leads with a heading and a call
 * to action, which overstates a state the agent resolves by clicking any row.
 */
export function ConversationEmpty({
  message = "Select a conversation to read it here.",
}: {
  message?: string;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <span className="flex size-10 items-center justify-center rounded-full bg-muted">
        <MessagesSquare className="size-5 text-muted-foreground" />
      </span>
      <p className="text-caption text-muted-foreground">{message}</p>
    </div>
  );
}
