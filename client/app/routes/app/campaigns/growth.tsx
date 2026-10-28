import { useEffect, useState } from "react";
import { Check, Copy, Download, Link2, Loader2, MonitorSmartphone, QrCode, Trash2 } from "lucide-react";

import { ChannelBadge } from "~/components/app/channel-badge";
import { SaveBar } from "~/components/app/save-bar";
import { SectionCard } from "~/components/app/section-card";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { PageHeader, PageHeaderContent, PageHeaderDescription, PageHeaderTitle } from "~/components/ui/page-header";
import { Skeleton } from "~/components/ui/skeleton";
import { Switch } from "~/components/ui/switch";
import { Textarea } from "~/components/ui/textarea";
import { useChannels } from "~/hooks/use-channel-queries";
import { useCurrentRole } from "~/hooks/use-current-role";
import { useArchiveGrowthLinkMutation, useCreateGrowthLinkMutation, useGrowthLinks, useSaveWidgetMutation, useSiteWidget } from "~/hooks/use-growth";
import { downloadBlob } from "~/lib/download-blob";
import { growthService } from "~/services/growth.service";
import type { GrowthLink, WidgetSettings } from "~/types/api";
import { messagingChannelWords } from "~/lib/channel-providers";
import { platformLabel } from "~/lib/labels";

export function meta() {
  return [{ title: "Links & widget | Collabo CRM" }];
}

const selectClass = "h-9 w-full rounded-md border bg-background px-2 text-sm";
const count = (n: number, word: string) => `${n.toLocaleString("en-IN")} ${word}${n === 1 ? "" : "s"}`;

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      size="xs"
      variant="ghost"
      aria-label={label}
      onClick={() => {
        void navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <Check /> : <Copy />}
    </Button>
  );
}

function QrPreview({ link, onClose }: { link: GrowthLink; onClose: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let objectUrl: string | null = null;
    void growthService.qr(link.id, "svg").then((blob) => {
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    });
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [link.id]);
  const file = (format: "svg" | "png") => `${link.name.replace(/[^\w-]+/g, "-")}-qr.${format}`;
  return (
    <div className="flex flex-wrap items-center gap-4 rounded-lg border bg-muted/40 p-3">
      {url ? <img src={url} alt={`QR code for ${link.name}`} className="size-36 rounded bg-white p-1" /> : <Skeleton className="size-36" />}
      <div className="space-y-2">
        <p className="text-caption text-muted-foreground">Scanning opens {link.shortUrl}, which counts the scan and opens the chat.</p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => void downloadBlob(() => growthService.qr(link.id, "png"), file("png"), "The QR code was not downloaded.")}>
            <Download />
            PNG for print
          </Button>
          <Button size="sm" variant="outline" onClick={() => void downloadBlob(() => growthService.qr(link.id, "svg"), file("svg"), "The QR code was not downloaded.")}>
            <Download />
            SVG
          </Button>
          <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>
        </div>
      </div>
    </div>
  );
}

