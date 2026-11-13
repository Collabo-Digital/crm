import { useEffect, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, CircleAlert, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { CHANNEL_ICON, CHANNEL_LABEL } from "~/components/app/channel-badge";
import { InstagramAccountPickerDialog } from "~/components/app/channels/instagram-account-picker-dialog";
import { InstagramConnectDialog } from "~/components/app/channels/instagram-connect-dialog";
import { MessengerConnectDialog } from "~/components/app/channels/messenger-connect-dialog";
import { StepFrame } from "~/components/app/onboarding/step-frame";
import { QueryErrorState } from "~/components/app/query-error-state";
import { ShopifyConnectDialog } from "~/components/app/shopify-connect-dialog";
import { ShopifyLocationsDialog } from "~/components/app/shopify-locations-dialog";
import { WhatsAppConnectDialog } from "~/components/app/whatsapp-connect-dialog";
import { Button } from "~/components/ui/button";
import { StatusBadge } from "~/components/ui/status-badge";
import { channelKeys, useChannels, usePendingShopifyLocations } from "~/hooks/use-channel-queries";
import { useWizardStep } from "~/hooks/use-onboarding";
import { orgKeys } from "~/hooks/use-org-queries";
import {
  activeChannelsFor,
  canConnectAnother,
  CHANNEL_PROVIDERS,
  connectErrorMessage,
  CONNECTION_STATE_META,
  type ChannelProvider,
} from "~/lib/channel-providers";
import { forgetConnectFromSetup, rememberConnectFromSetup } from "~/lib/return-path";
import type { StatusTone } from "~/lib/status-tone";
import type { Channel, ChannelPlatform } from "~/types/api";

export function meta() {
  return [{ title: "Connect where you sell | Collabo CRM" }];
}

/** The platform behind the slug an OAuth callback comes back with (`?connected=shopify`, `?error=instagram_connect_failed`). */
const PLATFORM_BY_SLUG: Record<string, ChannelPlatform> = {
  shopify: "SHOPIFY",
  instagram: "INSTAGRAM",
  whatsapp: "WHATSAPP",
  messenger: "FACEBOOK",
};

const MANUAL_ORDER_FEATURES = ["Draft orders", "COD and UPI", "GST invoices"];

function Chips({ items }: { items: string[] }) {
  return (
    <ul className="mt-3 flex flex-wrap gap-1.5">
      {items.map((item) => (
        <li key={item} className="rounded-full bg-muted px-2.5 py-1 text-micro font-medium text-muted-foreground">
          {item}
        </li>
      ))}
    </ul>
  );
}

function ChannelCard({
  platform,
  label,
  description,
  status,
  tone,
  footer,
  children,
}: {
  platform: ChannelPlatform;
  label: string;
  description: string;
  status: string;
  tone: StatusTone;
  footer?: ReactNode;
  children?: ReactNode;
}) {
  const Icon = CHANNEL_ICON[platform];
  return (
    <article className="flex flex-col rounded-xl bg-card shadow-sm ring-1 ring-border">
      <div className="flex-1 p-5">
        <div className="flex items-center gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-surface-sunken">
            {/* Keyed so each card gets its own SVG: the Instagram mark's gradient ids are not namespaced. */}
            {Icon ? <Icon key={platform} width={20} height={20} /> : null}
          </span>
          <h2 className="min-w-0 flex-1 truncate text-section">{label}</h2>
          <StatusBadge tone={tone} dot>
            {status}
          </StatusBadge>
        </div>
        <p className="mt-3 text-body text-muted-foreground">{description}</p>
        {children}
      </div>
      {footer && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>}
    </article>
  );
}

/**
 * Setup step 4, team workspaces only: connect the store and the messaging
 * accounts. Optional, and the same connections as Settings › Channels: the
 * cards show the workspace's real channels, and connecting opens the same
 * dialogs. Shopify and Instagram leave the app to sign in and return through
 * Settings › Channels, which sends the result back here.
 */
export default function ChannelsStepPage() {
  const step = useWizardStep("channels");
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: channels, isLoading, isError, refetch } = useChannels();
  const storesWithUnlinkedLocations = usePendingShopifyLocations();

  const [connecting, setConnecting] = useState<ChannelPlatform | null>(null);
  /** Set when a dialog is re-authorizing an existing account rather than adding one. */
  const [reconnectChannelId, setReconnectChannelId] = useState<string | undefined>();
  const [shopDomain, setShopDomain] = useState<string | undefined>();
  /** The Shopify store whose locations are being linked. */
  const [linkingChannelId, setLinkingChannelId] = useState<string | null>(null);
  const [instagramPendingId, setInstagramPendingId] = useState<string | null>(null);
  /** Why the last attempt failed, shown on that provider's card until it is tried again. */
  const [connectErrors, setConnectErrors] = useState<Partial<Record<ChannelPlatform, string>>>({});

  // Moving on without the connection: a result that arrives later belongs to Settings.
  useEffect(() => forgetConnectFromSetup, []);

  // Everything a sign-in at Shopify or Instagram hands back arrives as query params.
  useEffect(() => {
    const connected = searchParams.get("connected");
    const error = searchParams.get("error");
    const pendingInstagram = searchParams.get("select") === "instagram" ? searchParams.get("pending") : null;
    if (!connected && !error && !pendingInstagram) return;
    // The result is here now, so Settings › Channels has nothing left to send back.
    forgetConnectFromSetup();

    if (connected) {
      const platform = PLATFORM_BY_SLUG[connected];
      const channelId = searchParams.get("channelId");
      toast.success(
        searchParams.get("note") === "refreshed"
          ? "That account was already connected. Its access has been refreshed."
          : `${platform ? CHANNEL_LABEL[platform] : "Channel"} connected`,
      );
      void queryClient.invalidateQueries({ queryKey: channelKeys.all });
      // The workspace's currency follows the Shopify store's.
      void queryClient.invalidateQueries({ queryKey: orgKeys.all });
      // Nothing syncs for a Shopify location until the owner says what it does.
      if (connected === "shopify" && searchParams.get("locations") === "pending" && channelId) {
        setLinkingChannelId(channelId);
      }
    } else if (error) {
      const slug = error.replace(/_connect_failed$/, "");
      const reason = searchParams.get("reason") ?? "connect_failed";
      const platform = PLATFORM_BY_SLUG[slug];
      const message = connectErrorMessage(slug, reason);
      // Cancelling is a decision, not a fault to show in red on the card.
      if (reason === "cancelled" || !platform) toast(message);
      else setConnectErrors((current) => ({ ...current, [platform]: message }));
    } else {
      setInstagramPendingId(pendingInstagram);
    }
    setSearchParams({}, { replace: true });
  }, [searchParams, setSearchParams, queryClient]);

  function startConnect(provider: ChannelProvider, channel?: Channel) {
    setConnectErrors(({ [provider.platform]: _tried, ...others }) => others);
    // Shopify re-authorizes by store address; Messenger re-shares every Page in one go.
    setReconnectChannelId(provider.platform === "INSTAGRAM" || provider.platform === "WHATSAPP" ? channel?.id : undefined);
    setShopDomain(
      provider.platform === "SHOPIFY" && channel
        ? (channel.externalStoreUrl?.replace(/^https?:\/\//, "") ?? channel.account?.handle ?? undefined)
        : undefined,
    );
    // These two leave the app; the others finish in a popup on this page.
    if (provider.connect === "redirect" || provider.connect === "dialog") rememberConnectFromSetup();
    setConnecting(provider.platform);
  }

  function closeDialog(open: boolean) {
    if (open) return;
    setConnecting(null);
    setReconnectChannelId(undefined);
    setShopDomain(undefined);
  }

  const connectedCount = CHANNEL_PROVIDERS.filter((provider) =>
    activeChannelsFor(provider, channels).some((channel) => channel.connectionState === "CONNECTED"),
  ).length;
  const busy = step.isCompleting || step.isLeaving;

  return (
    <StepFrame
      title="Connect where you sell"
      description="Bring orders and customer chats into Collabo. Connect any now, or later from Settings › Channels."
      status="Progress saved"
      exit={
        <Button variant="outline" disabled={busy} onClick={() => void step.exit()}>
          {step.isLeaving && <Loader2 className="animate-spin" aria-hidden />}
          Save & exit
        </Button>
      }
      footer={
        <>
          <Button variant="ghost" asChild>
            <Link to={step.previousPath ?? "/onboarding"}>
              <ArrowLeft aria-hidden />
              Previous
            </Link>
          </Button>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {connectedCount === 0 && (
              <Button variant="ghost" disabled={busy} onClick={() => void step.complete()}>
                Skip for now
              </Button>
            )}
            <Button size="lg" className="h-11 px-5" disabled={busy} onClick={() => void step.complete()}>
              {step.isCompleting && <Loader2 className="animate-spin" aria-hidden />}
              Continue
              {!step.isCompleting && <ArrowRight aria-hidden />}
            </Button>
          </div>
        </>
      }
    >
      {isError && !channels ? (
        <QueryErrorState resource="your channels" onRetry={() => void refetch()} />
      ) : isLoading ? (
        <div className="flex min-h-40 items-center justify-center">
          <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label="Loading your channels" />
        </div>
      ) : (
        <>
          <p className="text-right text-body font-medium">
            {connectedCount} of {CHANNEL_PROVIDERS.length} connected
          </p>

          <div className="grid gap-4 md:grid-cols-2">
            {CHANNEL_PROVIDERS.map((provider) => {
              const accounts = activeChannelsFor(provider, channels);
              const broken = accounts.find((channel) => channel.connectionState !== "CONNECTED");
              const error = connectErrors[provider.platform];
              const canAdd = canConnectAnother(provider, channels);
              const needsLocations = accounts.find((channel) =>
                storesWithUnlinkedLocations.some((store) => store.id === channel.id),
              );
              const [status, tone]: [string, StatusTone] = broken
                ? [CONNECTION_STATE_META[broken.connectionState].label, broken.connectionState === "EXPIRED" ? "attention" : "critical"]
                : accounts.length > 0
                  ? ["Connected", "success"]
                  : error
                    ? ["Couldn't connect", "critical"]
                    : ["Not connected", "neutral"];

              return (
                <ChannelCard
                  key={provider.platform}
                  platform={provider.platform}
                  label={provider.label}
                  description={provider.description}
                  status={status}
                  tone={tone}
                  footer={
                    (needsLocations || canAdd) && (
                      <>
                        {needsLocations && (
                          <Button variant="outline" onClick={() => setLinkingChannelId(needsLocations.id)}>
                            Link locations
                          </Button>
                        )}
                        {canAdd && (
                          <Button variant="outline" onClick={() => startConnect(provider)}>
                            {error ? "Try again" : accounts.length > 0 ? "Connect another" : "Connect"}
                          </Button>
                        )}
                      </>
                    )
                  }
                >
                  {accounts.length > 0 ? (
                    <ul className="mt-3 space-y-2">
                      {accounts.map((channel) => (
                        <li key={channel.id} className="rounded-lg bg-surface-sunken px-3 py-2">
                          <div className="flex items-center justify-between gap-3">
                            <p className="min-w-0 truncate text-body font-medium">{channel.account?.handle ?? channel.name}</p>
                            {channel.connectionState !== "CONNECTED" && (
                              <Button variant="outline" size="sm" onClick={() => startConnect(provider, channel)}>
                                Reconnect
                              </Button>
                            )}
                          </div>
                          {channel.connectionState !== "CONNECTED" ? (
                            <p className="mt-1 text-caption text-danger-text">
                              {channel.lastError ?? "This connection has stopped working. Reconnect it to carry on."}
                            </p>
                          ) : (
                            channel.platform === "SHOPIFY" &&
                            channel.syncStatus === "IN_PROGRESS" && (
                              <p className="mt-1 flex items-center gap-1.5 text-caption text-muted-foreground">
                                <Loader2 className="size-3 animate-spin" aria-hidden />
                                Importing products and orders…
                              </p>
                            )
                          )}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <Chips items={provider.features} />
                  )}
                  {needsLocations && (
                    <p className="mt-3 text-caption text-warning-text">
                      Some store locations aren't linked yet, so their stock doesn't sync.
                    </p>
                  )}
                  {error && (
                    <p role="alert" className="mt-3 flex items-start gap-2 rounded-lg bg-danger-subtle px-3 py-2 text-body text-danger-text">
                      <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                      {error}
                    </p>
                  )}
                </ChannelCard>
              );
            })}

            <ChannelCard
              platform="MANUAL"
              label="Manual orders"
              description="Record phone, walk-in and COD orders by hand, with stock and invoices kept in step."
              status="Always on"
              tone="success"
            >
              <Chips items={MANUAL_ORDER_FEATURES} />
            </ChannelCard>
          </div>
        </>
      )}

      <ShopifyConnectDialog
        open={connecting === "SHOPIFY"}
        onOpenChange={closeDialog}
        initialDomain={shopDomain}
        onConnected={setLinkingChannelId}
      />
      <ShopifyLocationsDialog channelId={linkingChannelId} onOpenChange={(open) => !open && setLinkingChannelId(null)} />
      <InstagramConnectDialog
        open={connecting === "INSTAGRAM"}
        onOpenChange={closeDialog}
        reconnectChannelId={reconnectChannelId}
        onUseFacebook={() => setConnecting("FACEBOOK")}
      />
      <MessengerConnectDialog open={connecting === "FACEBOOK"} onOpenChange={closeDialog} />
      <WhatsAppConnectDialog
        open={connecting === "WHATSAPP"}
        onOpenChange={closeDialog}
        reconnectChannelId={reconnectChannelId}
      />
      <InstagramAccountPickerDialog
        pendingId={instagramPendingId}
        onOpenChange={(open) => !open && setInstagramPendingId(null)}
        onRetry={() => {
          setInstagramPendingId(null);
          const instagram = CHANNEL_PROVIDERS.find((provider) => provider.platform === "INSTAGRAM");
          if (instagram) startConnect(instagram);
        }}
      />
    </StepFrame>
  );
}
