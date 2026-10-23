import { useRef, useState } from "react";
import { Loader2, MessageCircle, ExternalLink } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "~/components/ui/dialog";
import { Button } from "~/components/ui/button";
import { RadioGroup, RadioCard } from "~/components/ui/radio-group";
import {
  useWhatsAppInstallMutation,
  useCompleteWhatsAppInstallMutation,
} from "~/hooks/use-whatsapp-mutations";
import { ensureMetaSdk, readEmbeddedSignupMessage, type EmbeddedSignupEvent } from "~/lib/meta-sdk";

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

type NumberChoice = "business-app" | "new-number";

/// How long to wait for Embedded Signup's FINISH message after FB.login
/// returns the code. The two race; the code lives 30 seconds.
const SESSION_INFO_WAIT_MS = 2_000;

/**
 * Dialog that kicks off Meta's WhatsApp Embedded Signup flow (v5).
 *
 * Flow:
 *   1. Click "Continue with Meta" → backend returns { configId, state }.
 *   2. Launch FB.login with that configId. By default Meta offers to connect
 *      the business's existing WhatsApp Business app number (coexistence);
 *      "A new number" opts out of that.
 *   3. The popup posts session info (which account and number, whether it is
 *      a Business app number) and returns a short-lived `code`.
 *   4. Forward both to the backend, which exchanges the code, subscribes to
 *      the number's webhooks, registers a new number, and for a Business app
 *      number starts importing contacts and chat history.
 */
export function WhatsAppConnectDialog({
  open,
  onOpenChange,
  reconnectChannelId,
}: WhatsAppConnectDialogProps) {
  const [launching, setLaunching] = useState(false);
  const [choice, setChoice] = useState<NumberChoice>("business-app");
  const sessionRef = useRef<Extract<EmbeddedSignupEvent, { kind: "finish" }> | null>(null);

  const startInstall = useWhatsAppInstallMutation();
  const completeInstall = useCompleteWhatsAppInstallMutation();

  async function handleConnect() {
    setLaunching(true);

    const ready = await ensureMetaSdk();
    if (!ready || !window.FB) {
      setLaunching(false);
      return;
    }

    sessionRef.current = null;
    const onMessage = (event: MessageEvent) => {
      const parsed = readEmbeddedSignupMessage(event);
      if (parsed?.kind === "finish") sessionRef.current = parsed;
    };
    window.addEventListener("message", onMessage);
    const stopListening = () => window.removeEventListener("message", onMessage);

    try {
      const { configId, state } = await startInstall.mutateAsync({ reconnectChannelId });

      window.FB.login(
        (response) => {
          const code = response.authResponse?.code;
          if (!code) {
            stopListening();
            setLaunching(false);
            // User closed the popup or denied — not an error worth toasting.
            return;
          }
          void waitForSession().then((session) => {
            stopListening();
            completeInstall.mutate(
              {
                code,
                state,
                phoneNumberId: session?.phoneNumberId,
                wabaId: session?.wabaId,
                isOnBizApp: session?.isOnBizApp,
                businessId: session?.businessId,
              },
              {
                onSuccess: () => {
                  setLaunching(false);
                  onOpenChange(false);
                },
                onError: () => setLaunching(false),
              },
            );
          });
        },
        {
          config_id: configId,
          response_type: "code",
          override_default_response_type: true,
          extras: {
            version: "v5",
            setup: {},
            // v5 offers the Business app number by default; opt out for a
            // number that will run on the Cloud API alone.
            ...(choice === "new-number"
              ? { features: [{ name: "whatsapp_business_app_onboarding", enabled: false }] }
              : {}),
          },
        },
      );
    } catch {
      stopListening();
      setLaunching(false);
    }
  }

  function waitForSession(): Promise<typeof sessionRef.current> {
    if (sessionRef.current) return Promise.resolve(sessionRef.current);
    return new Promise((resolve) => {
      const started = Date.now();
      const tick = () => {
        if (sessionRef.current || Date.now() - started > SESSION_INFO_WAIT_MS) resolve(sessionRef.current);
        else setTimeout(tick, 100);
      };
      tick();
    });
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
            Link a WhatsApp number using Meta's Embedded Signup — no manual
            credentials required.
          </DialogDescription>
        </DialogHeader>

        <RadioGroup
          value={choice}
          onValueChange={(value) => setChoice(value as NumberChoice)}
          className="gap-3"
          aria-label="Which number to connect"
        >
          <RadioCard value="business-app" id="wa-number-business-app" disabled={isPending}>
            <p className="text-label text-foreground">The number I use on the WhatsApp Business app</p>
            <p className="mt-1 text-caption text-muted-foreground">
              Keep chatting from the app on your phone. Up to six months of chats are
              imported, and messages you send from the phone show up here too.
            </p>
          </RadioCard>
          <RadioCard value="new-number" id="wa-number-new" disabled={isPending}>
            <p className="text-label text-foreground">A new number for Collabo only</p>
            <p className="mt-1 text-caption text-muted-foreground">
              The number must not be in use on any WhatsApp app. You'll confirm it
              with a code during signup.
            </p>
          </RadioCard>
        </RadioGroup>

        {choice === "business-app" ? (
          <div className="rounded-lg border border-border bg-muted p-3">
            <p className="mb-1 text-caption font-medium text-foreground">Using your app number</p>
            <ul className="list-inside list-disc space-y-1 text-caption text-muted-foreground">
              <li>Have the phone with WhatsApp Business (version 2.24.17 or later) nearby — Meta sends a confirmation to it.</li>
              <li>Keep the app open until the import finishes. It can take a few minutes.</li>
              <li>Open the app at least once every two weeks, or Meta disconnects the number from Collabo.</li>
              <li>Groups, calls, broadcast lists, labels and the app's quick replies stay in the app; they don't sync here.</li>
              <li>Sending from Collabo is limited to 20 messages a second on this number.</li>
            </ul>
          </div>
        ) : (
          <div className="rounded-lg border border-border bg-success-subtle p-4">
            <p className="mb-2 text-caption font-semibold text-success">Before you continue, make sure you have:</p>
            <ul className="list-inside list-disc space-y-1.5 text-caption text-success">
              <li>
                A <strong>Meta Business</strong> account (
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
              <li>A phone number that can receive an SMS or call to verify it</li>
              <li>Admin access to the Facebook account you'll log in with</li>
            </ul>
          </div>
        )}

        <p className="text-caption text-muted-foreground">
          After connecting, add a payment method in WhatsApp Manager. Meta bills your
          business directly for messages, and without one Meta stops delivering
          replies once the free monthly allowance is used.
        </p>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
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
