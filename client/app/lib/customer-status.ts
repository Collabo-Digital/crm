import type { VipLevel } from "~/types/api";

/**
 * Canonical VIP-tier pill styling and labels.
 *
 * Same shape as `order-status.ts`, for the same reason: these maps were inlined
 * in `routes/app/orders/customers.tsx` on raw palette utilities
 * (`bg-yellow-100 text-yellow-700`, `bg-gray-100 … dark:bg-gray-800`) with no
 * token behind them. One source now, so the list and the customer detail page
 * cannot drift the way the order-status copies did.
 */

/** Tiers, not statuses, so they keep their own colours (on the text shades). */
export const VIP_CLASSES: Record<VipLevel, string> = {
  NONE: "bg-muted text-muted-foreground",
  BRONZE: "bg-warning-strong-subtle text-warning-strong-text",
  SILVER: "bg-muted text-foreground",
  GOLD: "bg-warning-subtle text-warning-text",
  PLATINUM: "bg-brand/30 text-brand-strong",
};

export const VIP_LABELS: Record<VipLevel, string> = {
  NONE: "Regular",
  BRONZE: "Bronze",
  SILVER: "Silver",
  GOLD: "Gold",
  PLATINUM: "Platinum",
};

/** Tier order, lowest to highest — drives the filter row so it cannot fall out of sync. */
export const VIP_ORDER: readonly VipLevel[] = [
  "NONE",
  "BRONZE",
  "SILVER",
  "GOLD",
  "PLATINUM",
];
