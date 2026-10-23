import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { Loader2 } from "lucide-react";

import { ChannelBadge } from "~/components/app/channel-badge";
import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { useCreateAutomationMutation } from "~/hooks/use-automation-mutations";
import { useChannels } from "~/hooks/use-channel-queries";
import { PLAYBOOKS, channelKeyOf, newStep, type Playbook } from "~/lib/automation-blocks";
import { cn } from "~/lib/utils";
import type { AutomationPlatform } from "~/types/api";

const PLATFORMS: AutomationPlatform[] = ["WHATSAPP", "INSTAGRAM", "FACEBOOK"];

/** Name it, pick the account it runs on, and start blank or from a playbook. */
export function CreateAutomationDialog({ playbook, onClose }: { playbook: Playbook | null; onClose: () => void }) {
  const navigate = useNavigate();
  const { data: channels = [] } = useChannels();
  const create = useCreateAutomationMutation();
  const usable = channels.filter(
    (c) =>
      PLATFORMS.includes(c.platform as AutomationPlatform) &&
      c.status === "CONNECTED" &&
      (!playbook || playbook.channels.includes(channelKeyOf(c.platform as AutomationPlatform))),
  );
  const [name, setName] = useState(playbook?.name ?? "");
  const [channelId, setChannelId] = useState("");
  useEffect(() => {
    if (!channelId && usable[0]) setChannelId(usable[0].id);
  }, [usable, channelId]);
  const channel = usable.find((c) => c.id === channelId);

  const submit = () => {
    if (!channel) return;
    const platform = channel.platform as AutomationPlatform;
    const key = channelKeyOf(platform);
    create.mutate(
      { name: name.trim(), platform, channelId: channel.id, steps: playbook ? playbook.steps(key) : [newStep("trigger", key)] },
      { onSuccess: (a) => navigate(`/campaigns/automations/${a.id}`) },
    );
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{playbook ? `New from “${playbook.name}”` : "New automation"}</DialogTitle>
          <DialogDescription>{playbook ? playbook.description : "Choose the account it runs on. You build the steps next; nothing runs until you publish."}</DialogDescription>
        </DialogHeader>
        <form
          id="create-automation"
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="automation-name">Name</Label>
            <Input id="automation-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="e.g. Price comments on reels" autoFocus />
          </div>
          <div className="space-y-1.5">
            <Label>Account</Label>
            {usable.length === 0 ? (
              <p className="rounded-lg border border-dashed p-3 text-caption text-muted-foreground">
                Connect a {playbook ? playbook.channels.map((c) => (c === "facebook" ? "Facebook Page" : c === "whatsapp" ? "WhatsApp number" : "Instagram account")).join(" or ") : "WhatsApp number, Instagram account or Facebook Page"} in Settings → Channels first.
              </p>
            ) : (
              <div className="space-y-1">
                {usable.map((c) => (
                  <label
                    key={c.id}
                    className={cn("flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-body", c.id === channelId ? "border-brand bg-brand/10" : "hover:bg-muted")}
                  >
                    <input type="radio" name="channel" className="sr-only" checked={c.id === channelId} onChange={() => setChannelId(c.id)} />
                    <ChannelBadge platform={c.platform} size={14} />
                    <span className="min-w-0 flex-1 truncate">{c.name}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        </form>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="create-automation" variant="accent" disabled={!name.trim() || !channel || create.isPending}>
            {create.isPending && <Loader2 className="animate-spin" />}
            Create and edit
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
