/**
 * Where to send someone once they have signed in: the page they asked for
 * before the sign-in screen, such as a shared `/inbox?c=…` link or the
 * Shopify install handoff (`/settings/channels?install_shop=…`).
 */

/**
 * A `next` the caller asked for, if it is safe to follow. Only same-site paths
 * are accepted: an absolute URL or a protocol-relative `//evil.example` would
 * turn our own login into an open redirect.
 */
export function safeNext(next: string | null | undefined): string | null {
  if (!next) return null;
  if (!next.startsWith("/") || next.startsWith("//")) return null;
  return next;
}

/** `path` carrying `next` along, for the links between the sign-in pages. */
export function withNext(path: string, next: string | null | undefined): string {
  const safe = safeNext(next);
  if (!safe || safe === "/") return path;
  return `${path}${path.includes("?") ? "&" : "?"}next=${encodeURIComponent(safe)}`;
}

/** The sign-in page, returning to `returnTo` afterwards. */
export function loginPath(returnTo?: string | null): string {
  return withNext("/auth/login", returnTo);
}

// Session storage: it must outlast the onboarding steps (and a reload during
// them) but not the tab.
const AFTER_ONBOARDING_KEY = "crm-after-onboarding";

/** Remember the page a signed-in member without a workspace was headed to. */
export function rememberAfterOnboarding(path: string) {
  try {
    sessionStorage.setItem(AFTER_ONBOARDING_KEY, path);
  } catch {
    // Storage blocked: onboarding ends on the dashboard instead.
  }
}

/** The page to open when onboarding is done, at most once. */
export function takeAfterOnboarding(): string | null {
  try {
    const path = sessionStorage.getItem(AFTER_ONBOARDING_KEY);
    sessionStorage.removeItem(AFTER_ONBOARDING_KEY);
    return safeNext(path);
  } catch {
    return null;
  }
}

/** Drop it: whoever signs in next was not headed there. */
export function forgetAfterOnboarding() {
  try {
    sessionStorage.removeItem(AFTER_ONBOARDING_KEY);
  } catch {
    // Nothing stored, then.
  }
}
