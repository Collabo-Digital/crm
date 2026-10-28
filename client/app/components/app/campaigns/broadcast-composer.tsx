import { useMemo, useRef, useState } from "react";
import { AlertTriangle, ChevronLeft, ChevronRight, Loader2, Paperclip, Send, Users } from "lucide-react";

import { SectionCard } from "~/components/app/section-card";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  useCampaignUploadMutation,
  useSendBroadcastMutation,
  useTestBroadcastMutation,
  useUpdateBroadcastMutation,
} from "~/hooks/use-campaign-mutations";
import { useBroadcastPreview, useBroadcasts, useSegments, useTemplates } from "~/hooks/use-campaign-queries";
import { useContactTags } from "~/hooks/use-inbox-queries";
import { CATEGORY_LABEL, VARIABLE_SOURCE_LABEL, renderBroadcast } from "~/lib/campaign-format";
import { serverMessage } from "~/lib/handle-mutation-error";
import { cn, formatCurrency } from "~/lib/utils";
import type {
  BroadcastAudience,
  BroadcastDetail,
  BroadcastVariables,
  MessageTemplate,
  TemplateParam,
  VariableSource,
  VariableSourceKind,
} from "~/types/api";

import { COMPOSER_STEPS, ComposerSteps } from "./composer-steps";
import { QualityDot } from "./template-status";
import { TemplatePreview } from "./template-preview";

const selectClass = "h-8 min-w-0 max-w-full rounded-lg border bg-background px-2 text-body";

/** A sensible first mapping: name-like values from the contact, the rest typed in. */
function defaultValues(params: TemplateParam[]): BroadcastVariables["values"] {
  const values: BroadcastVariables["values"] = {};
  for (const p of params) {
    if (p.component === "header" && p.kind !== "text") continue;
    values[p.key] = /name/i.test(p.name) ? { source: "first_name", fallback: "there" } : { source: "static", value: "" };
  }
  return values;
}

