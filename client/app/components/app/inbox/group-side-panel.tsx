import { useState } from "react";
import { Check, Copy, Users } from "lucide-react";
import { Link } from "react-router";

import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { useGroup } from "~/hooks/use-groups";
import { cn } from "~/lib/utils";

const STATUS_LABEL: Record<string, string> = {
  CREATING: "Being created",
  ACTIVE: "Active",
  SUSPENDED: "Suspended by WhatsApp",
  DELETING: "Being deleted",
  DELETED: "Deleted",
  FAILED: "Not created",
};

/** Beside a group's chat: who is in it, its invite link, and the way to manage it. */
export function GroupSidePanel({ groupId, className }: { groupId: string | null | undefined; className?: string }) {
  const { data: group, isLoading } = useGroup(groupId);
  const [copied, setCopied] = useState(false);
  if (!groupId) return <aside aria-label="Group" className={cn("p-5 text-caption text-muted-foreground", className)}>This group is not linked to Collabo.</aside>;
  if (isLoading || !group) return <Skeleton className={cn("m-5 h-40", className)} />;
  return (
    <aside aria-label="Group" className={cn("min-h-0 space-y-5 overflow-y-auto p-5", className)}>
      <div className="flex items-center gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-brand/30 text-brand-strong">
          <Users className="size-5" />
        </span>
        <div className="min-w-0">
          <p className="truncate text-body font-semibold">{group.subject}</p>
          <p className="text-micro text-muted-foreground">
            {STATUS_LABEL[group.status] ?? group.status} · {group.participants.length} of 8 people
          </p>
        </div>
      </div>
      {group.description && <p className="text-caption text-muted-foreground">{group.description}</p>}

      {group.inviteLink && group.status === "ACTIVE" && (
        <div className="space-y-1.5">
          <p className="text-micro font-semibold uppercase tracking-wider text-muted-foreground">Invite link</p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 text-micro">{group.inviteLink}</code>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Copy invite link"
              onClick={() => void navigator.clipboard.writeText(group.inviteLink!).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              })}
            >
              {copied ? <Check /> : <Copy />}
            </Button>
          </div>
        </div>
      )}

      <div className="space-y-1.5">
        <p className="text-micro font-semibold uppercase tracking-wider text-muted-foreground">People</p>
        {group.participants.length === 0 ? (
          <p className="text-caption text-muted-foreground">Nobody has joined yet. Share the invite link.</p>
        ) : (
          <ul className="space-y-1">
            {group.participants.map((p) => (
              <li key={p.waId} className="text-caption">
                <span className="font-medium">{p.name ?? `+${p.waId}`}</span>
                {p.name && <span className="text-muted-foreground"> · +{p.waId}</span>}
              </li>
            ))}
          </ul>
        )}
        {group.joinRequests.length > 0 && (
          <p className="text-caption text-brand-strong">
            {group.joinRequests.length} asking to join
          </p>
        )}
      </div>

      <p className="text-micro text-muted-foreground">
        Groups take text, files and templates. Until someone writes in the group, only a template can start the chat.
      </p>
      <Button size="sm" variant="outline" asChild>
        <Link to={`/inbox/groups?g=${group.id}`}>Manage group</Link>
      </Button>
    </aside>
  );
}
