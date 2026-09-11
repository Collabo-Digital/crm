import { Badge } from "~/components/ui/badge";
import { RadioGroupItem } from "~/components/ui/radio-group";
import type { LabelPreset } from "~/lib/label-stock";
import { cn } from "~/lib/utils";
import { LabelThumb } from "./label-thumb";

/** How many of this run's codes each stock can and can't take. */
export interface StockFitSummary {
  unfit: number;
  testScan: number;
}

/**
 * `label` packs size, layout and modifier into one string for the aria name
 * ("50 × 25 mm — 2 up — with gap"). The card splits that back out rather than
 * parsing it, so the two can never disagree about a preset that gets edited.
 */
export function sizeTitle(p: LabelPreset): string {
  return `${p.widthMm} × ${p.heightMm} mm`;
}

export function sizeLayout(p: LabelPreset): string {
  if (p.kind === "sheet") return `${p.across * p.down} per sheet`;
  if (p.across > 1) {
    return `${p.across} across · ${p.gapXMm > 0 ? `${p.gapXMm} mm gap` : "no gap"}`;
  }
  return "1 across";
}

export function StockSizeCard({
  preset,
  selected,
  fit,
}: {
  preset: LabelPreset;
  selected: boolean;
  fit: StockFitSummary | undefined;
}) {
  const id = `stock-${preset.id}`;
  return (
    <label
      htmlFor={id}
      className={cn(
        "relative flex cursor-pointer flex-col gap-2 rounded-lg border border-border bg-card p-3 transition-colors",
        "hover:border-ink/30",
        "has-data-[state=checked]:border-ink has-data-[state=checked]:ring-1 has-data-[state=checked]:ring-ink",
      )}
    >
      {/* Visually hidden, not removed: the RadioGroup still owns roving focus
          and arrow-key selection, and `has-data-[state=checked]` needs a real
          checked element to key off. The mock shows no radio dot. */}
      <RadioGroupItem value={preset.id} id={id} className="sr-only" />

      <span className="flex items-center gap-2.5">
        <LabelThumb
          widthMm={preset.widthMm}
          heightMm={preset.heightMm}
          across={preset.across}
          gapXMm={preset.gapXMm}
        />
        <span className="min-w-0">
          <span className="block text-label text-foreground">{sizeTitle(preset)}</span>
          <span className="block text-caption text-muted-foreground">
            {preset.useCase ?? sizeLayout(preset)}
          </span>
        </span>
      </span>

      <span className="flex flex-wrap items-center gap-1">
        {preset.recommended && (
          <Badge className="bg-brand text-brand-foreground">Recommended</Badge>
        )}
        <Badge variant="outline" className="font-normal text-muted-foreground">
          {sizeLayout(preset)}
        </Badge>
        {fit && fit.unfit > 0 ? (
          <Badge className="bg-danger-subtle text-danger">
            {fit.unfit} won't fit
          </Badge>
        ) : fit && fit.testScan > 0 ? (
          <Badge className="bg-warning-subtle text-warning-strong">Test scan</Badge>
        ) : null}
      </span>

      <span className="sr-only">
        {selected ? "Selected. " : ""}
        {preset.label}
      </span>
    </label>
  );
}
