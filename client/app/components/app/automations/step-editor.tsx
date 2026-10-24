import { useRef, useState } from "react";
import { Link } from "react-router";
import { Check, Copy, Loader2, Paperclip, Plus, RefreshCw, Trash2, X } from "lucide-react";

import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import { useInstagramPosts } from "~/hooks/use-automation-queries";
import { useSheetColumns } from "~/hooks/use-google";
import { useCampaignUploadMutation } from "~/hooks/use-campaign-mutations";
import { useTemplates } from "~/hooks/use-campaign-queries";
import { BLOCKS, CHANNEL_LABEL, EVENTS, ORDER_EVENTS, STORE_EVENTS, allSteps } from "~/lib/automation-blocks";
import { cn } from "~/lib/utils";
import type { AutomationChannelKey, AutomationIssue, AutomationStep, SheetColumn } from "~/types/api";

type Config = AutomationStep["config"];

export interface EditorContext {
  channel: AutomationChannelKey;
  channelId: string | null;
  steps: AutomationStep[];
  issues: AutomationIssue[];
  tags: string[];
  members: Array<{ id: string; name: string }>;
  teams: Array<{ id: string; name: string }>;
  /** Templates and files need Campaigns access; an influencer has neither. */
  storeTools: boolean;
  readOnly: boolean;
  /** May edit automations; only they are sent a webhook trigger's URL. */
  canEdit: boolean;
  /** The organization's Google sheets in Collabo. */
  sheets: Array<{ id: string; title: string }>;
  /** The trigger sheet's columns, for {{sheet.*}}. */
  sheetColumns: SheetColumn[];
}

const selectClass = "h-8 w-full rounded-lg border bg-background px-2 text-body disabled:opacity-60";
const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) || "/api/v1";

