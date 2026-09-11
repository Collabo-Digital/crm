import JsBarcode from "jsbarcode";

/**
 * Barcode geometry engine — pure, no React, no DOM.
 *
 * The contract this file exists to enforce: **one SVG user unit is one module**,
 * and the symbol's printed width is `totalModules × moduleMm`, set in
 * millimetres. Nothing may stretch it. The previous implementation handed the
 * SVG `w-full` + `preserveAspectRatio="none"`, so module width came out as
 * `availableWidth / totalModules` — a function of SKU length. One roll printed
 * X anywhere from 0.23 mm to 0.41 mm, with no quiet zone and no dot alignment,
 * which is the classic "scans on screen, not off the sticker" failure.
 *
 * JsBarcode is used ONLY as an encoder here (its documented object renderer:
 * pass a plain object and it fills `.encodings`). Its SVG DOM renderer is not
 * used — we draw plain <rect>s so the geometry is data we can assert on, and
 * so nothing imperative fights the layout.
 *
 * Module width is snapped to whole printer dots (25.4/dpi; 0.1251 mm at
 * 203 dpi) so every bar edge rounds the same direction.
 */

export type Symbology = "EAN13" | "UPC" | "EAN8" | "CODE128";

/** Quiet zone in MODULES per GS1 General Specifications. */
export const QUIET_ZONE: Record<Symbology, { left: number; right: number }> = {
  EAN13: { left: 11, right: 7 },
  UPC: { left: 9, right: 9 },
  EAN8: { left: 7, right: 7 },
  CODE128: { left: 10, right: 10 },
};

/** EAN/UPC nominal X (100% magnification). Also the ceiling for the unaligned path. */
export const NOMINAL_X_MM = 0.33;

/**
 * Recommended minimum X. For EAN/UPC this is 80% magnification (0.264). GS1
 * permits 0.249 mm specifically for ON-DEMAND THERMAL printing, which is what
 * roll profiles are — so thermal gets the lower threshold.
 */
export const RECOMMENDED_X_MM: Record<Symbology, number> = {
  EAN13: 0.264,
  UPC: 0.264,
  EAN8: 0.264,
  CODE128: 0.25,
};
export const THERMAL_X_MM: Record<Symbology, number> = {
  EAN13: 0.249,
  UPC: 0.249,
  EAN8: 0.249,
  CODE128: 0.25,
};

/** Practical scanner floor. Not a GS1 number — below this, stop rendering. */
export const HARD_FLOOR_X_MM = 0.19;

/** ISO/IEC 15417 minimum bar height. Jewellery tags scan at 3 mm in practice. */
export const MIN_BAR_HEIGHT_MM = 6.35;
export const MIN_BAR_HEIGHT_SMALL_MM = 3;

export type PlanQuality = "ok" | "unaligned" | "tight" | "unfit";

export interface BarcodePlan {
  value: string;
  symbology: Symbology;
  /** Modules in the symbol itself, excluding quiet zones. */
  modules: number;
  quietLeft: number;
  quietRight: number;
  /** modules + both quiet zones — the width the label must accommodate. */
  totalModules: number;
  moduleMm: number;
  /** Whole printer dots per module; 0 means "not dot-aligned". */
  dots: number;
  /** Exact printed width = totalModules × moduleMm. */
  widthMm: number;
  barHeightMm: number;
  /** Bar runs in module units, left quiet zone already folded into x. */
  bars: Array<{ x: number; w: number }>;
  quality: PlanQuality;
  magnificationPct?: number;
  notice?: string;
}

/** 25.4 mm per inch. 203 dpi -> 0.12512 mm/dot; 300 dpi -> 0.08467. */
export function dotPitchMm(dpi: number): number {
  return 25.4 / dpi;
}

/**
 * GTIN check digit, shared by EAN-13 / UPC-A / EAN-8. Walking the body
 * right-to-left with weights 3,1,3,1... gives EAN-13 its position-0 weight of 1
 * and EAN-8/UPC-A their weight of 3 without per-format special cases.
 */
export function gtinChecksumValid(value: string): boolean {
  if (!/^\d+$/.test(value) || value.length < 2) return false;
  const digits = value.split("").map(Number);
  const check = digits[digits.length - 1]!;
  const body = digits.slice(0, -1);
  let sum = 0;
  for (let i = body.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) {
    sum += body[i]! * w;
  }
  return (10 - (sum % 10)) % 10 === check;
}

