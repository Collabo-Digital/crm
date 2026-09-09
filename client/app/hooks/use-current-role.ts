import { useAuthStore } from "~/stores/auth.store";
import { hasPermission, type PermissionKey } from "~/lib/permissions";
import type { UserRole } from "~/types/api";

/**
 * The current user's role, scope and capabilities in the active organization.
 * Centralizes the `organizations.find(currentOrgId)` lookup used across the app.
 */
export function useCurrentRole(): {
  role: UserRole | undefined;
  vendorScope: string | null | undefined;
  isVendor: boolean;
  isInfluencer: boolean;
  /** Fine-grained capabilities on this membership, when the session carries them. */
  permissions: string[] | undefined;
  /** Does this member hold `key`? Same resolution the server applies. */
  can: (key: PermissionKey) => boolean;
} {
  const organizations = useAuthStore((s) => s.organizations);
  const currentOrgId = useAuthStore((s) => s.currentOrgId);
  const membership = organizations.find((m) => m.organization.id === currentOrgId);
  const role = membership?.role;
  const permissions = membership?.permissions;

  return {
    role,
    vendorScope: membership?.vendorScope,
    isVendor: role === "VENDOR",
    isInfluencer: role === "INFLUENCER",
    permissions,
    can: (key) => hasPermission(role, permissions, key),
  };
}
