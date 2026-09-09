import { apiClient } from "~/lib/api-client";
import type {
  OrgResponse,
  CreateOrganizationRequest,
  CreatePersonalRequest,
  UpdateOrganizationRequest,
  UpgradeToOrganizationRequest,
  OrgMember,
  UpdateMemberRoleRequest,
  SendInviteRequest,
  InviteInfluencerRequest,
  InfluencerRow,
  OrgInvite,
} from "~/types/api";

/**
 * Service layer for organization, member, and invite API endpoints.
 *
 * Each method returns the unwrapped response data (the API client
 * already strips the `{ success, data }` envelope).
 */
export const orgService = {
  // ─── Organizations ───

  create: (data: CreateOrganizationRequest) =>
    apiClient.post<OrgResponse>("/organizations", data).then((response) => response.data),

  createPersonal: (data: CreatePersonalRequest) =>
    apiClient
      .post<OrgResponse>("/organizations/personal", data)
      .then((response) => response.data),

  list: () =>
    apiClient.get<OrgResponse[]>("/organizations").then((response) => response.data),

  get: (orgId: string) =>
    apiClient.get<OrgResponse>(`/organizations/${orgId}`).then((response) => response.data),

  update: (orgId: string, data: UpdateOrganizationRequest) =>
    apiClient.patch<OrgResponse>(`/organizations/${orgId}`, data).then((response) => response.data),

  /** Flip a PERSONAL workspace to ORGANIZATION in place. OWNER only. */
  upgradeToOrganization: (orgId: string, data: UpgradeToOrganizationRequest) =>
    apiClient
      .post<OrgResponse>(`/organizations/${orgId}/upgrade-to-organization`, data)
      .then((response) => response.data),

  delete: (orgId: string) =>
    apiClient.delete<{ message: string }>(`/organizations/${orgId}`).then((response) => response.data),

  // ─── Members ───

  listMembers: (orgId: string) =>
    apiClient.get<OrgMember[]>(`/organizations/${orgId}/members`).then((response) => response.data),

  updateMemberRole: (orgId: string, memberId: string, data: UpdateMemberRoleRequest) =>
    apiClient
      .patch<OrgMember>(`/organizations/${orgId}/members/${memberId}`, data)
      .then((response) => response.data),

  removeMember: (orgId: string, memberId: string) =>
    apiClient
      .delete<OrgMember>(`/organizations/${orgId}/members/${memberId}`)
      .then((response) => response.data),

  // ─── Invites ───

  sendInvite: (orgId: string, data: SendInviteRequest) =>
    apiClient
      .post<OrgInvite>(`/organizations/${orgId}/invites`, data)
      .then((response) => response.data),

  listInvites: (orgId: string) =>
    apiClient.get<OrgInvite[]>(`/organizations/${orgId}/invites`).then((response) => response.data),

  revokeInvite: (orgId: string, inviteId: string) =>
    apiClient
      .delete<OrgInvite>(`/organizations/${orgId}/invites/${inviteId}`)
      .then((response) => response.data),

  /**
   * Re-issue a pending invitation. The server rotates the token, so the old
   * link stops working the moment this succeeds.
   */
  resendInvite: (orgId: string, inviteId: string) =>
    apiClient
      .post<OrgInvite>(`/organizations/${orgId}/invites/${inviteId}/resend`)
      .then((response) => response.data),

  /**
   * Invite an influencer. A dedicated endpoint rather than a role field, so the
   * role cannot be swapped for something else by editing the request.
   */
  inviteInfluencer: (orgId: string, data: InviteInfluencerRequest) =>
    apiClient
      .post<OrgInvite>(`/organizations/${orgId}/invites/influencers`, data)
      .then((response) => response.data),

  /** Everyone invited as an influencer: joined and outstanding, in one list. */
  listInfluencers: (orgId: string) =>
    apiClient
      .get<InfluencerRow[]>(`/organizations/${orgId}/influencers`)
      .then((response) => response.data),
};