/**
 * Pick the symbology from the stored value.
 *
 * We NEVER fabricate a GTIN. JsBarcode's EAN/UPC constructors append a check
 * digit when handed 12/11/7 digits — we never reach that path, because only
 * values that already validate at full length are routed to those formats.
 * A 13-digit string with a bad check digit falls to Code 128 WITH a notice,
 * which is the most useful diagnostic this feature has.
 */
export function detectSymbology(raw: string): { symbology: Symbology; notice?: string } {
  const value = raw.trim();
  if (/^\d{13}$/.test(value)) {
    if (gtinChecksumValid(value)) return { symbology: "EAN13" };
    return {
      symbology: "CODE128",
      notice:
        "13 digits but the check digit doesn't match — printed as Code 128. A retail POS expecting an EAN-13 will reject it.",
    };
  }
  if (/^\d{12}$/.test(value)) {
    if (gtinChecksumValid(value)) return { symbology: "UPC" };
    return {
      symbology: "CODE128",
      notice: "12 digits but the check digit doesn't match — printed as Code 128, not UPC-A.",
    };
  }
  if (/^\d{8}$/.test(value) && gtinChecksumValid(value)) {
    return { symbology: "EAN8" };
  }
  return { symbology: "CODE128" };
}

/**
 * Encode to a "0101100..." module string.
 *
 * `valid` suppresses JsBarcode's throw on bad input and leaves `encodings`
 * undefined. `flat: true` matters for EAN/UPC: the default guarded encoding
 * returns five encodings whose guard bars are taller than the data bars even
 * when displayValue is false. Flat gives one encoding — EAN-13/UPC-A = 95
 * modules, EAN-8 = 67.
 */
export function encodeBinary(value: string, symbology: Symbology): string | null {
  const sink: { encodings?: Array<{ data: string }> } = {};
  let ok = true;
  try {
    JsBarcode(sink as never, value, {
      format: symbology,
      flat: true,
      displayValue: false,
      margin: 0,
      width: 1,
      height: 1,
      valid: (v: boolean) => {
        ok = v;
      },
    });
  } catch {
    return null;
  }
  if (!ok || !sink.encodings) return null;
  const data = sink.encodings.map((e) => e.data).join("");
  return data.length > 0 ? data : null;
}

/** Runs of consecutive 1s, shifted right by the left quiet zone. Integers throughout. */
export function barRuns(
  binary: string,
  offsetModules: number,
): Array<{ x: number; w: number }> {
  const out: Array<{ x: number; w: number }> = [];
  let i = 0;
  while (i < binary.length) {
    if (binary[i] === "1") {
      let j = i;
      while (j < binary.length && binary[j] === "1") j++;
      out.push({ x: i + offsetModules, w: j - i });
      i = j;
    } else {
      i++;
    }
  }
  return out;
}

interface ModuleChoice {
  moduleMm: number;
  dots: number;
  quality: PlanQuality;
}

/**
 * The fit ladder. First match wins.
 *
 * 203 dpi quantises X to 0.125 mm steps, so between 1 dot (unscannable) and
 * 2 dots (0.2502 mm) there is nothing — narrow stock either fits at 2 dots or
 * needs the unaligned path. There is no gentle degradation, which is exactly
 * why steps 2-4 exist.
 */
