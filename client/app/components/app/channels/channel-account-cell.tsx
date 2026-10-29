import { CHANNEL_ICON, CHANNEL_LABEL } from "~/components/app/channel-badge";
import { cn } from "~/lib/utils";
import type { Channel, ChannelPlatform } from "~/types/api";

/**
 * The account's avatar, or the platform mark when the provider gives us none.
 *
 * `key` is set from the platform so React remounts the SVG per row rather than
 * reusing one instance — instagramIcon.jsx declares its gradient ids
 * un-namespaced, and several live instances on one page fight over the same
 * `<defs>` (documented in channel-badge.tsx).
 */
export function ChannelAvatar({
  platform,
  avatarUrl,
  size = 32,
  className,
}: {
  platform: ChannelPlatform;
  avatarUrl?: string | null;
  size?: number;
  className?: string;
}) {
  const Icon = CHANNEL_ICON[platform];

  if (avatarUrl) {
    return (
      <img
        src={avatarUrl}
        alt=""
        width={size}
        height={size}
        className={cn("shrink-0 rounded-full object-cover", className)}
        style={{ width: size, height: size }}
      />
    );
  }

  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-lg bg-muted",
        className,
      )}
      style={{ width: size, height: size }}
    >
      {Icon ? (
        <Icon key={platform} width={size * 0.55} height={size * 0.55} />
      ) : null}
    </span>
  );
}

/**
 * Who a channel is: the handle a merchant recognises, with the account id or
 * page underneath.
 *
 * A disconnected row still resolves here — the server keeps the last account
 * summary in metadata precisely so the history line can still be identified.
 */
export function ChannelAccountCell({ channel }: { channel: Channel }) {
  const { account } = channel;
  const primary = account?.handle ?? channel.name ?? CHANNEL_LABEL[channel.platform];
  const secondary =
    account?.detail ??
    account?.displayName ??
    (account?.externalId ? `ID ${account.externalId}` : null);

  return (
    <div className="flex min-w-0 items-center gap-3">
      <ChannelAvatar platform={channel.platform} avatarUrl={account?.avatarUrl} />
      <div className="min-w-0">
        <p className="truncate text-body font-medium text-foreground">{primary}</p>
        {secondary && (
          <p className="truncate text-caption text-muted-foreground">{secondary}</p>
        )}
      </div>
    </div>
  );
}
