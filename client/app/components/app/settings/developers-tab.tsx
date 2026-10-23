import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, KeyRound, Loader2, Send, Trash2 } from "lucide-react";

import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Switch } from "~/components/ui/switch";
import { useCurrentRole } from "~/hooks/use-current-role";
import { formatDateTime } from "~/lib/format-date";
import { handleMutationError } from "~/lib/handle-mutation-error";
import { cn } from "~/lib/utils";
import { developerService } from "~/services/developer.service";

/** The tab's icon, so Settings needs no icon import of its own. */
export const DevelopersIcon = KeyRound;

const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) || "/api/v1";
const keys = { catalog: ["developers", "catalog"], keys: ["developers", "keys"], webhooks: ["developers", "webhooks"] } as const;

function Card({ title, help, children }: { title: string; help: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl bg-white dark:bg-gray-900 shadow-sm ring-1 ring-border">
      <div className="border-b px-5 py-4">
        <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{title}</p>
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{help}</p>
      </div>
      <div className="space-y-4 px-5 py-4">{children}</div>
    </section>
  );
}

/** A secret shown once, with a copy button. */
function OnceSecret({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-1 rounded-lg border border-warning bg-warning-subtle p-3">
      <p className="text-xs font-medium text-warning-strong">{label} — copy it now, it is not shown again.</p>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded bg-background px-2 py-1 text-xs">{value}</code>
        <Button size="xs" variant="ghost" aria-label="Copy" onClick={() => { void navigator.clipboard.writeText(value); setCopied(true); }}>
          {copied ? <Check /> : <Copy />}
        </Button>
      </div>
    </div>
  );
}

