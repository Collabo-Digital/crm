import type { GstSupplyType, ProductOption, ProductVariant } from "~/types/api";
import type { VariantDraft } from "./variant-draft";

/** The product's Tax (GST) values, shown as the "inherit" hint in the editor. */
export type ProductTaxDefaults = {
  hsnCode: string | null;
  /** Select option string ("18"), "" when unset. */
  gstRate: string;
  unitOfMeasure: string | null;
  supplyType: GstSupplyType;
};

export type VariantGroup = {
  key: string;
  variants: ProductVariant[];
  /**
   * True when the group is a single variant with nothing below it — a
   * one-option product, or a simple product. Rendered as a plain row with no
   * chevron, because expanding it would just show itself again.
   */
  leaf: boolean;
};

export function isDefaultVariantLabel(value?: string | null): boolean {
  return !value || value === "Default Title";
}

export function formatVariantTitle(
  variant: ProductVariant,
  productTitle?: string,
  titleLabel?: string,
): string {
  if (titleLabel && !isDefaultVariantLabel(titleLabel)) return titleLabel;
  if (
    isDefaultVariantLabel(variant.title) ||
    isDefaultVariantLabel(variant.option1)
  ) {
    return productTitle?.trim() || "Default";
  }
  return variant.title;
}

export function formatVariantOptionLabel(variant: ProductVariant): string | null {
  const parts = [variant.option1, variant.option2, variant.option3].filter(
    (value): value is string => !!value && value !== "Default Title",
  );
  return parts.length > 0 ? parts.join(" / ") : null;
}

export function hasGstOverride(v: ProductVariant): boolean {
  return (
    v.hsnCode != null ||
    v.gstRate != null ||
    v.unitOfMeasure != null ||
    v.supplyType != null
  );
}

/** Which GST fields this variant overrides, for the editor's helper line. */
export function gstOverrideFields(v: ProductVariant): string[] {
  const names: string[] = [];
  if (v.hsnCode != null) names.push("HSN/SAC");
  if (v.gstRate != null) names.push("GST rate");
  if (v.unitOfMeasure != null) names.push("UQC");
  if (v.supplyType != null) names.push("supply type");
  return names;
}

/** Group variants by their first option value, preserving server position order. */
export function buildVariantGroups(variants: ProductVariant[]): VariantGroup[] {
  const map = new Map<string, ProductVariant[]>();

  for (const v of variants) {
    const key =
      !v.option1 || v.option1 === "Default Title" ? "Default" : v.option1;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(v);
  }

  return Array.from(map.entries())
    .map(([key, items]) => {
      const sorted = items.sort((a, b) => a.position - b.position);
      return {
        key,
        variants: sorted,
        leaf: sorted.length === 1 && !sorted[0].option2,
      };
    })
    .sort((a, b) => a.variants[0].position - b.variants[0].position);
}

export function plural(count: number, noun: string): string {
  const suffix = /(s|x|z|ch|sh)$/i.test(noun) ? "es" : "s";
  return `${count} ${count === 1 ? noun : noun + suffix}`;
}

export type GroupMeta = {
  childCount: number;
  childNoun: string;
  priceMin: number | null;
  priceMax: number | null;
  /** Summed stock across tracked children; null when none of them track it. */
  trackedStock: number | null;
  untrackedCount: number;
};

/**
 * The plain-English line under a group name: "3 types · ₹500 – ₹700 · 19 in
 * stock". Reads through `drafts` first so unsaved table edits are reflected —
 * a merchant who just typed a price should see the range move.
 */
