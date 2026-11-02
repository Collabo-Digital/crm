import { useRef, useState } from "react";
import { ArrowLeft, Loader2, Paperclip, Send } from "lucide-react";

import { TemplatePreview } from "~/components/app/campaigns/template-preview";
import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { useInboxTemplates } from "~/hooks/use-campaign-queries";
import { useUploadMutation } from "~/hooks/use-inbox-mutations";
import { CATEGORY_LABEL, buildSendComponents, renderDraft } from "~/lib/campaign-format";
import type { InboxSendPayload, InboxUpload, MessageTemplate, TemplateParam } from "~/types/api";

/** A first name to prefill with, or nothing when all we have is a number. */
const firstName = (name: string) => {
  const first = name.replace(/^@/, "").split(/\s+/)[0] ?? "";
  return /\p{L}/u.test(first) ? first : "";
};

function startValues(t: MessageTemplate, contactName: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const p of t.params) {
    if (p.component === "header" && p.kind !== "text") continue;
    values[p.key] = /name/i.test(p.name) ? firstName(contactName) : "";
  }
  return values;
}

const labelOf = (p: TemplateParam) =>
  p.kind === "coupon_code" ? "Coupon code" : p.component === "button" ? `Link button ${Number(p.buttonIndex) + 1}` : p.component === "header" ? "Header" : `{{${p.name}}}`;

/**
 * Send an approved template from the inbox — the only way to write first, or
 * again after WhatsApp's 24-hour window has closed.
 */
export function TemplatePickerDialog({
  open,
  onOpenChange,
  contactName,
  isSending,
  onSend,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contactName: string;
  isSending: boolean;
  /** Resolves true when the server accepted it. */
  onSend: (payload: InboxSendPayload) => Promise<boolean>;
}) {
  const { data: templates = [], isLoading } = useInboxTemplates(open);
  const upload = useUploadMutation();
  const [chosen, setChosen] = useState<MessageTemplate | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [file, setFile] = useState<InboxUpload | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const mediaParam = chosen?.params.find((p) => p.component === "header" && p.kind !== "text" && p.kind !== "location");
  const textParams = chosen?.params.filter((p) => !(p.component === "header" && p.kind !== "text")) ?? [];
  const ready = !!chosen && textParams.every((p) => values[p.key]?.trim()) && (!mediaParam || !!file);

  function close(next: boolean) {
    if (!next) {
      setChosen(null);
      setFile(null);
      setPreview(null);
    }
    onOpenChange(next);
  }

  async function send() {
    if (!chosen || !ready) return;
    const ok = await onSend({
      type: "template",
      name: chosen.name,
      language: chosen.language,
      category: chosen.category,
      components: buildSendComponents(chosen.params, chosen.parameterFormat, values),
      previewText: render?.body,
      ...(file && mediaParam ? { headerMedia: { storageKey: file.storageKey, mime: file.mime, kind: mediaParam.kind as "image", filename: file.filename } } : {}),
    });
    if (ok) close(false);
  }

  const render = chosen
    ? renderDraft({
        ...chosen.draft,
        header: chosen.draft.header?.format === "TEXT" ? { ...chosen.draft.header, example: values.header } : chosen.draft.header,
        body: { ...chosen.draft.body, examples: Object.fromEntries(textParams.filter((p) => p.component === "body").map((p) => [p.name, values[p.key] ?? ""])) },
      })
    : null;

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{chosen ? chosen.name : "Send a template"}</DialogTitle>
          <DialogDescription>
            {chosen ? `To ${contactName}. Fill in the values, then send.` : "Only Meta-approved templates can start or restart a WhatsApp conversation."}
          </DialogDescription>
        </DialogHeader>

        {!chosen ? (
          isLoading ? (
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          ) : templates.length === 0 ? (
            <p className="text-body text-muted-foreground">No approved templates yet. Someone with Campaigns access can create them under Campaigns → Templates.</p>
          ) : (
            <div className="grid max-h-[60vh] gap-3 overflow-y-auto sm:grid-cols-2">
              {templates.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => {
                    setChosen(t);
                    setValues(startValues(t, contactName));
                  }}
                  className="flex flex-col gap-2 rounded-xl border p-3 text-left hover:border-brand"
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate font-mono text-caption font-medium">{t.name}</span>
                    <span className="text-micro text-muted-foreground">{CATEGORY_LABEL[t.category]}</span>
                  </span>
                  <TemplatePreview render={t.preview} className="max-w-none" />
                </button>
              ))}
            </div>
          )
        ) : (
          <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_260px]">
            <div className="space-y-2.5">
              {mediaParam && (
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    ref={fileRef}
                    type="file"
                    className="hidden"
                    accept={mediaParam.kind === "image" ? "image/jpeg,image/png" : mediaParam.kind === "video" ? "video/mp4" : "application/pdf"}
                    onChange={async (e) => {
                      const f = e.target.files?.[0];
                      e.target.value = "";
                      if (!f) return;
                      const uploaded = await upload.mutateAsync(f).catch(() => null);
                      if (uploaded) {
                        setFile(uploaded);
                        setPreview(uploaded.mediaKind === "image" ? URL.createObjectURL(f) : null);
                      }
                    }}
                  />
                  <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()} disabled={upload.isPending}>
                    {upload.isPending ? <Loader2 className="animate-spin" /> : <Paperclip />}
                    Header {mediaParam.kind}
                  </Button>
                  <span className="truncate text-caption text-muted-foreground">{file?.filename ?? "Required"}</span>
                </div>
              )}
              {textParams.map((p) => (
                <div key={p.key} className="flex items-center gap-2">
                  <span className="w-28 shrink-0 truncate font-mono text-caption text-muted-foreground">{labelOf(p)}</span>
                  <Input
                    value={values[p.key] ?? ""}
                    onChange={(e) => setValues((v) => ({ ...v, [p.key]: e.target.value }))}
                    placeholder={p.example ?? ""}
                    aria-label={labelOf(p)}
                  />
                </div>
              ))}
              <div className="flex justify-between gap-2 pt-2">
                <Button variant="ghost" size="sm" onClick={() => setChosen(null)}>
                  <ArrowLeft />
                  Other templates
                </Button>
                <Button variant="accent" size="sm" disabled={!ready || isSending} onClick={() => void send()}>
                  {isSending ? <Loader2 className="animate-spin" /> : <Send />}
                  Send template
                </Button>
              </div>
            </div>
            {render && <TemplatePreview render={render} mediaUrl={preview} buttonKinds={chosen.draft.buttons?.map((b) => b.type)} />}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
