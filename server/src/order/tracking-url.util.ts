import { BadRequestException } from '@nestjs/common';

/** Longer than any courier's tracking address. */
const MAX_TRACKING_URL_LENGTH = 2048;

/** Names that only resolve inside a network, never to a courier's site. */
const INTERNAL_HOST = /(^|\.)(localhost|local|internal|intranet|lan|home\.arpa)$/i;

/**
 * Normalise a merchant-typed tracking URL before it reaches Shopify or the DB.
 *
 * Shopify rejects anything without a scheme at the GraphQL variable-coercion
 * layer (`Invalid url 'x', missing scheme`), which surfaced as an opaque 500.
 * Merchants routinely paste `track.courier.in/123`, so a missing scheme is
 * repaired with `https://`; anything that still is not an https link with a
 * real host is a 400 the UI can show verbatim.
 *
 * Customers are sent to this address from the store's own WhatsApp messages,
 * and vendors can set it, so only a public https site is taken: no plain
 * http, no IP address or internal name, and no `user@` part, which can make
 * `https://www.delhivery.com@evil.example` read as Delhivery.
 *
 * Blank → null (clears the URL — the tracking endpoints are full replaces).
 */
export function normalizeTrackingUrl(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_TRACKING_URL_LENGTH) {
    throw new BadRequestException(`Tracking URL is too long. Use the courier's tracking link, up to ${MAX_TRACKING_URL_LENGTH} characters.`);
  }

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw invalid(trimmed);
  }
  if (parsed.protocol === 'http:') {
    throw new BadRequestException(`Tracking URL "${trimmed}" is not secure. Use the courier's https:// link.`);
  }
  // `new URL('https://d')` parses fine, so require a dotted host too. The URL
  // parser writes every form of an IPv4 address (2130706433, 0x7f.1) as
  // dotted digits, and an IPv6 one in brackets.
  const host = parsed.hostname.replace(/\.$/, '');
  if (
    parsed.protocol !== 'https:' ||
    !host.includes('.') ||
    /^[\d.]+$/.test(host) ||
    host.startsWith('[') ||
    INTERNAL_HOST.test(host) ||
    parsed.username ||
    parsed.password ||
    /\s/.test(trimmed)
  ) {
    throw invalid(trimmed);
  }
  return withScheme;
}

function invalid(value: string) {
  return new BadRequestException(
    `Tracking URL "${value}" is not a valid link. Enter a full address like https://courier.com/track/123, or leave it blank.`,
  );
}
