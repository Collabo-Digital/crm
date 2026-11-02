import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type {
  User,
  OrganizationMembership,
  AuthOrganization,
  BillingPlan,
  BillingInterval,
} from "~/types/api";

/** Persisted authentication state for the current user session. */
interface AuthState {
  user: User | null;
  accessToken: string | null;
  refreshToken: string | null;
  isAuthenticated: boolean;
  organizations: OrganizationMembership[];
  currentOrgId: string | null;
  /**
   * When a super admin is impersonating another user, this is the super admin's userId.
   * `null` in all other cases. Drives the impersonation banner and the
   * "Switch back to my account" item in the profile dropdown.
   */
  impersonatedBy: string | null;
  /**
   * Plan selection captured at the onboarding choose-plan step. Held here
   * because the Organization row (which owns billingPlan) is created later
   * in the flow. Applied to the new org on create, then cleared.
   */
  pendingPlan: BillingPlan | null;
  pendingBillingInterval: BillingInterval | null;
  /**
   * The page a session that ended on its own (expired, refused by the server)
   * was on, to return to after signing in again. Null after signing out on
   * purpose. Not persisted.
   */
  returnTo: string | null;
}

/** Actions available on the auth store. */
interface AuthActions {
  setAuth: (
    user: Partial<User> & { id: string; email: string; firstName: string; lastName: string },
    accessToken: string,
    refreshToken: string,
    organizations?: OrganizationMembership[] | AuthOrganization[]
  ) => void;
  setTokens: (accessToken: string, refreshToken: string) => void;
  setOrganizations: (organizations: OrganizationMembership[]) => void;
  setCurrentOrg: (orgId: string) => void;
  setImpersonation: (impersonatedBy: string | null) => void;
  setPendingPlan: (plan: BillingPlan, interval: BillingInterval) => void;
  clearPendingPlan: () => void;
  logout: (returnTo?: string) => void;
}

const initialState: AuthState = {
  user: null,
  accessToken: null,
  refreshToken: null,
  isAuthenticated: false,
  organizations: [],
  currentOrgId: null,
  impersonatedBy: null,
  pendingPlan: null,
  pendingBillingInterval: null,
  returnTo: null,
};

/**
 * Normalize organizations from backend flat shape to the nested
 * OrganizationMembership shape used throughout the frontend.
 *
 * Backend returns: { id, name, slug, type, role }
 * Frontend needs:  { id, organizationId, role, isActive, organization: { id, name, slug, ... } }
 */
export function normalizeOrganizations(
  orgs: OrganizationMembership[] | AuthOrganization[]
): OrganizationMembership[] {
  if (!orgs || orgs.length === 0) return [];

  // Check if it's already in the nested format
  const first = orgs[0] as unknown as Record<string, unknown>;
  if ("organization" in first && typeof first.organization === "object") {
    return orgs as OrganizationMembership[];
  }

  // Convert flat backend shape → nested frontend shape
  return (orgs as AuthOrganization[]).map((o) => ({
    id: crypto.randomUUID(),
    organizationId: o.id,
    role: o.role,
    vendorScope: o.vendorScope ?? null,
    permissions: o.permissions ?? [],
    isActive: true,
    organization: {
      id: o.id,
      name: o.name,
      slug: o.slug,
      type: o.type,
      logo: null,
      timezone: "UTC",
      currency: "USD",
      industry: null,
      website: null,
      billingPlan: "BASIC" as const,
      billingInterval: null,
      onboardingStatus: "COMPLETED" as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  }));
}

/**
 * Fill in missing User fields so the store always has a full User object.
 */
function normalizeUser(
  partial: Partial<User> & { id: string; email: string; firstName: string; lastName: string }
): User {
  return {
    avatarUrl: null,
    emailVerified: false,
    twoFactorEnabled: false,
    lastLoginAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...partial,
  };
}

/**
 * Global auth store — manages user session, tokens, and organization memberships.
 *
 * Persisted to `localStorage` under the key `"crm-auth"` so sessions survive
 * page reloads. Token refresh is handled by the API client interceptor.
 */
export const useAuthStore = create<AuthState & AuthActions>()(
  persist(
    (set) => ({
      ...initialState,

      setAuth: (user, accessToken, refreshToken, organizations = []) =>
        set({
          user: normalizeUser(user),
          accessToken,
          refreshToken,
          isAuthenticated: true,
          organizations: normalizeOrganizations(organizations),
        }),

      setTokens: (accessToken, refreshToken) =>
        set({ accessToken, refreshToken }),

      setOrganizations: (organizations) => set({ organizations }),

      setCurrentOrg: (orgId) => set({ currentOrgId: orgId }),

      setImpersonation: (impersonatedBy) => set({ impersonatedBy }),

      setPendingPlan: (plan, interval) =>
        set({ pendingPlan: plan, pendingBillingInterval: interval }),

      clearPendingPlan: () =>
        set({ pendingPlan: null, pendingBillingInterval: null }),

      logout: (returnTo) => set({ ...initialState, returnTo: returnTo ?? null }),
    }),
    {
      name: "crm-auth",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        user: state.user,
        accessToken: state.accessToken,
        refreshToken: state.refreshToken,
        isAuthenticated: state.isAuthenticated,
        organizations: state.organizations,
        currentOrgId: state.currentOrgId,
        impersonatedBy: state.impersonatedBy,
        pendingPlan: state.pendingPlan,
        pendingBillingInterval: state.pendingBillingInterval,
      }),
    }
  )
);
