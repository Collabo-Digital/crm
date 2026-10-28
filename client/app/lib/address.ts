/**
 * Canonical reader for the loosely-typed address JSON.
 *
 * `Customer.addresses` / `defaultAddress` and the order address columns are all
 * `Json` — Shopify's payload passes through more or less verbatim, so keys are
 * snake_case there and camelCase on CRM-native records.
 *
 * Three other readers already exist (`readAddress` in routes/app/orders/$id.tsx,
 * `order-slip.tsx`, `vendor-order-detail.tsx`), each with its own key-alias
 * policy. This is the one meant to replace them; they are untouched for now, so
 * migrate them here rather than adding a fourth.
 */

/** Every alias observed across Shopify payloads and the offline-order form. */
const ALIASES: Record<string, readonly string[]> = {
  address1: ["address1", "address_1"],
  address2: ["address2", "address_2"],
  city: ["city"],
  province: ["province", "province_code", "state"],
  zip: ["zip", "postal_code", "pincode"],
  country: ["country", "country_code"],
  phone: ["phone"],
  company: ["company"],
  firstName: ["first_name", "firstName"],
  lastName: ["last_name", "lastName"],
  name: ["name"],
};

export interface ReadAddress {
  /** Display lines, already joined and empty-filtered. Never contains blanks. */
  lines: string[];
  /** Recipient name, from `name` or first/last. Null when absent. */
  name: string | null;
  phone: string | null;
  /** False when nothing usable was found — render a dash rather than an empty card. */
  hasAddress: boolean;
}

function pick(
  address: Record<string, unknown> | null | undefined,
  field: string,
): string {
  for (const key of ALIASES[field] ?? [field]) {
    const value = address?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/** Normalise an address blob into display-ready lines. */
export function readAddress(
  address: Record<string, unknown> | null | undefined,
): ReadAddress {
  const street = [pick(address, "address1"), pick(address, "address2")]
    .filter(Boolean)
    .join(", ");
  const region = [
    [pick(address, "city"), pick(address, "zip")].filter(Boolean).join(" "),
    pick(address, "province"),
  ]
    .filter(Boolean)
    .join(", ");

  const lines = [
    pick(address, "company"),
    street,
    region,
    pick(address, "country"),
  ].filter(Boolean);

  const name =
    pick(address, "name") ||
    [pick(address, "firstName"), pick(address, "lastName")]
      .filter(Boolean)
      .join(" ") ||
    null;

  return {
    lines,
    name,
    phone: pick(address, "phone") || null,
    hasAddress: lines.length > 0,
  };
}

/**
 * Google Maps link for a set of address lines — opens in a new tab.
 *
 * The keyless `search/?api=1` form, which is a documented and supported URL.
 */
export function mapsUrl(lines: string[]): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(lines.join(", "))}`;
}

/**
 * Google Maps URL for an `<iframe>` of the same address.
 *
 * ⚠️ This is NOT the Maps Embed API. `maps.google.com/maps?...&output=embed` is
 * an undocumented legacy endpoint. It is used here for one reason: it needs no
 * API key, and this app has none — the supported `/maps/embed/v1/place` form
 * requires a key on a billing-enabled Google Cloud project. The trade is that
 * it carries no SLA and Google may change or throttle it without notice, so
 * treat a blank map as expected breakage rather than a bug in our code.
 *
 * Takes the same `lines` as `mapsUrl` so the embed and the link can never drift
 * to different places. Address-string based, which matters because customer
 * addresses in this app never carry coordinates: the Shopify sync's
 * `transformAddress` picks 13 fields and lat/lon are not among them, and the
 * offline order form has no coordinate input.
 */
export function mapsEmbedUrl(lines: string[]): string {
  return `https://maps.google.com/maps?q=${encodeURIComponent(lines.join(", "))}&z=15&output=embed`;
}

/**
 * What stops a customer's address from being saved, in words for the form,
 * or null when it is complete. Mirrors the server's checks: a first line, a
 * city, and a PIN code, which in India is 6 digits.
 */
export function addressProblem(address: {
  address1?: string;
  city?: string;
  zip?: string;
  country?: string;
  country_code?: string;
}): string | null {
  if (!address.address1?.trim()) return "Enter the first line of the address.";
  if (!address.city?.trim()) return "Enter the city.";
  const zip = address.zip?.trim() ?? "";
  if (!zip) return "Enter the PIN code.";
  const indian = address.country_code === "IN" || /^india$/i.test(address.country ?? "");
  if (indian && !/^\d{6}$/.test(zip)) return "An Indian PIN code is 6 digits, like 400001.";
  return null;
}
