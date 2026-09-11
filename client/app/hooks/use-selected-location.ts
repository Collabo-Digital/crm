import { useCallback, useEffect, useMemo } from "react";
import { useSearchParams } from "react-router";

import { useWarehouses } from "~/hooks/use-inventory-queries";
import { useCurrentOrg } from "~/hooks/use-org-queries";
import type { Warehouse } from "~/types/api";

/**
 * The one location every inventory screen is scoped to.
 *
 * There is deliberately no "all locations" option. The stock list returns one
 * row per variant PER location, so an unscoped view lists the same product once
 * for every location a merchant stocks it at — which is what made the screen
 * unreadable, and made "where do I update this?" unanswerable.
 *
 * The choice lives in the URL so a link can be shared and the back button
 * works, and is mirrored to localStorage so it survives a fresh visit. Reading
 * order is URL → saved → the org's default location.
 */
const STORAGE_PREFIX = "inventory:location:";

function storageKey(orgId: string | undefined) {
  return orgId ? STORAGE_PREFIX + orgId : null;
}

function readSaved(orgId: string | undefined): string | null {
  const key = storageKey(orgId);
  if (!key) return null;
  // Private windows and blocked site data throw on access, not just return
  // null — a remembered convenience must never break the page.
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSaved(orgId: string | undefined, value: string) {
  const key = storageKey(orgId);
  if (!key) return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* ignore — the URL still carries the choice for this session */
  }
}

export interface SelectedLocation {
  /** Active locations, default first (the API orders isDefault desc). */
  locations: Warehouse[];
  /** Undefined until the list has loaded and a choice has resolved. */
  locationId: string | undefined;
  location: Warehouse | undefined;
  setLocationId: (id: string) => void;
  /** True while we still don't know which location to show. */
  isLoading: boolean;
  /** A single-location org gets a label instead of a picker. */
  hasChoice: boolean;
}

/**
 * `sync: false` reads the current choice without touching the URL. Screens that
 * merely reflect the selection (the product page's per-location boxes) must not
 * rewrite their own address bar — only the inventory screens own that param.
 */
export function useSelectedLocation(
  { sync = true }: { sync?: boolean } = {},
): SelectedLocation {
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: currentOrg } = useCurrentOrg();
  const orgId = currentOrg?.id;
  const warehouses = useWarehouses();

  const locations = useMemo(
    () => (warehouses.data ?? []).filter((w) => w.isActive),
    [warehouses.data],
  );

  const requested = searchParams.get("warehouseId");

  const resolved = useMemo(() => {
    if (locations.length === 0) return undefined;
    const exists = (id: string | null) =>
      id ? locations.find((w) => w.id === id) : undefined;
    // A stale id — a location deactivated, or a link from another org — falls
    // through to the default rather than showing an empty screen.
    return (
      exists(requested) ??
      exists(readSaved(orgId)) ??
      locations.find((w) => w.isDefault) ??
      locations[0]
    );
  }, [locations, requested, orgId]);

  const setLocationId = useCallback(
    (id: string) => {
      writeSaved(orgId, id);
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set("warehouseId", id);
          // Any page cursor belongs to the location we just left.
          next.delete("page");
          return next;
        },
        { replace: true },
      );
    },
    [orgId, setSearchParams],
  );

  // Put the resolved choice in the URL so what is on screen and what the
  // address bar says never disagree — including on first load, where the
  // default was picked for the merchant rather than by them.
  useEffect(() => {
    if (!sync || !resolved || requested === resolved.id) return;
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set("warehouseId", resolved.id);
        return next;
      },
      { replace: true },
    );
  }, [sync, resolved, requested, setSearchParams]);

  useEffect(() => {
    if (sync && resolved) writeSaved(orgId, resolved.id);
  }, [sync, resolved, orgId]);

  return {
    locations,
    locationId: resolved?.id,
    location: resolved,
    setLocationId,
    isLoading: warehouses.isLoading,
    hasChoice: locations.length > 1,
  };
}
