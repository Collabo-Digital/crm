import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Guardrails for the design tokens in app.css and the type floor.
 *
 * 1. Every text colour token is checked against the surfaces it sits on
 *    (WCAG AA: 4.5:1 for text, 3:1 for control edges, focus rings, status dots
 *    and chart marks), in light and dark and with the phone overrides.
 * 2. No new hand-typed `text-[Npx]` under 12px anywhere in app code. Files
 *    that still have some are listed in SMALL_TEXT_ALLOWANCE with their count;
 *    the count may only go down.
 */

const APP_DIR = fileURLToPath(new URL("..", import.meta.url));

/* ── Colour maths ─────────────────────────────────────────────────────────── */

type Rgba = { r: number; g: number; b: number; a: number };

const encode = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
const decode = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const clamp = (v: number) => Math.min(1, Math.max(0, v));
const alphaOf = (value: string | undefined) =>
  value === undefined ? 1 : value.endsWith("%") ? parseFloat(value) / 100 : parseFloat(value);

function parseColour(value: string): Rgba {
  const hex = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(value);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return { r: (n >> 16) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255, a: hex[2] ? parseInt(hex[2], 16) / 255 : 1 };
  }
  const oklch = /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+%?))?\s*\)$/i.exec(value);
  if (oklch) {
    const L = parseFloat(oklch[1]) / (oklch[2] ? 100 : 1);
    const C = parseFloat(oklch[3]);
    const h = (parseFloat(oklch[4]) * Math.PI) / 180;
    const A = C * Math.cos(h);
    const B = C * Math.sin(h);
    const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
    const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
    const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
    return {
      r: encode(clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)),
      g: encode(clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)),
      b: encode(clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)),
      a: alphaOf(oklch[5]),
    };
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[/,]\s*([\d.]+%?))?\s*\)$/i.exec(value);
  if (rgb) return { r: +rgb[1] / 255, g: +rgb[2] / 255, b: +rgb[3] / 255, a: alphaOf(rgb[4]) };
  throw new Error(`Cannot read colour "${value}"`);
}

/** Paint `top` over an opaque `bottom`, the way the browser blends in sRGB. */
function over(top: Rgba, bottom: Rgba): Rgba {
  const mix = (t: number, b: number) => t * top.a + b * (1 - top.a);
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a: 1 };
}

const luminance = (c: Rgba) => 0.2126 * decode(c.r) + 0.7152 * decode(c.g) + 0.0722 * decode(c.b);

function contrast(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/* ── Reading app.css ──────────────────────────────────────────────────────── */

type Tokens = Record<string, string>;

const css = readFileSync(join(APP_DIR, "app.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function declarations(source: string, selector: RegExp): Tokens {
  const match = selector.exec(source);
  assert.ok(match, `app.css has no block matching ${selector}`);
  const tokens: Tokens = {};
  for (const [, name, value] of match[1].matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) tokens[name] = value.trim();
  return tokens;
}

const phoneCss = css.slice(css.indexOf("@media (max-width: 767px)"));
const root = declarations(css, /^:root\s*\{([^}]*)\}/m);
const dark = declarations(css, /^\.dark\s*\{([^}]*)\}/m);
const phoneRoot = declarations(phoneCss, /:root\s*\{([^}]*)\}/);
const phoneDark = declarations(phoneCss, /html\.dark\s*\{([^}]*)\}/);

const THEMES: Record<string, Tokens> = {
  light: root,
  dark: { ...root, ...dark },
  "light, phone": { ...root, ...phoneRoot },
  "dark, phone": { ...root, ...dark, ...phoneRoot, ...phoneDark },
};

function resolve(tokens: Tokens, name: string, seen: string[] = []): string {
  const value = tokens[name];
  assert.ok(value !== undefined, `--${name} is not defined (via ${seen.join(" → ") || "pair list"})`);
  return value.replace(/var\(--([\w-]+)\)/g, (_, ref: string) => resolve(tokens, ref, [...seen, name]));
}

/** `brand/30` is the token at 30% opacity, as in the `bg-brand/30` utility. */
function colour(tokens: Tokens, spec: string): Rgba {
  const [name, opacity] = spec.split("/");
  const c = parseColour(resolve(tokens, name));
  return opacity ? { ...c, a: c.a * (Number(opacity) / 100) } : c;
}

