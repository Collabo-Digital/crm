import ShopifyIcon from "~/assests/icon/shopifyIcon";
import InstagramIcon from "~/assests/icon/instagramIcon";
import WhatsappIcon from "~/assests/icon/whatsappIcon";
import MessengerIcon from "~/assests/icon/messengerIcon";
import CollaboIcon from "~/assests/icon/collaboIcon";
import { cn } from "~/lib/utils";
import type { ChannelPlatform } from "~/types/api";

/** The icon files are plain SVG components — width/height numbers only, no className. */
type IconCmp = React.ComponentType<{ width?: number; height?: number }>;

/**
 * Five of the seven platforms have artwork. WOOCOMMERCE and TIKTOK fall
 * through to a label-only badge rather than a broken import.
 */
export const CHANNEL_ICON: Partial<Record<ChannelPlatform, IconCmp>> = {
  SHOPIFY: ShopifyIcon,
  INSTAGRAM: InstagramIcon,
  WHATSAPP: WhatsappIcon,
  FACEBOOK: MessengerIcon,
  // Orders created in this CRM are labelled "Collabo", so they carry its mark.
  MANUAL: CollaboIcon,
};

export const CHANNEL_LABEL: Record<ChannelPlatform, string> = {
  SHOPIFY: "Shopify",
  WOOCOMMERCE: "WooCommerce",
  INSTAGRAM: "Instagram",
  FACEBOOK: "Messenger",
  WHATSAPP: "WhatsApp",
  TIKTOK: "TikTok",
  MANUAL: "Manual",
};

/**
 * Channel chip — platform icon plus name.
 *
 * `variant="inline"` is the bare icon+label run used inside the orders table's
 * metadata line; `variant="chip"` wraps it in a bordered pill for the order
 * detail rail.
 *
 * Caveat: `instagramIcon.jsx` declares its gradient ids un-namespaced (`a`/`b`),
 * so several Instagram badges on one page share — and fight over — the same
 * defs. Pre-existing; it only bites on list views.
 */
export function ChannelBadge({
  platform,
  name,
  size = 12,
  variant = "inline",
  className,
}: {
  platform?: ChannelPlatform | null;
  /** The channel's own name, when it differs from the platform label. */
  name?: string | null;
  size?: number;
  variant?: "inline" | "chip";
  className?: string;
}) {
  const Icon = platform ? CHANNEL_ICON[platform] : undefined;
  const label = name || (platform ? CHANNEL_LABEL[platform] : null);

  const body = (
    <>
      {Icon && <Icon width={size} height={size} />}
      {label ?? "—"}
    </>
  );

  if (variant === "chip") {
    return (
      <span
        className={cn(
          "inline-flex w-fit items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-micro font-medium text-foreground",
          className,
        )}
      >
        {body}
      </span>
    );
  }

  return <span className={cn("inline-flex items-center gap-1", className)}>{body}</span>;
}
