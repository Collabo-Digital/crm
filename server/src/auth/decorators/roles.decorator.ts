import { SetMetadata } from '@nestjs/common';
import { UserRole } from '@prisma/client';

export const ROLES_KEY = 'roles';

/**
 * Restrict a route to specific roles.
 *
 * `RolesGuard` is ALLOW-by-default: a route with no `@Roles(...)` is open to
 * every authenticated member. Read endpoints rely on that deliberately, so
 * VIEWER keeps full read access. Every *mutating* endpoint should declare a
 * group below.
 *
 * ORDERING TRAP: the global guard chain is
 *   Throttler → Jwt → **Roles** → OrgRequired → **VendorAccess** →
 *   **InfluencerAccess** → Permissions → SuperAdmin
 * so `RolesGuard` runs BEFORE both outside-role guards. Any route marked
 * `@AllowVendor()` must therefore use a group that INCLUDES `VENDOR`
 * (`ORG_OPERATORS_AND_VENDORS`), and any route marked `@AllowInfluencer()` must
 * use a group that includes `INFLUENCER` (or declare no `@Roles` at all), or
 * they are rejected before their own guard ever runs.
 */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);

/**
 * Money and statutory/config actions: cancelling or capturing an order,
 * marking it paid, issuing or cancelling a GST invoice, editing tax setup.
 */
export const ORG_MANAGERS: UserRole[] = [
  UserRole.OWNER,
  UserRole.ADMIN,
  UserRole.MANAGER,
];

/**
 * Day-to-day order work: creating orders and drafts, editing them, archiving,
 * pushing to Shopify. Everything a MANAGER can do minus the financial and
 * statutory actions above.
 */
export const ORG_OPERATORS: UserRole[] = [...ORG_MANAGERS, UserRole.AGENT];

/**
 * Fulfilment and tracking — work external suppliers perform too. VENDOR is
 * still confined to its own line items by `VendorAccessGuard` + `vendorScope`
 * checks in the services; this group only gets it past `RolesGuard`.
 */
export const ORG_OPERATORS_AND_VENDORS: UserRole[] = [
  ...ORG_OPERATORS,
  UserRole.VENDOR,
];

/**
 * Who may connect and manage a channel.
 *
 * OWNER/ADMIN act for the organization; INFLUENCER is here only so that
 * `RolesGuard` lets them past to routes marked `@AllowInfluencer()` — WHICH
 * channel rows they may touch is a separate question, answered by
 * `Channel.ownerUserId` inside ChannelService. Passing this group is permission
 * to call the endpoint, never permission over someone else's account.
 */
export const CHANNEL_MANAGERS: UserRole[] = [
  UserRole.OWNER,
  UserRole.ADMIN,
  UserRole.INFLUENCER,
];