function ApiKeys({ scopes }: { scopes: string[] }) {
  const queryClient = useQueryClient();
  const { data: list = [] } = useQuery({ queryKey: keys.keys, queryFn: developerService.keys });
  const [name, setName] = useState("");
  const [chosen, setChosen] = useState<string[]>(["messages:send", "contacts:write", "contacts:read", "templates:read", "webhooks:manage"]);
  const [made, setMade] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: developerService.createKey,
    onSuccess: (k) => { setMade(k.key ?? null); setName(""); void queryClient.invalidateQueries({ queryKey: keys.keys }); },
    onError: (e) => handleMutationError(e, "The key was not made."),
  });
  const revoke = useMutation({
    mutationFn: developerService.revokeKey,
    // Revoking a key also switches off the webhooks it made.
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["developers"] }),
    onError: (e) => handleMutationError(e, "The key was not revoked."),
  });
  const base = API_BASE.startsWith("http") ? API_BASE : `${window.location.origin}${API_BASE}`;

  return (
    <Card title="API keys" help={`For your own tools and for Zapier: call ${base}/public/v1 with “Authorization: Bearer <key>”. Each key does only what you tick; revoking one stops it at once.`}>
      {made && <OnceSecret label="New API key" value={made} />}
      {list.length > 0 && (
        <ul className="divide-y rounded-lg border">
          {list.map((k) => (
            <li key={k.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs">
              <span className="font-medium">{k.name}</span>
              <code className="text-muted-foreground">{k.prefix}…</code>
              <span className="text-muted-foreground">{k.scopes.join(", ")}</span>
              <span className="ml-auto text-muted-foreground">{k.lastUsedAt ? `Used ${formatDateTime(k.lastUsedAt)}` : "Not used yet"}</span>
              <Button size="xs" variant="ghost" aria-label={`Revoke ${k.name}`} disabled={revoke.isPending} onClick={() => window.confirm(`Revoke “${k.name}”? Anything using it stops working.`) && revoke.mutate(k.id)}>
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); create.mutate({ name: name.trim(), scopes: chosen }); }}>
        <div className="space-y-1.5">
          <Label htmlFor="key-name">Name</Label>
          <Input id="key-name" placeholder="Zapier" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {scopes.map((s) => (
            <label key={s} className="flex items-center gap-1.5 text-xs">
              <Checkbox checked={chosen.includes(s)} onCheckedChange={(v) => setChosen(v === true ? [...chosen, s] : chosen.filter((x) => x !== s))} />
              {s}
            </label>
          ))}
        </div>
        <Button type="submit" size="sm" variant="outline" disabled={create.isPending || name.trim().length < 2 || !chosen.length}>
          {create.isPending && <Loader2 className="animate-spin" />}
          Make a key
        </Button>
      </form>
    </Card>
  );
}

function Deliveries({ id }: { id: string }) {
  const { data = [], isLoading } = useQuery({ queryKey: [...keys.webhooks, id, "deliveries"], queryFn: () => developerService.deliveries(id), refetchInterval: 10_000 });
  if (isLoading) return <Loader2 className="size-4 animate-spin text-muted-foreground" />;
  if (!data.length) return <p className="text-xs text-muted-foreground">No deliveries yet.</p>;
  return (
    <ul className="space-y-1 text-xs">
      {data.slice(0, 10).map((d) => (
        <li key={d.id} className="flex flex-wrap gap-2">
          <span className={cn("font-medium", d.status === "SENT" ? "text-success" : d.status === "FAILED" ? "text-danger" : "text-muted-foreground")}>{d.status.toLowerCase()}</span>
          <span>{d.event}</span>
          <span className="text-muted-foreground">{formatDateTime(d.createdAt)}</span>
          {d.responseStatus !== null && <span className="text-muted-foreground">HTTP {d.responseStatus}</span>}
          {d.attempts > 1 && <span className="text-muted-foreground">{d.attempts} attempts</span>}
          {d.error && d.status !== "SENT" && <span className="text-muted-foreground">{d.error}</span>}
        </li>
      ))}
    </ul>
  );
}

function Webhooks({ events }: { events: string[] }) {
  const queryClient = useQueryClient();
  const { data: list = [] } = useQuery({ queryKey: keys.webhooks, queryFn: developerService.webhooks });
  const [url, setUrl] = useState("");
  const [chosen, setChosen] = useState<string[]>(["message.received", "order.paid"]);
  const [secret, setSecret] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: keys.webhooks });
  const create = useMutation({
    mutationFn: developerService.createWebhook,
    onSuccess: (w) => { setSecret(w.secret ?? null); setUrl(""); refresh(); },
    onError: (e) => handleMutationError(e, "The webhook was not added."),
  });
  const act = useMutation({
    mutationFn: async (a: { kind: "toggle"; id: string; enabled: boolean } | { kind: "remove"; id: string } | { kind: "test"; id: string } | { kind: "rotate"; id: string }) => {
      if (a.kind === "toggle") return void (await developerService.updateWebhook(a.id, { enabled: a.enabled }));
      if (a.kind === "remove") return void (await developerService.removeWebhook(a.id));
      if (a.kind === "test") return void (await developerService.testWebhook(a.id));
      setSecret((await developerService.rotateSecret(a.id)).secret);
    },
    onSuccess: refresh,
    onError: (e) => handleMutationError(e, "The webhook was not updated."),
  });

  return (
    <Card title="Webhooks" help="Collabo posts JSON to your URL when these happen, signed in Collabo-Signature (t=<time>,v1=<HMAC-SHA256 of “<time>.<body>” with the secret>). Failed deliveries are retried for about two hours; after 20 failures in a row the webhook is switched off.">
      {secret && <OnceSecret label="Signing secret" value={secret} />}
      {list.length > 0 && (
        <ul className="divide-y rounded-lg border">
          {list.map((w) => (
            <li key={w.id} className="space-y-2 px-3 py-2.5 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <code className="min-w-0 truncate">{w.url}</code>
                {w.createdByApi && <span className="rounded bg-muted px-1.5 py-0.5 text-micro text-muted-foreground">made by the API</span>}
                <span className="ml-auto flex items-center gap-1.5">
                  <Switch checked={w.enabled} aria-label={`Switch ${w.url} ${w.enabled ? "off" : "on"}`} disabled={act.isPending} onCheckedChange={(enabled) => act.mutate({ kind: "toggle", id: w.id, enabled })} />
                  <Button size="xs" variant="ghost" disabled={act.isPending || !w.enabled} onClick={() => act.mutate({ kind: "test", id: w.id })}><Send />Test</Button>
                  <Button size="xs" variant="ghost" onClick={() => setOpen(open === w.id ? null : w.id)}>Deliveries</Button>
                  <Button size="xs" variant="ghost" disabled={act.isPending} onClick={() => window.confirm("Make a new signing secret? The old one stops working.") && act.mutate({ kind: "rotate", id: w.id })}>New secret</Button>
                  <Button size="xs" variant="ghost" aria-label="Remove webhook" disabled={act.isPending} onClick={() => window.confirm("Remove this webhook?") && act.mutate({ kind: "remove", id: w.id })}><Trash2 /></Button>
                </span>
              </div>
              <p className="text-muted-foreground">{w.events.join(", ")}</p>
              {w.disabledReason && <p className="text-warning">{w.disabledReason}</p>}
              {open === w.id && <Deliveries id={w.id} />}
            </li>
          ))}
        </ul>
      )}
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); create.mutate({ url: url.trim(), events: chosen }); }}>
        <div className="space-y-1.5">
          <Label htmlFor="wh-url">URL</Label>
          <Input id="wh-url" type="url" placeholder="https://example.com/collabo-webhook" value={url} onChange={(e) => setUrl(e.target.value)} />
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {events.map((ev) => (
            <label key={ev} className="flex items-center gap-1.5 text-xs">
              <Checkbox checked={chosen.includes(ev)} onCheckedChange={(v) => setChosen(v === true ? [...chosen, ev] : chosen.filter((x) => x !== ev))} />
              {ev}
            </label>
          ))}
        </div>
        <Button type="submit" size="sm" variant="outline" disabled={create.isPending || !url.startsWith("https://") || !chosen.length}>
          {create.isPending && <Loader2 className="animate-spin" />}
          Add webhook
        </Button>
      </form>
    </Card>
  );
}

/** Settings → Developers: the public API's keys and outgoing webhooks. */
export function DevelopersTab() {
  const { role } = useCurrentRole();
  const allowed = role === "OWNER" || role === "ADMIN";
  const { data: catalog } = useQuery({ queryKey: keys.catalog, queryFn: developerService.catalog, enabled: allowed });
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-bold text-gray-900 dark:text-gray-100">API and webhooks</h2>
        <p className="mt-1 text-xs text-muted-foreground">Connect Collabo to other systems: send WhatsApp messages and add contacts from them, and hear about messages, orders and payments as they happen.</p>
      </div>
      {!allowed ? (
        <p className="text-xs text-muted-foreground">Only owners and admins can manage API keys and webhooks.</p>
      ) : catalog ? (
        <>
          <ApiKeys scopes={catalog.scopes} />
          <Webhooks events={catalog.events} />
        </>
      ) : (
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
      )}
    </div>
  );
}
