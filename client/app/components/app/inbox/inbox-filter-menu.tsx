import { ListFilter } from "lucide-react";

import { ChannelBadge } from "~/components/app/channel-badge";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import type { Channel, InboxFilters, InboxMember } from "~/types/api";
import { SOCIAL_CHANNELS_OFFERED } from "~/lib/channel-providers";

const ANY = "any";

/**
 * The narrowing filters that sit on top of a folder: channel, tag, assignee,
 * unread and comments. Each one shows as a removable chip under the search
 * box while set, so this menu is only the way in.
 */
export function InboxFilterMenu({
  filters,
  channels,
  tags,
  members,
  showAssignee,
  onChange,
}: {
  filters: InboxFilters;
  channels: Channel[];
  /** Tags seen on the loaded conversations, plus the active one. */
  tags: string[];
  members: InboxMember[];
  /** Filtering by someone else's chats only makes sense for members who see them. */
  showAssignee: boolean;
  onChange: (patch: Partial<InboxFilters>) => void;
}) {
  const active = [filters.channelId, filters.tag, filters.assigneeId, filters.unread, filters.comments].filter(Boolean).length;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="xs" className="text-muted-foreground" aria-label="Filter conversations">
          <ListFilter className="size-3" />
          Filter
          {active > 0 && <span className="tabular-nums text-foreground">{active}</span>}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuCheckboxItem
          checked={!!filters.unread}
          onCheckedChange={(checked) => onChange({ unread: checked === true || undefined })}
        >
          Unread only
        </DropdownMenuCheckboxItem>
        {SOCIAL_CHANNELS_OFFERED && (
          <DropdownMenuCheckboxItem
            checked={!!filters.comments}
            onCheckedChange={(checked) => onChange({ comments: checked === true || undefined })}
          >
            With post comments
          </DropdownMenuCheckboxItem>
        )}
        <DropdownMenuSeparator />

        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Channel</DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-56">
            <DropdownMenuRadioGroup
              value={filters.channelId ?? ANY}
              onValueChange={(value) => onChange({ channelId: value === ANY ? undefined : value })}
            >
              <DropdownMenuRadioItem value={ANY}>Every channel</DropdownMenuRadioItem>
              {channels.map((channel) => (
                <DropdownMenuRadioItem key={channel.id} value={channel.id}>
                  <ChannelBadge platform={channel.platform} name={channel.name} size={12} className="truncate" />
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Tag</DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="max-h-72 w-52 overflow-y-auto">
            {tags.length === 0 ? (
              <DropdownMenuLabel className="font-normal text-muted-foreground">No tags on these conversations</DropdownMenuLabel>
            ) : (
              <DropdownMenuRadioGroup
                value={filters.tag ?? ANY}
                onValueChange={(value) => onChange({ tag: value === ANY ? undefined : value })}
              >
                <DropdownMenuRadioItem value={ANY}>Any tag</DropdownMenuRadioItem>
                {tags.map((tag) => (
                  <DropdownMenuRadioItem key={tag} value={tag}>
                    {tag}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            )}
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        {showAssignee && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Assigned to</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-h-72 w-52 overflow-y-auto">
              <DropdownMenuRadioGroup
                value={filters.assigneeId ?? ANY}
                onValueChange={(value) => onChange({ assigneeId: value === ANY ? undefined : value })}
              >
                <DropdownMenuRadioItem value={ANY}>Anyone</DropdownMenuRadioItem>
                {members.map((member) => (
                  <DropdownMenuRadioItem key={member.id} value={member.id}>
                    {member.name}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}

        {active > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() =>
                onChange({ channelId: undefined, tag: undefined, assigneeId: undefined, unread: undefined, comments: undefined })
              }
            >
              Clear filters
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
