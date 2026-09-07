import type { ProductOption } from "~/types/api";

/**
 * Local editable option with a stable client-side key for React lists.
 * The `uid` never leaves the client — normalizeProductOptions strips it from
 * payloads and comparisons.
 */
export type EditableOption = ProductOption & { uid: string };

export const newOptionUid = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : // crypto.randomUUID needs a secure context; fall back for plain-HTTP dev.
    `uid-${Math.random().toString(36).slice(2)}`;

/**
 * Rebuild product options as fresh literals carrying exactly the three keys the
 * server's `ProductOptionDto` accepts.
 *
 * Options fetched from the API can carry more than the `ProductOption` type
 * declares — Shopify's REST webhook stored `id` and `product_id` alongside
 * them, and TypeScript's excess-property check never sees parsed JSON. Posting
 * those back trips the server's `forbidNonWhitelisted` pipe with
 * "options.0.property id should not exist". The detail page also tags its
 * editable copies with a client-only `uid` that must never leave the browser.
 * Mapping to new objects drops all of it.
 *
 * Also trims names and values, drops blank values, and renumbers `position`
 * from array order — the only order the UI lets the user express.
 */
export function normalizeProductOptions(options: ProductOption[]): ProductOption[] {
  return options.map((option, index) => ({
    name: option.name?.trim() ?? "",
    values: (option.values ?? [])
      .map((value) => value.trim())
      .filter(Boolean),
    position: index + 1,
  }));
}
