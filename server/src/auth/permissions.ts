import { UserRole } from '@prisma/client';

/**
 * Fine-grained capability keys stored in `OrganizationMember.permissions`
 * (JSONB, shape: `{ grants: PermissionKey[], preset?: string }`).
 *
 * Design: warehouse-floor "roles" (Receiver, Picker, Packer, Dispatch,
 * Accounts) are NOT UserRole enum values — they are capability sets granted to
 * existing roles, surfaced in the team UI as named presets. A Picker is an
 * AGENT holding only `inventory.pick`. This avoids a Postgres enum migration,
 * keeps the RolesGuard→VendorAccessGuard ordering intact, and lets merchants
 * tweak per-user capabilities without new roles.
 *
 * Resolution rules (enforced by PermissionsGuard):
 *   - OWNER / ADMIN / MANAGER implicitly hold EVERY key.
 *   - AGENT, VIEWER and INFLUENCER hold exactly what their `grants` array contains.
 *   - VENDOR holds none — vendor floor access is a V2 question.
 *
 * `section.*` keys are a second family in the same grant list: which app
 * sections (nav tabs) an AGENT / VIEWER may open. They are enforced by
 * SectionAccessGuard via `@RequireSection(...)`, with one extra rule — a
 * member holding NO `section.*` key is unrestricted (see `resolveSections`).
 */
export const SECTION_KEYS = [
  'section.dashboard',
  'section.orders',
  'section.products',
  'section.customers',
  'section.invoices',
  'section.analytics',
  // No server controllers yet — reserved so the client can lock these tabs.
  'section.chat',
  'section.campaigns',
  'section.logistics',
] as const;

export type SectionKey = (typeof SECTION_KEYS)[number];

export const PERMISSION_KEYS = [
  ...SECTION_KEYS,
  'inventory.view',
  'inventory.receive',
  'inventory.adjust',
  'inventory.pick',
  'inventory.pack',
  'inventory.dispatch',
  'inventory.labels',
  'inventory.reports',
  'reports.finance',
  /**
   * Campaign access, split read/write from the start.
   *
   * Influencers currently get `campaigns.view` and nothing else (see
   * DEFAULT_ROLE_GRANTS). That split is the point: the requirement to give
   * influencers the Campaign section is explicitly TEMPORARY and due for review,
   * so narrowing it later must be a change of DATA — an entry in the map below,
   * or the grants on one member — and never a change of code. Nothing should
   * ever test `role === INFLUENCER` to decide campaign access.
   */
  'campaigns.view',
  'campaigns.manage',
  /**
   * Inbox (the Chat section). An AGENT / VIEWER without `chat.view_all` sees
   * the conversations assigned to them or to their teams, plus the unassigned
   * queue when they hold `chat.view_unassigned`. `chat.assign` lets them hand a
   * conversation to someone else; taking an unassigned one needs no grant.
   */
  'chat.view_all',
  'chat.view_unassigned',
  'chat.assign',
  /**
   * The two campaign actions with consequences outside the CRM — a broadcast
   * reaches customers and is billed by Meta, a template goes to Meta's review —
   * so they are granted apart from `campaigns.manage`.
   */
  'broadcasts.send',
  'templates.manage',
] as const;

export type PermissionKey = (typeof PERMISSION_KEYS)[number];

/** Shape of the OrganizationMember.permissions JSONB column. */
export interface MemberPermissions {
  grants: PermissionKey[];
  /** Name of the preset this grant-set was created from (display only). */
  preset?: string;
}

/**
 * Named grant bundles for the team UI. Purely templates — assigning one copies
 * its grants onto the member; nothing references the preset afterwards, so
 * merchants can tweak individual grants freely.
 */
export const PERMISSION_PRESETS: Record<
  string,
  { label: string; role: UserRole; grants: PermissionKey[] }
> = {
  warehouse_manager: {
    label: 'Warehouse Manager',
    role: UserRole.MANAGER,
    grants: [
      'inventory.view',
      'inventory.receive',
      'inventory.adjust',
      'inventory.pick',
      'inventory.pack',
      'inventory.dispatch',
      'inventory.labels',
      'inventory.reports',
    ],
  },
  receiver: {
    label: 'Receiver',
    role: UserRole.AGENT,
    grants: ['section.products', 'inventory.view', 'inventory.receive', 'inventory.labels'],
  },
  picker: {
    label: 'Picker',
    role: UserRole.AGENT,
    grants: ['section.products', 'inventory.view', 'inventory.pick'],
  },
  packer: {
    label: 'Packer',
    role: UserRole.AGENT,
    grants: ['section.products', 'inventory.view', 'inventory.pack'],
  },
  dispatch: {
    label: 'Dispatch',
    role: UserRole.AGENT,
    grants: ['section.products', 'inventory.view', 'inventory.dispatch'],
  },
  accounts: {
    label: 'Accounts',
    role: UserRole.VIEWER,
    grants: ['section.products', 'inventory.reports', 'reports.finance'],
  },
};

