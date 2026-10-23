import { useEffect, useState } from "react";
import { Link } from "react-router";
import { ArrowLeft, Loader2, Plus, Trash2 } from "lucide-react";

import { ChannelBadge } from "~/components/app/channel-badge";
import { SectionCard } from "~/components/app/section-card";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { PageHeader, PageHeaderContent, PageHeaderDescription, PageHeaderTitle } from "~/components/ui/page-header";
import { Skeleton } from "~/components/ui/skeleton";
import { useSaveStartersMutation } from "~/hooks/use-automation-mutations";
import { useConversationStarters } from "~/hooks/use-automation-queries";
import { useChannels } from "~/hooks/use-channel-queries";
import { useCurrentRole } from "~/hooks/use-current-role";
import { canEditAutomations } from "~/lib/permissions";
import { formatDateTime } from "~/lib/format-date";
import { cn } from "~/lib/utils";
import type { ConversationStarters } from "~/types/api";

export function meta() {
  return [{ title: "Conversation starters | Collabo CRM" }];
}

type Draft = Omit<ConversationStarters, "platform" | "pushedAt">;
const EMPTY: Draft = { getStarted: { enabled: false, payload: "GET_STARTED" }, iceBreakers: [], persistentMenu: [] };
const payloadOf = (text: string) => text.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "OPTION";

/**
 * What a Facebook Page or Instagram account offers before anyone types:
 * questions to tap, the Get Started button and a menu. A tap arrives as a
 * button tap (postback) that an automation can answer.
 */
