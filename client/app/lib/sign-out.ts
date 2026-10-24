import { authService } from "~/services/auth.service";
import { forgetAfterOnboarding } from "~/lib/return-path";
import { useAuthStore } from "~/stores/auth.store";
import { useCallStore } from "~/stores/call.store";

/**
 * Sign out of this browser on purpose. A WhatsApp call this browser is on is
 * hung up first, while the session can still tell the server; then the refresh
 * token is revoked and the local session cleared. Where to go next is the
 * caller's choice.
 */
export async function signOut() {
  await useCallStore.getState().hangUp();
  const { refreshToken, logout } = useAuthStore.getState();
  try {
    if (refreshToken) await authService.logout(refreshToken);
  } catch {
    // The local session ends either way.
  }
  forgetAfterOnboarding();
  logout();
}
