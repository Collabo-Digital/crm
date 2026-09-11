import type { StockBucket } from "~/types/api";

/**
 * One name, and one definition, for every inventory figure in the app.
 *
 * The same number used to be called Available, Stock, Sellable, Available
 * inventory, Total stock and In stock on six different screens, and no screen
 * said what any of them meant. Import from here rather than typing a label
 * inline, so a rename happens once.
 *
 * The words are Shopify's, because that is the model merchants arrive with.
 */
export interface StockTerm {
  label: string;
  /** One sentence, addressed to the merchant. Shown in the header tooltip. */
  definition: string;
}

export const STOCK_TERMS = {
  available: {
    label: "Available",
    definition:
      "Ready to sell at this location. This is the number a customer can order against, and the one you edit here.",
  },
  committed: {
    label: "Committed",
    definition:
      "In orders that are placed but not yet fulfilled. Shopify holds these back from Available, but the units are still on your shelf — so they count towards On hand.",
  },
  unavailable: {
    label: "Unavailable",
    definition:
      "In the building but not sellable — damaged stock and anything held in quality control.",
  },
  onHand: {
    label: "On hand",
    definition:
      "Everything physically at this location: available, plus committed, plus unavailable.",
  },
  bin: {
    label: "Bin",
    definition:
      "Where the stock sits inside this location. Informational — quantities are counted per location, not per bin.",
  },
} as const satisfies Record<string, StockTerm>;

/**
 * The two codes an item carries, defined once for the same reason the stock
 * figures above are.
 *
 * The Inventory toolbar used to offer "Generate all missing SKUs", "Generate
 * all missing barcodes" and "Switch all to short codes" side by side, and no
 * screen in the app said what a SKU was, what a barcode was, why an item needs
 * both, or what "short" meant. The distinction that matters to a merchant is
 * who reads it: a person, or a scanner.
 */
export const CODE_TERMS = {
  sku: {
    label: "SKU",
    definition:
      "Your own code for an item. You choose it and you read it — it appears on invoices, pick lists and reports. It is not scanned.",
  },
  barcode: {
    label: "Barcode",
    definition:
      "The number a scanner reads. We create a short 6-digit one so it fits on small labels. A real retail barcode (EAN or UPC) from your supplier or from Shopify always takes priority and is never replaced.",
  },
} as const satisfies Record<string, StockTerm>;

/** Bucket labels, for the adjust dialog and the movement history. */
export const BUCKET_TERMS: Record<StockBucket, StockTerm> = {
  AVAILABLE: STOCK_TERMS.available,
  RESERVED: {
    label: "Reserved",
    definition: "Set aside at this location and not counted as sellable.",
  },
  QC: {
    label: "QC",
    definition: "Held for quality control. Not sellable until it is released.",
  },
  DAMAGED: {
    label: "Damaged",
    definition: "Written off as unsellable, but still physically on hand.",
  },
};

/**
 * `null` on a ledger row means the stock entered or left the business entirely
 * — a receipt on one side, a sale or a write-off on the other.
 */
export function bucketLabel(bucket: StockBucket | null, direction: "from" | "to"): string {
  if (bucket === null) return direction === "from" ? "In" : "Out";
  return BUCKET_TERMS[bucket].label;
}

/**
 * Why a quantity moved. Keys are what the server stores; the first five are
 * historic and still appear on old rows. Keep in step with ADJUSTMENT_REASONS
 * in server/src/inventory/dto/adjustment.dto.ts.
 */
export const REASON_LABELS: Record<string, string> = {
  adjustment: "Adjustment",
  count: "Cycle count",
  damage: "Damaged",
  found: "Found stock",
  correction: "Correction",
  received: "Received",
  restock: "Restock",
  shrinkage: "Shrinkage",
  quality: "Quality control",
  other: "Other",
  // Written by the system rather than a person.
  sale: "Sale",
  sync: "Shopify sync",
  webhook: "Shopify update",
  initial: "Opening stock",
  migration: "Setup",
};

export function reasonLabel(reason: string): string {
  return REASON_LABELS[reason] ?? reason;
}

/** Reasons a merchant may choose when adjusting stock by hand. */
export const MANUAL_REASONS = [
  "correction",
  "count",
  "received",
  "restock",
  "damage",
  "shrinkage",
  "quality",
  "found",
  "other",
] as const;