/** Page surfaces a translucent tint can sit on. The worst one counts. */
const BASES = ["background", "card", "surface-sunken"];

function worstContrast(tokens: Tokens, fg: string, bg: string): number {
  const back = colour(tokens, bg);
  const bases = back.a < 1 ? BASES.map((b) => over(back, colour(tokens, b))) : [back];
  return Math.min(...bases.map((b) => contrast(over(colour(tokens, fg), b), b)));
}

/* ── The pairs ────────────────────────────────────────────────────────────── */

const TEXT = 4.5;
const NON_TEXT = 3;
const SURFACES = ["background", "card", "popover", "muted", "surface-sunken"];
const STATUSES = ["success", "warning", "warning-strong", "danger", "info"];

/** [foreground, background, minimum ratio] */
type Pair = [string, string, number];

const PAIRS: Pair[] = [
  ...["foreground", "muted-foreground"].flatMap((fg) => SURFACES.map((bg): Pair => [fg, bg, TEXT])),
  // Status words: on their own tint, and as plain text on a page or card.
  ...STATUSES.flatMap((s) => [`${s}-subtle`, ...BASES].map((bg): Pair => [`${s}-text`, bg, TEXT])),
  // Accent text, on surfaces and on the lime tint of an active chip or pill.
  ...[...BASES, "brand/30"].map((bg): Pair => ["brand-strong", bg, TEXT]),
  ["brand", "ink", TEXT],
  ["chat-bubble-foreground", "chat-bubble-in", TEXT],
  ["chat-bubble-foreground", "chat-bubble-out", TEXT],
  // Control edges and the focus ring.
  ...[...BASES, "muted"].flatMap((bg): Pair[] => [["input", bg, NON_TEXT], ["ring", bg, NON_TEXT]]),
  // Status dots and icons on the card. (A dot inside a pill only repeats the
  // pill's word, so it is not held to 3:1 against the tint.)
  ...STATUSES.map((s): Pair => [s, "card", NON_TEXT]),
  // Chart marks.
  ...[1, 2, 3, 4, 5].map((n): Pair => [`chart-${n}`, "card", NON_TEXT]),
];

/** `--x-foreground` is text on `--x`, so every such pair is checked too. */
const NON_TEXT_FOREGROUNDS: Record<string, string> = {
  "chat-send-foreground": "the send arrow is an icon, never text",
};

function foregroundPairs(tokens: Tokens): Pair[] {
  return Object.keys(tokens)
    .filter((name) => name.endsWith("-foreground"))
    .map((name): [string, string] => [name, name.slice(0, -"-foreground".length)])
    .filter(([, bg]) => bg in tokens)
    .map(([fg, bg]): Pair => [fg, bg, fg in NON_TEXT_FOREGROUNDS ? NON_TEXT : TEXT]);
}

describe("design tokens meet WCAG AA contrast", () => {
  for (const [theme, tokens] of Object.entries(THEMES)) {
    it(`in ${theme}`, () => {
      const pairs = new Map([...PAIRS, ...foregroundPairs(tokens)].map((p) => [`${p[0]} on ${p[1]}`, p]));
      const failures = [...pairs.values()]
        .map(([fg, bg, min]) => ({ fg, bg, min, ratio: worstContrast(tokens, fg, bg) }))
        .filter(({ ratio, min }) => ratio < min)
        .map(({ fg, bg, min, ratio }) => `--${fg} on --${bg}: ${ratio.toFixed(2)}:1, needs ${min}:1`);
      assert.deepEqual(failures, []);
    });
  }
});

/* ── The 12px floor ───────────────────────────────────────────────────────── */

const HAND_TYPED_SIZE = /\btext-\[(\d+(?:\.\d+)?)(px|rem)\]/g;

/** The one exception: a short badge label in 11px semibold capitals. */
const isBadgeLabel = (line: string, px: number) =>
  px === 11 && /\buppercase\b/.test(line) && /\bfont-(semibold|bold)\b/.test(line);