function ChatLinks({ canManage }: { canManage: boolean }) {
  const { data: links, isLoading } = useGrowthLinks();
  const { data: channels = [] } = useChannels();
  const chatChannels = channels.filter((c) => ["WHATSAPP", "FACEBOOK", "INSTAGRAM"].includes(c.platform) && c.status === "CONNECTED");
  const create = useCreateGrowthLinkMutation();
  const archive = useArchiveGrowthLinkMutation();
  const [qrFor, setQrFor] = useState<string | null>(null);
  const [channelId, setChannelId] = useState("");
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [tag, setTag] = useState("");
  useEffect(() => {
    if (!channelId && chatChannels[0]) setChannelId(chatChannels[0].id);
  }, [chatChannels, channelId]);
  const chosen = chatChannels.find((c) => c.id === channelId);

  return (
    <SectionCard
      title="Chat links and QR codes"
      icon={<Link2 className="size-4 text-muted-foreground" />}
      description="Share a link or print its QR code on packaging, posters and ads. Each counts its clicks, and a WhatsApp chat it starts is tagged."
    >
      <div className="space-y-4 p-5">
        {isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : !links?.length ? (
          <p className="text-caption text-muted-foreground">No chat links yet.</p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {links.map((l) => (
              <li key={l.id} className="space-y-2 px-3 py-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <ChannelBadge platform={l.channel.platform} size={12} />
                  <span className="text-body font-medium">{l.name}</span>
                  {l.tag && <span className="rounded bg-muted px-1.5 py-0.5 text-micro text-muted-foreground">tag {l.tag}</span>}
                  <span className="ml-auto text-caption tabular-nums text-muted-foreground">
                    {count(l.clicks, "click")}{l.channel.platform === "WHATSAPP" ? ` · ${count(l.chats, "chat")}` : ""}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <code className="min-w-0 truncate rounded bg-muted px-2 py-1 text-xs">{l.shortUrl}</code>
                  <CopyButton value={l.shortUrl} label={`Copy the link for ${l.name}`} />
                  <Button size="xs" variant="ghost" onClick={() => setQrFor(qrFor === l.id ? null : l.id)}>
                    <QrCode />
                    QR code
                  </Button>
                  {canManage && !l.isWidgetButton && (
                    <Button size="xs" variant="ghost" aria-label={`Remove ${l.name}`} disabled={archive.isPending} onClick={() => window.confirm(`Remove “${l.name}”? The link and its QR code stop working.`) && archive.mutate(l.id)}>
                      <Trash2 />
                    </Button>
                  )}
                </div>
                {l.prefilledText && <p className="text-micro text-muted-foreground">Opens with: “{l.prefilledText}” and its reference {l.code}</p>}
                {qrFor === l.id && <QrPreview link={l} onClose={() => setQrFor(null)} />}
              </li>
            ))}
          </ul>
        )}

        {canManage && (chatChannels.length === 0 ? (
          <p className="text-caption text-muted-foreground">Connect {messagingChannelWords()} in Settings → Channels to make chat links.</p>
        ) : (
          <form
            className="grid gap-3 rounded-lg border border-dashed p-3 sm:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate({ channelId, name: name.trim(), prefilledText: text.trim() || undefined, tag: tag.trim() || undefined }, {
                onSuccess: () => {
                  setName("");
                  setText("");
                  setTag("");
                },
              });
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="gl-channel">Opens a chat on</Label>
              <select id="gl-channel" className={selectClass} value={channelId} onChange={(e) => setChannelId(e.target.value)}>
                {chatChannels.map((c) => <option key={c.id} value={c.id}>{c.name} · {platformLabel(c.platform)}</option>)}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="gl-name">Name</Label>
              <Input id="gl-name" placeholder="Diwali poster" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            {chosen?.platform === "WHATSAPP" && (
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="gl-text">The message it starts with</Label>
                <Textarea id="gl-text" rows={2} maxLength={500} placeholder="Hi! I saw your Diwali offer." value={text} onChange={(e) => setText(e.target.value)} />
                <p className="text-micro text-muted-foreground">Its reference is added at the end, so the chat is tagged and counted.</p>
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="gl-tag">Tag the contact</Label>
              <Input id="gl-tag" placeholder="diwali-poster" maxLength={60} value={tag} onChange={(e) => setTag(e.target.value)} disabled={chosen?.platform !== "WHATSAPP"} />
            </div>
            <div className="flex items-end">
              <Button type="submit" size="sm" disabled={create.isPending || name.trim().length < 2 || !channelId}>
                {create.isPending && <Loader2 className="animate-spin" />}
                Create link
              </Button>
            </div>
          </form>
        ))}
      </div>
    </SectionCard>
  );
}

function Field({ id, label, children, hint }: { id: string; label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <p className="text-micro text-muted-foreground">{hint}</p>}
    </div>
  );
}

