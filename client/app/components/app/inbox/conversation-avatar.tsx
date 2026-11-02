import { Users } from "lucide-react";

import { CHANNEL_ICON } from "~/components/app/channel-badge";
import { Avatar, AvatarFallback, AvatarImage } from "~/components/ui/avatar";
import { getInitials } from "~/lib/inbox-format";
import { cn } from "~/lib/utils";
import type { ChannelPlatform } from "~/types/api";

/**
 * Contact avatar with an initials fallback and, optionally, the channel's mark.
 *
 * One neutral fill for everyone, rather than a rotating palette keyed off the
 * row's position — a contact must not change colour when the list re-sorts.
 * Identity comes from the initials and the channel badge beside them.
 */
export function ConversationAvatar({
  name,
  avatarUrl,
  platform,
  size = "default",
  isGroup = false,
  className,
}: {
  name: string;
  avatarUrl?: string | null;
  platform?: ChannelPlatform;
  size?: "default" | "sm" | "lg";
  /** A WhatsApp group: a group mark instead of initials. */
  isGroup?: boolean;
  className?: string;
}) {
  const ChannelIcon = platform ? CHANNEL_ICON[platform] : undefined;
  return (
    <div className={cn("relative shrink-0", className)}>
      <Avatar size={size}>
        {avatarUrl && <AvatarImage src={avatarUrl} alt="" />}
        <AvatarFallback className="bg-brand/30 text-caption font-semibold text-brand-strong">
          {isGroup ? <Users className="size-1/2" aria-label="Group" /> : getInitials(name)}
        </AvatarFallback>
      </Avatar>
      {ChannelIcon && (
        <span className="absolute -bottom-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full bg-card ring-1 ring-border">
          <ChannelIcon width={10} height={10} />
        </span>
      )}
    </div>
  );
}
