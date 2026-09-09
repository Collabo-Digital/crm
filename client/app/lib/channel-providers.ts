import type {
  Channel,
  ChannelConnectionState,
  ChannelPlatform,
} from "~/types/api";

/**
 * The channel registry: what the Channels settings page can connect, and how.
 *
 * Data rather than branches, so adding a provider later is one entry here plus
 * an OAuth service on the server — the page itself does not learn a new
 * platform name. This is the client half of the server's CONNECTION_POLICY.
 */
export interface ChannelProvider {
  platform: ChannelPlatform;
  label: string;
  description: string;
  /** How many accounts an org may hold at once. `null` = unbounded. */
  maxConnections: number | null;
  /**
   * How connecting starts:
   *   redirect         — leave the app for the provider, come back to a callback
   *   embedded-signup  — Meta's popup, driven by their JS SDK, no navigation
   *   dialog           — collect input from the merchant first (Shopify domain)
   */
  connect: "redirect" | "embedded-signup" | "dialog";
  features: string[];
}

export const CHANNEL_PROVIDERS: ChannelProvider[] = [
  {
    platform: "WHATSAPP",
    label: "WhatsApp Business",
    description:
      "Send order updates and reply to customers on WhatsApp. One business number per organization.",
    maxConnections: 1,
    connect: "embedded-signup",
    features: ["Order notifications", "Customer chat", "Message templates"],
  },
  {
    platform: "INSTAGRAM",
    label: "Instagram",
    description:
      "Connect the Instagram business accounts you run. Add as many handles as you manage.",
    maxConnections: null,
    connect: "redirect",
    features: ["Direct messages", "Comments & mentions", "Profile insights"],
  },
  {
    platform: "SHOPIFY",
    label: "Shopify",
    description:
      "Sync products, orders, customers and inventory with your Shopify store.",
    maxConnections: 1,
    connect: "dialog",
    features: ["Product sync", "Order management", "Inventory tracking"],
  },
];

export function findProvider(platform: ChannelPlatform): ChannelProvider | undefined {
  return CHANNEL_PROVIDERS.find((p) => p.platform === platform);
}

/**
 * A row occupies its provider's slot unless it is disconnected — an errored or
 * expired account still holds the account, and the fix is to reconnect it, not
 * to connect a second one beside it.
 */
export function isActiveChannel(channel: Channel): boolean {
  return channel.connectionState !== "DISCONNECTED";
}

export function activeChannelsFor(
  provider: ChannelProvider,
  channels: Channel[] | undefined,
): Channel[] {
  return (channels ?? []).filter(
    (c) => c.platform === provider.platform && isActiveChannel(c),
  );
}

/** Whether the Connect button should be offered at all. */
export function canConnectAnother(
  provider: ChannelProvider,
  channels: Channel[] | undefined,
): boolean {
  if (provider.maxConnections === null) return true;
  return activeChannelsFor(provider, channels).length < provider.maxConnections;
}

/** Badge presentation per connection state. Tokens only, per DESIGN.md. */
export const CONNECTION_STATE_META: Record<
  ChannelConnectionState,
  { label: string; className: string }
> = {
  CONNECTED: {
    label: "Connected",
    className: "bg-success-subtle text-success",
  },
  ERROR: {
    label: "Connection error",
    className: "bg-danger-subtle text-danger",
  },
  EXPIRED: {
    label: "Expired",
    className: "bg-warning-subtle text-warning-strong",
  },
  DISCONNECTED: {
    label: "Not connected",
    className: "bg-muted text-muted-foreground",
  },
};

/**
 * Copy for the `reason` slugs an OAuth callback can redirect back with.
 *
 * The merchant's browser lands on the channels page carrying
 * `?error=<platform>_connect_failed&reason=<slug>`; without a mapping the page
 * could only say "something went wrong", which does not tell them whether to
 * retry, fix their Meta setup, or disconnect somewhere else first.
 */
export const CONNECT_ERROR_MESSAGES: Record<string, Record<string, string>> = {
  instagram: {
    cancelled: "Instagram connection was cancelled.",
    invalid_state: "That connection link expired. Please try again.",
    no_pages:
      "No Facebook Page found. Instagram connects through a Page, so create one first.",
    no_instagram_account:
      "No Instagram Business account is linked to your Facebook Page. Switch the account to Business or Creator and link it to a Page.",
    already_connected: "That Instagram account is already connected here.",
    limit_reached: "This organization has reached its Instagram account limit.",
    account_taken:
      "That Instagram account is connected to another organization. Disconnect it there first.",
    connect_failed: "Could not connect Instagram. Please try again.",
  },
  whatsapp: {
    cancelled: "WhatsApp connection was cancelled.",
    invalid_state: "That connection link expired. Please try again.",
    already_connected: "That WhatsApp account is already connected here.",
    limit_reached:
      "A WhatsApp account is already connected. Disconnect it before connecting another.",
    account_taken:
      "That WhatsApp Business account is connected to another organization. Disconnect it there first.",
    connect_failed: "Could not connect WhatsApp. Please try again.",
  },
  shopify: {
    invalid_state: "The connection link expired — please try again.",
    cancelled: "Installation was cancelled in Shopify.",
    shop_taken: "This store is already connected to another organization.",
    invalid_hmac: "The request could not be verified. Please try again.",
    connect_failed: "Could not connect to Shopify. Please try again.",
  },
};

export function connectErrorMessage(platform: string, reason: string): string {
  const forPlatform = CONNECT_ERROR_MESSAGES[platform] ?? {};
  return (
    forPlatform[reason] ??
    forPlatform.connect_failed ??
    "Could not connect the channel. Please try again."
  );
}

/** "8 Sep 2026" — the connected/disconnected date format used on this page. */
export function formatChannelDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}
