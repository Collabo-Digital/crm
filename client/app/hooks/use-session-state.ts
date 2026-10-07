import { useCallback, useEffect, useState } from "react";

import { useAuthStore } from "~/stores/auth.store";

/**
 * `useState` that outlives the component, for the choices a page is expected to
 * remember: a date range, a filter chip, the active tab.
 *
 * A route's element unmounts on navigation, so plain `useState` put the
 * dashboard back on "Last 7 days" every time the merchant returned to it.
 *
 * Kept in sessionStorage on purpose: the choice survives moving between pages
 * and a refresh, but a new visit opens on the defaults again — the narrow
 * default windows are the cheap first load. Keys carry the org id, so one
 * organisation's filters are never applied to another's data.
 *
 * Search text and page numbers do not live here: they are in the URL (see
 * use-list-url-state), so the navbar's bare link still starts fresh. The one
 * exception is a list's last query string, mirrored under `<list>.return` so a
 * detail page can link back to the page it came from.
 */
const STORAGE_PREFIX = "ui:";

type Guard<T> = (value: unknown) => value is T;

function read<T>(key: string, fallback: T, isValid: Guard<T>): T {
  // Private windows and blocked site data throw on access, and a saved value
  // can be an option that no longer exists — neither may break the page.
  try {
    const raw = window.sessionStorage.getItem(key);
    if (raw === null) return fallback;
    const parsed: unknown = JSON.parse(raw);
    return isValid(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    window.sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore — the choice still holds until the page unmounts */
  }
}

export function useSessionState<T>(
  key: string,
  fallback: T,
  isValid: Guard<T>,
): [T, (next: T | ((previous: T) => T)) => void] {
  // From the store, not `useCurrentOrg`: it is available synchronously, so the
  // first render already has the saved value instead of flashing the default
  // (and firing the default's request).
  const orgId = useAuthStore((state) => state.currentOrgId);
  const storageKey = `${STORAGE_PREFIX}${orgId ?? ""}:${key}`;

  const [entry, setEntry] = useState(() => ({
    key: storageKey,
    value: read(storageKey, fallback, isValid),
  }));

  // The key moved under a mounted component — an org switch that did not
  // reload, or the same panel shown for a different customer. Adopt that key's
  // own saved value rather than carrying the old one across.
  let value = entry.value;
  if (entry.key !== storageKey) {
    value = read(storageKey, fallback, isValid);
    setEntry({ key: storageKey, value });
  }

  useEffect(() => {
    if (entry.key === storageKey) write(storageKey, entry.value);
  }, [entry, storageKey]);

  const setValue = useCallback(
    (next: T | ((previous: T) => T)) => {
      setEntry((previous) => ({
        key: storageKey,
        value:
          typeof next === "function"
            ? (next as (previous: T) => T)(previous.value)
            : next,
      }));
    },
    [storageKey],
  );

  return [value, setValue];
}

/** Guard for a fixed set of options, e.g. `oneOf(DASHBOARD_RANGES)`. */
export function oneOf<T extends string>(values: readonly T[]): Guard<T> {
  return (value): value is T =>
    typeof value === "string" && (values as readonly string[]).includes(value);
}

export function isString(value: unknown): value is string {
  return typeof value === "string";
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

export function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(isString)
  );
}
