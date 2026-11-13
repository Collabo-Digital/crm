import { getCountries } from "libphonenumber-js/min";

/** What a business sells, for the workspace's `industry`. */
export const INDUSTRIES = [
  "Fashion & apparel",
  "Beauty & personal care",
  "Jewellery & accessories",
  "Electronics",
  "Home & living",
  "Food & beverages",
  "Health & wellness",
  "Kids & baby",
  "Sports & outdoors",
  "Books & stationery",
  "Handicrafts & gifts",
  "Other",
] as const;

export const INDIA = "India";

const REGION_NAMES = new Intl.DisplayNames(["en"], { type: "region" });

/** Country names in English, India first: nearly every workspace is Indian. */
export const COUNTRIES: string[] = getCountries()
  .map((code) => REGION_NAMES.of(code) ?? code)
  .sort((a, b) => (a === INDIA ? -1 : b === INDIA ? 1 : a.localeCompare(b)));

// Browsers still report a few zones under their pre-rename ids.
const ZONE_RENAMES: Record<string, string> = {
  "Asia/Calcutta": "Asia/Kolkata",
  "Asia/Katmandu": "Asia/Kathmandu",
  "Asia/Rangoon": "Asia/Yangon",
  "Asia/Saigon": "Asia/Ho_Chi_Minh",
};

const currentZoneName = (zone: string) => ZONE_RENAMES[zone] ?? zone;

/** The timezone this browser is set to, as an IANA id. UTC when it can't be read. */
export function detectTimezone(): string {
  try {
    return currentZoneName(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  } catch {
    return "UTC";
  }
}

/** Every IANA timezone the browser knows, for the "Change" picker. */
export function timezoneOptions(): string[] {
  try {
    return [...new Set(Intl.supportedValuesOf("timeZone").map(currentZoneName))].sort();
  } catch {
    return ["UTC", detectTimezone()];
  }
}

/** "Asia/Kolkata (IST)": the zone with its short name, as people recognise it. */
export function timezoneLabel(zone: string): string {
  try {
    const shortName = new Intl.DateTimeFormat("en-IN", { timeZone: zone, timeZoneName: "short" })
      .formatToParts(new Date())
      .find((part) => part.type === "timeZoneName")?.value;
    return shortName ? `${zone} (${shortName})` : zone;
  } catch {
    return zone;
  }
}
