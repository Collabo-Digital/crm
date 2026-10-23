import { Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Button } from "~/components/ui/button";
import { useDisconnectChannelMutation } from "~/hooks/use-channel-mutations";
import { CHANNEL_LABEL } from "~/components/app/channel-badge";
import type { Channel } from "~/types/api";

/**
 * Confirmation before disconnecting a channel.
 *
 * Replaces a native `confirm()`, which could not say WHICH account was about to
 * go or what would stop working — the two things the merchant needs to know,
 * given an org can now hold several Instagram accounts that look alike in a
 * one-line browser prompt.
 *
 * Stays open when the mutation fails: closing on error would hide the toast
 * behind a page the merchant thinks succeeded.
 */
export function ChannelDisconnectDialog({
  channel,
  onOpenChange,
}: {
  channel: Channel | null;
  onOpenChange: (open: boolean) => void;
}) {
  const disconnect = useDisconnectChannelMutation();

  if (!channel) return null;

  const label = channel.account?.handle ?? channel.name ?? CHANNEL_LABEL[channel.platform];

  return (
    <Dialog open onOpenChange={(open) => !disconnect.isPending && onOpenChange(open)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Disconnect {label}?</DialogTitle>
          <DialogDescription>
            Features that use this channel stop working until it is reconnected:
            messaging, order notifications and any syncing it drives.
          </DialogDescription>
        </DialogHeader>

        <p className="text-caption text-muted-foreground">
          Nothing is deleted. Past orders, invoices and message history stay exactly
          as they are, and you can reconnect the same account later to pick up where
          you left off.
        </p>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={disconnect.isPending}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={disconnect.isPending}
            onClick={() =>
              disconnect.mutate(channel.id, {
                onSuccess: () => onOpenChange(false),
              })
            }
          >
            {disconnect.isPending && <Loader2 className="animate-spin" />}
            Disconnect
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