export function chooseModuleWidth(args: {
  totalModules: number;
  availableMm: number;
  dpi: number;
  preferDots: number | "auto";
  recommendedMm: number;
}): ModuleChoice {
  const { totalModules, availableMm, dpi, preferDots, recommendedMm } = args;
  const pitch = dotPitchMm(dpi);
  const maxFit = availableMm / totalModules;
  // "auto" caps the module at roughly 0.5 mm so a short code doesn't balloon
  // into a comically wide symbol on a large label.
  const capDots = preferDots === "auto" ? Math.max(1, Math.round(0.5 / pitch)) : preferDots;

  // 1. crisp AND compliant — the largest whole-dot module that still fits.
  const maxK = Math.min(Math.floor(maxFit / pitch), capDots);
  if (maxK >= 1 && maxK * pitch >= recommendedMm) {
    return { moduleMm: maxK * pitch, dots: maxK, quality: "ok" };
  }

  // 2. compliant but not dot-aligned. Scannability outranks edge crispness:
  //    e.g. EAN-13 on 38 mm stock, where 2 dots is 76% magnification and
  //    3 dots does not fit at all.
  if (maxFit >= recommendedMm) {
    return { moduleMm: Math.min(maxFit, NOMINAL_X_MM), dots: 0, quality: "unaligned" };
  }

  // 3. snapped, below recommended but above the hard floor.
  const tightK = Math.floor(maxFit / pitch);
  if (tightK >= 1 && tightK * pitch >= HARD_FLOOR_X_MM) {
    return { moduleMm: tightK * pitch, dots: tightK, quality: "tight" };
  }

  // 4. unaligned, above the hard floor.
  if (maxFit >= HARD_FLOOR_X_MM) {
    return { moduleMm: maxFit, dots: 0, quality: "tight" };
  }

  // 5. does not fit at any scannable width.
  return { moduleMm: 0, dots: 0, quality: "unfit" };
}

/**
 * Everything about a code that does NOT depend on the stock it lands on.
 *
 * This is the only half that touches JsBarcode, so it is the expensive half.
 * Measure once per distinct value, then classify it against as many presets as
 * you like with `classifyFit`, which is integer arithmetic and allocates
 * nothing. The size picker needs a fit verdict for every variant against every
 * preset on every render; encoding that matrix would be hundreds of JsBarcode
 * calls per keystroke.
 */
export interface BarcodeMetrics {
  value: string;
  symbology: Symbology;
  /** null when the value cannot be encoded at all (non-ASCII in Code 128). */
  binary: string | null;
  modules: number;
  quietLeft: number;
  quietRight: number;
  /** modules + both quiet zones. 0 when unencodable. */
  totalModules: number;
  /** GS1 80% floor — laser and sheet stock. */
  recommendedMm: number;
  /** GS1 on-demand-thermal allowance — roll stock. */
  thermalRecommendedMm: number;
  /** Check-digit / encodability diagnostic. Stock-independent. */
  notice?: string;
}

export function measureBarcode(raw: string): BarcodeMetrics {
  const detected = detectSymbology(raw);
  const symbology = detected.symbology;
  const qz = QUIET_ZONE[symbology];
  const binary = encodeBinary(raw.trim(), symbology);
  const modules = binary?.length ?? 0;

  return {
    value: raw,
    symbology,
    binary,
    modules,
    quietLeft: qz.left,
    quietRight: qz.right,
    totalModules: binary ? modules + qz.left + qz.right : 0,
    recommendedMm: RECOMMENDED_X_MM[symbology],
    thermalRecommendedMm: THERMAL_X_MM[symbology],
    // An encode failure replaces the check-digit diagnostic rather than joining
    // it: there is no symbol, so "printed as Code 128" would be a lie.
    notice: binary
      ? detected.notice
      : symbology === "CODE128"
        ? "contains characters Code 128 cannot encode (non-ASCII)"
        : "could not be encoded",
  };
}

export interface FitVerdict {
  quality: PlanQuality;
  moduleMm: number;
  dots: number;
  /** EAN/UPC only — percentage of the 0.33 mm nominal X. */
  magnificationPct?: number;
  /** Coarse bucket, for a badge. */
  fit: "fits" | "tight" | "unfit";
  /**
   * Prints, but should be scanned once first. NOT the same as `fit !== "fits"`:
   * on thermal stock the recommended X is 0.249 mm, below the 0.264 mm that
   * EAN/UPC needs for 80% magnification, so a symbol can be `quality: "ok"` and
   * still be sub-80%. Both cases raise a notice in `planBarcode`; this keeps the
   * badge and the notice agreeing.
   */
  needsTestScan: boolean;
  /** The threshold actually applied, so callers can quote it. */
  recommendedMm: number;
}

/**
 * Where one code lands on one printable width. O(1) — no encoding.
 *
 * Delegates to `chooseModuleWidth`, deliberately: the size-card badges and the
 * rendered symbol must never disagree, and the only way to guarantee that
 * without a test runner is to have one implementation of the ladder.
 */