function Field({ label, hint, children, htmlFor }: { label: string; hint?: string; children: React.ReactNode; htmlFor?: string }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <p className="text-micro text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** The {{variables}} a message can use here, as chips that insert themselves. */
function variablesFor(ctx: EditorContext): string[] {
  const trigger = ctx.steps[0]?.config ?? {};
  const saved = new Set<string>();
  for (const s of allSteps(ctx.steps)) {
    if (s.type === "wait_for_reply" && s.config.saveAs) saved.add(`attr.${s.config.saveAs}`);
    if (s.type === "set_attribute" && s.config.key) saved.add(`attr.${s.config.key}`);
    if (s.type === "http_request" && s.config.saveAs) saved.add(`${s.config.saveAs}.status_code`);
    if (s.type === "store_action" && s.config.action === "create_draft_order") ["draft.checkout_url", "draft.total", "draft.name"].forEach((v) => saved.add(v));
  }
  const event = String(trigger.event ?? "");
  if (ORDER_EVENTS.includes(event)) ["order.name", "order.total", "order.items", "order.payment", "order.status", "order.tracking_url", "order.tracking_number", "order.carrier"].forEach((v) => saved.add(v));
  // The invoice event carries {{invoice.*}}; "Send the invoice" fills it on order events.
  if (event === "invoice_issued" || (ORDER_EVENTS.includes(event) && allSteps(ctx.steps).some((s) => s.type === "send_invoice"))) {
    ["invoice.number", "invoice.date", "invoice.total"].forEach((v) => saved.add(v));
  }
  if (event === "checkout_abandoned") ["checkout.url", "checkout.url_path", "checkout.total", "checkout.items"].forEach((v) => saved.add(v));
  // A paid link carries {{payment.*}}; "Send a payment link" fills it for its own message and later steps.
  if (event === "payment_received") ["payment.amount", "payment.method", "payment.description"].forEach((v) => saved.add(v));
  if (event === "website_signup") ["signup.name", "signup.page"].forEach((v) => saved.add(v));
  if (event === "ad_message") ["ad.id", "ad.headline", "ad.body", "ad.url"].forEach((v) => saved.add(v));
  if (allSteps(ctx.steps).some((s) => s.type === "send_payment_link")) ["payment.link", "payment.link_path", "payment.amount", "payment.expires"].forEach((v) => saved.add(v));
  return [
    "first_name",
    "name",
    ...(ctx.channel === "whatsapp" ? ["phone"] : ["username"]),
    "trigger_text",
    "last_reply",
    ...saved,
    ...(trigger.event === "webhook" ? ["webhook.<field>"] : []),
    ...(trigger.event === "sheet_row" ? ["sheet.row", ...ctx.sheetColumns.map((c) => `sheet.${c.key}`)] : []),
  ];
}

function TextWithVariables({
  id,
  value,
  onChange,
  ctx,
  rows = 4,
  maxLength,
  placeholder,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  ctx: EditorContext;
  rows?: number;
  maxLength?: number;
  placeholder?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const insert = (name: string) => {
    const el = ref.current;
    const token = `{{${name}}}`;
    const at = el?.selectionStart ?? value.length;
    const next = value.slice(0, at) + token + value.slice(el?.selectionEnd ?? at);
    onChange(next);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(at + token.length, at + token.length);
    });
  };
  return (
    <div className="space-y-1.5">
      <Textarea id={id} ref={ref} rows={rows} value={value} maxLength={maxLength} disabled={ctx.readOnly} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      {!ctx.readOnly && (
        <div className="flex flex-wrap gap-1">
          {variablesFor(ctx).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => insert(v.replace("<field>", "field"))}
              className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-micro text-muted-foreground hover:text-foreground"
            >
              {`{{${v}}}`}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Segmented<T extends string>({ value, options, onChange, disabled }: { value: T; options: Array<[T, string]>; onChange: (v: T) => void; disabled?: boolean }) {
  return (
    <div className="flex flex-wrap gap-1 rounded-lg bg-muted p-0.5">
      {options.map(([key, label]) => (
        <button
          key={key}
          type="button"
          disabled={disabled}
          aria-pressed={value === key}
          onClick={() => onChange(key)}
          className={cn("flex-1 rounded-md px-2 py-1 text-caption font-medium", value === key ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground")}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function AmountUnit({ config, set, readOnly, units = ["minutes", "hours", "days"] }: { config: Config; set: (patch: Config) => void; readOnly: boolean; units?: string[] }) {
  return (
    <div className="flex gap-2">
      <Input type="number" min={1} max={10000} className="w-24" value={config.amount ?? 1} disabled={readOnly} onChange={(e) => set({ amount: Math.max(1, Number(e.target.value) || 1) })} />
      <select className={selectClass} value={config.unit} disabled={readOnly} onChange={(e) => set({ unit: e.target.value })}>
        {units.map((u) => (
          <option key={u} value={u}>
            {u}
          </option>
        ))}
      </select>
    </div>
  );
}

function TagsInput({ value, onChange, suggestions, readOnly, id }: { value: string[]; onChange: (v: string[]) => void; suggestions: string[]; readOnly: boolean; id: string }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const tag = draft.trim();
    if (tag && !value.some((t) => t.toLowerCase() === tag.toLowerCase()) && value.length < 10) onChange([...value, tag]);
    setDraft("");
  };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1">
        {value.map((t) => (
          <span key={t} className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-caption">
            {t}
            {!readOnly && (
              <button type="button" onClick={() => onChange(value.filter((x) => x !== t))} aria-label={`Remove ${t}`}>
                <X className="size-3" />
              </button>
            )}
          </span>
        ))}
      </div>
      {!readOnly && (
        <div className="flex gap-2">
          <Input
            id={id}
            list={`${id}-list`}
            value={draft}
            maxLength={60}
            placeholder="Type a tag"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                add();
              }
            }}
          />
          <datalist id={`${id}-list`}>
            {suggestions.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
          <Button type="button" variant="outline" size="sm" onClick={add} disabled={!draft.trim()}>
            Add
          </Button>
        </div>
      )}
    </div>
  );
}

// ─── Trigger ────────────────────────────────────────────────────────────────

function PostPicker({ channelId, value, onChange, readOnly }: { channelId: string; value: string; onChange: (v: string) => void; readOnly: boolean }) {
  const { data, isLoading, refetch, isFetching } = useInstagramPosts(channelId);
  const posts = data?.data ?? [];
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-4 gap-1.5">
        <button
          type="button"
          disabled={readOnly}
          onClick={() => onChange("")}
          className={cn("flex aspect-square items-center justify-center rounded-lg border p-1 text-center text-micro font-medium", !value ? "border-brand bg-brand/10" : "hover:bg-muted")}
        >
          Any post
        </button>
        {posts.slice(0, 11).map((p) => (
          <button
            key={p.externalId}
            type="button"
            disabled={readOnly}
            onClick={() => onChange(p.externalId)}
            title={p.caption ?? p.externalId}
            className={cn("relative aspect-square overflow-hidden rounded-lg border bg-muted", value === p.externalId ? "ring-2 ring-brand" : "hover:opacity-90")}
          >
            {p.thumbnailUrl ? <img src={p.thumbnailUrl} alt={p.caption ?? "Post"} className="size-full object-cover" loading="lazy" /> : <span className="p-1 text-micro">{p.caption ?? p.mediaType}</span>}
            {value === p.externalId && (
              <span className="absolute right-1 top-1 rounded-full bg-brand p-0.5 text-brand-foreground">
                <Check className="size-3" />
              </span>
            )}
          </button>
        ))}
      </div>
      <div className="flex items-center justify-between text-micro text-muted-foreground">
        <span>{isLoading ? "Loading posts…" : data?.syncError ? "Posts could not be loaded from Instagram." : value && !posts.some((p) => p.externalId === value) ? `Post ${value}` : `${posts.length} recent posts`}</span>
        <Button variant="ghost" size="xs" onClick={() => void refetch()} disabled={isFetching}>
          <RefreshCw className={cn(isFetching && "animate-spin")} />
          Refresh
        </Button>
      </div>
    </div>
  );
}

function WebhookUrl({ token, phoneField, canEdit }: { token: string; phoneField: string; canEdit: boolean }) {
  const [copied, setCopied] = useState(false);
  if (!token) {
    return (
      <p className="rounded-lg border border-dashed p-3 text-caption text-muted-foreground">
        {canEdit ? "The URL is created when you publish." : "Only people who can edit automations see this URL."}
      </p>
    );
  }
  const url = `${API_BASE.startsWith("http") ? API_BASE : `${window.location.origin}${API_BASE}`}/automations/hooks/${token}`;
  // A dotted field nests: customer.phone → {"customer": {"phone": …}}.
  const body = phoneField.split(".").reduceRight<unknown>((inner, key) => ({ [key]: inner }), "+919876543210") as Record<string, unknown>;
  const example = `curl -X POST '${url}' \\\n  -H 'Content-Type: application/json' \\\n  -H 'Idempotency-Key: order-1042' \\\n  -d '${JSON.stringify({ ...body, name: "Asha", order: "#1042" })}'`;
  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Input readOnly value={url} className="font-mono text-micro" onFocus={(e) => e.target.select()} />
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label="Copy URL"
          onClick={() => {
            void navigator.clipboard.writeText(url);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? <Check /> : <Copy />}
        </Button>
      </div>
      <pre className="overflow-x-auto rounded-lg bg-muted p-2 font-mono text-micro text-muted-foreground">{example}</pre>
      <p className="text-micro text-muted-foreground">Keep this URL private: anyone with it can start the automation. Other fields in the JSON become {"{{webhook.<field>}}"}.</p>
    </div>
  );
}

function SheetSelect({ id, value, onChange, ctx }: { id: string; value: string; onChange: (sheetId: string) => void; ctx: EditorContext }) {
  return (
    <>
      <select id={id} className={selectClass} value={value} disabled={ctx.readOnly} onChange={(e) => onChange(e.target.value)}>
        <option value="">Choose a sheet</option>
        {ctx.sheets.map((s) => (
          <option key={s.id} value={s.id}>
            {s.title}
          </option>
        ))}
      </select>
      {ctx.sheets.length === 0 && (
        <p className="text-micro text-muted-foreground">
          Add one in <Link to="/campaigns/automations/sheets" className="underline">Google Sheets</Link> first.
        </p>
      )}
    </>
  );
}

/** "A row is added to a sheet": which sheet, and which column has the person's number. */
function SheetTriggerFields({ config, set, ctx }: { config: Config; set: (p: Config) => void; ctx: EditorContext }) {
  const { data: columns = [], isLoading, isError } = useSheetColumns(config.sheetId || undefined);
  return (
    <>
      <Field label="Sheet" htmlFor="t-sheet">
        <SheetSelect id="t-sheet" value={config.sheetId ?? ""} onChange={(sheetId) => set({ sheetId, phoneField: "" })} ctx={ctx} />
      </Field>
      {config.sheetId && (
        <Field label="Phone column" hint="Each row’s WhatsApp number, with its country code." htmlFor="t-phone-column">
          {isError ? (
            <p className="text-micro text-danger">The sheet’s columns could not be read from Google.</p>
          ) : (
            <select id="t-phone-column" className={selectClass} value={config.phoneField ?? ""} disabled={ctx.readOnly || isLoading} onChange={(e) => set({ phoneField: e.target.value })}>
              <option value="">{isLoading ? "Reading the columns…" : "Choose a column"}</option>
              {columns.map((c) => (
                <option key={c.key} value={c.header}>
                  {c.header}
                </option>
              ))}
            </select>
          )}
        </Field>
      )}
      <p className="rounded-lg bg-info-subtle p-2 text-micro text-info">
        Collabo reads the sheet every couple of minutes. Each new row starts this once, for the number in its phone column; a new number becomes a contact. Messages must be approved templates, since they may not have written to you.
      </p>
    </>
  );
}

/** "Add a row to a sheet": a value for each of the sheet's columns. */
function SheetRowFields({ config, set, ctx }: { config: Config; set: (p: Config) => void; ctx: EditorContext }) {
  const { data: columns = [], isLoading, isError } = useSheetColumns(config.sheetId || undefined);
  const values = (config.values as string[] | undefined) ?? [];
  const setValue = (i: number, v: string) => {
    const next = [...values];
    while (next.length < columns.length) next.push("");
    next[i] = v;
    set({ values: next.slice(0, Math.max(columns.length, i + 1)) });
  };
  return (
    <div className="space-y-4">
      <Field label="Sheet" htmlFor="sr-sheet">
        <SheetSelect id="sr-sheet" value={config.sheetId ?? ""} onChange={(sheetId) => set({ sheetId, values: [] })} ctx={ctx} />
      </Field>
      {config.sheetId &&
        (isLoading ? (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        ) : isError ? (
          <p className="text-micro text-danger">The sheet’s columns could not be read from Google.</p>
        ) : columns.length === 0 ? (
          <p className="text-micro text-muted-foreground">The sheet has no column names. Type them in its first row, then choose it again.</p>
        ) : (
          columns.map((c, i) => (
            <Field key={c.key} label={c.header} htmlFor={`sr-${i}`}>
              <TextWithVariables id={`sr-${i}`} rows={1} value={values[i] ?? ""} onChange={(v) => setValue(i, v)} ctx={ctx} maxLength={1000} />
            </Field>
          ))
        ))}
      <p className="text-micro text-muted-foreground">Added below the last row, as plain text: nothing a customer wrote becomes a formula.</p>
    </div>
  );
}

function TriggerForm({ config, set, ctx }: { config: Config; set: (p: Config) => void; ctx: EditorContext }) {
  const events = EVENTS[ctx.channel];
  const ro = ctx.readOnly;
  const hint = events.find((e) => e.value === config.event)?.hint || undefined;
  return (
    <div className="space-y-4">
      <Field label={`On ${CHANNEL_LABEL[ctx.channel]}`} htmlFor="t-event" hint={hint}>
        <select id="t-event" className={selectClass} value={config.event} disabled={ro} onChange={(e) => set({ event: e.target.value })}>
          {events.map((ev) => (
            <option key={ev.value} value={ev.value}>
              {ev.label}
            </option>
          ))}
        </select>
      </Field>

      {config.event === "comment" && ctx.channel === "instagram" && ctx.channelId && (
        <Field label="Which post">
          <PostPicker channelId={ctx.channelId} value={config.post ?? ""} onChange={(post) => set({ post })} readOnly={ro} />
        </Field>
      )}
      {config.event === "comment" && ctx.channel === "facebook" && (
        <Field label="Post id" hint="Leave empty for every post on the Page." htmlFor="t-post">
          <Input id="t-post" value={config.post ?? ""} disabled={ro} maxLength={64} onChange={(e) => set({ post: e.target.value.trim() })} placeholder="Any post" />
        </Field>
      )}

      {(config.event === "comment" || config.event === "message") && (
        <>
          <Field label="Match">
            <Segmented
              value={config.match ?? "contains"}
              disabled={ro}
              onChange={(match) => set({ match })}
              options={[
                ["contains", "Has a keyword"],
                ["exact", "Is exactly"],
                ["any", config.event === "comment" ? "Any comment" : "Any message"],
              ]}
            />
          </Field>
          {config.match !== "any" && (
            <Field label="Keywords" hint="Separate with commas. Whole words, any case: “price” matches “PRICE?” but not “priced”." htmlFor="t-keyword">
              <Input id="t-keyword" value={config.keyword ?? ""} disabled={ro} maxLength={500} onChange={(e) => set({ keyword: e.target.value })} placeholder="price, link, details" />
            </Field>
          )}
        </>
      )}
      {config.event === "message" && (
        <label className="flex items-start gap-2 text-body">
          <Checkbox checked={!!config.newConversationOnly} disabled={ro} onCheckedChange={(v) => set({ newConversationOnly: v === true })} />
          <span>
            Only the first message of a conversation
            <span className="block text-micro text-muted-foreground">A new chat, or one reopened after it was closed.</span>
          </span>
        </label>
      )}
      {config.event === "postback" && (
        <>
          <Field label="Which buttons">
            <Segmented value={config.match === "any" ? "any" : "exact"} disabled={ro} onChange={(match) => set({ match })} options={[["exact", "These payloads"], ["any", "Any tap"]]} />
          </Field>
          {config.match !== "any" && (
            <Field label="Payloads" hint="The payloads you gave the ice breakers or menu items, comma-separated. Upper and lower case count." htmlFor="t-payload">
              <Input id="t-payload" value={config.keyword ?? ""} disabled={ro} onChange={(e) => set({ keyword: e.target.value })} placeholder="TRACK_ORDER" />
            </Field>
          )}
          <p className="text-micro text-muted-foreground">
            Set them up in <Link to="/campaigns/automations/starters" className="underline">Conversation starters</Link>.
          </p>
        </>
      )}
      {config.event === "ad_message" && (
        <Field label="Which ads" hint="Ad ids from Ads Manager, comma-separated. Leave empty for every ad. A “Someone sends a message” automation also sees this first message, so keep only one of them replying." htmlFor="t-ads">
          <Input id="t-ads" value={config.keyword ?? ""} disabled={ro} maxLength={500} onChange={(e) => set({ keyword: e.target.value.replace(/[^\d,\s]/g, "") })} placeholder="120210000000001, 120210000000002" />
        </Field>
      )}
      {config.event === "sheet_row" && <SheetTriggerFields config={config} set={set} ctx={ctx} />}
      {config.event === "website_signup" ? (
        <p className="rounded-lg bg-info-subtle p-2 text-micro text-info">
          The person who signed up becomes a contact, opted in with the text they agreed to. Messages must be approved templates, since they have not written yet.
        </p>
      ) : STORE_EVENTS.includes(config.event) && (
        <p className="rounded-lg bg-info-subtle p-2 text-micro text-info">
          The buyer is found by the phone number on the order or checkout; a new number becomes a contact. Messages must be approved templates, since they may not have written in 24 hours.
        </p>
      )}
      {config.event === "tag_added" && (
        <Field label="Tag" hint="Added by a person in the inbox, an import or another automation." htmlFor="t-tag">
          <Input id="t-tag" list="t-tag-list" value={config.tag ?? ""} disabled={ro} maxLength={60} onChange={(e) => set({ tag: e.target.value })} placeholder="vip" />
          <datalist id="t-tag-list">
            {ctx.tags.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </Field>
      )}
      {config.event === "webhook" && (
        <>
          <Field label="Phone number field" hint="Where the JSON carries the person’s number, with country code. Dots reach inside objects: customer.phone." htmlFor="t-phone">
            <Input id="t-phone" value={config.phoneField ?? "phone"} disabled={ro} maxLength={60} onChange={(e) => set({ phoneField: e.target.value.trim() })} />
          </Field>
          <Field label="URL">
            <WebhookUrl token={config.token ?? ""} phoneField={config.phoneField || "phone"} canEdit={ctx.canEdit} />
          </Field>
          {ctx.channel !== "whatsapp" && <p className="text-micro text-muted-foreground">On {CHANNEL_LABEL[ctx.channel]} the person must already have messaged you, with that number saved on their contact.</p>}
        </>
      )}
    </div>
  );
}

// ─── Send message ───────────────────────────────────────────────────────────

const OPTION_LIMITS: Record<string, { max: number; chars: number; label: string }> = {
  buttons: { max: 3, chars: 20, label: "Buttons" },
  list: { max: 10, chars: 24, label: "Rows" },
  quick_replies: { max: 13, chars: 20, label: "Quick replies" },
};

function OptionsEditor({ kind, options, onChange, readOnly }: { kind: string; options: string[]; onChange: (o: string[]) => void; readOnly: boolean }) {
  const limit = OPTION_LIMITS[kind];
  return (
    <Field label={limit.label} hint={`Up to ${limit.max}, ${limit.chars} characters each. Their reply is the label they tapped.`}>
      <div className="space-y-1.5">
        {options.map((o, i) => (
          <div key={i} className="flex gap-1.5">
            <Input value={o} maxLength={limit.chars} disabled={readOnly} onChange={(e) => onChange(options.map((x, j) => (j === i ? e.target.value : x)))} aria-label={`Option ${i + 1}`} />
            {!readOnly && (
              <Button type="button" variant="ghost" size="icon" onClick={() => onChange(options.filter((_, j) => j !== i))} aria-label={`Remove option ${i + 1}`}>
                <Trash2 />
              </Button>
            )}
          </div>
        ))}
        {!readOnly && (
          <Button type="button" variant="outline" size="sm" disabled={options.length >= limit.max} onClick={() => onChange([...options, ""])}>
            <Plus />
            Add
          </Button>
        )}
      </div>
    </Field>
  );
}

function FileField({ media, onChange, readOnly, label }: { media: Config["media"]; onChange: (m: Config["media"] | undefined) => void; readOnly: boolean; label: string }) {
  const upload = useCampaignUploadMutation();
  const input = useRef<HTMLInputElement>(null);
  return (
    <Field label={label} hint="Image, video or PDF.">
      <div className="flex items-center gap-2">
        {media ? (
          <span className="inline-flex min-w-0 items-center gap-1.5 rounded-lg border px-2 py-1 text-caption">
            <Paperclip className="size-3.5 shrink-0" />
            <span className="truncate">{media.filename ?? media.kind}</span>
            {!readOnly && (
              <button type="button" onClick={() => onChange(undefined)} aria-label="Remove file">
                <X className="size-3" />
              </button>
            )}
          </span>
        ) : (
          <span className="text-caption text-muted-foreground">No file yet</span>
        )}
        {!readOnly && (
          <>
            <input
              ref={input}
              type="file"
              className="hidden"
              accept="image/jpeg,image/png,video/mp4,application/pdf"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) upload.mutate(file, { onSuccess: (u) => onChange({ storageKey: u.storageKey, mime: u.mime, kind: u.kind, filename: u.filename }) });
              }}
            />
            <Button type="button" variant="outline" size="sm" onClick={() => input.current?.click()} disabled={upload.isPending}>
              {upload.isPending ? <Loader2 className="animate-spin" /> : <Paperclip />}
              {media ? "Replace" : "Upload"}
            </Button>
          </>
        )}
      </div>
    </Field>
  );
}

/**
 * `invoice`: only templates with a document header, which carries the invoice PDF.
 * `payment`: only templates without a media header; the link goes in a button or the text.
 */
function TemplateFields({ config, set, ctx, invoice = false, payment = false }: { config: Config; set: (p: Config) => void; ctx: EditorContext; invoice?: boolean; payment?: boolean }) {
  const { data: all = [], isLoading } = useTemplates({ status: "APPROVED" });
  const templates = invoice
    ? all.filter((t) => t.params.some((p) => p.component === "header" && p.kind === "document"))
    : payment
      ? all.filter((t) => !t.params.some((p) => p.component === "header" && p.kind !== "text"))
      : all;
  const template = templates.find((t) => t.id === config.templateId);
  const values: Record<string, string> = config.templateValues ?? {};
  return (
    <div className="space-y-3">
      <Field
        label="Template"
        hint={
          invoice
            ? "Approved WhatsApp templates with a document header. Start from the “GST invoice” template if you have none."
            : payment
              ? "Approved WhatsApp templates without a media header. Start from “Pay for your order” or “Pay online instead of cash” if you have none."
              : "Approved WhatsApp templates. They can be sent even after the 24-hour window closes."
        }
        htmlFor="m-template"
      >
        <select id="m-template" className={selectClass} value={config.templateId ?? ""} disabled={ctx.readOnly || isLoading} onChange={(e) => set({ templateId: e.target.value || undefined })}>
          <option value="">{isLoading ? "Loading…" : templates.length ? "Choose a template" : invoice ? "No template with a document header yet" : "No approved templates yet"}</option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} · {t.language} · {t.category.toLowerCase()}
            </option>
          ))}
        </select>
      </Field>
      {template && (
        <>
          <p className="whitespace-pre-wrap rounded-lg bg-muted p-2 text-caption">{template.preview.body}</p>
          {template.params.map((p) =>
            p.component === "header" && p.kind !== "text" && invoice ? (
              <p key={p.key} className="rounded-lg border border-dashed p-2 text-caption text-muted-foreground">
                The header carries the order’s GST invoice as a PDF.
              </p>
            ) : p.component === "header" && p.kind !== "text" ? (
              <FileField key={p.key} label="Header file" media={config.media} onChange={(media) => set({ media })} readOnly={ctx.readOnly} />
            ) : (
              <Field key={p.key} label={p.component === "body" ? `Body {{${p.name}}}` : p.kind === "coupon_code" ? "Coupon code" : p.component === "header" ? "Header" : `Button ${Number(p.name) + 1} link`} htmlFor={`tv-${p.key}`}>
                <Input
                  id={`tv-${p.key}`}
                  value={values[p.key] ?? ""}
                  disabled={ctx.readOnly}
                  placeholder={p.example ? `e.g. ${p.example}` : "{{first_name}}"}
                  onChange={(e) => set({ templateValues: { ...values, [p.key]: e.target.value } })}
                />
              </Field>
            ),
          )}
          {template.params.some((p) => p.component !== "header" || p.kind === "text") && (
            <p className="text-micro text-muted-foreground">
              {invoice
                ? <>Use {"{{first_name}}"}, {"{{order.name}}"}, {"{{invoice.number}}"} or {"{{invoice.total}}"} for values that change per order.</>
                : payment
                  ? <>Put {"{{payment.link_path}}"} in a button whose URL is https://rzp.io/{"{{1}}"}, or {"{{payment.link}}"} in the text. {"{{order.total}}"} and {"{{payment.amount}}"} give the amount.</>
                  : <>Use {"{{first_name}}"}, {"{{attr.field}}"} or {"{{webhook.field}}"} for values that change per person.</>}
            </p>
          )}
        </>
      )}
    </div>
  );
}

