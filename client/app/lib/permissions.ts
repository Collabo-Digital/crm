import type { UserRole } from "~/types/api";

/**
 * The client half of the server's permission model (server/src/auth/permissions.ts).
 *
 * This decides what to SHOW. The server decides what is allowed — every gate
 * here has a matching one behind the API, and this file exists so the UI does
 * not offer actions that would be refused.
 */
export type PermissionKey =
  | "products.edit"
  | "inventory.view"
  | "inventory.receive"
  | "inventory.adjust"
  | "inventory.pick"
  | "inventory.pack"
  | "inventory.dispatch"
  | "inventory.labels"
  | "inventory.reports"
  | "reports.finance"
  | "pos.sell"
  | "campaigns.view"
  | "campaigns.manage"
  | "chat.view_all"
  | "chat.view_unassigned"
  | "chat.assign"
  | "broadcasts.send"
  | "templates.manage";

/** Roles that implicitly hold every key. Mirrors IMPLICIT_ALL_ROLES. */
const IMPLICIT_ALL_ROLES: UserRole[] = ["OWNER", "ADMIN", "MANAGER"];

/**
 * What a role starts with. Mirrors DEFAULT_ROLE_GRANTS on the server.
 *
 * The membership's own grants are authoritative when we have them; this is the
 * fallback for the moment right after acceptance, before the session has been
 * re-read. Campaign access for influencers is TEMPORARY and lives here as data
 * precisely so narrowing it later is an edit, not a refactor.
 */
const DEFAULT_ROLE_GRANTS: Partial<Record<UserRole, PermissionKey[]>> = {
  INFLUENCER: ["campaigns.view"],
};

export function defaultGrantsForRole(role: UserRole | undefined): PermissionKey[] {
  return role ? [...(DEFAULT_ROLE_GRANTS[role] ?? [])] : [];
}

/**
 * Does this member hold `key`?
 *
 * Same resolution the server's PermissionsGuard applies, so the UI and the API
 * agree: owners/admins/managers hold everything, vendors hold nothing, everyone
 * else holds exactly their grants.
 */
export function hasPermission(
  role: UserRole | undefined,
  grants: readonly string[] | undefined,
  key: PermissionKey,
): boolean {
  if (!role) return false;
  if (role === "VENDOR") return false;
  if (IMPLICIT_ALL_ROLES.includes(role)) return true;
  return (grants ?? defaultGrantsForRole(role)).includes(key);
}

/**
 * May edit automations and conversation starters: the server's EDITORS
 * (owners, admins, managers, influencers) holding campaigns.manage. Agents and
 * viewers only read them, even with that grant.
 */
export function canEditAutomations(role: UserRole | undefined, grants: readonly string[] | undefined): boolean {
  return role !== "AGENT" && role !== "VIEWER" && hasPermission(role, grants, "campaigns.manage");
}

/**
 * May change the catalogue: add and edit products, their prices, photos and
 * variants, and the stock counts in the product form. The server's product
 * writes take an operator role with products.edit, which owners, admins and
 * managers hold implicitly; a viewer is refused them whatever it holds. A
 * vendor edits its own products, confined by its vendor scope.
 */
export function canEditProducts(role: UserRole | undefined, grants: readonly string[] | undefined): boolean {
  if (role === "VENDOR") return true;
  return role !== "VIEWER" && role !== "INFLUENCER" && hasPermission(role, grants, "products.edit");
}

/**
 * Roles that are OUTSIDE parties rather than staff.
 *
 * Both are deny-by-default on the server and get a reduced navigation here.
 */
export function isExternalRole(role: UserRole | undefined): boolean {
  return role === "VENDOR" || role === "INFLUENCER";
}
