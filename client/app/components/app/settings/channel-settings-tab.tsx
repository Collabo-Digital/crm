import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Link2 } from "lucide-react";
import { TableSkeleton } from "~/components/app/table-skeleton";
import { EmptyState } from "~/components/app/empty-state";
import { QueryErrorState } from "~/components/app/query-error-state";
import { ShopifyConnectDialog } from "~/components/app/shopify-connect-dialog";
import { WhatsAppConnectDialog } from "~/components/app/whatsapp-connect-dialog";
import { ChannelProviderCards } from "~/components/app/channels/channel-provider-cards";
import { ConnectedAccountsTable } from "~/components/app/channels/connected-accounts-table";
import { ChannelManageDialog } from "~/components/app/channels/channel-manage-dialog";
import { ChannelDisconnectDialog } from "~/components/app/channels/channel-disconnect-dialog";
import { InstagramConnectDialog } from "~/components/app/channels/instagram-connect-dialog";
import { InstagramAccountPickerDialog } from "~/components/app/channels/instagram-account-picker-dialog";
import { useChannels, channelKeys } from "~/hooks/use-channel-queries";
import { orgKeys } from "~/hooks/use-org-queries";
import { useCurrentRole } from "~/hooks/use-current-role";
import { CHANNEL_PROVIDERS, connectErrorMessage, type ChannelProvider } from "~/lib/channel-providers";
import type { Channel, ChannelPlatform } from "~/types/api";

/**
 * Who may connect and manage a channel here.
 *
 * Influencers are included because connecting their OWN Instagram is the whole
 * reason they have an account. That is not a widening of trust: the server only
 * ever returns them the channels they personally connected, and re-checks
 * ownership on every write. So everything an influencer can see on this page is
 * already theirs to manage.
 */
const MANAGE_ROLES = ["OWNER", "ADMIN", "INFLUENCER"];

/** What each role may connect. Influencers bring an Instagram account, nothing else. */
const INFLUENCER_PROVIDERS: ChannelPlatform[] = ["INSTAGRAM"];