export function classifyFit(args: {
  metrics: BarcodeMetrics;
  availableMm: number;
  dpi: number;
  preferDots: number | "auto";
  thermal: boolean;
}): FitVerdict {
  const { metrics, availableMm, dpi, preferDots, thermal } = args;
  const recommendedMm = thermal ? metrics.thermalRecommendedMm : metrics.recommendedMm;

  if (metrics.totalModules <= 0) {
    return {
      quality: "unfit",
      moduleMm: 0,
      dots: 0,
      fit: "unfit",
      needsTestScan: false,
      recommendedMm,
    };
  }

  const choice = chooseModuleWidth({
    totalModules: metrics.totalModules,
    availableMm,
    dpi,
    preferDots,
    recommendedMm,
  });

  const magnificationPct =
    metrics.symbology === "CODE128" || choice.quality === "unfit"
      ? undefined
      : Math.round((choice.moduleMm / NOMINAL_X_MM) * 100);

  return {
    quality: choice.quality,
    moduleMm: choice.moduleMm,
    dots: choice.dots,
    magnificationPct,
    fit:
      choice.quality === "unfit" ? "unfit" : choice.quality === "tight" ? "tight" : "fits",
    needsTestScan:
      choice.quality === "tight" || (magnificationPct !== undefined && magnificationPct < 80),
    recommendedMm,
  };
}

/**
 * Full geometry for one code on one label. Pure — safe to call during render.
 * `availableMm` is the printable width the symbol may occupy (the label's
 * content box, or a jewellery preset's barcode window).
 *
 * Composed from `measureBarcode` + `classifyFit` so there is exactly one fit
 * ladder in the codebase. Do not re-inline it.
 */
export function planBarcode(args: {
  value: string;
  availableMm: number;
  dpi: number;
  preferDots: number | "auto";
  maxBarHeightMm: number;
  minBarHeightMm?: number;
  thermal?: boolean;
}): BarcodePlan {
  const {
    value,
    availableMm,
    dpi,
    preferDots,
    maxBarHeightMm,
    minBarHeightMm = MIN_BAR_HEIGHT_MM,
    thermal = true,
  } = args;

  const metrics = measureBarcode(value);

  const base: BarcodePlan = {
    value,
    symbology: metrics.symbology,
    modules: metrics.modules,
    quietLeft: metrics.quietLeft,
    quietRight: metrics.quietRight,
    totalModules: metrics.totalModules,
    moduleMm: 0,
    dots: 0,
    widthMm: 0,
    barHeightMm: 0,
    bars: [],
    quality: "unfit",
    notice: metrics.notice,
  };

  if (!metrics.binary) return base;

  const verdict = classifyFit({ metrics, availableMm, dpi, preferDots, thermal });

  if (verdict.quality === "unfit") {
    const neededMm = metrics.totalModules * verdict.recommendedMm;
    return {
      ...base,
      notice: `needs ${neededMm.toFixed(1)} mm at ${verdict.recommendedMm} mm modules, only ${availableMm.toFixed(1)} mm available`,
    };
  }

  const notices: string[] = [];
  if (metrics.notice) notices.push(metrics.notice);
  if (verdict.magnificationPct !== undefined && verdict.magnificationPct < 80) {
    notices.push(
      `${metrics.symbology} at ${verdict.magnificationPct}% magnification (below the GS1 80% minimum) — fine for in-store scanners, may be rejected by retail partners.`,
    );
  }
  if (verdict.quality === "tight") {
    notices.push(
      `module width ${verdict.moduleMm.toFixed(3)} mm is below the recommended ${verdict.recommendedMm} mm — test-scan before running the batch`,
    );
  } else if (verdict.quality === "unaligned") {
    notices.push(`module width not dot-aligned at ${dpi} dpi — bar edges may vary by one dot`);
  }
  if (maxBarHeightMm < minBarHeightMm) {
    notices.push(
      `label too short for a ${minBarHeightMm} mm bar height — scanning may be unreliable`,
    );
  }

  return {
    ...base,
    moduleMm: verdict.moduleMm,
    dots: verdict.dots,
    widthMm: metrics.totalModules * verdict.moduleMm,
    barHeightMm: Math.max(minBarHeightMm, Math.min(maxBarHeightMm, 20)),
    bars: barRuns(metrics.binary, metrics.quietLeft),
    quality: verdict.quality,
    magnificationPct: verdict.magnificationPct,
    notice: notices.length > 0 ? notices.join(" ") : undefined,
  };
}
