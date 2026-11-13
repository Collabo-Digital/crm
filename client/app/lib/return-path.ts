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

// The setup wizard's Sales channels step starts a Shopify or Instagram
// connection, and both come back to Settings › Channels. This marks that the
// trip started in the wizard, so that page can send the result back there.
const CONNECT_FROM_SETUP_KEY = "crm-connect-from-setup";
/** Longer than any sign-in at Shopify or Instagram takes; after it, a result belongs to Settings. */
const CONNECT_FROM_SETUP_TTL_MS = 15 * 60 * 1000;

/** The wizard is about to hand over to Shopify or Instagram. */
export function rememberConnectFromSetup() {
  try {
    sessionStorage.setItem(CONNECT_FROM_SETUP_KEY, String(Date.now()));
  } catch {
    // Storage blocked: the result shows in Settings › Channels instead.
  }
}

/** The wizard has shown the result, or moved on without it: a later result belongs to Settings. */
export function forgetConnectFromSetup() {
  try {
    sessionStorage.removeItem(CONNECT_FROM_SETUP_KEY);
  } catch {
    // Nothing stored, then.
  }
}

/**
 * Did this connection start in the setup wizard, recently? Asking doesn't
 * clear the mark (the wizard does, once it has shown the result), so it is
 * safe to ask twice: React runs a page's first effect twice in development.
 */
export function connectStartedInSetup(): boolean {
  try {
    const startedAt = Number(sessionStorage.getItem(CONNECT_FROM_SETUP_KEY));
    return startedAt > 0 && Date.now() - startedAt < CONNECT_FROM_SETUP_TTL_MS;
  } catch {
    return false;
  }
}
