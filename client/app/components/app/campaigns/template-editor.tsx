import { useRef, useState } from "react";
import { Loader2, Paperclip, Plus, Trash2 } from "lucide-react";

import { SectionCard } from "~/components/app/section-card";
import { Button } from "~/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "~/components/ui/dropdown-menu";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import { useCampaignUploadMutation } from "~/hooks/use-campaign-mutations";
import { TEMPLATE_LANGUAGES, renderDraft, variablesIn } from "~/lib/campaign-format";
import { cn } from "~/lib/utils";
import type { TemplateCategory, TemplateDraft, TemplateDraftButton } from "~/types/api";

import { TemplatePreview } from "./template-preview";

type HeaderChoice = "NONE" | "TEXT" | "IMAGE" | "VIDEO" | "DOCUMENT" | "LOCATION";

const HEADER_ACCEPT: Record<string, string> = { IMAGE: "image/jpeg,image/png", VIDEO: "video/mp4", DOCUMENT: "application/pdf" };

const BUTTON_TYPES: Array<{ type: TemplateDraftButton["type"]; label: string }> = [
  { type: "QUICK_REPLY", label: "Quick reply" },
  { type: "URL", label: "Link" },
  { type: "PHONE_NUMBER", label: "Call" },
  { type: "COPY_CODE", label: "Copy coupon code" },
];

const selectClass = "h-8 w-full rounded-lg border bg-background px-2 text-body";

/** Lower case, digits and underscores — what Meta accepts — as the merchant types. */
const toTemplateName = (s: string) => s.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+/, "").slice(0, 512);

/**
 * The template editor: one form beside a live preview. It does not try to
 * second-guess Meta's review; the server applies Meta's documented rules on
 * submit and says exactly what to fix.
 */
