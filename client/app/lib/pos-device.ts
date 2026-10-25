import type { PosStaffView } from "~/types/api";

/**
 * What one till device remembers: its store, and who unlocked it. Private
 * windows and blocked site data throw on access, so every read and write is
 * guarded — a remembered convenience must never break the till.
 */

export interface PosStaffSession {
  staff: PosStaffView;
  staffToken: string;
  expiresAt: string;
}

const storeKey = (orgId: string) => `pos:store:${orgId}`;
const staffKey = (orgId: string) => `pos:staff:${orgId}`;

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null) {
  try {
    if (value == null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* the choice lasts for this page instead */
  }
}

export function readSavedStore(orgId: string | null): string | undefined {
  return (orgId && read(storeKey(orgId))) || undefined;
}

export function saveStore(orgId: string | null, storeId: string | null) {
  if (orgId) write(storeKey(orgId), storeId);
}

export function readStaffSession(orgId: string | null): PosStaffSession | null {
  const raw = orgId ? read(staffKey(orgId)) : null;
  if (!raw) return null;
  try {
    const session = JSON.parse(raw) as PosStaffSession;
    return new Date(session.expiresAt).getTime() > Date.now() ? session : null;
  } catch {
    return null;
  }
}

export function saveStaffSession(orgId: string | null, session: PosStaffSession | null) {
  if (orgId) write(staffKey(orgId), session && JSON.stringify(session));
}

let audio: AudioContext | null = null;

/** A scanner's beep: one high note when an item is added, two low ones when not. */
export function beep(ok: boolean) {
  try {
    audio ??= new AudioContext();
    const ctx = audio;
    const notes = ok ? [0] : [0, 0.16];
    for (const at of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "square";
      osc.frequency.value = ok ? 1760 : 330;
      gain.gain.value = 0.04;
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + at);
      osc.stop(ctx.currentTime + at + (ok ? 0.08 : 0.12));
    }
  } catch {
    /* no sound on this device */
  }
}
