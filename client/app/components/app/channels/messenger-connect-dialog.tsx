import { useEffect, useState } from "react";
import { Loader2, MessagesSquare } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Button } from "~/components/ui/button";
import { ensureMetaSdk } from "~/lib/meta-sdk";
import {
  useCompleteMessengerInstallMutation,
  useMessengerInstallMutation,
} from "~/hooks/use-messenger-mutations";

/**
 * Connect Facebook Pages for Messenger, and the Instagram professional
 * accounts linked to them, in one Facebook Login for Business popup. The
 * business picks the Pages inside Meta's dialog; every Page it shares is
 * connected.
 */
export function MessengerConnectDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [launching, setLaunching] = useState(false);
  const startInstall = useMessengerInstallMutation();
  const completeInstall = useCompleteMessengerInstallMutation();

  // Meta's SDK loads only here, as the dialog opens: a popup opens only close
  // to the click, so the click should not also wait for the download.
  useEffect(() => {
    if (open) void ensureMetaSdk();
  }, [open]);

  async function handleConnect() {
    setLaunching(true);
    const ready = await ensureMetaSdk();
    if (!ready || !window.FB) {
      setLaunching(false);
      return;
    }
    try {
      const { configId, state } = await startInstall.mutateAsync();
      window.FB.login(
        (response) => {
          const code = response.authResponse?.code;
          if (!code) {
            setLaunching(false);
            return;
          }
          completeInstall.mutate(
            { code, state },
            {
              onSuccess: () => {
                setLaunching(false);
                onOpenChange(false);
              },
              onError: () => setLaunching(false),
            },
          );
        },
        { config_id: configId, response_type: "code", override_default_response_type: true },
      );
    } catch {
      setLaunching(false);
    }
  }

  const isPending = launching || completeInstall.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <div className="flex size-8 items-center justify-center rounded-lg bg-surface-sunken">
              <MessagesSquare className="size-4 text-foreground" />
            </div>
            Connect Facebook Pages
          </DialogTitle>
          <DialogDescription>
            Reply to Messenger chats and Page comments from Collabo. Instagram
            accounts linked to these Pages connect at the same time.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-lg border border-border bg-muted p-3">
          <p className="mb-1 text-caption font-medium text-foreground">In the Facebook popup:</p>
          <ol className="list-inside list-decimal space-y-0.5 text-caption text-muted-foreground">
            <li>Log in with an account that has full control of the Pages</li>
            <li>Choose the Pages (and their Instagram accounts) to share</li>
            <li>Allow Collabo to manage messages and comments</li>
          </ol>
        </div>
        <p className="text-caption text-muted-foreground">
          For Instagram, turn on <strong>Allow access to messages</strong> in the Instagram
          app under Settings → Messages and story replies → Connected tools.
        </p>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button variant="accent" onClick={handleConnect} disabled={isPending}>
            {isPending && <Loader2 className="animate-spin" />}
            {isPending ? "Connecting…" : "Continue with Facebook"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
