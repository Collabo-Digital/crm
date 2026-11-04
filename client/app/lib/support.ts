/**
 * Where people ask Collabo for help, and Collabo's legal pages. Set at build
 * time: VITE_SUPPORT_EMAIL, VITE_SUPPORT_WHATSAPP, VITE_TERMS_URL and
 * VITE_PRIVACY_URL replace the defaults below (see .env.example).
 */
export const SUPPORT_EMAIL: string = import.meta.env.VITE_SUPPORT_EMAIL || "support@collabo.store";

/** Digits with the country code, like 919876543210. Unset hides WhatsApp support. */
const SUPPORT_WHATSAPP: string = String(import.meta.env.VITE_SUPPORT_WHATSAPP ?? "").replace(/\D/g, "");

export function supportEmailLink(subject?: string): string {
  return `mailto:${SUPPORT_EMAIL}${subject ? `?subject=${encodeURIComponent(subject)}` : ""}`;
}

export const supportWhatsAppLink: string | null = SUPPORT_WHATSAPP ? `https://wa.me/${SUPPORT_WHATSAPP}` : null;

// Collabo's own pages, served by this app (routes/public/privacy.tsx, terms.tsx).
export const TERMS_URL: string = import.meta.env.VITE_TERMS_URL || "/terms";
export const PRIVACY_URL: string = import.meta.env.VITE_PRIVACY_URL || "/privacy";