/** Multi-select as toggleable rows, for segments and past broadcasts. */
function PickList({ items, value, onChange, empty }: { items: Array<{ id: string; label: string; hint?: string }>; value: string[]; onChange: (v: string[]) => void; empty: string }) {
  if (!items.length) return <p className="text-caption text-muted-foreground">{empty}</p>;
  return (
    <div className="max-h-56 space-y-1 overflow-y-auto rounded-lg border p-1.5">
      {items.map((item) => (
        <label key={item.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-body hover:bg-muted">
          <Checkbox checked={value.includes(item.id)} onCheckedChange={(on) => onChange(on === true ? [...value, item.id] : value.filter((v) => v !== item.id))} />
          <span className="flex-1 truncate">{item.label}</span>
          {item.hint && <span className="text-caption tabular-nums text-muted-foreground">{item.hint}</span>}
        </label>
      ))}
    </div>
  );
}

/** Comma-separated tag entry with suggestions. */
function TagInput({ value, onChange, suggestions, id }: { value: string[]; onChange: (v: string[]) => void; suggestions: string[]; id: string }) {
  const joined = value.join(", ");
  const [text, setText] = useState(joined);
  // Follow the saved tags when they change, so the box never shows a value that was not saved.
  const [shown, setShown] = useState(joined);
  if (shown !== joined) {
    setShown(joined);
    setText(joined);
  }
  return (
    <>
      <Input
        id={id}
        value={text}
        list={`${id}-list`}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => onChange([...new Set(text.split(",").map((t) => t.trim()).filter(Boolean))])}
        placeholder="vip, diwali-list"
      />
      <datalist id={`${id}-list`}>
        {suggestions.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
    </>
  );
}

/**
 * The broadcast composer. Works on a server-side draft: every step saves as
 * it changes, so leaving and coming back loses nothing, and the review is
 * computed by the server from exactly what will be sent.
 */
export function BroadcastComposer({ broadcast }: { broadcast: BroadcastDetail }) {
  const [step, setStep] = useState(() => (broadcast.templateId ? 2 : broadcast.audience.segmentIds.length || broadcast.audience.tags.length || broadcast.audience.everyone ? 1 : 0));
  const [reached, setReached] = useState(step);
  const [timing, setTiming] = useState<"now" | "later">("now");
  const [scheduledFor, setScheduledFor] = useState("");
  const [testPhone, setTestPhone] = useState("");
  const [name, setName] = useState(broadcast.name);
  const [campaign, setCampaign] = useState(broadcast.campaign ?? "");
  const [headerPreview, setHeaderPreview] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const update = useUpdateBroadcastMutation(broadcast.id);
  const upload = useCampaignUploadMutation();
  const test = useTestBroadcastMutation(broadcast.id);
  const send = useSendBroadcastMutation(broadcast.id);
  const { data: segments = [], isSuccess: segmentsLoaded } = useSegments();
  const { data: tagRows = [] } = useContactTags();
  const { data: past } = useBroadcasts({ status: "COMPLETED", limit: 50 });
  const { data: templates = [], isLoading: templatesLoading } = useTemplates({ status: "APPROVED" });
  const review = useBroadcastPreview(broadcast.id, step === 3);

  const audience = broadcast.audience;
  const vars = broadcast.variables;
  const template = broadcast.template;
  const params = template?.params ?? [];
  const mediaParam = params.find((p) => p.component === "header" && p.kind !== "text" && p.kind !== "location");
  const tags = tagRows.map((t) => t.tag);

  // Each change is built from the draft as it stands when made, not from this render.
  const setAudience = (patch: Partial<BroadcastAudience>) => update.save((d) => ({ audience: { ...d.audience, ...patch } }));
  const setExclude = (patch: Partial<BroadcastAudience["exclude"]>) =>
    update.save((d) => ({ audience: { ...d.audience, exclude: { ...d.audience.exclude, ...patch } } }));
  const setValue = (key: string, source: VariableSource) =>
    update.save((d) => ({ variables: { ...d.variables, values: { ...d.variables.values, [key]: source } } }));

  const chooseTemplate = (t: MessageTemplate) => update.save(() => ({ templateId: t.id, variables: { values: defaultValues(t.params) } }));

  // A ticked segment that no longer exists is listed too, so it can be unticked.
  const segmentItems = (selected: string[], hint: boolean) => [
    ...segments.map((s) => ({ id: s.id, label: s.name, hint: hint ? s.lastCount?.toLocaleString("en-IN") : undefined })),
    ...(segmentsLoaded ? selected.filter((id) => !segments.some((s) => s.id === id)).map((id) => ({ id, label: "Deleted segment" })) : []),
  ];

  const audienceChosen = audience.everyone || audience.segmentIds.length > 0 || audience.tags.length > 0;
  const valuesFilled = params
    .filter((p) => !(p.component === "header" && p.kind !== "text"))
    .every((p) => {
      const s = vars.values[p.key];
      return !!s && (s.source !== "static" || !!s.value?.trim()) && (s.source !== "attribute" || !!s.value?.trim());
    }) && (!mediaParam || !!vars.headerMedia);
  const canAdvance = [audienceChosen, !!template, valuesFilled, true][step];

  const previewRender = useMemo(() => (template ? renderBroadcast(template, vars) : null), [template, vars]);

  function go(next: number) {
    setStep(next);
    setReached((r) => Math.max(r, next));
  }

  async function chooseHeaderFile(file: File) {
    const uploaded = await upload.mutateAsync(file).catch(() => null);
    if (!uploaded) return;
    setHeaderPreview(uploaded.kind === "image" ? URL.createObjectURL(file) : null);
    update.save((d) => ({ variables: { ...d.variables, headerMedia: { storageKey: uploaded.storageKey, mime: uploaded.mime, kind: uploaded.kind, filename: uploaded.filename } } }));
  }

  const r = review.data;

  return (
    <div className="space-y-5 pb-20 md:pb-0">
      <div className="grid gap-3 rounded-xl bg-card p-4 shadow-sm ring-1 ring-border sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="bc-name">Broadcast name</Label>
          <Input id="bc-name" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name !== broadcast.name && update.save(() => ({ name }))} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="bc-campaign">Group</Label>
          <Input
            id="bc-campaign"
            value={campaign}
            onChange={(e) => setCampaign(e.target.value)}
            onBlur={() => campaign !== (broadcast.campaign ?? "") && update.save(() => ({ campaign: campaign || null }))}
            placeholder="Optional — groups broadcasts in reports"
          />
        </div>
      </div>

      <ComposerSteps current={step} reached={reached} onSelect={go} />

      <SectionCard
        title={COMPOSER_STEPS[step]}
        description={
          [
            "Who receives it, and who is left out.",
            "An approved WhatsApp template. Broadcasts can only send templates.",
            "Where each value in the template comes from, per person.",
            "Check the numbers, send yourself a test, then send or schedule.",
          ][step]
        }
        action={update.isPending ? <span className="text-micro text-muted-foreground">Saving…</span> : undefined}
      >
        <div className="p-4 sm:p-5">
          {step === 0 && (
            <div className="grid gap-6 lg:grid-cols-2">
              <div className="space-y-4">
                <label className="flex items-center gap-2 text-body">
                  <Checkbox checked={audience.everyone} onCheckedChange={(on) => setAudience({ everyone: on === true })} />
                  Everyone on this WhatsApp number
                </label>
                {!audience.everyone && (
                  <>
                    <div className="space-y-1.5">
                      <Label>Segments</Label>
                      <PickList
                        items={segmentItems(audience.segmentIds, true)}
                        value={audience.segmentIds}
                        onChange={(segmentIds) => setAudience({ segmentIds })}
                        empty="No segments yet. Build one under Segments."
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="bc-tags">Or anyone tagged</Label>
                      <TagInput id="bc-tags" value={audience.tags} onChange={(t) => setAudience({ tags: t })} suggestions={tags} />
                    </div>
                  </>
                )}
              </div>
              <div className="space-y-4">
                <p className="text-caption font-semibold uppercase tracking-wider text-muted-foreground">Leave out</p>
                <div className="space-y-1.5">
                  <Label>People in these segments</Label>
                  <PickList
                    items={segmentItems(audience.exclude.segmentIds, false)}
                    value={audience.exclude.segmentIds}
                    onChange={(segmentIds) => setExclude({ segmentIds })}
                    empty="No segments."
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="bc-exclude-tags">People tagged</Label>
                  <TagInput id="bc-exclude-tags" value={audience.exclude.tags} onChange={(t) => setExclude({ tags: t })} suggestions={tags} />
                </div>
                <div className="space-y-1.5">
                  <Label>People who already received</Label>
                  <PickList
                    items={(past?.data ?? []).filter((b) => b.id !== broadcast.id).map((b) => ({ id: b.id, label: b.name, hint: b.stats.sent.toLocaleString("en-IN") }))}
                    value={audience.exclude.broadcastIds}
                    onChange={(broadcastIds) => setExclude({ broadcastIds })}
                    empty="No sent broadcasts yet."
                  />
                </div>
                <label className="flex flex-wrap items-center gap-2 text-body">
                  <Checkbox
                    checked={audience.exclude.messagedWithinHours !== null}
                    onCheckedChange={(on) => setExclude({ messagedWithinHours: on === true ? 24 : null })}
                  />
                  People sent any broadcast in the last
                  <Input
                    type="number"
                    min={1}
                    max={720}
                    className="h-7 w-16"
                    disabled={audience.exclude.messagedWithinHours === null}
                    value={audience.exclude.messagedWithinHours ?? 24}
                    onChange={(e) => setExclude({ messagedWithinHours: Math.min(720, Math.max(1, Number(e.target.value) || 1)) })}
                    aria-label="Hours"
                  />
                  hours
                </label>
                <label className="flex items-center gap-2 text-body">
                  <Checkbox checked={audience.requireOptIn} onCheckedChange={(on) => setAudience({ requireOptIn: on === true })} />
                  Only people with a recorded opt-in
                </label>
                <p className="text-micro text-muted-foreground">Blocked contacts are always left out, and people who opted out never get marketing.</p>
              </div>
            </div>
          )}

          {step === 1 &&
            (templatesLoading ? (
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            ) : templates.length === 0 ? (
              <p className="text-body text-muted-foreground">No approved templates yet. Create one under Templates and wait for Meta’s approval.</p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {templates.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => chooseTemplate(t)}
                    aria-pressed={t.id === broadcast.templateId}
                    className={cn(
                      "flex flex-col gap-3 rounded-xl border p-3 text-left transition-colors hover:bg-muted/50",
                      t.id === broadcast.templateId && "border-brand ring-2 ring-brand/40",
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-mono text-caption font-medium">{t.name}</span>
                      <span className="shrink-0 text-micro text-muted-foreground">{CATEGORY_LABEL[t.category]} · {t.language}</span>
                    </div>
                    <TemplatePreview render={t.preview} buttonKinds={t.draft.buttons?.map((b) => b.type)} className="max-w-none" />
                    <QualityDot score={t.qualityScore} />
                  </button>
                ))}
              </div>
            ))}

          {step === 2 && template && (
            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
              <div className="space-y-3">
                {mediaParam && (
                  <div className="flex flex-wrap items-center gap-2 rounded-lg border p-3">
                    <span className="w-32 text-caption font-medium">Header {mediaParam.kind}</span>
                    <input
                      ref={fileRef}
                      type="file"
                      className="hidden"
                      accept={mediaParam.kind === "image" ? "image/jpeg,image/png" : mediaParam.kind === "video" ? "video/mp4" : "application/pdf"}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) void chooseHeaderFile(f);
                        e.target.value = "";
                      }}
                    />
                    <Button type="button" size="sm" variant="outline" onClick={() => fileRef.current?.click()} disabled={upload.isPending}>
                      {upload.isPending ? <Loader2 className="animate-spin" /> : <Paperclip />}
                      {vars.headerMedia ? "Replace" : "Upload"}
                    </Button>
                    <span className="text-caption text-muted-foreground">{vars.headerMedia?.filename ?? "Everyone gets the same file."}</span>
                  </div>
                )}
                {params
                  .filter((p) => !(p.component === "header" && p.kind !== "text"))
                  .map((p) => {
                    const s = vars.values[p.key] ?? { source: "static" as const, value: "" };
                    const label =
                      p.kind === "coupon_code" ? "Coupon code" : p.component === "button" ? `Link button ${Number(p.buttonIndex) + 1}` : p.component === "header" ? "Header" : `{{${p.name}}}`;
                    return (
                      <div key={p.key} className="flex flex-wrap items-center gap-2 rounded-lg border p-3">
                        <span className="w-32 truncate font-mono text-caption font-medium" title={p.example ? `Example: ${p.example}` : undefined}>
                          {label}
                        </span>
                        <select
                          className={selectClass}
                          value={s.source}
                          onChange={(e) => setValue(p.key, { source: e.target.value as VariableSourceKind, value: "", fallback: s.fallback })}
                          aria-label={`Source for ${label}`}
                        >
                          {(Object.keys(VARIABLE_SOURCE_LABEL) as VariableSourceKind[]).map((k) => (
                            <option key={k} value={k}>
                              {VARIABLE_SOURCE_LABEL[k]}
                            </option>
                          ))}
                        </select>
                        {(s.source === "static" || s.source === "attribute") && (
                          <Input
                            key={`${p.key}-${s.source}`}
                            className="h-8 min-w-40 flex-1"
                            defaultValue={s.value ?? ""}
                            placeholder={s.source === "static" ? p.example ?? "Text" : "Attribute name, e.g. city"}
                            onBlur={(e) => e.target.value !== (s.value ?? "") && setValue(p.key, { ...s, value: e.target.value })}
                            aria-label={`Value for ${label}`}
                          />
                        )}
                        {s.source !== "static" && (
                          <Input
                            key={`${p.key}-fallback`}
                            className="h-8 w-36"
                            defaultValue={s.fallback ?? ""}
                            placeholder="If missing…"
                            onBlur={(e) => e.target.value !== (s.fallback ?? "") && setValue(p.key, { ...s, fallback: e.target.value })}
                            aria-label={`Fallback for ${label}`}
                          />
                        )}
                      </div>
                    );
                  })}
                <p className="text-micro text-muted-foreground">
                  Without a fallback, people missing a value are left out rather than sent a message with a gap.
                </p>
              </div>
              {previewRender && <TemplatePreview render={previewRender} mediaUrl={headerPreview} buttonKinds={template.draft.buttons?.map((b) => b.type)} />}
            </div>
          )}

          {step === 3 &&
            (review.isError ? (
              <div className="flex flex-wrap items-start gap-2 rounded-lg bg-danger-subtle px-3 py-2 text-caption text-danger">
                <AlertTriangle className="mt-px size-4 shrink-0" />
                <span className="flex-1">{serverMessage(review.error, "The review could not be worked out.")}</span>
                <Button size="sm" variant="outline" onClick={() => void review.refetch()} disabled={review.isFetching}>
                  Try again
                </Button>
              </div>
            ) : review.isLoading || !r ? (
              <div className="flex items-center gap-2 text-caption text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Working out who receives it…
              </div>
            ) : (
              <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
                <div className="space-y-5">
                  {r.blockers.map((b) => (
                    <p key={b} className="flex items-start gap-2 rounded-lg bg-danger-subtle px-3 py-2 text-caption text-danger">
                      <AlertTriangle className="mt-px size-4 shrink-0" />
                      {b}
                    </p>
                  ))}
                  {r.warnings.map((w) => (
                    <p key={w} className="flex items-start gap-2 rounded-lg bg-warning-subtle px-3 py-2 text-caption text-warning-strong">
                      <AlertTriangle className="mt-px size-4 shrink-0" />
                      {w}
                    </p>
                  ))}
                  <div className="grid gap-4 sm:grid-cols-3">
                    <div>
                      <p className="text-micro uppercase tracking-wider text-muted-foreground">Will receive</p>
                      <p className="mt-1 flex items-center gap-1.5 text-section font-semibold tabular-nums">
                        <Users className="size-4 text-muted-foreground" />
                        {r.audience.sending.toLocaleString("en-IN")}
                      </p>
                      <p className="text-micro text-muted-foreground">of {r.audience.total.toLocaleString("en-IN")} in the audience</p>
                    </div>
                    <div className="sm:col-span-2">
                      <p className="text-micro uppercase tracking-wider text-muted-foreground">Estimated Meta cost</p>
                      {r.cost.ratesConfigured ? (
                        <>
                          <p className="mt-1 text-section font-semibold tabular-nums">
                            {r.cost.totals.length ? r.cost.totals.map((t) => formatCurrency(t.amount, t.currency)).join(" + ") : "—"}
                          </p>
                          <p className="text-micro text-muted-foreground">
                            {r.cost.category ? `${CATEGORY_LABEL[r.cost.category]} rates you entered` : ""}
                            {r.cost.unpriced ? ` · ${r.cost.unpriced} people in countries without a rate` : ""}
                          </p>
                        </>
                      ) : (
                        <p className="mt-1 text-caption text-muted-foreground">Add your rates from Meta’s rate card on the Campaigns overview to see an estimate.</p>
                      )}
                    </div>
                  </div>
                  {Object.keys(r.audience.skipped).length > 0 && (
                    <div className="space-y-1">
                      <p className="text-caption font-medium">Left out</p>
                      {Object.entries(r.audience.skipped).map(([reason, count]) => (
                        <p key={reason} className="flex justify-between text-caption text-muted-foreground">
                          <span>{r.audience.skippedLabels[reason] ?? reason}</span>
                          <span className="tabular-nums">{count.toLocaleString("en-IN")}</span>
                        </p>
                      ))}
                    </div>
                  )}
                  {r.limit && (
                    <p className="text-caption text-muted-foreground">
                      Messaging limit: {r.limit.limit.toLocaleString("en-IN")} people a day · about {(r.limit.usedToday ?? 0).toLocaleString("en-IN")} used in the last 24 hours.
                    </p>
                  )}

                  <div className="space-y-2 rounded-lg border p-3">
                    <Label htmlFor="bc-test">Send a test first</Label>
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <Input id="bc-test" value={testPhone} onChange={(e) => setTestPhone(e.target.value)} placeholder="+91 98450 12345" />
                      <Button variant="outline" disabled={test.isPending || testPhone.replace(/\D/g, "").length < 8 || !!r.blockers.find((b) => /template/.test(b))} onClick={() => test.mutate(testPhone)}>
                        {test.isPending && <Loader2 className="animate-spin" />}
                        Send test
                      </Button>
                    </div>
                    <p className="text-micro text-muted-foreground">Values missing for that number use the template’s examples.</p>
                  </div>

                  <div className="space-y-2">
                    <Label>When</Label>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button size="sm" variant={timing === "now" ? "secondary" : "outline"} onClick={() => setTiming("now")}>
                        Send now
                      </Button>
                      <Button size="sm" variant={timing === "later" ? "secondary" : "outline"} onClick={() => setTiming("later")}>
                        Schedule
                      </Button>
                      {timing === "later" && (
                        <Input type="datetime-local" className="w-56" value={scheduledFor} onChange={(e) => setScheduledFor(e.target.value)} aria-label="Send at" />
                      )}
                    </div>
                  </div>
                </div>
                <div className="space-y-3">
                  <p className="text-caption font-medium text-muted-foreground">As it will arrive</p>
                  {r.sample.length === 0 && previewRender && <TemplatePreview render={previewRender} mediaUrl={headerPreview} />}
                  {r.sample.map((s, i) => (
                    <div key={i} className="space-y-1">
                      <p className="text-micro text-muted-foreground">To {s.contact}</p>
                      <TemplatePreview render={s.preview} mediaUrl={headerPreview} buttonKinds={template?.draft.buttons?.map((b) => b.type)} />
                    </div>
                  ))}
                </div>
              </div>
            ))}
        </div>

        <div className="fixed inset-x-4 bottom-[calc(var(--mobile-nav-height)+0.5rem)] z-30 flex items-center justify-between gap-3 rounded-xl border bg-card p-3 shadow-lg md:static md:rounded-none md:border-0 md:border-t md:px-5 md:py-4 md:shadow-none">
          <Button variant="outline" size="sm" disabled={step === 0} onClick={() => go(step - 1)}>
            <ChevronLeft />
            Back
          </Button>
          {step === COMPOSER_STEPS.length - 1 ? (
            <Button
              variant="accent"
              size="sm"
              disabled={!r?.ready || review.isError || send.isPending || (timing === "later" && !scheduledFor)}
              onClick={() => send.mutate(timing === "later" && scheduledFor ? new Date(scheduledFor).toISOString() : undefined)}
            >
              {send.isPending ? <Loader2 className="animate-spin" /> : <Send />}
              {timing === "now" ? `Send to ${r?.audience.sending.toLocaleString("en-IN") ?? "…"}` : "Schedule"}
            </Button>
          ) : (
            <Button variant="accent" size="sm" disabled={!canAdvance || update.isPending} onClick={() => go(step + 1)}>
              Next
              <ChevronRight />
            </Button>
          )}
        </div>
      </SectionCard>
    </div>
  );
}
