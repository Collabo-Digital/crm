import { toast } from "sonner";

/** Graph API version the JS SDK is initialised with. Matches the server's. */
export const META_SDK_VERSION = "v25.0";

let loading: Promise<boolean> | null = null;

/**
 * Loads Meta's JavaScript SDK the first time a feature needs it (WhatsApp,
 * Messenger and Ads connect), so no other page runs Meta's code. Resolves once
 * `window.FB` is initialised; callers share one load. Its loader puts a stub
 * on `window.FB` before the real SDK arrives, so a load in progress is awaited
 * rather than trusting `window.FB`.
 */
export function ensureMetaSdk(): Promise<boolean> {
  if (loading) return loading;
  // Already there from before this module was loaded (a hot reload).
  if (window.FB) return Promise.resolve(true);

  const appId = import.meta.env.VITE_META_APP_ID;
  if (!appId) {
    toast.error(
      "VITE_META_APP_ID is missing from client environment. Set it in .env and restart the dev server.",
    );
    return Promise.resolve(false);
  }

  loading = new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ready: boolean, error?: string) => {
      if (settled) return;
      settled = true;
      if (error) toast.error(error);
      resolve(ready);
    };
    window.fbAsyncInit = () => {
      window.FB?.init({ appId, cookie: true, xfbml: false, version: META_SDK_VERSION });
      finish(true);
    };
    if (!document.getElementById("facebook-jssdk")) {
      const script = document.createElement("script");
      script.id = "facebook-jssdk";
      script.src = "https://connect.facebook.net/en_US/sdk.js";
      script.async = true;
      script.defer = true;
      script.crossOrigin = "anonymous";
      script.onerror = () => {
        // Removed so the next try adds it again.
        script.remove();
        finish(false, "Failed to load Meta SDK. Check your network.");
      };
      document.body.appendChild(script);
    }
    // Safety timeout — if SDK never loads within 10s, bail.
    setTimeout(() => finish(false, "Meta SDK did not load in time. Please try again."), 10000);
  }).then((ready) => {
    if (!ready) loading = null;
    return ready;
  });
  return loading;
}

/** What Embedded Signup reports through `window.postMessage`. */
export type EmbeddedSignupEvent =
  | {
      kind: "finish";
      phoneNumberId?: string;
      wabaId?: string;
      isOnBizApp?: boolean;
      businessId?: string;
    }
  | { kind: "cancel"; step?: string; error?: string };

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/**
 * Read one message event from the Embedded Signup popup. Null for anything
 * else on the window (other frames, other SDK traffic).
 *
 * v5 always finishes with `FINISH` and `messaging_account_ids`; v4 and earlier
 * name the account `waba_id` and use `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING`
 * for a WhatsApp Business app number.
 */
export function readEmbeddedSignupMessage(event: Pick<MessageEvent, "origin" | "data">): EmbeddedSignupEvent | null {
  if (!event.origin.endsWith("facebook.com")) return null;
  let payload: unknown = event.data;
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch {
      return null;
    }
  }
  if (!payload || typeof payload !== "object") return null;
  const message = payload as { type?: unknown; event?: unknown; data?: Record<string, unknown> };
  if (message.type !== "WA_EMBEDDED_SIGNUP") return null;
  const data = message.data ?? {};

  if (message.event === "CANCEL") {
    return { kind: "cancel", step: str(data.current_step), error: str(data.error_message) };
  }
  if (typeof message.event !== "string" || !message.event.startsWith("FINISH")) return null;

  const accounts = Array.isArray(data.messaging_account_ids) ? data.messaging_account_ids : [];
  return {
    kind: "finish",
    phoneNumberId: str(data.phone_number_id),
    wabaId: str(accounts[0]) ?? str(data.waba_id),
    isOnBizApp:
      typeof data.is_on_biz_app === "boolean"
        ? data.is_on_biz_app
        : message.event === "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING"
          ? true
          : undefined,
    businessId: str(data.business_id),
  };
}
