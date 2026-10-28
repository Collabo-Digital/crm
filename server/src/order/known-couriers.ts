/**
 * Couriers whose tracking pages the public order page (`/t/<token>`) opens
 * straight away. Any other address is shown to the customer first, with a
 * button to continue there: a vendor or a staff account can type in any
 * site, and the link reaches customers in the store's own WhatsApp messages.
 * The courier's subdomains count too (www., track.).
 */
export const KNOWN_COURIER_DOMAINS = [
  'shiprocket.co',
  'shiprocket.in',
  'delhivery.com',
  'bluedart.com',
  'dtdc.in',
  'dtdc.com',
  'ecomexpress.in',
  'indiapost.gov.in',
  'xpressbees.com',
  'ekartlogistics.com',
  'shadowfax.in',
  'smartr.in',
  'gati.com',
  'tpcindia.com',
  'fedex.com',
  'dhl.com',
  'ups.com',
  'aramex.com',
];

export function isKnownCourierUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return false;
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  return KNOWN_COURIER_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}
