import { queryClient } from "~/lib/query-client";
import { sessionStamp } from "~/lib/session-stamp";
import { useAuthStore } from "~/stores/auth.store";

/** localStorage key the auth store persists under — see auth.store.ts. */
const AUTH_STORAGE_KEY = "crm-auth";

/**
 * The session the app is in now — whose data the cache holds, and what each
 * request is stamped with when it is sent (see api-client.ts), so a request
 * that outlives its session is neither replayed into the next one nor allowed
 * to hand it the old session's data.
 */
export function currentSessionStamp(): string {
  return sessionStamp(useAuthStore.getState());
}

let started = false;

/**
 * Empties the query cache whenever the session identity changes.
 *
 * Query keys carry no user or org id (["orders","list",…], ["dashboard",…]),
 * and the QueryClient outlives a logout because sign-out is an in-app
 * navigation, not a reload. Without this, the next account to sign in on the
 * same tab was served the previous account's orders, customers and invoices —
 * unrefetched for the first 30s (staleTime), and painted first after that.
 *
 * Watching the store, instead of clearing at each call site, covers every way
 * the identity can change — sign out, a 401 logout, login, invite accept,
 * creating or switching organization, impersonation — including ones added
 * later.
 */
export function startSessionCacheGuard() {
  if (started || typeof window === "undefined") return;
  started = true;

  let identity = currentSessionStamp();

  useAuthStore.subscribe((state) => {
    const next = sessionStamp(state);
    if (next === identity) return;
    identity = next;

    // Drop responses still in flight for the old identity, so they cannot land
    // in the cache after it has been emptied.
    void queryClient.cancelQueries();

    if (state.accessToken) {
      // Signed in as someone (or some org) else: wipe every query back to its
      // empty state and refetch the mounted ones with the new token.
      void queryClient.resetQueries();
    } else {
      // Signed out. Nothing to refetch — just forget the data. Queries only:
      // a mutation may be mid-flight (delete account calls logout from its own
      // onSuccess) and must be left to finish.
      queryClient.removeQueries();
    }
  });

  // Another tab signed out, signed in as someone else or switched org. Adopt
  // that session here too. Otherwise this tab keeps the old one in memory and
  // writes it back over the new session on its next token refresh.
  window.addEventListener("storage", (event) => {
    if (event.key === AUTH_STORAGE_KEY) {
      void useAuthStore.persist.rehydrate();
    }
  });
}