/**
 * Parse the raw JSONB column into a validated grant list. Tolerant of legacy /
 * malformed content: anything that isn't a known key is dropped.
 */
export function extractGrants(raw: unknown): PermissionKey[] {
  if (!raw || typeof raw !== 'object') return [];
  const grants = (raw as { grants?: unknown }).grants;
  if (!Array.isArray(grants)) return [];
  const known = new Set<string>(PERMISSION_KEYS);
  return grants.filter((g): g is PermissionKey => typeof g === 'string' && known.has(g));
}

/** Roles that implicitly hold every permission key. */
export const IMPLICIT_ALL_ROLES: UserRole[] = [
  UserRole.OWNER,
  UserRole.ADMIN,
  UserRole.MANAGER,
];

/**
 * May this member read the order LIST with this filter?
 *
 * `GET /orders` is shared: customer detail shows that customer's orders and
 * product detail the orders containing that product. Without the Orders (or
 * Logistics) section, the list is only served through one of those filters —
 * otherwise a Customers-only member could page through every order by calling
 * the endpoint bare.
 */
export function canListOrders(
  role: UserRole,
  grants: readonly string[],
  filter: { customerId?: string; productId?: string },
): boolean {
  const sections = resolveSections(role, grants);
  if (sections === 'all') return true;
  if (sections.has('section.orders') || sections.has('section.logistics')) return true;
  return (
    (sections.has('section.customers') && !!filter.customerId) ||
    (sections.has('section.products') && !!filter.productId)
  );
}

/**
 * May this member search the store's customers? The same sections
 * `GET /customers` asks for: Customers, or Orders for the order form's
 * customer picker. The inbox's "Find customer" asks this too, so a member
 * given only the Chat section cannot read the customer list through it.
 */
export function canBrowseCustomers(role: UserRole, grants: readonly string[]): boolean {
  const sections = resolveSections(role, grants);
  return sections === 'all' || sections.has('section.customers') || sections.has('section.orders');
}

/** Roles whose section access is chosen per member (the invite checkboxes). */
export const SECTION_SCOPED_ROLES: UserRole[] = [UserRole.AGENT, UserRole.VIEWER];

export function sectionGrants(grants: readonly string[]): SectionKey[] {
  const known = new Set<string>(SECTION_KEYS);
  return grants.filter((g): g is SectionKey => known.has(g));
}

/**
 * Which sections a member may open: `'all'`, or the granted set.
 *
 * An AGENT / VIEWER with no `section.*` key at all is unrestricted. That is
 * the state of every member who joined before section access existed, so
 * nobody is locked out by a deploy and no backfill is needed. New data cannot
 * drift back into it by accident: the invite and the member PATCH both refuse
 * a grant list that names no section.
 *
 * VENDOR resolves to `'all'` here on purpose — VendorAccessGuard and the
 * vendor scope already decide what a vendor reaches.
 */
export function resolveSections(
  role: UserRole,
  grants: readonly string[],
): 'all' | Set<SectionKey> {
  if (!SECTION_SCOPED_ROLES.includes(role)) return 'all';
  const sections = sectionGrants(grants);
  return sections.length === 0 ? 'all' : new Set(sections);
}

/**
 * What a member of a given role starts with, written onto
 * `OrganizationMember.permissions` when the membership is created.
 *
 * Only roles that need a non-empty starting set appear here. Roles in
 * IMPLICIT_ALL_ROLES are deliberately absent — they hold everything regardless,
 * and seeding grants for them would imply the list is exhaustive when it is not.
 *
 * This map is the single place to change what influencers may do. Revoking
 * campaign access later is one edit here for future influencers, plus a
 * permissions update on existing memberships — no guard, route or component
 * changes anywhere.
 */
export const DEFAULT_ROLE_GRANTS: Partial<Record<UserRole, PermissionKey[]>> = {
  // TEMPORARY, pending the campaign permission review: influencers may see the
  // Campaign section but not act in it.
  [UserRole.INFLUENCER]: ['campaigns.view'],
};

/** The starting grants for a new membership of this role. */
export function defaultGrantsForRole(role: UserRole): PermissionKey[] {
  return [...(DEFAULT_ROLE_GRANTS[role] ?? [])];
}

/**
 * Does this member hold `key`?
 *
 * The same resolution the PermissionsGuard applies, exported so services and
 * the /me payload answer the question identically rather than each re-deriving
 * it. VENDOR is excluded wholesale, matching the guard.
 */
export function hasPermission(
  role: UserRole | undefined,
  grants: readonly string[] | undefined,
  key: PermissionKey,
): boolean {
  if (!role) return false;
  if (role === UserRole.VENDOR) return false;
  if (IMPLICIT_ALL_ROLES.includes(role)) return true;
  return (grants ?? []).includes(key);
}
