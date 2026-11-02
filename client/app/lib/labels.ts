/** Member roles as people read them. */
export const ROLE_LABEL: Record<string, string> = {
  OWNER: "Owner",
  ADMIN: "Admin",
  MANAGER: "Manager",
  AGENT: "Agent",
  VIEWER: "Viewer",
  VENDOR: "Vendor",
  INFLUENCER: "Influencer",
};

/** Channel platforms as people read them. */
export const PLATFORM_LABEL: Record<string, string> = {
  WHATSAPP: "WhatsApp",
  INSTAGRAM: "Instagram",
  FACEBOOK: "Messenger",
  SHOPIFY: "Shopify",
  WOOCOMMERCE: "WooCommerce",
  TIKTOK: "TikTok",
  MANUAL: "In store",
};

export const roleLabel = (role: string | null | undefined) => (role ? (ROLE_LABEL[role] ?? role) : "Member");
export const platformLabel = (platform: string) => PLATFORM_LABEL[platform] ?? platform;
