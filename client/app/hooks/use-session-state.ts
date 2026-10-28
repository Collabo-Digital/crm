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

type Store = "session" | "local";

function storageOf(store: Store): Storage {
  return store === "local" ? window.localStorage : window.sessionStorage;
}

function read<T>(store: Store, key: string, fallback: T, isValid: Guard<T>): T {
  // Private windows and blocked site data throw on access, and a saved value
  // can be an option that no longer exists — neither may break the page.
  try {
    const raw = storageOf(store).getItem(key);
    if (raw === null) return fallback;
    const parsed: unknown = JSON.parse(raw);
    return isValid(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function write(store: Store, key: string, value: unknown) {
  try {
    storageOf(store).setItem(key, JSON.stringify(value));
  } catch {
    /* ignore — the choice still holds until the page unmounts */
  }
}

function useStoredState<T>(
  store: Store,
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
    value: read(store, storageKey, fallback, isValid),
  }));

  // The key moved under a mounted component — an org switch that did not
  // reload, or the same panel shown for a different customer. Adopt that key's
  // own saved value rather than carrying the old one across.
  let value = entry.value;
  if (entry.key !== storageKey) {
    value = read(store, storageKey, fallback, isValid);
    setEntry({ key: storageKey, value });
  }

  useEffect(() => {
    if (entry.key === storageKey) write(store, storageKey, entry.value);
  }, [entry, storageKey, store]);

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

export function useSessionState<T>(
  key: string,
  fallback: T,
  isValid: Guard<T>,
): [T, (next: T | ((previous: T) => T)) => void] {
  return useStoredState("session", key, fallback, isValid);
}

/**
 * A value saved by `useSessionState`, read once without taking it over: for a
 * link built away from the page that owns it (the phone app bar's back arrow
 * reading a list's `<list>.return`). Never writes, so it cannot overwrite the
 * owner's newer value.
 */
export function readSessionState<T>(key: string, fallback: T, isValid: Guard<T>): T {
  const orgId = useAuthStore.getState().currentOrgId;
  return read("session", `${STORAGE_PREFIX}${orgId ?? ""}:${key}`, fallback, isValid);
}

/**
 * Same contract, but in localStorage: for preferences that should outlive the
 * browser session — which columns a list shows, how many rows per page. Still
 * keyed by org, so one organisation's layout never leaks into another's.
 */
export function useLocalState<T>(
  key: string,
  fallback: T,
  isValid: Guard<T>,
): [T, (next: T | ((previous: T) => T)) => void] {
  return useStoredState("local", key, fallback, isValid);
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
