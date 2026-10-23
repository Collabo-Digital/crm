import { Loader2, RefreshCw } from "lucide-react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { SectionCard } from "~/components/app/section-card";
import { ChannelSyncOptions } from "~/components/app/channel-sync-options";
import { CHANNEL_LABEL, CHANNEL_ICON } from "~/components/app/channel-badge";
import { useTriggerSyncMutation } from "~/hooks/use-channel-mutations";
import {
  CONNECTION_STATE_META,
  formatChannelDate,
  isActiveChannel,
} from "~/lib/channel-providers";
import { ChannelAccountCell } from "./channel-account-cell";
import { cn } from "~/lib/utils";
import type { Channel } from "~/types/api";

/**
 * The moment the outbound rate limiter's cooldown on this channel ends, or
 * null when there is none. A past value is stale (the breaker expired on its
 * own), not an error, so it is only surfaced while still in the future.
 */
function rateLimitedUntil(channel: Channel): Date | null {
  if (!channel.rateLimitedUntil) return null;
  const at = new Date(channel.rateLimitedUntil);
  return at.getTime() > Date.now() ? at : null;
}

/** Everything the sync queue knows how to pull for a Shopify store. */
const SYNC_ENTITY_TYPES = [
  "locations",
  "products",
  "orders",
  "customers",
  "inventory",
  "collections",
];

/**
 * Every channel connection the org holds, live or historical.
 *
 * Disconnected rows stay listed rather than vanishing: they carry the orders and
 * message logs of the account they were, so hiding them would make a merchant
 * think that history had gone too. They read muted, with Reconnect as the only
 * action.
 */
export function ConnectedAccountsTable({
  channels,
  canManage,
  onManage,
  onReconnect,
  onDisconnect,
}: {
  channels: Channel[];
  canManage: boolean;
  onManage: (channel: Channel) => void;
  onReconnect: (channel: Channel) => void;
  onDisconnect: (channel: Channel) => void;
}) {
  const triggerSync = useTriggerSyncMutation();

  // Active first, then newest. Sorting on the enum would be meaningless, and a
  // disconnected row jumping to the top of the list reads as an alert.
  const rows = [...channels].sort((a, b) => {
    const activeDiff = Number(isActiveChannel(b)) - Number(isActiveChannel(a));
    if (activeDiff !== 0) return activeDiff;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

  return (
    <SectionCard
      title="Connected accounts"
      description="Every account this organization has linked."
    >
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Channel</TableHead>
              <TableHead>Account</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Connected</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((channel) => {
              const state = CONNECTION_STATE_META[channel.connectionState];
              const disconnected = !isActiveChannel(channel);
              const Icon = CHANNEL_ICON[channel.platform];
              const isSyncable =
                channel.platform === "SHOPIFY" || channel.platform === "MANUAL";
              const isSyncing = channel.syncStatus === "IN_PROGRESS";

              return (
                <TableRow
                  key={channel.id}
                  className={cn(disconnected && "text-muted-foreground")}
                >
                  <TableCell>
                    <span className="flex items-center gap-2 text-body">
                      {Icon ? (
                        <Icon key={channel.id} width={16} height={16} />
                      ) : null}
                      {CHANNEL_LABEL[channel.platform]}
                    </span>
                  </TableCell>

                  <TableCell className="max-w-64">
                    <ChannelAccountCell channel={channel} />
                  </TableCell>

                  <TableCell>
                    <Badge className={state.className}>{state.label}</Badge>
                    {channel.lastError && (
                      <p className="mt-1 max-w-56 text-caption text-danger">
                        {channel.lastError}
                      </p>
                    )}
                    {rateLimitedUntil(channel) && (
                      <p
                        className="mt-1 max-w-56 text-caption text-muted-foreground"
                        title={channel.rateLimitReason ?? undefined}
                      >
                        Rate limited by the store until{" "}
                        {rateLimitedUntil(channel)!.toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                        . Syncs and pushes resume automatically.
                      </p>
                    )}
                  </TableCell>

                  <TableCell className="text-caption">
                    {disconnected
                      ? channel.disconnectedAt
                        ? `Disconnected ${formatChannelDate(channel.disconnectedAt)}`
                        : "—"
                      : formatChannelDate(channel.connectedAt)}
                  </TableCell>

                  <TableCell>
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      {/* Shopify and Manual keep the sync affordances they had —
                          Instagram and WhatsApp have no push/pull semantics on
                          this queue and the server rejects a sync for them. */}
                      {isSyncable && !disconnected && (
                        <>
                          <ChannelSyncOptions channel={channel} />
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={triggerSync.isPending || isSyncing}
                            title={
                              channel.platform === "MANUAL"
                                ? "Push every CRM-created product, offline order and draft to your connected Shopify store."
                                : "Pull latest data from Shopify and push any unsynced local items."
                            }
                            onClick={() =>
                              triggerSync.mutate({
                                id: channel.id,
                                data: { entityTypes: SYNC_ENTITY_TYPES },
                              })
                            }
                          >
                            {isSyncing || triggerSync.isPending ? (
                              <Loader2 className="animate-spin" />
                            ) : (
                              <RefreshCw />
                            )}
                            {isSyncing
                              ? "Syncing"
                              : channel.platform === "MANUAL"
                                ? "Push"
                                : "Sync"}
                          </Button>
                        </>
                      )}

                      {canManage && channel.platform !== "MANUAL" && (
                        <>
                          {(disconnected ||
                            channel.connectionState === "ERROR" ||
                            channel.connectionState === "EXPIRED") && (
                              <Button
                                variant="accent"
                                size="sm"
                                onClick={() => onReconnect(channel)}
                              >
                                <RefreshCw />
                                Reconnect
                              </Button>
                            )}
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => onManage(channel)}
                          >
                            Manage
                          </Button>
                          {!disconnected && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-danger hover:text-danger"
                              onClick={() => onDisconnect(channel)}
                            >
                              Disconnect
                            </Button>
                          )}
                        </>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </SectionCard>
  );
}