function WebsiteWidget({ canManage }: { canManage: boolean }) {
  const { data, isLoading } = useSiteWidget();
  const { data: channels = [] } = useChannels();
  const numbers = channels.filter((c) => c.platform === "WHATSAPP" && c.status === "CONNECTED");
  const save = useSaveWidgetMutation();
  const [settings, setSettings] = useState<WidgetSettings | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [channelId, setChannelId] = useState("");
  const [domains, setDomains] = useState("");
  const savedChannelId = data?.channelId ?? numbers[0]?.id ?? "";
  function reset() {
    if (!data) return;
    setSettings(data.settings);
    setEnabled(data.enabled);
    setChannelId(savedChannelId);
    setDomains(data.allowedDomains.join(", "));
  }
  useEffect(() => {
    reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  if (isLoading || !data || !settings) return <Skeleton className="h-96 w-full rounded-xl" />;
  const dirty =
    enabled !== data.enabled ||
    channelId !== savedChannelId ||
    domains !== data.allowedDomains.join(", ") ||
    JSON.stringify(settings) !== JSON.stringify(data.settings);
  const b = settings.button;
  const p = settings.popup;
  const setButton = (patch: Partial<WidgetSettings["button"]>) => setSettings({ ...settings, button: { ...b, ...patch } });
  const setPopup = (patch: Partial<WidgetSettings["popup"]>) => setSettings({ ...settings, popup: { ...p, ...patch } });
  const snippet = data.scriptUrl ? `<script src="${data.scriptUrl}" async></script>` : null;
  const ro = !canManage;

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!dirty || !channelId) return;
        save.mutate({ channelId, enabled, settings, allowedDomains: domains.split(",").map((d) => d.trim()).filter(Boolean) });
      }}
    >
    <SectionCard
      title="Website chat button and pop-up"
      icon={<MonitorSmartphone className="size-4 text-muted-foreground" />}
      description="A WhatsApp button for your website, and a pop-up that collects numbers with the visitor’s consent. Paste the script once; changes here apply within five minutes."
    >
      <div className="space-y-5 p-5">
        <div className="flex flex-wrap gap-6">
          {([["Button clicks", data.stats.clicks], ["Chats started", data.stats.chats], ["Pop-up shown", data.stats.popupViews], ["Sign-ups", data.stats.signups]] as const).map(([label, n]) => (
            <div key={label}>
              <p className="text-caption text-muted-foreground">{label}</p>
              <p className="text-section font-semibold tabular-nums">{n.toLocaleString("en-IN")}</p>
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
          <Label htmlFor="w-on" className="flex flex-col items-start gap-0.5 font-normal">
            <span className="text-body font-medium">Show on my website</span>
            <span className="text-micro text-muted-foreground">Off: the script does nothing, wherever it is pasted.</span>
          </Label>
          <Switch id="w-on" checked={enabled} disabled={ro} onCheckedChange={setEnabled} />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="w-number" label="WhatsApp number">
            <select id="w-number" className={selectClass} value={channelId} disabled={ro} onChange={(e) => setChannelId(e.target.value)}>
              {numbers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <Field id="w-label" label="Button text" hint="Phones show the icon only.">
            <Input id="w-label" maxLength={40} value={b.label} disabled={ro} onChange={(e) => setButton({ label: e.target.value })} />
          </Field>
          <Field id="w-color" label="Colour">
            <div className="flex items-center gap-2">
              <input type="color" aria-label="Pick a colour" value={b.color} disabled={ro} onChange={(e) => setButton({ color: e.target.value })} className="h-9 w-12 rounded border" />
              <Input id="w-color" maxLength={7} value={b.color} disabled={ro} onChange={(e) => setButton({ color: e.target.value })} />
            </div>
          </Field>
          <Field id="w-pos" label="Corner">
            <select id="w-pos" className={selectClass} value={b.position} disabled={ro} onChange={(e) => setButton({ position: e.target.value as "left" | "right" })}>
              <option value="right">Bottom right</option>
              <option value="left">Bottom left</option>
            </select>
          </Field>
          <Field id="w-greet" label="Greeting bubble" hint="Shown after a few seconds; leave empty for none.">
            <Input id="w-greet" maxLength={160} value={b.greeting} disabled={ro} onChange={(e) => setButton({ greeting: e.target.value })} />
          </Field>
          <Field id="w-prefill" label="The message a chat starts with">
            <Input id="w-prefill" maxLength={500} value={b.prefilledText} disabled={ro} onChange={(e) => setButton({ prefilledText: e.target.value })} />
          </Field>
        </div>

        <div className="space-y-4 rounded-lg border p-3">
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="w-popup" className="flex flex-col items-start gap-0.5 font-normal">
              <span className="text-body font-medium">Number-capture pop-up</span>
              <span className="text-micro text-muted-foreground">Once a week per visitor. Each sign-up is opted in with your consent text, tagged, and starts “Someone signs up on your website” automations, once it is confirmed on WhatsApp if you ask for that below.</span>
            </Label>
            <Switch id="w-popup" checked={p.enabled} disabled={ro} onCheckedChange={(v) => setPopup({ enabled: v })} />
          </div>
          {p.enabled && (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex items-center justify-between gap-4 sm:col-span-2">
                <Label htmlFor="p-confirm" className="flex flex-col items-start gap-0.5 font-normal">
                  <span className="text-body font-medium">Ask people to confirm on WhatsApp</span>
                  <span className="text-micro text-muted-foreground">Recommended. After signing up, people send a short code to your WhatsApp number, and only then are they opted in. Without it, anyone can type someone else’s number, and WhatsApp may restrict your number if people report messages they didn’t ask for.</span>
                </Label>
                <Switch id="p-confirm" checked={p.confirmOnWhatsApp} disabled={ro} onCheckedChange={(v) => setPopup({ confirmOnWhatsApp: v })} />
              </div>
              <Field id="p-title" label="Title">
                <Input id="p-title" maxLength={80} value={p.title} disabled={ro} onChange={(e) => setPopup({ title: e.target.value })} />
              </Field>
              <Field id="p-button" label="Button">
                <Input id="p-button" maxLength={30} value={p.buttonLabel} disabled={ro} onChange={(e) => setPopup({ buttonLabel: e.target.value })} />
              </Field>
              <div className="sm:col-span-2">
                <Field id="p-text" label="Text">
                  <Textarea id="p-text" rows={2} maxLength={300} value={p.text} disabled={ro} onChange={(e) => setPopup({ text: e.target.value })} />
                </Field>
              </div>
              <div className="sm:col-span-2">
                <Field id="p-consent" label="Consent checkbox" hint="The visitor must tick this. Name your business and say what you will send.">
                  <Textarea id="p-consent" rows={2} maxLength={300} value={p.consentText} disabled={ro} onChange={(e) => setPopup({ consentText: e.target.value })} />
                </Field>
              </div>
              <Field id="p-success" label="After signing up" hint={p.confirmOnWhatsApp ? "Shown only while “Ask people to confirm on WhatsApp” is off." : undefined}>
                <Input id="p-success" maxLength={200} value={p.successText} disabled={ro} onChange={(e) => setPopup({ successText: e.target.value })} />
              </Field>
              <Field id="p-tag" label="Tag sign-ups">
                <Input id="p-tag" maxLength={60} value={p.tag} disabled={ro} onChange={(e) => setPopup({ tag: e.target.value })} />
              </Field>
              <Field id="p-delay" label="Show after (seconds)">
                <Input id="p-delay" type="number" min={0} max={300} value={p.delaySeconds} disabled={ro} onChange={(e) => setPopup({ delaySeconds: Math.max(0, Math.min(300, Number(e.target.value) || 0)) })} />
              </Field>
              <Field id="p-cc" label="Country code">
                <Input id="p-cc" maxLength={3} value={p.defaultCountryCode} disabled={ro} onChange={(e) => setPopup({ defaultCountryCode: e.target.value.replace(/\D/g, "") })} />
              </Field>
            </div>
          )}
        </div>

        <Field id="w-domains" label="Your website" hint="Comma-separated, e.g. shop.example.com. The pop-up accepts sign-ups from these sites (and their subdomains) only.">
          <Input id="w-domains" value={domains} disabled={ro} placeholder="shop.example.com" onChange={(e) => setDomains(e.target.value)} />
        </Field>

        {snippet && (
          <div className="space-y-1.5">
            <p className="text-caption font-medium">Paste this before &lt;/body&gt; on every page, or in Shopify: Online Store → Themes → Edit code → theme.liquid.</p>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-1.5 text-xs">{snippet}</code>
              <CopyButton value={snippet} label="Copy the script tag" />
            </div>
          </div>
        )}
      </div>
    </SectionCard>
    {canManage && <SaveBar dirty={dirty} saving={save.isPending} invalid={!channelId} onDiscard={reset} what="the website widget" />}
    </form>
  );
}

/** Campaigns → Links & widget: ways to start chats from outside the inbox. */
export default function GrowthPage() {
  const { can } = useCurrentRole();
  const canManage = can("campaigns.manage");
  return (
    <div className="space-y-6">
      <PageHeader>
        <PageHeaderContent>
          <PageHeaderTitle>Links & widget</PageHeaderTitle>
          <PageHeaderDescription>Start more chats: links and QR codes for anywhere, and a WhatsApp button and sign-up pop-up for your website.</PageHeaderDescription>
        </PageHeaderContent>
      </PageHeader>
      <ChatLinks canManage={canManage} />
      <WebsiteWidget canManage={canManage} />
    </div>
  );
}
