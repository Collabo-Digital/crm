import { Check, Plus } from "lucide-react";
import { Card } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { CHANNEL_ICON } from "~/components/app/channel-badge";
import {
  CHANNEL_PROVIDERS,
  activeChannelsFor,
  canConnectAnother,
  type ChannelProvider,
} from "~/lib/channel-providers";
import type { Channel } from "~/types/api";

/**
 * One card per connectable channel, rendered from the provider registry rather
 * than hardcoded per platform.
 *
 * The card is where the connection RULES become visible: WhatsApp shows its one
 * account and no Connect button once linked, while Instagram keeps offering
 * "Connect another account" however many are already on. Previously this was a
 * marketplace dialog whose Instagram tile did nothing at all when clicked.
 */
export function ChannelProviderCards({
  providers = CHANNEL_PROVIDERS,
  channels,
  canManage,
  onConnect,
}: {
  /** Which providers to offer. Defaults to all; narrowed by role at the call site. */
  providers?: ChannelProvider[];
  channels: Channel[] | undefined;
  canManage: boolean;
  onConnect: (provider: ChannelProvider) => void;
}) {
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {providers.map((provider) => {
        const Icon = CHANNEL_ICON[provider.platform];
        const active = activeChannelsFor(provider, channels);
        const canAdd = canConnectAnother(provider, channels);

        return (
          <Card
            key={provider.platform}
            className="gap-0 justify-between p-5 shadow-sm ring-border"
          >
            <div>
              <div className="flex items-center gap-3">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-surface-sunken">
                  {Icon ? (
                    <Icon key={provider.platform} width={20} height={20} />
                  ) : null}
                </span>
                <div className="min-w-0">
                  <p className="truncate text-section text-foreground">
                    {provider.label}
                  </p>
                  {active.length > 0 && (
                    <p className="text-caption text-muted-foreground">
                      {active.length} account{active.length === 1 ? "" : "s"} connected
                    </p>
                  )}
                </div>
              </div>

              <p className="mt-3 text-caption text-muted-foreground">
                {provider.description}
              </p>

              <div className="mt-3 flex flex-wrap gap-1.5">
                {provider.features.map((feature) => (
                  <span
                    key={feature}
                    className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-micro font-medium text-muted-foreground"
                  >
                    <Check className="size-3 text-brand-strong" />
                    {feature}
                  </span>
                ))}
              </div>
            </div>

            {canManage && (
              <div className="mt-5">
                {canAdd ? (
                  <Button
                    variant="accent"
                    className="w-full"
                    onClick={() => onConnect(provider)}
                  >
                    <Plus />
                    {active.length > 0
                      ? "Connect another account"
                      : `Connect ${provider.label}`}
                  </Button>
                ) : (
                  // The limit is reached, so there is nothing to offer. Saying
                  // so beats a disabled button with no explanation.
                  <p className="text-caption text-muted-foreground">
                    {provider.maxConnections === 1
                      ? "Only one account can be connected. Disconnect it below to use a different one."
                      : "Account limit reached for this organization."}
                  </p>
                )}
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
}