function countSmallSizes(source: string): number {
  let count = 0;
  for (const line of source.split("\n")) {
    for (const [, size, unit] of line.matchAll(HAND_TYPED_SIZE)) {
      const px = Number(size) * (unit === "rem" ? 16 : 1);
      if (px < 12 && !isBadgeLabel(line, px)) count += 1;
    }
  }
  return count;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

/**
 * Files that still hand-type text under 12px, with how many times. These were
 * left for each screen's own clean-up (the printed slips and the sign-in
 * illustrations are drawn at their own scale on purpose). Replace a size with
 * text-caption or a larger role, then lower the count here; never raise it.
 */
const SMALL_TEXT_ALLOWANCE: Record<string, number> = {
  "components/app/analytics/messaging-volume-chart.tsx": 1,
  "components/app/auth/illustrations/automated-workflow.tsx": 3,
  "components/app/auth/illustrations/customer-profile.tsx": 5,
  "components/app/auth/illustrations/unified-commerce.tsx": 4,
  "components/app/channel-sync-options.tsx": 7,
  "components/app/gstr1-panels.tsx": 2,
  "components/app/inbox/message-bubble.tsx": 3,
  "components/app/inbox/voice-note-player.tsx": 1,
  "components/app/inventory/location-kind-badge.tsx": 1,
  "components/app/inward-supplies-panel.tsx": 6,
  "components/app/low-stock-products-panel.tsx": 2,
  "components/app/order-actions.tsx": 8,
  "components/app/order-create/address-fields.tsx": 2,
  "components/app/order-create/bill-summary.tsx": 5,
  "components/app/order-create/customer-picker-or-create.tsx": 6,
  "components/app/order-create/offline-order-form.tsx": 5,
  "components/app/order-create/order-cart.tsx": 4,
  "components/app/order-create/product-picker.tsx": 2,
  "components/app/order-dialog-primitives.tsx": 2,
  "components/app/order-fulfillments.tsx": 9,
  "components/app/order-slip.tsx": 12,
  "components/app/phone-input.tsx": 4,
  "components/app/pos/product-finder.tsx": 1,
  "components/app/product-create/image-gallery-uploader.tsx": 5,
  "components/app/product-create/stock-locations.tsx": 1,
  "components/app/product-create/variant-image-link.tsx": 2,
  "components/app/product-save-pill.tsx": 1,
  "components/app/products/bulk-action-bar.tsx": 1,
  "components/app/products/csv-import-wizard.tsx": 11,
  "components/app/sales-donut-chart.tsx": 2,
  "components/app/settings/billing-tab.tsx": 1,
  "components/app/settings/developers-tab.tsx": 1,
  "components/app/settings/payments-card.tsx": 2,
  "components/app/settings/upgrade-organization-dialog.tsx": 6,
  "components/app/shopify-connect-dialog.tsx": 3,
  "components/app/shopify-locations-dialog.tsx": 2,
  "components/app/top-products-panel.tsx": 6,
  "components/app/vendor-order-detail.tsx": 5,
  "components/billing/plan-cards.tsx": 4,
  "routes/app/admin/user-detail.tsx": 2,
  "routes/app/orders/$id.tsx": 1,
  "routes/app/products.tsx": 2,
  "routes/app/products/inventory.tsx": 5,
  "routes/app/products/inventory/warehouses.tsx": 6,
  "routes/onboarding/invite-team.tsx": 1,
};

describe("type floor", () => {
  const found = Object.fromEntries(
    sourceFiles(APP_DIR)
      .map((file) => [relative(APP_DIR, file), countSmallSizes(readFileSync(file, "utf8"))] as const)
      .filter(([, count]) => count > 0),
  );

  it("adds no hand-typed text size under 12px", () => {
    const over = Object.entries(found)
      .filter(([file, count]) => count > (SMALL_TEXT_ALLOWANCE[file] ?? 0))
      .map(([file, count]) => `${file}: ${count} sizes under 12px, allowed ${SMALL_TEXT_ALLOWANCE[file] ?? 0} (use text-caption or larger)`);
    assert.deepEqual(over, []);
  });

  it("keeps the allowance list as low as the code", () => {
    const stale = Object.entries(SMALL_TEXT_ALLOWANCE)
      .filter(([file, allowed]) => (found[file] ?? 0) < allowed)
      .map(([file, allowed]) => `${file}: allowed ${allowed}, now ${found[file] ?? 0} (lower it in SMALL_TEXT_ALLOWANCE)`);
    assert.deepEqual(stale, []);
  });
});
