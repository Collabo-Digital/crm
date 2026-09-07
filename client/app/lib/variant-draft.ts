import type { ProductVariant } from "~/types/api";

/**
 * The four variant fields that are editable inline in the variants table and
 * batched into the page-level Save, rather than written the moment they change.
 *
 * Everything else on a variant is edited in the inline editor panel and saved
 * on its own — see `components/app/product-variants/variant-inline-editor.tsx`.
 */
export type VariantDraft = {
  price: string;
  cost: string;
  inventoryQuantity: string;
  sku: string;
};

export function toInputNumber(value: number | string | null | undefined): string {
  if (value == null || value === "") return "";
  const n = typeof value === "string" ? Number(value) : value;
  return Number.isFinite(n) ? String(n) : "";
}

/** "" → null (clear the field); valid number → number; garbage → undefined (skip). */
export function toNullableNumber(input: string): number | null | undefined {
  if (!input.trim()) return null;
  const parsed = Number(input);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** GST rate as the select option string ("18", "0.25"), "" when unset. */
export function toGstRateOption(value: number | string | null | undefined): string {
  if (value == null || value === "") return "";
  const n = Number(value);
  return Number.isFinite(n) ? String(n) : "";
}

export function buildVariantDrafts(
  variants: ProductVariant[],
): Record<string, VariantDraft> {
  const drafts: Record<string, VariantDraft> = {};
  for (const variant of variants) {
    drafts[variant.id] = {
      price: toInputNumber(variant.price),
      cost: toInputNumber(variant.cost),
      inventoryQuantity: toInputNumber(variant.inventoryQuantity ?? 0),
      sku: variant.sku ?? "",
    };
  }
  return drafts;
}

export function isVariantDraftDirty(
  variant: ProductVariant,
  draft?: VariantDraft,
): boolean {
  if (!draft) return false;
  return (
    draft.price !== toInputNumber(variant.price) ||
    draft.cost !== toInputNumber(variant.cost) ||
    draft.inventoryQuantity !== toInputNumber(variant.inventoryQuantity ?? 0) ||
    draft.sku !== (variant.sku ?? "")
  );
}

export function areVariantDraftsDirty(
  current: Record<string, VariantDraft>,
  baseline: Record<string, VariantDraft>,
): boolean {
  for (const id of Object.keys(baseline)) {
    const draft = current[id];
    const base = baseline[id];
    if (!draft || !base) continue;
    if (
      draft.price !== base.price ||
      draft.cost !== base.cost ||
      draft.inventoryQuantity !== base.inventoryQuantity ||
      draft.sku !== base.sku
    ) {
      return true;
    }
  }
  return false;
}
