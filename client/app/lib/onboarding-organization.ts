import { isValidPhoneNumber } from "libphonenumber-js/min";

import { INDIA } from "~/lib/org-options";
import { GST_STATES, GSTIN_PATTERN, PIN_CODE } from "~/lib/pos-cart";
import type { OrganizationGstin, OrgResponse, StoreProfileSettings } from "~/types/api";

/** The Organization step of the setup wizard, as the owner types it. */
export interface OrganizationFormValues {
  name: string;
  industry: string;
  website: string;
  email: string;
  /** E.164, as `PhoneInput` emits it. */
  phone: string;
  country: string;
  state: string;
  city: string;
  pin: string;
  street: string;
  /** IANA id. */
  timezone: string;
  gstRegistered: boolean;
  gstin: string;
  legalName: string;
}

export type OrganizationField = keyof OrganizationFormValues;
export type OrganizationFormErrors = Partial<Record<OrganizationField, string>>;

export const EMPTY_ORGANIZATION_FORM: OrganizationFormValues = {
  name: "",
  industry: "",
  website: "",
  email: "",
  phone: "",
  country: INDIA,
  state: "",
  city: "",
  pin: "",
  street: "",
  timezone: "",
  gstRegistered: false,
  gstin: "",
  legalName: "",
};

/** Top to bottom on the page, so the first error is the first one the owner meets. */
export const ORGANIZATION_FIELD_ORDER: readonly OrganizationField[] = [
  "name",
  "industry",
  "website",
  "email",
  "phone",
  "country",
  "state",
  "city",
  "pin",
  "street",
  "gstin",
  "legalName",
];

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Shaped like an email address. The server is the authority; this only catches typos early. */
export const isEmailAddress = (value: string) => EMAIL.test(value);
// A domain with or without its protocol: "acmestore.in", "https://acmestore.in/shop".
const WEB_ADDRESS = /^(https?:\/\/)?([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(:\d+)?(\/\S*)?$/i;

/** The address as the server stores it: "acmestore.in" becomes "https://acmestore.in". Blank stays blank. */
export function websiteUrl(website: string): string {
  const typed = website.trim();
  if (!typed) return "";
  return /^https?:\/\//i.test(typed) ? typed : `https://${typed}`;
}

/** The state a GSTIN is registered in, read from its first two digits. */
export function gstinState(gstin: string): { code: string; name: string } | null {
  return GST_STATES.find((state) => state.code === gstin.trim().slice(0, 2)) ?? null;
}

/** The step as the server holds it, spread over the three places it is stored. */
export function savedOrganizationValues(
  org: OrgResponse,
  profile: StoreProfileSettings,
  gstins: OrganizationGstin[],
): OrganizationFormValues {
  const gstin = gstins.find((entry) => entry.isDefault) ?? gstins[0];
  return {
    name: org.name,
    industry: org.industry ?? "",
    // Shown the way people type it; the save puts the protocol back.
    website: (profile.website || org.website || "").replace(/^https:\/\//i, ""),
    email: profile.supportEmail,
    phone: profile.supportPhone,
    country: profile.country || INDIA,
    state: profile.province,
    city: profile.city,
    pin: profile.zip,
    street: profile.address1,
    timezone: org.timezone,
    gstRegistered: org.gstEnabled,
    gstin: gstin?.gstin ?? "",
    legalName: gstin?.legalName ?? "",
  };
}

/**
 * What stops this form from being saved, keyed by field. Empty when it can be.
 * The limits mirror the server's: the organization DTOs, the store profile
 * schema and the GSTIN DTO.
 */
export function validateOrganizationForm(values: OrganizationFormValues): OrganizationFormErrors {
  const errors: OrganizationFormErrors = {};
  const name = values.name.trim();
  const website = values.website.trim();
  const email = values.email.trim();
  const pin = values.pin.trim();

  if (!name) errors.name = "Enter your business name.";
  else if (name.length < 2) errors.name = "Use at least 2 characters.";
  else if (name.length > 100) errors.name = "Use 100 characters or fewer.";

  if (!values.industry) errors.industry = "Choose your industry.";

  if (website && !WEB_ADDRESS.test(website)) errors.website = "Enter a full web address, like acmestore.in";

  if (!email) errors.email = "Enter your business email.";
  else if (!EMAIL.test(email)) errors.email = "Enter a valid email address, like hello@acmestore.in";

  if (!values.phone) errors.phone = "Enter your business phone number.";
  else if (!isValidPhoneNumber(values.phone)) errors.phone = "Enter a valid phone number.";

  if (!values.country) errors.country = "Choose your country.";

  if (!values.state.trim()) errors.state = values.country === INDIA ? "Choose your state." : "Enter your state or region.";
  else if (values.state.trim().length > 100) errors.state = "Use 100 characters or fewer.";

  if (!values.city.trim()) errors.city = "Enter your city.";
  else if (values.city.trim().length > 100) errors.city = "Use 100 characters or fewer.";

  if (pin && values.country === INDIA && !PIN_CODE.test(pin)) errors.pin = "A PIN code has 6 digits, like 400013.";
  else if (pin.length > 20) errors.pin = "Use 20 characters or fewer.";

  if (values.street.trim().length > 200) errors.street = "Use 200 characters or fewer.";

  if (values.gstRegistered) {
    const legalName = values.legalName.trim();
    if (!values.gstin.trim()) errors.gstin = "Enter your GSTIN.";
    else if (!GSTIN_PATTERN.test(values.gstin.trim())) errors.gstin = "A GSTIN has 15 characters, like 27AABCU9603R1ZM.";
    else if (!gstinState(values.gstin)) errors.gstin = "The first two digits aren't a state code. Check your GSTIN.";

    if (!legalName) errors.legalName = "Enter the legal name on your GST certificate.";
    else if (legalName.length < 2) errors.legalName = "Use at least 2 characters.";
    else if (legalName.length > 200) errors.legalName = "Use 200 characters or fewer.";
  }

  return errors;
}
