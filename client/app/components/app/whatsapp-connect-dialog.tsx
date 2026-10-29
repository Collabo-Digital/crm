import { useEffect, useRef, useState } from "react";
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
import { ensureMetaSdk } from "~/lib/meta-sdk";
import { readEmbeddedSignupMessage, type EmbeddedSignupEvent } from "~/lib/embedded-signup";
import type { WhatsAppInstallResponse } from "~/types/api";

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

/// How long to wait for a CANCEL message after FB.login returns no code.
const CANCEL_WAIT_MS = 1_000;

/// The server keeps a signup state for ten minutes; renew it well before.
const STATE_RENEW_MS = 8 * 60_000;

const NO_WINDOW =
  "Meta's window closed before signup finished. If no window opened, allow pop-ups for this site in your browser, then try again.";

/** Poll `read` until it has a value or `ms` pass. */
function waitFor<T>(read: () => T | null, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      const value = read();
      if (value || Date.now() - started > ms) resolve(value);
      else setTimeout(tick, 100);
    };
    tick();
  });
}

/**
 * Dialog that kicks off Meta's WhatsApp Embedded Signup flow (v5).
 *
 * Flow:
 *   1. When the dialog opens, load the Meta SDK and ask the backend for
 *      { configId, state }. Browsers open a popup only from the click itself,
 *      not after an awaited request, so this cannot wait for the click.
 *   2. "Continue with Meta" launches FB.login with that configId. By default
 *      Meta offers to connect the business's existing WhatsApp Business app
 *      number (coexistence); "A new number" opts out of that.
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
  const [signup, setSignup] = useState<WhatsAppInstallResponse | null>(null);
  const [preparing, setPreparing] = useState(false);
  // Bumped to fetch a new state: after a failed try (the server spends the
  // state on every callback), or from "Try again".
  const [attempt, setAttempt] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const sessionRef = useRef<Extract<EmbeddedSignupEvent, { kind: "finish" }> | null>(null);
  const cancelRef = useRef<Extract<EmbeddedSignupEvent, { kind: "cancel" }> | null>(null);

  const { mutateAsync: requestSignup } = useWhatsAppInstallMutation();
  const completeInstall = useCompleteWhatsAppInstallMutation();

  useEffect(() => {
    if (!open) return;
    let live = true;
    const load = async () => {
      const ready = await ensureMetaSdk();
      if (!ready || !live) return;
      try {
        const next = await requestSignup({ reconnectChannelId });
        if (live) setSignup(next);
      } catch {
        // The mutation shows the server's reason.
      }
    };
    setSignup(null);
    setNotice(null);
    setPreparing(true);
    void load().finally(() => live && setPreparing(false));
    const renew = setInterval(() => void load(), STATE_RENEW_MS);
    return () => {
      live = false;
      clearInterval(renew);
    };
  }, [open, reconnectChannelId, requestSignup, attempt]);

  // Synchronous to FB.login on purpose: see step 1 above.
  function handleConnect() {
    if (!signup || !window.FB) return;
    const { configId, state } = signup;
    setLaunching(true);
    setNotice(null);

    sessionRef.current = null;
    cancelRef.current = null;
    const onMessage = (event: MessageEvent) => {
      const parsed = readEmbeddedSignupMessage(event);
      if (parsed?.kind === "finish") sessionRef.current = parsed;
      else if (parsed?.kind === "cancel") cancelRef.current = parsed;
    };
    window.addEventListener("message", onMessage);
    const stopListening = () => window.removeEventListener("message", onMessage);

    window.FB.login(
      (response) => {
        const code = response.authResponse?.code;
        if (!code) {
          // Embedded Signup posts CANCEL when someone leaves the flow; with
          // no CANCEL the window most likely never opened.
          void waitFor(() => cancelRef.current, CANCEL_WAIT_MS).then((cancel) => {
            stopListening();
            setLaunching(false);
            if (cancel?.error) setNotice(`Meta stopped the signup: ${cancel.error}`);
            else if (!cancel) setNotice(NO_WINDOW);
          });
          return;
        }
        void waitFor(() => sessionRef.current, SESSION_INFO_WAIT_MS).then((session) => {
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
              onError: () => {
                setLaunching(false);
                setAttempt((n) => n + 1);
              },
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

        {notice && (
          <p role="alert" className="text-caption text-destructive">
            {notice}
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            Cancel
          </Button>
          {signup || isPending || preparing ? (
            <Button variant="accent" onClick={handleConnect} disabled={isPending || !signup}>
              {(isPending || !signup) && <Loader2 className="animate-spin" />}
              {isPending ? "Connecting…" : signup ? "Continue with Meta" : "Getting ready…"}
            </Button>
          ) : (
            // Getting ready failed; the reason was shown as it happened.
            <Button variant="accent" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
