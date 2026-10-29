import { Loader2, Phone } from "lucide-react";

import { SectionCard } from "~/components/app/section-card";
import { Switch } from "~/components/ui/switch";
import { useCallSettings, useSaveCallSettings } from "~/hooks/use-calls";
import { useChannels } from "~/hooks/use-channel-queries";
import type { Channel } from "~/types/api";

function NumberCalling({ channel }: { channel: Channel }) {
  const { data, isLoading, isError } = useCallSettings(channel.id, true);
  const save = useSaveCallSettings(channel.id);
  if (isLoading) return <Loader2 className="m-5 size-4 animate-spin text-muted-foreground" />;
  if (isError || !data) return <p className="px-5 py-3 text-caption text-muted-foreground">{channel.name}: the calling settings could not be read from WhatsApp.</p>;
  if (!data.available) return <p className="px-5 py-3 text-caption text-muted-foreground">{channel.name}: {data.reason}</p>;
  const toggle = (patch: Partial<typeof data>) =>
    save.mutate({ enabled: data.enabled, showCallButton: data.showCallButton, callbackPermission: data.callbackPermission, ...patch });
  const rows: Array<[keyof typeof data & ("enabled" | "showCallButton" | "callbackPermission"), string, string]> = [
    ["enabled", "Take WhatsApp calls", "Calls ring in the browser for the whole team; the first to answer takes it."],
    ["showCallButton", "Show the call button in chats", "Off hides it; people you ask can still allow calls."],
    ["callbackPermission", "Calling in lets you call back", "Someone who calls the business allows calls back for a while."],
  ];
  return (
    <div className="space-y-3 px-5 py-4">
      <p className="text-body font-medium">{channel.name}</p>
      {rows.map(([key, label, hint]) => (
        <label key={key} className="flex items-start justify-between gap-4">
          <span className="min-w-0">
            <span className="block text-caption font-medium">{label}</span>
            <span className="block text-micro text-muted-foreground">{hint}</span>
          </span>
          <Switch
            checked={data[key]}
            disabled={save.isPending || (key !== "enabled" && !data.enabled)}
            onCheckedChange={(checked) => toggle({ [key]: checked })}
            aria-label={`${label} on ${channel.name}`}
          />
        </label>
      ))}
    </div>
  );
}

/** WhatsApp calling per number (Meta's call settings), for owners and admins. */
export function CallingCard() {
  const { data: channels = [] } = useChannels();
  const numbers = channels.filter((c) => c.platform === "WHATSAPP" && c.status === "CONNECTED");
  if (!numbers.length) return null;
  return (
    <SectionCard
      title="WhatsApp calls"
      icon={<Phone className="size-4 text-muted-foreground" />}
      description="Voice calls in the browser, through WhatsApp. Calls from customers are free; calling them needs their permission and is billed by Meta. Your number needs a messaging limit of at least 2,000."
    >
      <div className="divide-y">
        {numbers.map((c) => (
          <NumberCalling key={c.id} channel={c} />
        ))}
      </div>
    </SectionCard>
  );
}
