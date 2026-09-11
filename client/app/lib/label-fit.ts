/**
 * Label-side fit questions: how big the text is, how much height it steals from
 * the bars, and — when a code does not fit — what the merchant can actually do
 * about it. Pure, no React.
 *
 * Kept out of `barcode.ts` on purpose: that file is the geometry engine and
 * knows nothing about label stock or merchant copy. This one is the join
 * between the two.
 */
import { classifyFit, HARD_FLOOR_X_MM, type BarcodeMetrics } from "~/lib/barcode";
import {
  familyOfGroup,
  presetProfileMap,
  presetsBySize,
  type LabelPreset,
  type PrintableWindow,
  type ResolvedProfile,
  type StockFamily,
} from "~/lib/label-stock";

/** Text sizes track label height — a 10 mm tag and a 70 mm carton can't share one. */
export function typeScale(heightMm: number): number {
  return Math.min(1.4, Math.max(0.7, heightMm / 25));
}

// ── the slot model ─────────────────────────────────────────────────────────
//
// This is the ONE place that decides how tall anything on a label is. The
// renderer draws these numbers and the barcode planner reserves against them;
// if the two ever disagree the label overflows its own box and `overflow:
// hidden` eats the bottom row.
//
// It replaced a flat "2.6 mm per text row" estimate, which was short by 10-19%
// because a 7 pt line at leading-tight is 3.087 mm, not 2.6. Since
// `barHeightMm` was derived as `contentHeight - reserved`, every label came out
// exactly that much too tall: 18 of the 24 presets overflowed, including the
// default and both recommended ones, losing about a third of the last text
// row's glyphs on paper.

/** Font sizes in points, exactly as `LabelBody` renders them. */
export const LABEL_PT = { title: 7, hri: 6.5, sku: 6.5, price: 7 } as const;

/** Tailwind's `leading-tight`. The rows carry this class; keep them in step. */
export const LABEL_LINE_HEIGHT = 1.25;

const MM_PER_PT = 25.4 / 72;

/**
 * How far the SKU / price row is pulled in from the label's content edges, at
 * scale 1. Purely visual: `justify-between` otherwise pins them further out
 * than the barcode above them.
 */
export const META_INSET_MM = 1.5;

/** Ceiling on that inset as a share of the panel width, for narrow stock. */
const META_INSET_MAX_SHARE = 0.05;

/** Rendered line-box height of one text row, in millimetres. */
export function rowHeightMm(pt: number, scale: number): number {
  return pt * scale * MM_PER_PT * LABEL_LINE_HEIGHT;
}

export interface PanelSlots {
  scale: number;
  /** Reserved for the product name. 0 on a barcode-only panel. */
  titleMm: number;
  /** Reserved for the SKU / price row. 0 on a barcode-only panel. */
  metaMm: number;
  /** Reserved for the digits under the bars. 0 when the run has no GS1 code. */
  hriMm: number;
  /** Whatever is left for the bars. 0 on a text-only panel. */
  barsMm: number;
  /**
   * Horizontal inset for the SKU / price row only.
   *
   * That row is `justify-between`, so without it the SKU is pinned to the left
   * content edge and the price to the right, both further out than the barcode
   * above them. Applied to no other row: the bars in particular are planned
   * against the FULL `contentWidthMm`, so narrowing the box they land in
   * without telling the planner is exactly how barcodes got clipped before.
   */
  metaInsetMm: number;
}

export interface LabelLayout {
  /** The panel carrying the bars — the whole cell when the die has no windows. */
  barcode: PanelSlots;
  /** The panel carrying the text — the same cell when the die has no windows. */
  info: PanelSlots;
}

/**
 * Every slot is reserved unconditionally — not by checkbox state, and not by
 * whether a given product happens to have the value. That is deliberate and is
 * what "elements keep a fixed position" means: the bars are the same height and
 * in the same place on every label of a given size, whatever is switched on.
 *
 * `hriPossible` is the one input that can remove a slot, because it is not a
 * preference: a catalogue with no EAN/UPC anywhere has no digits row to show
 * and should not pay for one. It is the same condition that decides whether the
 * "Barcode number" checkbox is offered at all.
 *
 * `metaMm` always reserves the 7 pt height even when only the 6.5 pt SKU shows:
 * SKU and price share one `items-baseline` row, so the row must not change
 * height depending on which half is present.
 */
export function labelLayout(
  profile: ResolvedProfile,
  hriPossible: boolean,
): LabelLayout {
  const windows = profile.printableWindows;

  if (windows?.length) {
    const bar = windowBox(profile, windows, "barcode");
    const info = windowBox(profile, windows, "info");
    return {
      barcode: panelSlots({
        ...bar,
        // A window panel is roughly half a label tall, so on its own height it
        // would sit at the 0.7 floor. Doubling is what the renderer has always
        // done; it lives here now so planner and renderer cannot disagree.
        scale: typeScale(bar.heightMm * 2),
        hriPossible,
        carries: { bars: true, text: false },
      }),
      info: panelSlots({
        ...info,
        scale: typeScale(info.heightMm * 2),
        hriPossible,
        carries: { bars: false, text: true },
      }),
    };
  }

  const slots = panelSlots({
    heightMm: profile.contentHeightMm,
    widthMm: profile.contentWidthMm,
    // Scale tracks the LABEL height, not the content box — unchanged from the
    // original, so padding does not quietly shrink the type.
    scale: typeScale(profile.heightMm),
    hriPossible,
    carries: { bars: true, text: true },
  });
  return { barcode: slots, info: slots };
}