function SendMessageForm({ config, set, ctx }: { config: Config; set: (p: Config) => void; ctx: EditorContext }) {
  const wa = ctx.channel === "whatsapp";
  const kinds: Array<[string, string]> = [
    ["text", "Text"],
    ...(ctx.storeTools ? ([["media", "File"]] as Array<[string, string]>) : []),
    ["buttons", "Buttons"],
    ...(wa ? ([["list", "List"]] as Array<[string, string]>) : ([["quick_replies", "Quick replies"]] as Array<[string, string]>)),
    ...(wa && ctx.storeTools ? ([["template", "Template"]] as Array<[string, string]>) : []),
  ];
  const kind = config.kind ?? "text";
  return (
    <div className="space-y-4">
      <Field label="Send">
        <Segmented value={kind} disabled={ctx.readOnly} options={kinds} onChange={(k) => set({ kind: k, ...(OPTION_LIMITS[k] ? { options: (config.options ?? []).slice(0, OPTION_LIMITS[k].max) } : {}) })} />
      </Field>
      {kind === "template" ? (
        <TemplateFields config={config} set={set} ctx={ctx} />
      ) : (
        <>
          {kind === "media" && <FileField label="File" media={config.media} onChange={(media) => set({ media })} readOnly={ctx.readOnly} />}
          <Field label={kind === "media" ? "Caption" : "Message"} hint={ctx.channel === "instagram" ? "Instagram allows up to 1,000 bytes (emoji count as several)." : undefined} htmlFor="m-text">
            <TextWithVariables id="m-text" value={config.message ?? ""} onChange={(message) => set({ message })} ctx={ctx} maxLength={4096} placeholder="Hi {{first_name}}! …" />
          </Field>
          {OPTION_LIMITS[kind] && <OptionsEditor kind={kind} options={config.options ?? []} onChange={(options) => set({ options })} readOnly={ctx.readOnly} />}
          {kind === "list" && (
            <Field label="List button" htmlFor="m-listbutton">
              <Input id="m-listbutton" value={config.listButton ?? "Choose"} maxLength={20} disabled={ctx.readOnly} onChange={(e) => set({ listButton: e.target.value })} />
            </Field>
          )}
        </>
      )}
      {ctx.steps[0]?.config.event === "comment" && !wa && (
        <p className="rounded-lg bg-info-subtle p-2 text-micro text-info">
          Someone who only commented can get one private reply. Put messages after “Wait for a reply”, in the “They replied” branch.
        </p>
      )}
    </div>
  );
}

