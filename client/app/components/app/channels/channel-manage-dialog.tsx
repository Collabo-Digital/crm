import { useEffect, useState } from "react";
import { ExternalLink, Loader2, RefreshCw } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Button } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Switch } from "~/components/ui/switch";
import { useUpdateChannelMutation } from "~/hooks/use-channel-mutations";
import { CHANNEL_LABEL } from "~/components/app/channel-badge";
import {
  CONNECTION_STATE_META,
  formatChannelDate,
} from "~/lib/channel-providers";
import { ChannelAvatar } from "./channel-account-cell";
import { cn } from "~/lib/utils";
import type { Channel } from "~/types/api";

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <span className="shrink-0 text-caption text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-caption text-foreground">{value}</span>
    </div>
  );
}

/**
 * Everything about one connected account, plus the two things a merchant can
 * change about it here: the name it shows under, and whether it is in use.
 *
 * Reconnect and Disconnect are raised to the caller — both open a flow of their
 * own (a provider dialog, a confirmation), and nesting those inside this dialog
 * would stack two modals.
 */
export function ChannelManageDialog({
  channel,
  onOpenChange,
  onReconnect,
  onDisconnect,
  canManage,
}: {
  channel: Channel | null;
  onOpenChange: (open: boolean) => void;
  onReconnect: (channel: Channel) => void;
  onDisconnect: (channel: Channel) => void;
  canManage: boolean;
}) {
  const [name, setName] = useState("");
  const update = useUpdateChannelMutation();

  useEffect(() => {
    if (channel) setName(channel.name ?? "");
  }, [channel]);

  if (!channel) return null;

  const state = CONNECTION_STATE_META[channel.connectionState];
  const account = channel.account;
  const isDisconnected = channel.connectionState === "DISCONNECTED";
  const nameChanged = name.trim() !== "" && name.trim() !== channel.name;

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            <ChannelAvatar
              platform={channel.platform}
              avatarUrl={account?.avatarUrl}
              size={36}
            />
            <span className="min-w-0 truncate">
              {account?.handle ?? channel.name ?? CHANNEL_LABEL[channel.platform]}
            </span>
            <Badge className={cn("shrink-0", state.className)}>{state.label}</Badge>
          </DialogTitle>
          <DialogDescription>
            {CHANNEL_LABEL[channel.platform]} account connected to this organization.
          </DialogDescription>
        </DialogHeader>

        {channel.lastError && (
          <p className="rounded-lg bg-danger-subtle p-3 text-caption text-danger">
            {channel.lastError}
          </p>
        )}

        <div className="divide-y divide-border rounded-lg border border-border px-3">
          <DetailRow label="Channel" value={CHANNEL_LABEL[channel.platform]} />
          {account?.displayName && (
            <DetailRow label="Account name" value={account.displayName} />
          )}
          {account?.detail && <DetailRow label="Linked to" value={account.detail} />}
          {account?.externalId && (
            <DetailRow
              label="Account ID"
              value={<span className="font-mono">{account.externalId}</span>}
            />
          )}
          <DetailRow
            label={isDisconnected ? "Disconnected" : "Connected"}
            value={formatChannelDate(
              isDisconnected ? channel.disconnectedAt : channel.connectedAt,
            )}
          />
          {channel.tokenExpiresAt && (
            <DetailRow
              label="Access expires"
              value={formatChannelDate(channel.tokenExpiresAt)}
            />
          )}
          {channel.externalStoreUrl && (
            <DetailRow
              label="Profile"
              value={
                <a
                  href={channel.externalStoreUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-brand-strong hover:underline"
                >
                  Open
                  <ExternalLink className="size-3" />
                </a>
              }
            />
          )}
        </div>

        {canManage && !isDisconnected && (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="channel-name">Display name</Label>
              <Input
                id="channel-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={account?.handle ?? "Channel name"}
              />
              <p className="text-caption text-muted-foreground">
                What this account is called across the app. Does not change anything
                on {CHANNEL_LABEL[channel.platform]}.
              </p>
            </div>

            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="text-label text-foreground">Enabled</p>
                <p className="text-caption text-muted-foreground">
                  Turn off to pause this account without disconnecting it.
                </p>
              </div>
              <Switch
                checked={channel.isEnabled}
                disabled={update.isPending}
                onCheckedChange={(checked) =>
                  update.mutate({ id: channel.id, data: { isEnabled: checked } })
                }
              />
            </div>
          </div>
        )}

        <DialogFooter className="flex-wrap">
          {canManage && (
            <>
              <Button
                variant="outline"
                onClick={() => onReconnect(channel)}
                className="mr-auto"
              >
                <RefreshCw />
                {isDisconnected ? "Reconnect" : "Re-authorize"}
              </Button>
              {!isDisconnected && (
                <Button variant="destructive" onClick={() => onDisconnect(channel)}>
                  Disconnect
                </Button>
              )}
            </>
          )}
          {nameChanged && canManage && !isDisconnected ? (
            <Button
              variant="accent"
              disabled={update.isPending}
              onClick={() =>
                update.mutate(
                  { id: channel.id, data: { name: name.trim() } },
                  { onSuccess: () => onOpenChange(false) },
                )
              }
            >
              {update.isPending && <Loader2 className="animate-spin" />}
              Save
            </Button>
          ) : (
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
