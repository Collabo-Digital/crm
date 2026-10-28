/**
 * What the public order page (`/t/<token>`) does with the shipment's
 * tracking address: open a known courier's page at once, or show the order
 * with the address's site named and a button to continue there. Anyone who
 * can save a shipment (a vendor, a staff account) can type in any site, and
 * this link comes in the store's own WhatsApp messages; the server says
 * which sites are known couriers.
 */
export type TrackingStep =
  | { kind: "none" }
  | { kind: "open"; url: string }
  | { kind: "confirm"; url: string; host: string };

export function trackingStep(order: { trackingUrl: string | null; knownCourier?: boolean }): TrackingStep {
  const raw = order.trackingUrl;
  if (!raw) return { kind: "none" };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { kind: "none" };
  }
  // Only a web address is followed; anything else shows the status page instead.
  if (url.protocol !== "https:" && url.protocol !== "http:") return { kind: "none" };
  if (order.knownCourier && url.protocol === "https:") return { kind: "open", url: raw };
  return { kind: "confirm", url: raw, host: url.hostname };
}