export function ChannelSettingsTab() {
  const [shopifyOpen, setShopifyOpen] = useState(false);
  const [instagramOpen, setInstagramOpen] = useState(false);
  const [whatsappOpen, setWhatsappOpen] = useState(false);
  /** Set when a dialog is re-authorizing an existing row rather than adding one. */
  const [reconnectChannelId, setReconnectChannelId] = useState<string | undefined>();
  const [manageChannel, setManageChannel] = useState<Channel | null>(null);
  const [disconnectChannel, setDisconnectChannel] = useState<Channel | null>(null);
  const [instagramPendingId, setInstagramPendingId] = useState<string | null>(null);
  // Pre-fills the Shopify dialog when arriving from the embedded Shopify
  // app's "Open CRM" button (?install_shop=my-store.myshopify.com)
  const [installDomain, setInstallDomain] = useState<string | undefined>();

  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const { role, isInfluencer } = useCurrentRole();
  const canManage = !!role && MANAGE_ROLES.includes(role);
  // An influencer is offered Instagram and nothing else — a Connect Shopify
  // button would only produce a refusal, since the server closes those routes
  // to them.
  const providers = isInfluencer
    ? CHANNEL_PROVIDERS.filter((p) => INFLUENCER_PROVIDERS.includes(p.platform))
    : CHANNEL_PROVIDERS;

  const { data: channels, isLoading, isError, refetch } = useChannels();

  // Everything an OAuth round trip can hand back arrives as query params, since
  // the provider redirects the browser rather than returning to our code.
  useEffect(() => {
    const connected = searchParams.get("connected");
    const error = searchParams.get("error");
    const select = searchParams.get("select");
    const pending = searchParams.get("pending");
    const installShop = searchParams.get("install_shop");

    if (connected) {
      const refreshed = searchParams.get("note") === "refreshed";
      toast.success(
        refreshed
          ? "That account was already connected — its access has been refreshed."
          : connected === "shopify"
            ? "Shopify store connected — initial sync started"
            : connected === "instagram"
              ? "Instagram account connected"
              : connected === "whatsapp"
                ? "WhatsApp Business connected"
                : "Channel connected",
      );
      queryClient.invalidateQueries({ queryKey: channelKeys.all });
      // Org currency is auto-synced from the Shopify shop on connect
      queryClient.invalidateQueries({ queryKey: orgKeys.all });
      setSearchParams({}, { replace: true });
    } else if (error) {
      const platform = error.replace(/_connect_failed$/, "");
      const reason = searchParams.get("reason") ?? "connect_failed";
      const message = connectErrorMessage(platform, reason);
      // A cancelled authorization is a decision, not a fault — saying it in red
      // reads as a failure the merchant has to fix.
      if (reason === "cancelled") toast(message);
      else toast.error(message);
      setSearchParams({}, { replace: true });
    } else if (select === "instagram" && pending) {
      setInstagramPendingId(pending);
      setSearchParams({}, { replace: true });
    } else if (installShop) {
      setInstallDomain(installShop);
      setShopifyOpen(true);
      setSearchParams({}, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  /** Open the right connect flow for a provider. */
  function startConnect(provider: ChannelProvider, channelId?: string) {
    setReconnectChannelId(channelId);
    if (provider.platform === "SHOPIFY") setShopifyOpen(true);
    if (provider.platform === "INSTAGRAM") setInstagramOpen(true);
    if (provider.platform === "WHATSAPP") setWhatsappOpen(true);
  }

  function reconnect(channel: Channel) {
    setManageChannel(null);
    if (channel.platform === "SHOPIFY") {
      setInstallDomain(
        channel.externalStoreUrl?.replace(/^https?:\/\//, "") ??
        channel.account?.handle ??
        undefined,
      );
      setShopifyOpen(true);
      return;
    }
    if (channel.platform === "INSTAGRAM") {
      setReconnectChannelId(channel.id);
      setInstagramOpen(true);
      return;
    }
    if (channel.platform === "WHATSAPP") {
      setReconnectChannelId(channel.id);
      setWhatsappOpen(true);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-section text-foreground">Channels</h2>
        <p className="mt-1 text-caption text-muted-foreground">
          {isInfluencer
            ? "Connect your own Instagram account to collaborate with this organization."
            : "Connect the accounts this organization sells and talks to customers through."}
        </p>
        {isInfluencer && (
          <p className="mt-2 text-caption text-muted-foreground">
            Only the accounts you connect appear here. You can disconnect them at
            any time.
          </p>
        )}
        {!canManage && (
          <p className="mt-2 text-caption text-muted-foreground">
            Only owners and admins can connect or disconnect channels.
          </p>
        )}
      </div>

      <ChannelProviderCards
        providers={providers}
        channels={channels}
        canManage={canManage}
        onConnect={(provider) => startConnect(provider)}
      />

      {/* Error first, and deliberately so: this page's empty state invites the
          merchant to connect a channel, so rendering it on a failed request
          invited them to connect one they had already connected. */}
      {isError && !channels ? (
        <QueryErrorState resource="your channels" onRetry={() => refetch()} />
      ) : isLoading ? (
        <TableSkeleton rows={3} columns={5} />
      ) : !channels || channels.length === 0 ? (
        <EmptyState
          title="No channels connected"
          description="Connect an account above to start syncing orders and talking to customers."
        />
      ) : (
        <ConnectedAccountsTable
          channels={channels}
          canManage={canManage}
          onManage={setManageChannel}
          onReconnect={reconnect}
          onDisconnect={setDisconnectChannel}
        />
      )}

      {/* Shopify connect dialog (public-app OAuth + advanced custom-app fallback) */}
      <ShopifyConnectDialog
        open={shopifyOpen}
        onOpenChange={(open) => {
          setShopifyOpen(open);
          if (!open) {
            setInstallDomain(undefined);
            setReconnectChannelId(undefined);
          }
        }}
        initialDomain={installDomain}
      />

      <InstagramConnectDialog
        open={instagramOpen}
        onOpenChange={(open) => {
          setInstagramOpen(open);
          if (!open) setReconnectChannelId(undefined);
        }}
        reconnectChannelId={reconnectChannelId}
      />

      {/* WhatsApp Embedded Signup dialog */}
      <WhatsAppConnectDialog
        open={whatsappOpen}
        onOpenChange={(open) => {
          setWhatsappOpen(open);
          if (!open) setReconnectChannelId(undefined);
        }}
        reconnectChannelId={reconnectChannelId}
      />

      <InstagramAccountPickerDialog
        pendingId={instagramPendingId}
        onOpenChange={(open) => !open && setInstagramPendingId(null)}
        onRetry={() => {
          setInstagramPendingId(null);
          setInstagramOpen(true);
        }}
      />

      <ChannelManageDialog
        channel={manageChannel}
        canManage={canManage}
        onOpenChange={(open) => !open && setManageChannel(null)}
        onReconnect={reconnect}
        onDisconnect={(channel) => {
          setManageChannel(null);
          setDisconnectChannel(channel);
        }}
      />

      <ChannelDisconnectDialog
        channel={disconnectChannel}
        onOpenChange={(open) => !open && setDisconnectChannel(null)}
      />
    </div>
  );
}
