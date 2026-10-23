import { useState } from "react";
import { Loader2, MessageCircle, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "~/components/ui/dialog";
import { Button } from "~/components/ui/button";
import {
  useWhatsAppInstallMutation,
  useCompleteWhatsAppInstallMutation,
} from "~/hooks/use-whatsapp-mutations";

interface WhatsAppConnectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Re-authorize an existing WhatsApp channel rather than connect a new one.
   * An org may hold only one active WhatsApp account, so without this the
   * server would refuse the second connect that a Reconnect really is.
   */
  reconnectChannelId?: string;
}

/**
 * Dialog that kicks off Meta's WhatsApp Embedded Signup flow.
 *
 * Flow:
 *   1. Click "Continue with Meta" → backend returns { configId, state }.
 *   2. Launch FB.login popup with that configId — merchant picks/creates
 *      their WABA + phone number inside Meta's UI.
 *   3. Meta returns a short-lived `code` to the popup callback.
 *   4. Forward { code, state } to the backend, which exchanges the code for
 *      a long-lived token, reads the WABA + phone number IDs, and creates
 *      the Channel row.
 */
export function WhatsAppConnectDialog({
  open,
  onOpenChange,
  reconnectChannelId,
}: WhatsAppConnectDialogProps) {
  const [launching, setLaunching] = useState(false);

  const startInstall = useWhatsAppInstallMutation();
  const completeInstall = useCompleteWhatsAppInstallMutation();

  /**
   * Ensures window.FB is available — loads the SDK on-demand if it hasn't
   * been loaded yet (e.g., user clicked before MetaSdkInit finished, or
   * VITE_META_APP_ID wasn't set at root mount).
   */
  async function ensureSdk(): Promise<boolean> {
    if (window.FB) return true;

    const appId = import.meta.env.VITE_META_APP_ID;
    if (!appId) {
      toast.error(
        "VITE_META_APP_ID is missing from client environment. Set it in .env and restart the dev server.",
      );
      return false;
    }

    return new Promise((resolve) => {
      window.fbAsyncInit = () => {
        window.FB?.init({ appId, cookie: true, xfbml: false, version: "v21.0" });
        resolve(true);
      };
      if (!document.getElementById("facebook-jssdk")) {
        const script = document.createElement("script");
        script.id = "facebook-jssdk";
        script.src = "https://connect.facebook.net/en_US/sdk.js";
        script.async = true;
        script.defer = true;
        script.crossOrigin = "anonymous";
        script.onerror = () => {
          toast.error("Failed to load Meta SDK. Check your network.");
          resolve(false);
        };
        document.body.appendChild(script);
      }
      // Safety timeout — if SDK never loads within 10s, bail.
      setTimeout(() => {
        if (!window.FB) {
          toast.error("Meta SDK did not load in time. Please try again.");
          resolve(false);
        }
      }, 10000);
    });
  }

  async function handleConnect() {
    setLaunching(true);

    const ready = await ensureSdk();
    if (!ready || !window.FB) {
      setLaunching(false);
      return;
    }

    try {
      const { configId, state } = await startInstall.mutateAsync({ reconnectChannelId });

      window.FB.login(
        (response) => {
          const code = response.authResponse?.code;
          if (!code) {
            setLaunching(false);
            // User closed the popup or denied — not an error worth toasting.
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
        {
          config_id: configId,
          response_type: "code",
          override_default_response_type: true,
          extras: {
            feature: "whatsapp_embedded_signup",
            sessionInfoVersion: 3,
          },
        },
      );
    } catch {
      setLaunching(false);
    }
  }

  const isPending = launching || completeInstall.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <div className="flex size-8 items-center justify-center rounded-lg bg-success-subtle">
              <MessageCircle className="size-4 text-success" />
            </div>
            Connect WhatsApp Business
          </DialogTitle>
          <DialogDescription>
            Link your WhatsApp Business Account and phone number using Meta's
            Embedded Signup — no manual credentials required.
          </DialogDescription>
        </DialogHeader>

        {/* Prerequisites */}
        <div className="rounded-lg border border-border bg-success-subtle p-4">
          <p className="mb-2 text-caption font-semibold text-success">
            Before you continue, make sure you have:
          </p>
          <ul className="list-inside list-disc space-y-1.5 text-caption text-success">
            <li>
              A <strong>Meta Business Manager</strong> account (
              <a
                href="https://business.facebook.com/"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-0.5 underline"
              >
                business.facebook.com
                <ExternalLink className="size-3" />
              </a>
              )
            </li>
            <li>
              A verified phone number you want to use for WhatsApp Business (or
              a free test number Meta provides during signup)
            </li>
            <li>
              Admin access to the Facebook account you'll log in with during
              the popup
            </li>
          </ul>
        </div>

        {/* What happens next */}
        <div className="rounded-lg border border-border bg-muted p-3">
          <p className="mb-1 text-caption font-medium text-foreground">
            After clicking Continue:
          </p>
          <ol className="list-inside list-decimal space-y-0.5 text-caption text-muted-foreground">
            <li>A Meta popup will open asking you to log in to Facebook</li>
            <li>
              Create or select a WhatsApp Business Account and phone number
            </li>
            <li>
              Grant permission for our app to manage messages on your behalf
            </li>
            <li>
              The popup closes and your WhatsApp channel appears as "Connected"
            </li>
          </ol>
        </div>

        {/* Actions */}
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
          >
            Cancel
          </Button>
          <Button variant="accent" onClick={handleConnect} disabled={isPending}>
            {isPending && <Loader2 className="animate-spin" />}
            {isPending ? "Connecting…" : "Continue with Meta"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