export function computeGroupMeta(
  variants: ProductVariant[],
  drafts: Record<string, VariantDraft>,
  childNoun: string,
): GroupMeta {
  const prices = variants
    .map((v) => {
      const raw = drafts[v.id]?.price ?? String(v.price ?? "");
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    })
    .filter((n): n is number => n != null);

  const tracked = variants.filter((v) => v.trackQuantity !== false);
  const trackedStock = tracked.length
    ? tracked.reduce((sum, v) => {
      const raw = drafts[v.id]?.inventoryQuantity ?? String(v.inventoryQuantity ?? 0);
      const n = Number.parseInt(raw, 10);
      return sum + (Number.isFinite(n) ? n : 0);
    }, 0)
    : null;

  return {
    childCount: variants.length,
    childNoun,
    priceMin: prices.length ? Math.min(...prices) : null,
    priceMax: prices.length ? Math.max(...prices) : null,
    trackedStock,
    untrackedCount: variants.length - tracked.length,
  };
}

export function matchesVariantSearch(v: ProductVariant, query: string): boolean {
  if (!query) return true;
  const haystack = [v.option1, v.option2, v.option3, v.title, v.sku]
    .filter((s): s is string => !!s)
    .join(" ")
    .toLowerCase();
  return haystack.includes(query);
}

/**
 * How the option set reads as a sentence: "6 colors × 2 types = 12 variants".
 * Options without both a name and at least one value can't contribute a
 * combination, so they're ignored rather than counted as ×0.
 */
export function combinationSummary(options: ProductOption[]): {
  parts: Array<{ count: number; name: string }>;
  total: number;
} {
  const complete = options.filter(
    (o) => o.name.trim().length > 0 && o.values.length > 0,
  );
  if (complete.length === 0) return { parts: [], total: 0 };
  return {
    parts: complete.map((o) => ({ count: o.values.length, name: o.name.trim() })),
    total: complete.reduce((acc, o) => acc * o.values.length, 1),
  };
}

/**
 * How many combinations "Generate" would actually create.
 *
 * Mirrors `generateVariantsFromOptions` on the server, including its back-fill
 * rule: a pre-existing variant missing a value for an option is treated as
 * holding that option's FIRST value (Shopify's `LEAVE_AS_IS` parity). Without
 * that step, adding a third option to a 12-variant product would predict 12 new
 * rows when the server creates none.
 */
export function pendingCombinationCount(
  options: ProductOption[],
  existing: ProductVariant[],
): number {
  const complete = options.filter(
    (o) => o.name.trim().length > 0 && o.values.length > 0,
  );
  if (complete.length === 0) return 0;

  const slots: Array<Array<string | null>> = [0, 1, 2].map(
    (i) => complete[i]?.values ?? [null],
  );

  const taken = new Set<string>();
  for (const v of existing) {
    const key = [v.option1, v.option2, v.option3].map((value, i) => {
      const option = complete[i];
      if (!option) return null;
      if (!value || value === "Default Title") return option.values[0];
      return value;
    });
    taken.add(key.join("|"));
  }

  let count = 0;
  for (const a of slots[0]) {
    for (const b of slots[1]) {
      for (const c of slots[2]) {
        if (!taken.has([a, b, c].join("|"))) count += 1;
      }
    }
  }
  return count;
}

/**
 * Token-only tint pairs for the fallback swatch tile. Deliberately background +
 * matching foreground pairs from the design system rather than raw colours, so
 * a token rename can't leave an unreadable tile behind.
 */
const SWATCH_TINTS = [
  "bg-brand text-brand-foreground",
  "bg-info-subtle text-info",
  "bg-success-subtle text-success",
  "bg-warning-subtle text-warning",
  "bg-danger-subtle text-danger",
  "bg-muted text-muted-foreground",
] as const;

/** Stable per-value tint, so "Ice" is the same colour on every page load. */
export function swatchTint(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return SWATCH_TINTS[hash % SWATCH_TINTS.length];
}

const COLOUR_OPTION = /^(colou?r|shade|colorway|tone)$/i;

/**
 * Whether to try reading an option value as a literal CSS colour.
 *
 * Gated on the option NAME, not the value: "Ice", "Tomato", "Salmon" and
 * "Linen" are all valid CSS colour keywords and all plausible flavour, fabric
 * or scent names. Without the gate a Flavour option would render food as paint.
 */
export function isColourOption(optionName?: string | null): boolean {
  return COLOUR_OPTION.test((optionName ?? "").trim());
}