// ─── Condition ──────────────────────────────────────────────────────────────

const RULE_FIELDS: Array<{ field: string; label: string; ops: Array<[string, string]>; values?: Array<[string, string]> }> = [
  { field: "last_reply", label: "Their last reply", ops: [["contains", "has the words"], ["equals", "is"], ["exists", "was given"], ["not_exists", "was not given"]] },
  { field: "trigger_text", label: "The message that started it", ops: [["contains", "has the words"], ["equals", "is"]] },
  { field: "tag", label: "Tag", ops: [["has", "they have"], ["not_has", "they don’t have"]] },
  { field: "attribute", label: "Contact field", ops: [["equals", "is"], ["contains", "has the words"], ["exists", "is set"], ["not_exists", "is not set"], ["gte", "is at least"], ["lte", "is at most"]] },
  { field: "consent", label: "Marketing consent", ops: [["is", "is"], ["is_not", "is not"]], values: [["opted_in", "opted in"], ["opted_out", "opted out"], ["unknown", "not given"]] },
  { field: "customer", label: "Store customer", ops: [["exists", "is linked"], ["not_exists", "is not linked"]] },
  { field: "orders_count", label: "Orders", ops: [["gte", "at least"], ["lte", "at most"], ["equals", "exactly"]] },
  { field: "window", label: "Reply window", ops: [["is", "is"]], values: [["open", "open"], ["closed", "closed"]] },
  { field: "assigned", label: "Conversation", ops: [["exists", "is assigned"], ["not_exists", "is unassigned"]] },
  { field: "order_payment", label: "Order payment", ops: [["is", "is"], ["is_not", "is not"]], values: [["cod", "cash on delivery"], ["prepaid", "prepaid"]] },
  { field: "order_total", label: "Order total", ops: [["gte", "is at least"], ["lte", "is at most"]] },
];
const NO_VALUE = new Set(["exists", "not_exists"]);

