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
 * Prerequisites, then hand the merchant to Facebook Login.
 *
 * The two failures this screen exists to prevent are the ones Meta only reports
 * after a full round trip: a personal Instagram account (rather than Business or
 * Creator), and one not linked to a Facebook Page. Both come back as a generic
 * OAuth failure the merchant cannot act on.
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
            Instagram connects through the Facebook Page linked to your account.
            You will sign in with Facebook and choose which account to connect.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-lg border border-border bg-muted p-4">
          <p className="text-caption font-medium text-foreground">
            Before you continue, check that:
          </p>
          <ul className="mt-2 list-inside list-disc space-y-1.5 text-caption text-muted-foreground">
            <li>
              Your Instagram account is a <strong>Business</strong> or{" "}
              <strong>Creator</strong> account, not a personal one.
            </li>
            <li>It is linked to a Facebook Page you administer.</li>
            <li>
              You are signing in with the Facebook account that manages that Page
              (
              <a
                href="https://business.facebook.com/"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-0.5 text-brand-strong underline hover:text-brand-strong-hover"
              >
                business.facebook.com
                <ExternalLink className="size-3" />
              </a>
              ).
            </li>
          </ul>
        </div>

        <p className="text-caption text-muted-foreground">
          If the login grants access to several Instagram accounts, you will be
          asked which one to connect. You can come back and add the others
          afterwards.
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
            Continue with Facebook
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
