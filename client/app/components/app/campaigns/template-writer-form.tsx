import { Loader2, Sparkles } from "lucide-react";

import { Button } from "~/components/ui/button";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import { TEMPLATE_LANGUAGES } from "~/lib/campaign-format";
import type { WriteTemplateRequest } from "~/types/api";

const selectClass = "h-9 w-full min-w-0 rounded-lg border bg-background px-2 text-body";

const IDEAS = [
  "Tell customers their order has shipped, with a button to track the parcel",
  "Remind people who left items in their cart that delivery is free over ₹999",
  "Announce our Diwali sale with the code DIWALI20 and a link to shop",
  "Ask for a review a week after delivery",
];

export interface WriterBrief {
  brief: string;
  language: string;
  category: "" | "MARKETING" | "UTILITY";
}

export const EMPTY_BRIEF: WriterBrief = { brief: "", language: "en", category: "" };

/** Describe a message in your own words; the AI writes a template draft to edit. */
export function TemplateWriterForm({
  value,
  onChange,
  onSubmit,
  onCancel,
  isWriting,
  draftsPerDay,
}: {
  value: WriterBrief;
  onChange: (value: WriterBrief) => void;
  onSubmit: (request: WriteTemplateRequest) => void;
  onCancel: () => void;
  isWriting: boolean;
  draftsPerDay: number;
}) {
  const ready = value.brief.trim().length >= 10;
  return (
    <form
      className="max-w-2xl space-y-4 rounded-xl border bg-card p-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) onSubmit({ brief: value.brief.trim(), language: value.language, ...(value.category ? { category: value.category } : {}) });
      }}
    >
      <div className="flex items-center gap-2">
        <Sparkles className="size-4 text-brand" />
        <h2 className="text-body font-semibold">Write with AI</h2>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="writer-brief">What should the message do?</Label>
        <Textarea
          id="writer-brief"
          rows={4}
          maxLength={1000}
          value={value.brief}
          disabled={isWriting}
          onChange={(e) => onChange({ ...value, brief: e.target.value })}
          placeholder="For example: tell customers their order has shipped, with a button to track the parcel."
        />
        <div className="-mx-5 flex gap-1.5 overflow-x-auto px-5 pb-1 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:px-0">
          {IDEAS.map((idea) => (
            <button
              key={idea}
              type="button"
              disabled={isWriting}
              onClick={() => onChange({ ...value, brief: idea })}
              className="shrink-0 whitespace-nowrap rounded-full border px-2.5 py-1 text-left text-micro text-muted-foreground hover:border-brand hover:text-foreground sm:shrink sm:whitespace-normal"
            >
              {idea}
            </button>
          ))}
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="min-w-0 space-y-1.5">
          <Label htmlFor="writer-language">Language</Label>
          <select id="writer-language" className={selectClass} value={value.language} disabled={isWriting} onChange={(e) => onChange({ ...value, language: e.target.value })}>
            {TEMPLATE_LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
        </div>
        <div className="min-w-0 space-y-1.5">
          <Label htmlFor="writer-category">Category</Label>
          <select
            id="writer-category"
            className={selectClass}
            value={value.category}
            disabled={isWriting}
            onChange={(e) => onChange({ ...value, category: e.target.value as WriterBrief["category"] })}
          >
            <option value="">Let the AI choose</option>
            <option value="UTILITY">Utility: about their order or account</option>
            <option value="MARKETING">Marketing: offers and announcements</option>
          </select>
        </div>
      </div>
      <p className="text-micro text-muted-foreground">
        Your description and your store’s name and website go to Anthropic’s Claude to write the draft. Nothing reaches Meta until you submit it. Your team can write {draftsPerDay} drafts a day.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={!ready || isWriting}>
          {isWriting ? <Loader2 className="animate-spin" /> : <Sparkles />}
          {isWriting ? "Writing…" : "Write draft"}
        </Button>
        <Button type="button" variant="ghost" disabled={isWriting} onClick={onCancel}>
          Back
        </Button>
      </div>
    </form>
  );
}
