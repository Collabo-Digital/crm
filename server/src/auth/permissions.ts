import { UserRole } from '@prisma/client';

/**
 * Fine-grained capability keys stored in `OrganizationMember.permissions`
 * (JSONB, shape: `{ grants: PermissionKey[], preset?: string }`).
 *
 * Design: jobs (Packer, Warehouse, Cashier, Accountant, Marketing) are NOT
 * UserRole enum values — they are capability sets granted to existing roles,
 * surfaced in the team UI as job templates (PERMISSION_PRESETS). A Cashier is
 * an AGENT holding `pos.sell`. This avoids a Postgres enum migration,
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
  /**
   * Reading the money: invoices, GST returns and payment fees. Checked on top
   * of the Invoices section, so an Accountant (an AGENT holding it) reads them
   * while issuing, cancelling and filing stay with ORG_MANAGERS.
   */
  'reports.finance',
  /**
   * The point-of-sale till, opened without the Orders section: a Cashier holds
   * it and no `section.orders`, the way a Packer holds `inventory.pack`. The
   * till's settings, staff and store reports stay with ORG_MANAGERS.
   */
  'pos.sell',
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

/** A job template for the Agent role, as the team screen offers it. */
export interface PermissionPreset {
  id: string;
  label: string;
  /** What the job can do and what it leaves out, shown under the buttons. */
  description: string;
  grants: PermissionKey[];
}

/**
 * The job templates on the team screen (Settings › Team members, "Start from a
 * job"), served to the client by `GET /organizations/:orgId/members/job-templates`
 * so this is the only list. Purely templates — picking one fills the member's
 * sections and abilities, which stay editable; nothing references the template
 * afterwards.
 *
 * Every template names a section, or a section-less job: a member with
 * neither is unrestricted (see `resolveSections`). The Packer, Warehouse and
 * Cashier stay within the grants billed as an ops seat. The Accountant has no
 * Orders section, because Agents can change orders.
 */
export const PERMISSION_PRESETS: readonly PermissionPreset[] = [
  {
    id: 'support',
    label: 'Support agent',
    description: 'Answers chats in the Inbox, including new ones nobody has picked up yet. Nothing else.',
    grants: ['section.chat', 'chat.view_unassigned'],
  },
  {
    id: 'marketing',
    label: 'Marketing',
    description:
      'Creates and sends broadcasts, submits message templates to Meta and builds segments in Campaigns. Can see automations but not change them. No orders, chats or customers.',
    grants: ['section.campaigns', 'campaigns.view', 'campaigns.manage', 'broadcasts.send', 'templates.manage'],
  },
  {
    id: 'accountant',
    label: 'Accountant',
    description:
      'Sees and downloads invoices, GST returns and payment fees, and opens Analytics. Cannot issue, cancel or change anything. No orders, chats or customers.',
    grants: ['section.invoices', 'section.analytics', 'reports.finance'],
  },
  {
    id: 'warehouse',
    label: 'Warehouse',
    description:
      'Receives stock, prints labels and packs orders, from Products and the Packing list. No orders, customers or sales figures.',
    // No inventory.adjust: it is not an ops-seat grant. Ticking "Adjust stock
    // counts" on the member adds it, and makes theirs a full seat.
    grants: [
      'section.products',
      'inventory.view',
      'inventory.receive',
      'inventory.pick',
      'inventory.pack',
      'inventory.dispatch',
      'inventory.labels',
    ],
  },
  {
    id: 'packer',
    label: 'Packer',
    description: 'Packs orders with the Packing list and scanner, and can look products up. No orders, customers or sales figures.',
    grants: ['section.products', 'inventory.pack'],
  },
  {
    id: 'cashier',
    label: 'Cashier',
    description: 'Sells at the till in Point of sale, finding products and customers there. Nothing else: no orders, products, store reports or till settings.',
    // No section: the till is the whole job (see SECTIONLESS_JOBS). Products
    // would let an Agent change catalogue prices, which the till sells at.
    grants: ['pos.sell'],
  },
];

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

/**
 * Grants that are a whole job without any section. A member holding one and
 * no section has chosen access, not "not configured": a Cashier holding
 * `pos.sell` alone opens the till and no section at all.
 */
export const SECTIONLESS_JOBS: PermissionKey[] = ['pos.sell'];

/** Does this grant list say what the member opens: a section, or a section-less job? */
export function namesAccess(grants: readonly string[]): boolean {
  return sectionGrants(grants).length > 0 || SECTIONLESS_JOBS.some((key) => grants.includes(key));
}

export function sectionGrants(grants: readonly string[]): SectionKey[] {
  const known = new Set<string>(SECTION_KEYS);
  return grants.filter((g): g is SectionKey => known.has(g));
}

/**
 * Which sections a member may open: `'all'`, or the granted set.
 *
 * An AGENT / VIEWER with no `section.*` key at all is unrestricted, unless
 * they hold a section-less job (SECTIONLESS_JOBS). That is the state of every
 * member who joined before section access existed, so nobody is locked out
 * by a deploy and no backfill is needed. New data cannot drift back into it
 * by accident: the invite and the member PATCH both refuse a grant list that
 * names neither a section nor such a job.
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
  return namesAccess(grants) ? new Set(sections) : 'all';
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