function ConditionForm({ config, set, ctx }: { config: Config; set: (p: Config) => void; ctx: EditorContext }) {
  const rules: Array<{ field: string; op: string; key: string; value: string }> = config.rules ?? [];
  const setRule = (i: number, patch: Partial<(typeof rules)[number]>) => set({ rules: rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-body">
        Yes when
        <select className={cn(selectClass, "w-auto")} value={config.match ?? "all"} disabled={ctx.readOnly} onChange={(e) => set({ match: e.target.value })}>
          <option value="all">all</option>
          <option value="any">any</option>
        </select>
        of these are true
      </div>
      {rules.map((rule, i) => {
        const spec = RULE_FIELDS.find((f) => f.field === rule.field) ?? RULE_FIELDS[0];
        return (
          <div key={i} className="space-y-2 rounded-lg border p-2.5">
            <div className="flex gap-1.5">
              <select
                className={selectClass}
                value={rule.field}
                disabled={ctx.readOnly}
                aria-label="What to check"
                onChange={(e) => {
                  const next = RULE_FIELDS.find((f) => f.field === e.target.value)!;
                  setRule(i, { field: next.field, op: next.ops[0][0], key: "", value: next.values?.[0][0] ?? "" });
                }}
              >
                {RULE_FIELDS.map((f) => (
                  <option key={f.field} value={f.field}>
                    {f.label}
                  </option>
                ))}
              </select>
              {!ctx.readOnly && (
                <Button type="button" variant="ghost" size="icon" onClick={() => set({ rules: rules.filter((_, j) => j !== i) })} aria-label="Remove rule">
                  <Trash2 />
                </Button>
              )}
            </div>
            {rule.field === "attribute" && (
              <Input value={rule.key} placeholder="Field name, e.g. city" maxLength={60} disabled={ctx.readOnly} onChange={(e) => setRule(i, { key: e.target.value.trim() })} aria-label="Field name" />
            )}
            <div className="flex gap-1.5">
              <select className={selectClass} value={rule.op} disabled={ctx.readOnly} onChange={(e) => setRule(i, { op: e.target.value })} aria-label="Comparison">
                {spec.ops.map(([op, label]) => (
                  <option key={op} value={op}>
                    {label}
                  </option>
                ))}
              </select>
              {!NO_VALUE.has(rule.op) && spec.field !== "customer" && spec.field !== "assigned" &&
                (spec.values ? (
                  <select className={selectClass} value={rule.value} disabled={ctx.readOnly} onChange={(e) => setRule(i, { value: e.target.value })} aria-label="Value">
                    {spec.values.map(([v, label]) => (
                      <option key={v} value={v}>
                        {label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <Input
                    value={rule.value}
                    list={rule.field === "tag" ? "cond-tags" : undefined}
                    inputMode={rule.field === "orders_count" ? "numeric" : undefined}
                    placeholder={rule.field === "tag" ? "vip" : rule.op === "contains" ? "yes, sure" : "value"}
                    maxLength={500}
                    disabled={ctx.readOnly}
                    onChange={(e) => setRule(i, { value: e.target.value })}
                    aria-label="Value"
                  />
                ))}
            </div>
          </div>
        );
      })}
      <datalist id="cond-tags">
        {ctx.tags.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
      {!ctx.readOnly && (
        <Button type="button" variant="outline" size="sm" disabled={rules.length >= 10} onClick={() => set({ rules: [...rules, { field: "tag", op: "has", key: "", value: "" }] })}>
          <Plus />
          Add rule
        </Button>
      )}
      <p className="text-micro text-muted-foreground">Words match whole words in any case; separate alternatives with commas.</p>
    </div>
  );
}

// ─── The panel ──────────────────────────────────────────────────────────────

/** The form for the selected block. */
export function StepEditor({ step, onChange, ctx }: { step: AutomationStep; onChange: (config: Config) => void; ctx: EditorContext }) {
  const c = step.config;
  const set = (patch: Config) => onChange({ ...c, ...patch });
  const ro = ctx.readOnly;
  const issues = ctx.issues.filter((i) => i.stepId === step.id);
  const spec = BLOCKS[step.type];
  const Icon = spec.icon;

  let body: React.ReactNode = null;
  switch (step.type) {
    case "trigger":
      body = <TriggerForm config={c} set={set} ctx={ctx} />;
      break;
    case "send_message":
      body = <SendMessageForm config={c} set={set} ctx={ctx} />;
      break;
    case "reply_comment":
      body = (
        <div className="space-y-4">
          <Field label="Reply" hint={c.mode === "public" ? "Shown to everyone under their comment." : "A DM to the commenter. Meta allows one per comment, within 7 days."}>
            <Segmented value={c.mode ?? "private"} disabled={ro} onChange={(mode) => set({ mode })} options={[["private", "Privately (DM)"], ["public", "Publicly"]]} />
          </Field>
          <Field label="Message" htmlFor="rc-text">
            <TextWithVariables id="rc-text" value={c.message ?? ""} onChange={(message) => set({ message })} ctx={ctx} maxLength={2000} />
          </Field>
        </div>
      );
      break;
    case "wait":
      body = (
        <Field label="Wait for" hint="At most 30 days.">
          <AmountUnit config={c} set={set} readOnly={ro} />
        </Field>
      );
      break;
    case "wait_for_reply":
      body = (
        <div className="space-y-4">
          <Field label="Give up after" hint="Then the “No reply” branch runs. At most 7 days.">
            <AmountUnit config={c} set={set} readOnly={ro} />
          </Field>
          <Field label="Save their reply as" hint="Optional. Kept on the contact as a field and usable as {{attr.name}}." htmlFor="wr-save">
            <Input id="wr-save" value={c.saveAs ?? ""} disabled={ro} maxLength={40} placeholder="e.g. size" onChange={(e) => set({ saveAs: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_") })} />
          </Field>
          <p className="text-micro text-muted-foreground">While someone is waiting here, their next message goes to this automation instead of starting others.</p>
        </div>
      );
      break;
    case "condition":
      body = <ConditionForm config={c} set={set} ctx={ctx} />;
      break;
    case "add_tag":
    case "remove_tag":
      body = (
        <Field label="Tags">
          <TagsInput id={`tags-${step.id}`} value={c.tags ?? []} onChange={(tags) => set({ tags })} suggestions={ctx.tags} readOnly={ro} />
        </Field>
      );
      break;
    case "set_attribute":
      body = (
        <div className="space-y-4">
          <Field label="Field name" hint="Lower case, numbers and _." htmlFor="sa-key">
            <Input id="sa-key" value={c.key ?? ""} disabled={ro} maxLength={40} placeholder="city" onChange={(e) => set({ key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_") })} />
          </Field>
          <Field label="Value" htmlFor="sa-value">
            <TextWithVariables id="sa-value" rows={2} value={c.value ?? ""} onChange={(value) => set({ value })} ctx={ctx} maxLength={500} />
          </Field>
        </div>
      );
      break;
    case "assign":
      body = (
        <div className="space-y-4">
          <Field label="Assign to" htmlFor="as-mode">
            <select id="as-mode" className={selectClass} value={c.mode} disabled={ro} onChange={(e) => set({ mode: e.target.value })}>
              <option value="round_robin">The next available agent</option>
              <option value="user">A team member</option>
              <option value="team">A team’s queue</option>
              <option value="unassign">Nobody (unassign)</option>
            </select>
          </Field>
          {c.mode === "user" && (
            <Field label="Team member" htmlFor="as-user">
              <select id="as-user" className={selectClass} value={c.userId ?? ""} disabled={ro} onChange={(e) => set({ userId: e.target.value })}>
                <option value="">Choose</option>
                {ctx.members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {(c.mode === "team" || c.mode === "round_robin") && (
            <Field label={c.mode === "team" ? "Team" : "From team"} hint={c.mode === "round_robin" ? "Online members under their limit take turns. Leave empty for everyone." : undefined} htmlFor="as-team">
              <select id="as-team" className={selectClass} value={c.teamId ?? ""} disabled={ro} onChange={(e) => set({ teamId: e.target.value })}>
                <option value="">{c.mode === "team" ? "Choose" : "Everyone"}</option>
                {ctx.teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </div>
      );
      break;
    case "set_status":
      body = (
        <div className="space-y-4">
          <Field label="Mark the conversation">
            <Segmented value={c.status ?? "closed"} disabled={ro} onChange={(status) => set({ status })} options={[["open", "Open"], ["closed", "Closed"], ["snoozed", "Snoozed"]]} />
          </Field>
          {c.status === "snoozed" && (
            <Field label="Snooze for (hours)" htmlFor="ss-hours">
              <Input id="ss-hours" type="number" min={1} max={720} value={c.hours ?? 24} disabled={ro} onChange={(e) => set({ hours: Math.max(1, Number(e.target.value) || 1) })} />
            </Field>
          )}
        </div>
      );
      break;
    case "add_note":
      body = (
        <Field label="Note" hint="Only your team sees notes." htmlFor="an-text">
          <TextWithVariables id="an-text" value={c.text ?? ""} onChange={(text) => set({ text })} ctx={ctx} maxLength={2000} />
        </Field>
      );
      break;
    case "http_request":
      body = (
        <div className="space-y-4">
          <div className="flex gap-2">
            <select className={cn(selectClass, "w-24")} value={c.method} disabled={ro} onChange={(e) => set({ method: e.target.value })} aria-label="Method">
              <option>POST</option>
              <option>GET</option>
            </select>
            <Input value={c.url ?? ""} disabled={ro} maxLength={1000} placeholder="https://your-system.example/hook" onChange={(e) => set({ url: e.target.value })} aria-label="URL" />
          </div>
          {c.method === "POST" && (
            <Field label="JSON body" hint="Variables are filled in and escaped. Empty sends {}." htmlFor="hr-body">
              <TextWithVariables id="hr-body" rows={5} value={c.body ?? ""} onChange={(body) => set({ body })} ctx={ctx} maxLength={5000} placeholder='{"phone": "{{phone}}"}' />
            </Field>
          )}
          <Field label="Save the answer as" hint="Its JSON fields become {{name.field}} for later steps; an error answer stops the run." htmlFor="hr-save">
            <Input id="hr-save" value={c.saveAs ?? ""} disabled={ro} maxLength={40} placeholder="order" onChange={(e) => set({ saveAs: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_") })} />
          </Field>
          <p className="text-micro text-muted-foreground">Requests time out after 10 seconds and cannot reach private network addresses.</p>
        </div>
      );
      break;
    case "send_invoice":
      body = (
        <div className="space-y-3">
          <p className="text-caption text-muted-foreground">
            Sends the GST invoice of the order this automation is about. The order needs an invoice: turn on automatic invoices in Settings → Orders, or issue it by hand.
          </p>
          <TemplateFields config={c} set={set} ctx={ctx} invoice />
        </div>
      );
      break;
    case "send_payment_link":
      body = (
        <div className="space-y-3">
          <p className="text-caption text-muted-foreground">
            Collects payment for the order this automation is about, or for the draft order an earlier step made from a cart. Paying marks the order paid, in Shopify too, or turns the draft into an order.
          </p>
          <Field label="How the customer pays" htmlFor="pl-method">
            <select id="pl-method" className={selectClass} value={c.method ?? "link"} disabled={ro} onChange={(e) => set({ method: e.target.value })}>
              <option value="link">A payment link from your Razorpay account</option>
              <option value="whatsapp_pay">WhatsApp Pay, inside the chat (India)</option>
            </select>
          </Field>
          {c.method === "whatsapp_pay" ? (
            <>
              <p className="rounded-lg border border-dashed p-2 text-caption text-muted-foreground">
                Sends a “Review and Pay” bill with the order’s items. Only within 24 hours of the customer’s last message (right after a cart, or after “Wait for a reply”), and the order needs a delivery address in India. Turn it on per number in Campaigns → Catalog.
              </p>
              <Field label="Message" hint="Optional; the bill’s items and total are shown either way." htmlFor="pl-wp-text">
                <TextWithVariables id="pl-wp-text" rows={2} value={c.message ?? ""} onChange={(message) => set({ message })} ctx={ctx} maxLength={1024} placeholder="Thanks {{first_name}}! Review your order and pay below." />
              </Field>
            </>
          ) : (
          <Field label="Send it as" htmlFor="pl-kind">
            <select id="pl-kind" className={selectClass} value={c.kind ?? "template"} disabled={ro} onChange={(e) => set({ kind: e.target.value })}>
              <option value="template">A WhatsApp template (works any time)</option>
              <option value="text">A message (only within 24 hours of their last message, e.g. right after a cart)</option>
            </select>
          </Field>
          )}
          {c.method === "whatsapp_pay" ? null : c.kind === "text" ? (
            <Field label="Message" hint="Put {{payment.link}} where the link should go." htmlFor="pl-text">
              <TextWithVariables id="pl-text" value={c.message ?? ""} onChange={(message) => set({ message })} ctx={ctx} maxLength={4096} placeholder="Pay {{payment.amount}} here: {{payment.link}}" />
            </Field>
          ) : (
            <TemplateFields config={c} set={set} ctx={ctx} payment />
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Link expires after (hours)" htmlFor="pl-expiry">
              <Input id="pl-expiry" type="number" min={1} max={720} value={c.expiresInHours ?? 48} disabled={ro} onChange={(e) => set({ expiresInHours: Math.min(720, Math.max(1, Number(e.target.value) || 1)) })} />
            </Field>
            <Field label="When paid, tag the order" hint="Optional, e.g. cod-to-prepaid." htmlFor="pl-tag">
              <Input id="pl-tag" value={c.tagOnPaid ?? ""} disabled={ro} maxLength={60} onChange={(e) => set({ tagOnPaid: e.target.value })} />
            </Field>
          </div>
        </div>
      );
      break;
    case "store_action":
      body = (
        <div className="space-y-4">
          <Field label="Action" htmlFor="sa-action">
            <select id="sa-action" className={selectClass} value={c.action} disabled={ro} onChange={(e) => set({ action: e.target.value })}>
              <option value="tag_order">Tag the order</option>
              <option value="note_order">Add to the order’s note</option>
              <option value="cancel_order">Cancel the order</option>
              <option value="tag_customer">Tag the store customer</option>
              <option value="create_draft_order">Make a draft order from the cart</option>
            </select>
          </Field>
          {(c.action === "tag_order" || c.action === "tag_customer") && (
            <Field label="Tag" hint={c.action === "tag_order" ? "Added in Shopify too for Shopify orders." : "Kept in Collabo; Shopify customer tags are not changed."} htmlFor="sa-value">
              <Input id="sa-value" value={c.value ?? ""} maxLength={60} disabled={ro} placeholder="cod-confirmed" onChange={(e) => set({ value: e.target.value })} />
            </Field>
          )}
          {c.action === "note_order" && (
            <Field label="Note" htmlFor="sa-note">
              <TextWithVariables id="sa-note" rows={2} value={c.value ?? ""} onChange={(value) => set({ value })} ctx={ctx} maxLength={500} />
            </Field>
          )}
          {c.action === "cancel_order" && (
            <>
              <Field label="Staff note" hint="Shown in the order’s timeline. The customer is notified, items are restocked and nothing is refunded." htmlFor="sa-cancel">
                <Input id="sa-cancel" value={c.value ?? ""} maxLength={200} disabled={ro} placeholder="Customer declined on WhatsApp" onChange={(e) => set({ value: e.target.value })} />
              </Field>
            </>
          )}
          {c.action === "create_draft_order" && (
            <p className="text-micro text-muted-foreground">
              The draft is mirrored to your Shopify store, and its checkout link becomes {"{{draft.checkout_url}}"} for the next steps. Without a Shopify store the draft stays in Collabo and the link is empty.
            </p>
          )}
        </div>
      );
      break;
    case "sheet_add_row":
      body = <SheetRowFields config={c} set={set} ctx={ctx} />;
      break;
    case "post_review":
      body = (
        <div className="space-y-4">
          <Field label="Rating" hint="Usually the saved answer to the rating question. Its first digit from 1 to 5, or its stars, is the rating." htmlFor="pr-rating">
            <TextWithVariables id="pr-rating" rows={1} value={c.rating ?? ""} onChange={(rating) => set({ rating })} ctx={ctx} maxLength={200} placeholder="{{attr.review_rating}}" />
          </Field>
          <Field label="Review" hint="Their words: {{last_reply}} is the reply just received. Without words, or with “skip”, the rating is kept in Collabo only." htmlFor="pr-text">
            <TextWithVariables id="pr-text" rows={1} value={c.text ?? ""} onChange={(text) => set({ text })} ctx={ctx} maxLength={500} placeholder="{{last_reply}}" />
          </Field>
          <Field label="Product" htmlFor="pr-products">
            <select id="pr-products" className={selectClass} value={c.products ?? "first"} disabled={ro} onChange={(e) => set({ products: e.target.value })}>
              <option value="first">The order’s first product</option>
              <option value="each">Each product in the order</option>
            </select>
          </Field>
          <Field label="Name shown" hint="Judge.me uses your store’s setting when it is stricter." htmlFor="pr-name">
            <select id="pr-name" className={selectClass} value={c.nameFormat ?? "last_initial"} disabled={ro} onChange={(e) => set({ nameFormat: e.target.value })}>
              <option value="">Full name</option>
              <option value="last_initial">First name and last initial</option>
              <option value="all_initials">Initials</option>
              <option value="anonymous">Anonymous</option>
            </select>
          </Field>
          <p className="text-micro text-muted-foreground">
            Published to the Judge.me connected in Campaigns → Reviews, with the order’s name and email. Every rating is published, high or low; Judge.me’s own settings decide what shows on your store.
          </p>
        </div>
      );
      break;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <span className="flex size-7 items-center justify-center rounded-lg bg-muted">
          <Icon className="size-4" />
        </span>
        <div>
          <p className="text-body font-semibold">{spec.label}</p>
          <p className="text-micro text-muted-foreground">{spec.hint}</p>
        </div>
      </div>
      {issues.length > 0 && (
        <ul className="space-y-1 rounded-lg bg-danger-subtle p-2.5">
          {issues.map((i) => (
            <li key={i.code} className="text-caption text-danger">
              <span className="font-semibold">{i.title}.</span> {i.body}
            </li>
          ))}
        </ul>
      )}
      {body}
    </div>
  );
}
