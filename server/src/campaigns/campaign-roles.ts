import { UserRole } from '@prisma/client';

/// Staff who may open Campaigns; AGENT and VIEWER also need the campaigns.* grants.
/// Influencers are refused by their guard: these routes never allow them.
export const CAMPAIGN_READERS: UserRole[] = [UserRole.OWNER, UserRole.ADMIN, UserRole.MANAGER, UserRole.AGENT, UserRole.VIEWER];
export const CAMPAIGN_EDITORS: UserRole[] = [UserRole.OWNER, UserRole.ADMIN, UserRole.MANAGER, UserRole.AGENT];
