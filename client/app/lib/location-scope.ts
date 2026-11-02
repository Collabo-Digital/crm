import type { LocationKind, UserRole, Warehouse } from "~/types/api";

/**
 * Store scoping: the stock locations (stores and warehouses) a Manager or
 * Agent works at. An empty list means every location. Owners and Admins
 * always work everywhere, and the other roles are never limited. The server
 * enforces it (server/src/auth/location-scope.util.ts); this only builds the
 * picker.
 */
export const LOCATION_SCOPED_ROLES: readonly UserRole[] = ["MANAGER", "AGENT"];

export function isLocationScopedRole(role: UserRole): boolean {
  return LOCATION_SCOPED_ROLES.includes(role);
}

export interface ScopeOption {
  id: string;
  name: string;
  kind: LocationKind;
  isActive: boolean;
}

/**
 * The locations a member can be given: every active one, stores first, plus
 * any switched-off one they still have, so it can be seen and taken away.
 */
export function scopeOptions(locations: readonly Warehouse[], scope: readonly string[]): ScopeOption[] {
  const shown = locations.filter((l) => l.isActive || scope.includes(l.id));
  const rank = (kind: LocationKind) => (kind === "STORE" ? 0 : 1);
  return shown
    .map((l, i) => ({ l, i }))
    .sort((a, b) => rank(a.l.kind) - rank(b.l.kind) || a.i - b.i)
    .map(({ l }) => ({ id: l.id, name: l.name, kind: l.kind, isActive: l.isActive }));
}

/** Does the workspace have stock locations to choose from? */
export function usesStockLocations(locations: readonly Warehouse[] | undefined): boolean {
  return (locations ?? []).some((l) => l.isActive);
}

/**
 * Ticks or unticks one location. The last one cannot be unticked: an empty
 * list means every location, which is chosen on its own, never by accident.
 */
export function toggleLocation(scope: readonly string[], id: string, on: boolean): string[] {
  if (on) return scope.includes(id) ? [...scope] : [...scope, id];
  const next = scope.filter((s) => s !== id);
  return next.length === 0 ? [...scope] : next;
}

/** "Only these locations" starts with the first one ticked, so the choice is never empty. */
export function startLimiting(options: readonly ScopeOption[]): string[] {
  const first = options.find((o) => o.isActive);
  return first ? [first.id] : [];
}

/** The member row's label: every location, the one location, or how many. */
export function locationScopeLabel(scope: readonly string[] | undefined, locations: readonly Warehouse[]): string {
  const ids = scope ?? [];
  if (ids.length === 0) return "All locations";
  if (ids.length === 1) return locations.find((l) => l.id === ids[0])?.name ?? "1 location";
  return `${ids.length} locations`;
}
