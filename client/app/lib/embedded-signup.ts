/**
 * What WhatsApp Embedded Signup's popup posts to this window while the
 * connect dialog waits for it (components/app/whatsapp-connect-dialog.tsx).
 * Any page holding a handle on the window can post to it, so only Meta's own
 * signup pages are believed, and only messages of the expected shape.
 */

/** Where Embedded Signup runs. Compared whole: a suffix check let in notfacebook.com. */
export const EMBEDDED_SIGNUP_ORIGINS: ReadonlySet<string> = new Set([
  "https://www.facebook.com",
  "https://web.facebook.com",
  "https://business.facebook.com",
]);

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/** Meta's ids are digits. Anything else is dropped, and the server asks Meta instead. */
function metaId(value: unknown): string | undefined {
  return typeof value === "string" && /^\d{1,32}$/.test(value) ? value : undefined;
}

/**
 * Read one message event from the Embedded Signup popup. Null for anything
 * else on the window (other frames, other SDK traffic, other sites).
 *
 * v5 always finishes with `FINISH` and `messaging_account_ids`; v4 and earlier
 * name the account `waba_id` and use `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING`
 * for a WhatsApp Business app number.
 */
export function readEmbeddedSignupMessage(event: Pick<MessageEvent, "origin" | "data">): EmbeddedSignupEvent | null {
  if (!EMBEDDED_SIGNUP_ORIGINS.has(event.origin)) return null;
  let payload: unknown = event.data;
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch {
      return null;
    }
  }
  if (!isRecord(payload) || payload.type !== "WA_EMBEDDED_SIGNUP" || typeof payload.event !== "string") return null;
  const data = payload.data ?? {};
  if (!isRecord(data)) return null;

  if (payload.event === "CANCEL") {
    return { kind: "cancel", step: str(data.current_step), error: str(data.error_message) };
  }
  if (!payload.event.startsWith("FINISH")) return null;

  const accounts = Array.isArray(data.messaging_account_ids) ? data.messaging_account_ids : [];
  return {
    kind: "finish",
    phoneNumberId: metaId(data.phone_number_id),
    wabaId: metaId(accounts[0]) ?? metaId(data.waba_id),
    isOnBizApp:
      typeof data.is_on_biz_app === "boolean"
        ? data.is_on_biz_app
        : payload.event === "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING"
          ? true
          : undefined,
    businessId: metaId(data.business_id),
  };
}
