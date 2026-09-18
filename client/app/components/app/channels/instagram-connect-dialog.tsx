import { ExternalLink, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Button } from "~/components/ui/button";
import { useInstallInstagramMutation } from "~/hooks/use-channel-mutations";

/**
 * Prerequisites, then hand the merchant to Instagram Login.
 *
 * The failures this screen exists to prevent are the ones Instagram only
 * reports after a full round trip: a personal account (rather than Business or
 * Creator), and message access switched off, which connects fine but never
 * delivers a DM.
 *
 * `reconnectChannelId` re-authorizes an existing account instead of adding
 * another — a meaningful distinction here, since an org may hold many.
 */
export function InstagramConnectDialog({
  open,
  onOpenChange,
  reconnectChannelId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  reconnectChannelId?: string;
}) {
  const install = useInstallInstagramMutation();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {reconnectChannelId ? "Reconnect Instagram" : "Connect Instagram"}
          </DialogTitle>
          <DialogDescription>
            You will sign in with Instagram and allow access to the account you
            want to connect. No Facebook Page is needed.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-lg border border-border bg-muted p-4">
          <p className="text-caption font-medium text-foreground">
            Before you continue, check that:
          </p>
          <ul className="mt-2 list-inside list-disc space-y-1.5 text-caption text-muted-foreground">
            <li>
              Your Instagram account is a <strong>Business</strong> or{" "}
              <strong>Creator</strong> account, not a personal one (
              <a
                href="https://help.instagram.com/502981923235522"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-0.5 text-brand-strong underline hover:text-brand-strong-hover"
              >
                how to switch
                <ExternalLink className="size-3" />
              </a>
              ).
            </li>
            <li>
              To receive DMs, message access is on: in the Instagram app go to{" "}
              <strong>
                Settings → Messages and story replies → Message controls →
                Connected tools
              </strong>{" "}
              and turn on <strong>Allow access to messages</strong>.
            </li>
          </ul>
        </div>

        <p className="text-caption text-muted-foreground">
          Each sign-in connects one account. To add another, connect again and
          sign in with that account.
        </p>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={install.isPending}
          >
            Cancel
          </Button>
          <Button
            variant="accent"
            disabled={install.isPending}
            onClick={() => install.mutate({ reconnectChannelId })}
          >
            {install.isPending && <Loader2 className="animate-spin" />}
            Continue with Instagram
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
