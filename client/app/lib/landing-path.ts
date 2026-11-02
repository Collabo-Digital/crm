import { useAuthStore } from "~/stores/auth.store";
import { firstAllowedPath, resolveAccess } from "~/lib/sections";

/** Landing path for the signed-in member, for callers outside React. */
export function getLandingPath(): string {
  const { organizations, currentOrgId } = useAuthStore.getState();
  const membership =
    organizations.find((m) => m.organization.id === currentOrgId) ??
    organizations[0];
  return firstAllowedPath(
    resolveAccess(membership?.role, membership?.permissions ?? []),
  );
}