/** A window's content height, with the profile's padding taken off both edges. */
function windowBox(
  profile: ResolvedProfile,
  windows: PrintableWindow[],
  role: PrintableWindow["role"],
): { widthMm: number; heightMm: number } {
  const w = windows.find((x) => x.role === role) ?? windows[0]!;
  return {
    widthMm: Math.max(1, w.wMm - 2 * profile.paddingMm),
    heightMm: Math.max(1, w.hMm - 2 * profile.paddingMm),
  };
}

function panelSlots(args: {
  heightMm: number;
  widthMm: number;
  scale: number;
  hriPossible: boolean;
  carries: { bars: boolean; text: boolean };
}): PanelSlots {
  const { heightMm, widthMm, scale, hriPossible, carries } = args;

  const titleMm = carries.text ? rowHeightMm(LABEL_PT.title, scale) : 0;
  const metaMm = carries.text ? rowHeightMm(LABEL_PT.price, scale) : 0;
  const hriMm = carries.bars && hriPossible ? rowHeightMm(LABEL_PT.hri, scale) : 0;
  const barsMm = carries.bars ? Math.max(0, heightMm - titleMm - metaMm - hriMm) : 0;

  // Scales with the label like every other dimension, but capped as a share of
  // the panel: on the barbell's 18 mm info window a flat 1.2 mm each side would
  // eat 13% of a panel that is already short of room, and the SKU truncates
  // that much earlier.
  const metaInsetMm = carries.text
    ? Math.min(META_INSET_MM * scale, widthMm * META_INSET_MAX_SHARE)
    : 0;

  return { scale, titleMm, metaMm, hriMm, barsMm, metaInsetMm };
}

/**
 * Longest Code 128 alphanumeric code that fits, from `modules = 11N + 35` plus
 * the 20-module quiet zone, at the hard floor. Approximate by design — Code C
 * packs digits two per symbol, so numeric codes get roughly double this.
 */
export function maxCodeChars(availableMm: number): number {
  const modules = Math.floor(availableMm / HARD_FLOOR_X_MM);
  return Math.max(0, Math.floor((modules - 20 - 35) / 11));
}

/**
 * The smallest stock that would actually print this code.
 *
 * Trialled at each preset's OWN `defaultDpi` and automatic bar width, because
 * selecting it is what the route applies — offering a size that only fits at
 * the dpi the merchant happens to be on right now would be a lie.
 *
 * Cheap now: `presetProfileMap` resolves the frozen table once and `classifyFit`
 * is integer arithmetic. This used to run `resolveProfile` + a full JsBarcode
 * encode per preset, from inside a `title` attribute, on every render.
 */
export function findFittingPreset(args: {
  metrics: BarcodeMetrics;
  /** Only consider stock that gives the symbol more room than this. */
  minContentWidthMm: number;
  /** Stay within one media family — a roll merchant has no A4 sheets. */
  family?: StockFamily;
}): LabelPreset | undefined {
  const profiles = presetProfileMap();
  return presetsBySize().find((p) => {
    if (args.family && familyOfGroup(p.group) !== args.family) return false;
    const resolved = profiles.get(p.id);
    if (!resolved || resolved.contentWidthMm <= args.minContentWidthMm) return false;
    return (
      classifyFit({
        metrics: args.metrics,
        availableMm: resolved.contentWidthMm,
        dpi: p.defaultDpi,
        preferDots: "auto",
        thermal: resolved.kind === "roll",
      }).fit !== "unfit"
    );
  });
}

/**
 * A remedy that is actually available.
 *
 * The original text said "try larger stock, a 300 dpi printer, or a shorter
 * code". Two things were wrong with it: it was shown to merchants already on
 * 300 dpi, and — verified by sweeping 356 unfit cases across every code and
 * width — **a finer printer never rescues an unfit verdict at all.** `unfit` is
 * reached only when `maxFit < HARD_FLOOR_X_MM`, and `maxFit` is
 * `availableMm / totalModules`: no dpi term. Raising dpi buys finer steps ABOVE
 * the floor, never a lower floor. So the only real remedies are wider stock or
 * a shorter code, and both are named concretely here.
 */
export function fitRemedy(args: {
  metrics: BarcodeMetrics;
  profile: ResolvedProfile;
  /**
   * Must match what the caller's "switch to a bigger size" button offers, or
   * the sentence names one stock and the button another.
   */
  family?: StockFamily;
}): string {
  const { metrics, profile, family } = args;
  const parts: string[] = [];

  if (metrics.totalModules > 0) {
    const neededMm = metrics.totalModules * HARD_FLOOR_X_MM;
    parts.push(
      `Needs ${neededMm.toFixed(1)} mm, this label gives ${profile.contentWidthMm.toFixed(1)} mm.`,
    );
  }

  const fits = findFittingPreset({
    metrics,
    minContentWidthMm: profile.contentWidthMm,
    family,
  });
  if (fits) parts.push(`Fits ${fits.widthMm} × ${fits.heightMm} mm or larger.`);

  const chars = maxCodeChars(profile.contentWidthMm);
  parts.push(
    `On this stock a code of about ${chars} characters fits (roughly ${chars * 2} if digits only).`,
  );

  return parts.join(" ");
}
