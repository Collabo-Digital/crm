import type {
  BusinessIdType,
  InvoiceSample,
  InvoiceSettings,
  UpdateInvoiceSettingsRequest,
} from "~/types/api";

/**
 * The "Invoices & bills" settings form: what it edits, what Save and the live
 * preview send, and the checks that mirror the server's
 * (`invoice-settings.schema.ts`), so neither sends a value it would refuse.
 *
 * Type-only imports, so `node --test` runs this file as it is.
 */

/** What the form edits. The signature image is not in it: its upload saves at once. */
export type InvoiceDraft = Omit<InvoiceSettings, "signature">;

export const MAX_BUSINESS_IDS = 6;

/** The label each ID prints with. A custom ID prints the merchant's own. */
export const BUSINESS_ID_LABELS: Record<BusinessIdType, string> = {
  CIN: "CIN",
  FSSAI: "FSSAI Lic. No.",
  UDYAM: "Udyam Reg. No.",
  IEC: "IEC",
  LUT: "LUT",
  DL: "D.L. No.",
  CUSTOM: "Custom",
};

/** A few colours that print well, offered before the picker. Any `#RRGGBB` is allowed. */
export const BRAND_COLOR_PRESETS: ReadonlyArray<{ name: string; hex: string }> = [
  { name: "Teal", hex: "#0F766E" },
  { name: "Forest", hex: "#1F6F5C" },
  { name: "Blue", hex: "#1D4ED8" },
  { name: "Indigo", hex: "#4338CA" },
  { name: "Plum", hex: "#86198F" },
  { name: "Maroon", hex: "#9F1239" },
  { name: "Rust", hex: "#C2410C" },
];

export const SAMPLE_LABELS: Record<InvoiceSample, string> = {
  tax_invoice: "Tax invoice",
  tax_invoice_b2b: "Business invoice",
  bill_of_supply: "Bill of supply",
  credit_note: "Credit note",
  bill: "Bill",
};

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const WEB_LINK = /^https?:\/\/\S+$/i;

export function toDraft(settings: InvoiceSettings): InvoiceDraft {
  const { signature: _signature, ...draft } = settings;
  return draft;
}

/** The draft as the server stores it: trimmed text and an upper-case colour. */
export function cleanDraft(draft: InvoiceDraft): InvoiceDraft {
  return {
    ...draft,
    brandColor: draft.brandColor === null ? null : draft.brandColor.trim().toUpperCase(),
    businessIds: draft.businessIds.map((id) => ({ ...id, label: id.label.trim(), value: id.value.trim() })),
    registeredOffice: draft.registeredOffice.trim(),
    terms: draft.terms.trim(),
    returnPolicy: draft.returnPolicy.trim(),
    returnPolicyUrl: draft.returnPolicyUrl.trim(),
    footerNote: draft.footerNote.trim(),
    signatoryName: draft.signatoryName.trim(),
    signatoryDesignation: draft.signatoryDesignation.trim(),
  };
}

/**
 * What would stop a save, by field: `brandColor`, `returnPolicyUrl`, and
 * `businessIds.<i>.value` / `.label`. Lengths are held by each input's
 * `maxLength`, so they are not checked again here.
 */
export function draftErrors(draft: InvoiceDraft): Record<string, string> {
  const d = cleanDraft(draft);
  const errors: Record<string, string> = {};
  if (d.brandColor !== null && !HEX_COLOR.test(d.brandColor)) {
    errors.brandColor = "Enter a colour like #1F6F5C.";
  }
  if (d.returnPolicyUrl && !WEB_LINK.test(d.returnPolicyUrl)) {
    errors.returnPolicyUrl = "Enter a full link starting with http:// or https://, or leave it blank.";
  }
  d.businessIds.forEach((id, i) => {
    if (!id.value) errors[`businessIds.${i}.value`] = "Enter the number, or remove this ID.";
    if (id.type === "CUSTOM" && !id.label) errors[`businessIds.${i}.label`] = "Name this ID.";
  });
  return errors;
}

/** Deep equality for the draft's values: strings, booleans, null and the list of IDs. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => same(item, b[i]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => same((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
    );
  }
  return false;
}

/** Only what changed, so two managers saving different fields don't undo each other. */
export function settingsPatch(saved: InvoiceSettings, draft: InvoiceDraft): UpdateInvoiceSettingsRequest {
  const clean = cleanDraft(draft);
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(clean) as Array<keyof InvoiceDraft>) {
    if (!same(clean[key], saved[key])) patch[key] = clean[key];
  }
  return patch as UpdateInvoiceSettingsRequest;
}

/**
 * The unsaved form for the live preview, without whatever would make the
 * server refuse it: an unfinished colour or link falls back to the saved one,
 * and an ID still being typed is left off.
 */
export function previewSettings(draft: InvoiceDraft): UpdateInvoiceSettingsRequest {
  const errors = draftErrors(draft);
  const clean = cleanDraft(draft);
  const { brandColor, returnPolicyUrl, businessIds, ...rest } = clean;
  return {
    ...rest,
    ...(errors.brandColor ? {} : { brandColor }),
    ...(errors.returnPolicyUrl ? {} : { returnPolicyUrl }),
    businessIds: businessIds.filter((_, i) => !errors[`businessIds.${i}.value`] && !errors[`businessIds.${i}.label`]),
  };
}

/**
 * Carries the user's edits onto settings that changed on the server
 * meanwhile (an upload, another manager's save): a field the user has not
 * touched takes the new saved value, one they have keeps their edit.
 */
export function rebaseDraft(base: InvoiceSettings, next: InvoiceSettings, draft: InvoiceDraft): InvoiceDraft {
  const out: Record<string, unknown> = { ...draft };
  for (const key of Object.keys(draft) as Array<keyof InvoiceDraft>) {
    if (same(draft[key], base[key])) out[key] = next[key];
  }
  return out as InvoiceDraft;
}

/** The PAN inside a GSTIN: characters 3 to 12. */
export function panFromGstin(gstin: string | null | undefined): string | null {
  return gstin && gstin.length === 15 ? gstin.slice(2, 12) : null;
}

/** WCAG 2 relative luminance of `#RRGGBB`. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Contrast of `#RRGGBB` against white paper, from 1 to 21. */
export function contrastOnWhite(hex: string): number {
  return 1.05 / (luminance(hex) + 0.05);
}

/**
 * Under 3:1 against white, the PDFs never set text in the brand colour: it
 * colours the top bar and the tints only, and titles print in ink.
 */
export function isLightBrandColor(hex: string): boolean {
  return contrastOnWhite(hex) < 3;
}

/**
 * The samples the preview offers. A Bill of supply only means something
 * under the composition scheme, and a Bill (a till sale with no GST invoice)
 * only without GST.
 */
export function previewSamples({ gstEnabled, composition }: { gstEnabled: boolean; composition: boolean }): InvoiceSample[] {
  return [
    "tax_invoice",
    "tax_invoice_b2b",
    ...(composition ? (["bill_of_supply"] as const) : []),
    "credit_note",
    ...(gstEnabled ? [] : (["bill"] as const)),
  ];
}

/** The sample that looks like this merchant's everyday document. */
export function defaultSample({ gstEnabled, composition }: { gstEnabled: boolean; composition: boolean }): InvoiceSample {
  if (!gstEnabled) return "bill";
  return composition ? "bill_of_supply" : "tax_invoice";
}
