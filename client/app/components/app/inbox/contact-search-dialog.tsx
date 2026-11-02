import { useState } from "react";

import { CHANNEL_ICON, CHANNEL_LABEL } from "~/components/app/channel-badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { useDebounced } from "~/hooks/use-debounced";
import { useInboxContacts } from "~/hooks/use-inbox-queries";
import { platformOffered } from "~/lib/channel-providers";
import type { ChannelPlatform, InboxContactRow } from "~/types/api";

/** What tells one of a person's chats from the others: the number, else the @username. */
export function chatHandle(chat: { phone: string | null; username: string | null; name: string }): string {
  return chat.phone ?? (chat.username ? `@${chat.username}` : chat.name);
}

/** The platform's mark, named for screen readers. */
export function PlatformIcon({ platform, size = 14 }: { platform: ChannelPlatform; size?: number }) {
  const Icon = CHANNEL_ICON[platform];
  return (
    <span className="inline-flex shrink-0 items-center">
      {Icon && <Icon width={size} height={size} />}
      <span className="sr-only">{CHANNEL_LABEL[platform]}</span>
    </span>
  );
}

/**
 * Search the organization's chats by name, number or @username, and pick
 * one. Groups are never listed, and neither are platforms this deployment
 * does not offer.
 */
export function ContactSearchDialog({
  open,
  onOpenChange,
  title,
  description,
  excludeIds,
  onPick,
  isPending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  /** The chat itself, or chats already linked. */
  excludeIds: string[];
  onPick: (contact: InboxContactRow) => void;
  isPending: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <ContactSearch excludeIds={excludeIds} onPick={onPick} isPending={isPending} />
      </DialogContent>
    </Dialog>
  );
}

/** Mounted only while the dialog is open, so a closed dialog makes no requests. */
function ContactSearch({ excludeIds, onPick, isPending }: { excludeIds: string[]; onPick: (contact: InboxContactRow) => void; isPending: boolean }) {
  const [q, setQ] = useState("");
  const debounced = useDebounced(q.trim());
  const searching = debounced.length >= 2;
  const search = useInboxContacts({ search: debounced, limit: 10 }, searching);
  const results = searching ? (search.data?.data ?? []).filter((c) => !excludeIds.includes(c.id) && platformOffered(c.platform)) : [];

  return (
    <div className="space-y-2">
      <Input value={q} onChange={(event) => setQ(event.target.value)} placeholder="Name, number or @username" aria-label="Search chats" autoFocus />
      <div className="max-h-72 space-y-1 overflow-y-auto">
        {results.length === 0 ? (
          <p className="px-1 py-2 text-caption text-muted-foreground">
            {!searching ? "Type at least two characters." : search.isFetching ? "Searching…" : "No chats match."}
          </p>
        ) : (
          results.map((contact) => {
            const handle = chatHandle(contact);
            return (
              <button
                key={contact.id}
                type="button"
                disabled={isPending}
                onClick={() => onPick(contact)}
                className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left hover:bg-muted disabled:opacity-50"
              >
                <PlatformIcon platform={contact.platform} size={16} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-caption font-medium text-foreground">{contact.name}</span>
                  <span className="block truncate text-micro text-muted-foreground">
                    {[handle !== contact.name ? handle : contact.channel.name, contact.customer ? `Linked to ${contact.customer.name ?? "a customer"}` : null]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
