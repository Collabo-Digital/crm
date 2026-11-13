import { useSyncExternalStore } from "react";

import type { OrganizationFormValues } from "~/lib/onboarding-organization";
import { useAuthStore } from "~/stores/auth.store";
import type { OnboardingAudience } from "~/types/api";

/**
 * What the setup wizard keeps in this browser, per user.
 *
 * Nothing exists on the server until the Organization step is saved, so the
 * first two steps live here: closing the tab or signing out loses nothing.
 * `orgId` is written the moment the workspace is created, so a save that is
 * retried (a dropped response, a later part failing) reuses that workspace
 * instead of creating a second one.
 */
export interface OnboardingDraft {
  audience: OnboardingAudience;
  /** The workspace this draft created. Null until the first successful create. */
  orgId: string | null;
  /** Where to reopen the wizard before the workspace exists. */
  step: "welcome" | "organization";
  /** The Organization form as last typed. Emptied once the step is saved. */
  organization: Partial<OrganizationFormValues>;
}

const EMPTY_DRAFT: OnboardingDraft = { audience: "team", orgId: null, step: "welcome", organization: {} };

const CHANGED = "collabo:onboarding-draft";
const storageKey = (userId: string) => `collabo.onboarding-draft.${userId}`;

// Private windows can refuse storage. The draft then lasts for the tab only.
const memory = new Map<string, string>();

function readRaw(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return memory.get(key) ?? null;
  }
}

function writeRaw(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    if (value === null) memory.delete(key);
    else memory.set(key, value);
  }
  window.dispatchEvent(new Event(CHANGED));
}

/** Anything unreadable falls back field by field, so a damaged draft never blocks the wizard. */
function parseDraft(raw: string | null): OnboardingDraft {
  if (!raw) return EMPTY_DRAFT;
  try {
    const stored = JSON.parse(raw) as Partial<OnboardingDraft> | null;
    if (!stored || typeof stored !== "object") return EMPTY_DRAFT;
    return {
      audience: stored.audience === "solo" ? "solo" : "team",
      orgId: typeof stored.orgId === "string" && stored.orgId ? stored.orgId : null,
      step: stored.step === "organization" ? "organization" : "welcome",
      organization: stored.organization && typeof stored.organization === "object" ? stored.organization : {},
    };
  } catch {
    return EMPTY_DRAFT;
  }
}

// `useSyncExternalStore` needs the same object back while nothing has changed.
let lastRead: { key: string; raw: string | null; draft: OnboardingDraft } | null = null;

export function readOnboardingDraft(userId: string): OnboardingDraft {
  if (!userId) return EMPTY_DRAFT;
  const key = storageKey(userId);
  const raw = readRaw(key);
  if (lastRead?.key !== key || lastRead.raw !== raw) lastRead = { key, raw, draft: parseDraft(raw) };
  return lastRead.draft;
}

export function updateOnboardingDraft(userId: string, patch: Partial<OnboardingDraft>) {
  if (!userId) return;
  writeRaw(storageKey(userId), JSON.stringify({ ...readOnboardingDraft(userId), ...patch }));
}

/** Setup is finished or handed to the server: nothing left to keep here. */
export function clearOnboardingDraft(userId: string) {
  if (userId) writeRaw(storageKey(userId), null);
}

function subscribe(onChange: () => void) {
  window.addEventListener(CHANGED, onChange);
  // Another tab of the same browser edited the draft.
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGED, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/** The signed-in user's draft, re-read whenever it changes. */
export function useOnboardingDraft(): OnboardingDraft {
  const userId = useAuthStore((state) => state.user?.id) ?? "";
  return useSyncExternalStore(
    subscribe,
    () => readOnboardingDraft(userId),
    () => EMPTY_DRAFT,
  );
}
