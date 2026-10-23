import { useQuery } from "@tanstack/react-query";
import { orgService } from "~/services/org.service";
import { useAuthStore } from "~/stores/auth.store";

/** React Query key factory for all organization-related queries. */
export const orgKeys = {
  all: ["organizations"] as const,
  list: () => [...orgKeys.all, "list"] as const,
  detail: (orgId: string) => [...orgKeys.all, "detail", orgId] as const,
  members: (orgId: string) => [...orgKeys.all, "members", orgId] as const,
  invites: (orgId: string) => [...orgKeys.all, "invites", orgId] as const,
  influencers: (orgId: string) => [...orgKeys.all, "influencers", orgId] as const,
};

/** Fetch all organizations for the current user */
export function useOrganizations() {
  return useQuery({
    queryKey: orgKeys.list(),
    queryFn: () => orgService.list(),
  });
}

/** Fetch a single organization by ID */
export function useOrganization(orgId?: string | null) {
  return useQuery({
    queryKey: orgKeys.detail(orgId!),
    queryFn: () => orgService.get(orgId!),
    enabled: !!orgId,
  });
}

/** Fetch the current active organization */
export function useCurrentOrg() {
  const currentOrgId = useAuthStore((s) => s.currentOrgId);
  return useOrganization(currentOrgId);
}

/** Fetch members of an organization */
export function useOrgMembers(orgId?: string | null) {
  return useQuery({
    queryKey: orgKeys.members(orgId!),
    queryFn: () => orgService.listMembers(orgId!),
    enabled: !!orgId,
  });
}

/** Fetch pending invites of an organization */
export function useOrgInvites(orgId?: string | null) {
  return useQuery({
    queryKey: orgKeys.invites(orgId!),
    queryFn: () => orgService.listInvites(orgId!),
    enabled: !!orgId,
  });
}

/** Everyone invited as an influencer: joined and outstanding, in one list. */
export function useInfluencers(orgId?: string | null) {
  return useQuery({
    queryKey: orgKeys.influencers(orgId!),
    queryFn: () => orgService.listInfluencers(orgId!),
    enabled: !!orgId,
  });
}
