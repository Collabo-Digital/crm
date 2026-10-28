import { parseStoreProfileSettings } from '../organization-settings/schemas/store-profile-settings.schema';

/**
 * The "Get started" checklist on an owner's dashboard: which of a new store's
 * first jobs are done. Every step is read from the workspace's own data rather
 * than ticked by hand, so a step done anywhere in the app counts, and undoing
 * it (disconnecting WhatsApp, say) shows it as not done again.
 */
export interface SetupProgress {
  /** A WhatsApp number is connected. */
  whatsapp: boolean;
  /** There are products, or a Shopify store is connected to bring them in. */
  catalogue: boolean;
  /**
   * The store profile has a phone or WhatsApp number to print, and there is an
   * address to print: the profile's own, or a registered GSTIN's (the slip
   * falls back to it).
   */
  storeProfile: boolean;
  /** GST is on, with at least one active GSTIN. */
  gst: boolean;
  /** Someone besides the owner has joined or been invited. Influencers don't count. */
  team: boolean;
  /** One of Collabo's recommended automations is on: live, or waiting for Meta to approve its templates. */
  automations: boolean;
}

/** What the checklist is worked out from, gathered by DashboardService.getSetupProgress. */
export interface SetupFacts {
  whatsappChannels: number;
  shopifyChannels: number;
  products: number;
  storeProfileSettings: unknown;
  gstEnabled: boolean;
  /** The stored address of each active GSTIN. */
  gstinAddresses: unknown[];
  /** Active members other than influencers, the owner included. */
  members: number;
  /** Unexpired staff invitations nobody has accepted yet. */
  pendingInvites: number;
  /** Recommended-pack automations that are live or set to go live by themselves. */
  recommendedAutomationsOn: number;
}

const filled = (value: unknown) => typeof value === 'string' && value.trim() !== '';

function hasAddress(address: unknown): boolean {
  if (!address || typeof address !== 'object') return false;
  const a = address as Record<string, unknown>;
  return filled(a.address1) || filled(a.city);
}

export function setupProgress(facts: SetupFacts): SetupProgress {
  const profile = parseStoreProfileSettings(facts.storeProfileSettings);
  const contact = filled(profile.supportPhone) || filled(profile.whatsappPhone);
  const address = hasAddress(profile) || facts.gstinAddresses.some(hasAddress);
  return {
    whatsapp: facts.whatsappChannels > 0,
    catalogue: facts.products > 0 || facts.shopifyChannels > 0,
    storeProfile: contact && address,
    gst: facts.gstEnabled && facts.gstinAddresses.length > 0,
    team: facts.members > 1 || facts.pendingInvites > 0,
    automations: facts.recommendedAutomationsOn > 0,
  };
}
