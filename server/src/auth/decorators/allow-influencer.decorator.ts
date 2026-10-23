import { SetMetadata } from '@nestjs/common';

/**
 * Marks a route (or whole controller) as reachable by the INFLUENCER role.
 *
 * INFLUENCER is deny-by-default (see `InfluencerAccessGuard`), exactly like
 * VENDOR: an influencer is blocked from every endpoint UNLESS it carries
 * `@AllowInfluencer()`. They are an outside party invited to collaborate, so the
 * safe default is that a newly added endpoint is closed to them until someone
 * decides otherwise.
 *
 * ORDERING TRAP (the same one documented in roles.decorator.ts): the guard chain
 * is Throttler -> Jwt -> **Roles** -> OrgRequired -> VendorAccess ->
 * **InfluencerAccess** -> Permissions -> SuperAdmin. `RolesGuard` therefore runs
 * BEFORE this guard, so a route marked `@AllowInfluencer()` must either carry no
 * `@Roles(...)` at all or use a group that INCLUDES `INFLUENCER` — otherwise
 * influencers are rejected before this guard is ever consulted.
 */
export const ALLOW_INFLUENCER_KEY = 'allowInfluencer';
export const AllowInfluencer = () => SetMetadata(ALLOW_INFLUENCER_KEY, true);