export function TemplateEditor({
  initial,
  mode,
  isSubmitting,
  onSubmit,
}: {
  initial: TemplateDraft;
  mode: "create" | "edit";
  isSubmitting: boolean;
  onSubmit: (draft: TemplateDraft) => void;
}) {
  const [draft, setDraft] = useState<TemplateDraft>(initial);
  const [mediaPreview, setMediaPreview] = useState<string | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const upload = useCampaignUploadMutation();
  const locked = mode === "edit";

  const patch = (next: Partial<TemplateDraft>) => setDraft((d) => ({ ...d, ...next }));
  const headerChoice: HeaderChoice = draft.header?.format ?? "NONE";
  const bodyVars = variablesIn(draft.body.text);
  const buttons = draft.buttons ?? [];

  function setHeader(choice: HeaderChoice) {
    setMediaPreview(null);
    if (choice === "NONE") patch({ header: undefined });
    else if (choice === "TEXT") patch({ header: { format: "TEXT", text: "" } });
    else if (choice === "LOCATION") patch({ header: { format: "LOCATION" } });
    else patch({ header: { format: choice } });
  }

  /** Insert the next variable at the cursor: {{n}} or a named one. */
  function addVariable() {
    const el = bodyRef.current;
    let token: string;
    if (draft.parameterFormat === "NAMED") {
      const name = window.prompt("Variable name (lower case and underscores), e.g. first_name");
      if (!name) return;
      token = `{{${name.trim().toLowerCase().replace(/[^a-z_]+/g, "_")}}}`;
    } else {
      token = `{{${bodyVars.length + 1}}}`;
    }
    const text = draft.body.text;
    const at = el?.selectionStart ?? text.length;
    patch({ body: { ...draft.body, text: `${text.slice(0, at)}${token}${text.slice(at)}` } });
    requestAnimationFrame(() => el?.focus());
  }

  function setButton(index: number, next: TemplateDraftButton) {
    patch({ buttons: buttons.map((b, i) => (i === index ? next : b)) });
  }

  function addButton(type: TemplateDraftButton["type"]) {
    const next: TemplateDraftButton =
      type === "QUICK_REPLY"
        ? { type, text: "" }
        : type === "URL"
          ? { type, text: "", url: "https://" }
          : type === "PHONE_NUMBER"
            ? { type, text: "Call us", phoneNumber: "" }
            : { type, example: "" };
    patch({ buttons: [...buttons, next] });
  }

  async function chooseFile(file: File) {
    const uploaded = await upload.mutateAsync(file).catch(() => null);
    if (!uploaded) return;
    setMediaPreview(uploaded.kind === "image" ? URL.createObjectURL(file) : null);
    patch({ header: { format: draft.header!.format as "IMAGE", storageKey: uploaded.storageKey, mime: uploaded.mime, filename: uploaded.filename } });
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
      <div className="space-y-6">
        <SectionCard title="Basics" description={locked ? "Name, language and category cannot change after submission." : "Meta reviews the category with the content."}>
          <div className="grid gap-4 p-5 sm:grid-cols-2">
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="tpl-name">Name</Label>
              <Input
                id="tpl-name"
                value={draft.name}
                disabled={locked}
                onChange={(e) => patch({ name: toTemplateName(e.target.value) })}
                placeholder="order_shipped"
              />
              <p className="text-micro text-muted-foreground">Lower-case letters, digits and underscores. Customers never see it.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tpl-language">Language</Label>
              <select id="tpl-language" className={selectClass} value={draft.language} disabled={locked} onChange={(e) => patch({ language: e.target.value })}>
                {TEMPLATE_LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tpl-category">Category</Label>
              <select
                id="tpl-category"
                className={selectClass}
                value={draft.category}
                disabled={locked}
                onChange={(e) => patch({ category: e.target.value as TemplateCategory })}
              >
                <option value="MARKETING">Marketing — offers, news, reminders to buy</option>
                <option value="UTILITY">Utility — about an order or account</option>
              </select>
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label>Variables</Label>
              <div className="flex flex-wrap gap-2">
                {(["POSITIONAL", "NAMED"] as const).map((f) => (
                  <Button
                    key={f}
                    type="button"
                    size="sm"
                    variant={draft.parameterFormat === f ? "secondary" : "outline"}
                    disabled={locked}
                    onClick={() => patch({ parameterFormat: f })}
                  >
                    {f === "POSITIONAL" ? "Numbered — {{1}}, {{2}}" : "Named — {{first_name}}"}
                  </Button>
                ))}
              </div>
            </div>
          </div>
        </SectionCard>

        <SectionCard title="Header" description="Optional. Text up to 60 characters, or a file.">
          <div className="space-y-3 p-5">
            <div className="flex flex-wrap gap-1.5">
              {(["NONE", "TEXT", "IMAGE", "VIDEO", "DOCUMENT", "LOCATION"] as HeaderChoice[]).map((c) => (
                <Button key={c} type="button" size="xs" variant={headerChoice === c ? "secondary" : "ghost"} onClick={() => setHeader(c)}>
                  {c === "NONE" ? "None" : c[0] + c.slice(1).toLowerCase()}
                </Button>
              ))}
            </div>
            {draft.header?.format === "TEXT" && (
              <div className="grid gap-3 sm:grid-cols-2">
                <Input
                  value={draft.header.text}
                  maxLength={60}
                  onChange={(e) => patch({ header: { ...(draft.header as { format: "TEXT"; text: string }), text: e.target.value } })}
                  placeholder="Our {{1}} is live"
                  aria-label="Header text"
                />
                {variablesIn(draft.header.text).length > 0 && (
                  <Input
                    value={draft.header.example ?? ""}
                    onChange={(e) => patch({ header: { ...(draft.header as { format: "TEXT"; text: string }), example: e.target.value } })}
                    placeholder="Example for {{1}}"
                    aria-label="Header example"
                  />
                )}
              </div>
            )}
            {draft.header && ["IMAGE", "VIDEO", "DOCUMENT"].includes(draft.header.format) && (
              <div className="flex flex-wrap items-center gap-2">
                <input
                  ref={fileRef}
                  type="file"
                  className="hidden"
                  accept={HEADER_ACCEPT[draft.header.format]}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void chooseFile(file);
                    e.target.value = "";
                  }}
                />
                <Button type="button" size="sm" variant="outline" onClick={() => fileRef.current?.click()} disabled={upload.isPending}>
                  {upload.isPending ? <Loader2 className="animate-spin" /> : <Paperclip />}
                  {"storageKey" in draft.header && draft.header.storageKey ? "Replace sample" : "Upload a sample"}
                </Button>
                <span className="text-caption text-muted-foreground">
                  {"filename" in draft.header && draft.header.filename
                    ? draft.header.filename
                    : "Meta reviews this sample. Each broadcast can use its own file."}
                </span>
              </div>
            )}
          </div>
        </SectionCard>

        <SectionCard
          title="Body"
          description="Up to 1,024 characters."
          action={
            <Button type="button" size="xs" variant="outline" onClick={addVariable}>
              <Plus />
              Variable
            </Button>
          }
        >
          <div className="space-y-3 p-5">
            <Textarea
              ref={bodyRef}
              value={draft.body.text}
              maxLength={1024}
              rows={6}
              onChange={(e) => patch({ body: { ...draft.body, text: e.target.value } })}
              aria-label="Message body"
              placeholder={draft.parameterFormat === "NAMED" ? "Hi {{first_name}}, your order {{order_number}} has shipped." : "Hi {{1}}, your order {{2}} has shipped."}
            />
            <p className="text-right text-micro text-muted-foreground tabular-nums">{draft.body.text.length} / 1024</p>
            {bodyVars.length > 0 && (
              <div className="space-y-2">
                <p className="text-caption font-medium">Examples for review</p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {bodyVars.map((v) => (
                    <div key={v} className="flex items-center gap-2">
                      <span className="w-28 shrink-0 truncate font-mono text-caption text-muted-foreground">{`{{${v}}}`}</span>
                      <Input
                        value={draft.body.examples[v] ?? ""}
                        onChange={(e) => patch({ body: { ...draft.body, examples: { ...draft.body.examples, [v]: e.target.value } } })}
                        placeholder="Example value"
                        aria-label={`Example for ${v}`}
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="tpl-footer">Footer</Label>
              <Input id="tpl-footer" value={draft.footer ?? ""} maxLength={60} onChange={(e) => patch({ footer: e.target.value })} placeholder="Optional, e.g. Tap Stop promotions to opt out" />
            </div>
          </div>
        </SectionCard>

        <SectionCard
          title="Buttons"
          description="Up to 10: quick replies, up to 2 links, 1 call and 1 coupon code."
          action={
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" size="xs" variant="outline" disabled={buttons.length >= 10}>
                  <Plus />
                  Button
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {BUTTON_TYPES.map((b) => (
                  <DropdownMenuItem key={b.type} onSelect={() => addButton(b.type)}>
                    {b.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          }
        >
          <div className="space-y-2 p-5">
            {buttons.length === 0 && <p className="text-caption text-muted-foreground">No buttons. Marketing templates usually add a “Stop promotions” quick reply.</p>}
            {buttons.map((b, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2 rounded-lg border p-2">
                <span className="w-24 shrink-0 text-caption font-medium">{BUTTON_TYPES.find((t) => t.type === b.type)?.label}</span>
                {b.type !== "COPY_CODE" && (
                  <Input className="h-7 w-40" maxLength={25} value={b.text} onChange={(e) => setButton(i, { ...b, text: e.target.value })} placeholder="Label" aria-label="Button label" />
                )}
                {b.type === "URL" && (
                  <>
                    <Input className="h-7 min-w-48 flex-1" value={b.url} onChange={(e) => setButton(i, { ...b, url: e.target.value })} placeholder="https://… (add {{1}} at the end for a per-person link)" aria-label="Link" />
                    {variablesIn(b.url).length > 0 && (
                      <Input className="h-7 w-32" value={b.example ?? ""} onChange={(e) => setButton(i, { ...b, example: e.target.value })} placeholder="Example" aria-label="Link example" />
                    )}
                  </>
                )}
                {b.type === "PHONE_NUMBER" && (
                  <Input className="h-7 w-44" value={b.phoneNumber} onChange={(e) => setButton(i, { ...b, phoneNumber: e.target.value })} placeholder="+91 98450 12345" aria-label="Phone number" />
                )}
                {b.type === "COPY_CODE" && (
                  <Input className="h-7 w-40" maxLength={20} value={b.example} onChange={(e) => setButton(i, { ...b, example: e.target.value })} placeholder="Example code" aria-label="Example coupon code" />
                )}
                <Button type="button" variant="ghost" size="icon-xs" className="ml-auto" onClick={() => patch({ buttons: buttons.filter((_, j) => j !== i) })} aria-label="Remove button">
                  <Trash2 />
                </Button>
              </div>
            ))}
          </div>
        </SectionCard>
      </div>

      <div className="space-y-4 lg:sticky lg:top-6 lg:self-start">
        <p className="text-caption font-medium text-muted-foreground">Preview</p>
        <TemplatePreview render={renderDraft(draft)} mediaUrl={mediaPreview} buttonKinds={buttons.map((b) => b.type)} />
        <Button
          variant="accent"
          className={cn("w-full")}
          disabled={isSubmitting || !draft.name || !draft.body.text.trim()}
          onClick={() => onSubmit({ ...draft, footer: draft.footer?.trim() || undefined })}
        >
          {isSubmitting && <Loader2 className="animate-spin" />}
          {mode === "edit" ? "Submit changes for review" : "Submit for review"}
        </Button>
        <p className="text-micro text-muted-foreground">
          Meta usually reviews within minutes, sometimes up to a day. The status here updates by itself.
          {mode === "edit" && " Approved templates can be edited once a day and 10 times a month."}
        </p>
      </div>
    </div>
  );
}
