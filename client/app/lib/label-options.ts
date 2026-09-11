/**
 * What the label print screen remembers — pure, no React, no DOM beyond
 * `localStorage`.
 *
 * `LabelOptions` is deliberately a description of **what gets printed** and
 * nothing else. View state (which media pill is showing, whether the advanced
 * panel is open, whether the first-run card has been dismissed) lives in its own
 * keys, so this record stays something you could hand to a print job.
 *
 * Nothing here is versioned, by design: every field added since the first
 * release has been additive, and `{...DEFAULT_OPTIONS, ...stored}` absorbs a
 * missing field correctly. If a field ever needs to change MEANING rather than
 * be added, that is the point to introduce a version — not before.
 */
import {
  CUSTOM_PRESET_ID,
  DEFAULT_CUSTOM,
  familyOfPreset,
  findPreset,
  type CustomStock,
  type StockFamily,
} from "~/lib/label-stock";

export const OPTS_KEY = "label-print-opts";
/** Advanced panel disclosure. Separate key — view state, not print state. */
export const ADVANCED_OPEN_KEY = "label-print-advanced-open";
/** First-run "we picked a setup for you" card. */
export const INTRO_DISMISSED_KEY = "label-print-intro-dismissed";

/** Batch ceiling across the whole run. */
export const MAX_LABELS = 1000;
/** Per-variant ceiling. Distinct from MAX_LABELS — both are honest. */
export const MAX_QTY_PER_VARIANT = 100;

export interface LabelOptions {
  showTitle: boolean;
  showSku: boolean;
  showPrice: boolean;
  /** Human-readable digits under EAN/UPC bars — GS1 requires HRI on retail symbols. */
  showHri: boolean;
  presetId: string;
  custom: CustomStock;
  startOffset: number;
  nudgeXMm: number;
  nudgeYMm: number;
  dpi: number;
  preferDots: number | "auto";
}

export const DEFAULT_OPTIONS: LabelOptions = {
  showTitle: true,
  showSku: true,
  showPrice: false,
  showHri: true,
  presetId: "roll-50x25",
  custom: DEFAULT_CUSTOM,
  startOffset: 0,
  nudgeXMm: 0,
  nudgeYMm: 0,
  dpi: 203,
  preferDots: "auto",
};

export function loadOptions(): LabelOptions {
  if (typeof window === "undefined") return DEFAULT_OPTIONS;
  try {
    const raw = JSON.parse(localStorage.getItem(OPTS_KEY) ?? "{}");
    const merged: LabelOptions = { ...DEFAULT_OPTIONS, ...raw };
    merged.custom = { ...DEFAULT_CUSTOM, ...(raw?.custom ?? {}) };

    // Options written before presets existed carry `mode: "sheet" | "thermal"`
    // and no presetId. Map it once so a merchant who chose the label roll keeps
    // the label roll. Not a migration — nothing is versioned.
    if (raw?.mode && !raw?.presetId) {
      merged.presetId = raw.mode === "thermal" ? "roll-50x25" : "sheet-a4-plain";
    }

    // A stored id for a preset that no longer exists resolves to CUSTOM inside
    // `resolveProfile` (findPreset returns undefined → sanitizeCustom). That was
    // invisible behind the old <select>; under the size picker it means no media
    // pill lit and no card selected, which reads as a broken screen. Fall back
    // to the default rather than stranding them.
    if (merged.presetId !== CUSTOM_PRESET_ID && !findPreset(merged.presetId)) {
      merged.presetId = DEFAULT_OPTIONS.presetId;
    }

    return merged;
  } catch {
    return DEFAULT_OPTIONS;
  }
}

export function saveOptions(options: LabelOptions): void {
  try {
    localStorage.setItem(OPTS_KEY, JSON.stringify(options));
  } catch {
    // storage unavailable — options just don't persist
  }
}

/** Has this browser ever printed labels? Drives the first-run card. */
export function isFirstVisit(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return localStorage.getItem(OPTS_KEY) === null;
  } catch {
    return false;
  }
}

export function loadFlag(key: string, fallback: boolean): boolean {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : raw === "1";
  } catch {
    return fallback;
  }
}

export function saveFlag(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {
    // storage unavailable
  }
}

/**
 * Is any advanced setting away from what the chosen stock implies?
 *
 * Drives both the "Custom settings active" badge and the rule that the advanced
 * panel is forced open on load when this is true. A collapsed panel silently
 * shifting the output by 2 mm is how support tickets are made.
 */
export function hasCustomAdvanced(options: LabelOptions): boolean {
  const preset = findPreset(options.presetId);
  const defaultDpi = preset?.defaultDpi ?? DEFAULT_OPTIONS.dpi;
  return (
    options.dpi !== defaultDpi ||
    options.preferDots !== "auto" ||
    options.startOffset !== 0 ||
    options.nudgeXMm !== 0 ||
    options.nudgeYMm !== 0
  );
}

/** The media family a stored options record should land on. */
export function familyOfOptions(options: LabelOptions): StockFamily {
  return options.presetId === CUSTOM_PRESET_ID
    ? "custom"
    : familyOfPreset(options.presetId);
}