export default function ConversationStartersPage() {
  const { data: channels = [] } = useChannels();
  const usable = channels.filter((c) => (c.platform === "FACEBOOK" || c.platform === "INSTAGRAM") && c.status === "CONNECTED");
  const [channelId, setChannelId] = useState("");
  useEffect(() => {
    if (!channelId && usable[0]) setChannelId(usable[0].id);
  }, [usable, channelId]);
  const { data, isLoading } = useConversationStarters(channelId || undefined);
  const save = useSaveStartersMutation();
  const { role, permissions } = useCurrentRole();
  const readOnly = !canEditAutomations(role, permissions);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  useEffect(() => {
    if (data) setDraft({ getStarted: data.getStarted, iceBreakers: data.iceBreakers, persistentMenu: data.persistentMenu });
  }, [data]);
  const facebook = data?.platform === "FACEBOOK";
  const menuNeedsStart = facebook && draft.persistentMenu.length > 0 && !draft.getStarted.enabled;

  return (
    <div className="space-y-6">
      <Link to="/campaigns/automations" className="inline-flex items-center gap-1 text-caption text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-3.5" />
        Automations
      </Link>
      <PageHeader>
        <PageHeaderContent>
          <PageHeaderTitle>Conversation starters</PageHeaderTitle>
          <PageHeaderDescription>
            Questions people can tap when they open a chat, and a menu that stays in it. Each tap sends its payload, which a “taps an ice breaker or menu item” automation can answer.
          </PageHeaderDescription>
        </PageHeaderContent>
      </PageHeader>

      {usable.length === 0 ? (
        <p className="rounded-xl border border-dashed p-6 text-center text-caption text-muted-foreground">Connect a Facebook Page or an Instagram account in Settings → Channels first.</p>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {usable.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setChannelId(c.id)}
                className={cn("flex items-center gap-2 rounded-full border px-3 py-1.5 text-caption", c.id === channelId ? "border-brand bg-brand/10 font-medium" : "hover:bg-muted")}
              >
                <ChannelBadge platform={c.platform} size={12} />
                {c.name}
              </button>
            ))}
          </div>

          {isLoading || !data ? (
            <Skeleton className="h-72 w-full rounded-xl" />
          ) : (
            <div className="grid gap-6 lg:grid-cols-2">
              <SectionCard title="Ice breakers" description="Up to four questions shown in a new chat, in the mobile apps.">
                <div className="space-y-2 p-5">
                  {draft.iceBreakers.map((b, i) => (
                    <div key={i} className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 rounded-lg border p-3 sm:grid-cols-[minmax(0,1fr)_9rem_auto] sm:gap-1.5 sm:rounded-none sm:border-0 sm:p-0">
                      <Input
                        className="col-span-2 sm:col-span-1"
                        value={b.question}
                        maxLength={80}
                        disabled={readOnly}
                        placeholder="Where is my order?"
                        aria-label={`Question ${i + 1}`}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            iceBreakers: draft.iceBreakers.map((x, j) => (j === i ? { question: e.target.value, payload: x.payload || payloadOf(e.target.value) } : x)),
                          })
                        }
                      />
                      <Input
                        value={b.payload}
                        maxLength={1000}
                        disabled={readOnly}
                        className="font-mono text-micro"
                        aria-label={`Payload ${i + 1}`}
                        onChange={(e) => setDraft({ ...draft, iceBreakers: draft.iceBreakers.map((x, j) => (j === i ? { ...x, payload: e.target.value } : x)) })}
                      />
                      {!readOnly && (
                        <Button variant="ghost" size="icon" aria-label={`Remove question ${i + 1}`} onClick={() => setDraft({ ...draft, iceBreakers: draft.iceBreakers.filter((_, j) => j !== i) })}>
                          <Trash2 />
                        </Button>
                      )}
                    </div>
                  ))}
                  {draft.iceBreakers.length === 0 && <p className="text-caption text-muted-foreground">None yet.</p>}
                  {!readOnly && (
                    <Button variant="outline" size="sm" disabled={draft.iceBreakers.length >= 4} onClick={() => setDraft({ ...draft, iceBreakers: [...draft.iceBreakers, { question: "", payload: "" }] })}>
                      <Plus />
                      Add question
                    </Button>
                  )}
                </div>
              </SectionCard>

              <SectionCard title="Menu" description="Always available in the chat. Items send a payload or open a link.">
                <div className="space-y-3 p-5">
                  {facebook && (
                    <label className="flex items-start gap-2 text-body">
                      <Checkbox
                        checked={draft.getStarted.enabled}
                        disabled={readOnly}
                        onCheckedChange={(v) => setDraft({ ...draft, getStarted: { ...draft.getStarted, enabled: v === true } })}
                      />
                      <span>
                        Show a Get Started button
                        <span className="block text-micro text-muted-foreground">
                          Sends <code className="font-mono">{draft.getStarted.payload}</code>. Messenger shows a menu only with it on.
                        </span>
                      </span>
                    </label>
                  )}
                  {draft.persistentMenu.map((m, i) => (
                    <div key={i} className="space-y-1.5 rounded-lg border p-2.5">
                      <div className="flex flex-wrap gap-1.5 sm:flex-nowrap">
                        <Input
                          value={m.title}
                          maxLength={30}
                          disabled={readOnly}
                          placeholder="Track my order"
                          aria-label={`Menu item ${i + 1}`}
                          onChange={(e) =>
                            setDraft({
                              ...draft,
                              persistentMenu: draft.persistentMenu.map((x, j) => (j === i ? { ...x, title: e.target.value, payload: x.payload || payloadOf(e.target.value) } : x)),
                            })
                          }
                        />
                        <select
                          className="h-8 min-w-0 rounded-lg border bg-background px-2 text-body"
                          value={m.type}
                          disabled={readOnly}
                          aria-label="Item type"
                          onChange={(e) => setDraft({ ...draft, persistentMenu: draft.persistentMenu.map((x, j) => (j === i ? { ...x, type: e.target.value as "postback" | "web_url" } : x)) })}
                        >
                          <option value="postback">Sends</option>
                          <option value="web_url">Opens</option>
                        </select>
                        {!readOnly && (
                          <Button variant="ghost" size="icon" aria-label={`Remove menu item ${i + 1}`} onClick={() => setDraft({ ...draft, persistentMenu: draft.persistentMenu.filter((_, j) => j !== i) })}>
                            <Trash2 />
                          </Button>
                        )}
                      </div>
                      <Input
                        value={m.type === "web_url" ? m.url : m.payload}
                        disabled={readOnly}
                        maxLength={1000}
                        className="font-mono text-micro"
                        placeholder={m.type === "web_url" ? "https://your-store.example" : "TRACK_ORDER"}
                        aria-label={m.type === "web_url" ? "Link" : "Payload"}
                        onChange={(e) =>
                          setDraft({ ...draft, persistentMenu: draft.persistentMenu.map((x, j) => (j === i ? (m.type === "web_url" ? { ...x, url: e.target.value } : { ...x, payload: e.target.value }) : x)) })
                        }
                      />
                    </div>
                  ))}
                  {!readOnly && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={draft.persistentMenu.length >= 20}
                      onClick={() => setDraft({ ...draft, persistentMenu: [...draft.persistentMenu, { title: "", type: "postback", payload: "", url: "" }] })}
                    >
                      <Plus />
                      Add menu item
                    </Button>
                  )}
                  {menuNeedsStart && <p className="text-micro text-warning">Turn on the Get Started button to show this menu.</p>}
                </div>
              </SectionCard>

              <div className="flex flex-wrap items-center justify-between gap-3 lg:col-span-2">
                <p className="text-caption text-muted-foreground">
                  {data.pushedAt ? `Last sent to Meta ${formatDateTime(data.pushedAt)}.` : "Not sent to Meta yet."} Setting ice breakers here replaces any written in Meta’s own inbox tools; changes can take a while to show.
                </p>
                {!readOnly && (
                  <Button
                    variant="accent"
                    disabled={save.isPending || menuNeedsStart || draft.iceBreakers.some((b) => !b.question.trim() || !b.payload.trim())}
                    onClick={() => save.mutate({ channelId, starters: draft })}
                  >
                    {save.isPending && <Loader2 className="animate-spin" />}
                    Save and send to Meta
                  </Button>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
