/**
 * Printer quality, bar width and positioning — collapsed by default.
 *
 * The route forces it open whenever any value here is away from what the chosen
 * stock implies. A collapsed panel silently shifting the output by 2 mm is how
 * "why is my print offset" tickets are made.
 *
 * Note what is deliberately NOT offered: a way to make an oversized code fit.
 * `unfit` is reached when `availableMm / totalModules` falls below the scanner
 * floor, and that ratio has no dpi term — a finer printer buys finer steps
 * above the floor, never a lower floor. Offering dpi as a remedy here would be
 * the same lie the old hint text told.
 */
import { ChevronDown } from "lucide-react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { dotPitchMm } from "~/lib/barcode";
import type { LabelOptions } from "~/lib/label-options";
import type { ResolvedProfile } from "~/lib/label-stock";
import { cn } from "~/lib/utils";

const DPI_OPTIONS = [
  { value: 203, label: "203 dpi", help: "Most thermal label printers" },
  { value: 300, label: "300 dpi", help: "Higher-end thermal printers" },
  { value: 600, label: "600 dpi", help: "Office laser printers" },
];

const NUDGE_STEP_MM = 0.5;

/**
 * Clamped to what the chosen stock can actually absorb, not to a flat number.
 * `maxNudgeXMm` is the stock's margin plus the label's padding — the empty
 * space a shift can eat. Past that the page's `overflow: hidden` stops moving
 * content and starts cutting it, which is what a roll (no margin, page exactly
 * one label wide) did at any positive offset.
 *
 * toFixed(1) because 0.5-mm steps otherwise accumulate float dust.
 */
function clampNudge(n: number, limitMm: number): number {
  return Math.max(-limitMm, Math.min(limitMm, Number(n.toFixed(1))));
}

function OptionButton({
  selected,
  onClick,
  title,
  help,
}: {
  selected: boolean;
  onClick: () => void;
  title: string;
  help?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={cn(
        "rounded-lg border px-3 py-2 text-left transition-colors",
        selected
          ? "border-ink bg-card ring-1 ring-ink"
          : "border-border bg-card hover:border-ink/30",
      )}
    >
      <span className="block text-label text-foreground">{title}</span>
      {help && <span className="block text-caption text-muted-foreground">{help}</span>}
    </button>
  );
}

export function AdvancedPrintSettings({
  options,
  profile,
  defaultDpi,
  open,
  onOpenChange,
  isCustomised,
  onChange,
  onStep,
  onReset,
}: {
  options: LabelOptions;
  profile: ResolvedProfile;
  /** The chosen stock's own dpi — labelled "recommended". */
  defaultDpi: number;
  open: boolean;
  onOpenChange: (next: boolean) => void;
  isCustomised: boolean;
  onChange: (patch: Partial<LabelOptions>) => void;
  /**
   * Relative change, resolved against the live options inside the parent's
   * updater. The +/- and arrow controls use this rather than computing from the
   * `options` prop, which is a snapshot of the last render: two clicks landing
   * in one frame would otherwise both read the same value and one would be lost.
   */
  onStep: (fn: (current: LabelOptions) => Partial<LabelOptions>) => void;
  onReset: () => void;
}) {
  const pitch = dotPitchMm(options.dpi);
  const isSheet = profile.kind === "sheet";

  // Offer dot counts by the module width they actually produce, not by fixed
  // numbers: 2 dots is 0.25 mm at 203 dpi but only 0.08 mm at 600, which is far
  // below any scannable width.
  const seen = new Set<number>();
  const dotOptions = [0.25, 0.33, 0.5]
    .map((targetMm) => Math.max(1, Math.round(targetMm / pitch)))
    .filter((k) => (seen.has(k) ? false : (seen.add(k), true)))
    .map((k) => ({ k, mm: (k * pitch).toFixed(2) }));

  const barWidthNote =
    options.preferDots === "auto"
      ? "automatic bar width"
      : `${(options.preferDots * pitch).toFixed(2)} mm bars`;
  const offsetNote =
    options.nudgeXMm || options.nudgeYMm
      ? ` · offset ${options.nudgeXMm}/${options.nudgeYMm} mm`
      : "";
  const skipNote =
    isSheet && options.startOffset ? ` · skip ${options.startOffset}` : "";

  const summary = isCustomised
    ? `${options.dpi} dpi · ${barWidthNote}${offsetNote}${skipNote}`
    : `Printer quality, bar width${
        isSheet ? ", sheet positioning" : ", fine positioning"
      }. Normally best left alone.`;

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-muted/40">
      <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-label text-foreground">Advanced print settings</span>
            {isCustomised && (
              <Badge className="bg-warning-subtle text-warning-strong">
                Custom settings active
              </Badge>
            )}
          </div>
          <p className="mt-0.5 text-caption leading-relaxed text-muted-foreground">
            {summary}
          </p>
        </div>
        <div className="flex flex-none items-center gap-2">
          {isCustomised && (
            <Button variant="outline" size="xs" onClick={onReset}>
              Reset to recommended
            </Button>
          )}
          <Button
            variant="ghost"
            size="xs"
            aria-expanded={open}
            onClick={() => onOpenChange(!open)}
          >
            {open ? "Hide" : "Show"}
            <ChevronDown
              className={cn("size-3.5 transition-transform", open && "rotate-180")}
            />
          </Button>
        </div>
      </div>

      {open && (
        <div className="space-y-5 border-t border-border bg-card px-3 py-4">
          <section className="space-y-2">
            <h4 className="text-label text-foreground">Printer quality</h4>
            <p className="text-caption leading-relaxed text-muted-foreground">
              How precisely the printer draws the bars. It is printed on the label
              printer&rsquo;s box — leave it alone if you don&rsquo;t know.
            </p>
            <div className="flex flex-wrap gap-2">
              {DPI_OPTIONS.map((d) => (
                <OptionButton
                  key={d.value}
                  selected={options.dpi === d.value}
                  onClick={() => onChange({ dpi: d.value, preferDots: "auto" })}
                  title={d.label + (d.value === defaultDpi ? " · recommended" : "")}
                  help={d.help}
                />
              ))}
            </div>
          </section>

          <section className="space-y-2">
            <h4 className="text-label text-foreground">Barcode width</h4>
            <p className="text-caption leading-relaxed text-muted-foreground">
              How wide each bar is drawn. Automatic picks the widest that fits your
              label, which is what scanners like.
            </p>
            <div className="flex flex-wrap gap-2">
              <OptionButton
                selected={options.preferDots === "auto"}
                onClick={() => onChange({ preferDots: "auto" })}
                title="Automatic · recommended"
              />
              {dotOptions.map(({ k, mm }) => (
                <OptionButton
                  key={k}
                  selected={options.preferDots === k}
                  onClick={() => onChange({ preferDots: k })}
                  title={`Fixed ${mm} mm bars`}
                  help={`${k} printer dot${k === 1 ? "" : "s"}`}
                />
              ))}
            </div>
          </section>

          <section className="space-y-2">
            <h4 className="text-label text-foreground">
              {isSheet ? "Sheet positioning" : "Fine positioning"}
            </h4>
            <p className="text-caption leading-relaxed text-muted-foreground">
              {isSheet
                ? "For part-used sticker sheets, and for printers that sit a millimetre off. The preview shows the result."
                : "For printers that sit a millimetre off. The preview shows the result."}
            </p>
            <div className="flex flex-wrap items-start gap-6">
              {isSheet && (
                <div>
                  <div className="mb-1.5 text-caption text-muted-foreground">
                    Skip already-used labels
                  </div>
                  <Stepper
                    value={options.startOffset}
                    step={1}
                    label="Labels to skip"
                    onStep={(delta) =>
                      onStep((o) => ({
                        startOffset: Math.max(
                          0,
                          Math.min(profile.perPage - 1, o.startOffset + delta),
                        ),
                      }))
                    }
                  />
                </div>
              )}
              <div>
                <div className="mb-1.5 text-caption text-muted-foreground">
                  Move everything{" "}
                  <span className="tabular-nums">
                    (&plusmn;{profile.maxNudgeXMm}/{profile.maxNudgeYMm} mm)
                  </span>
                </div>
                <NudgePad
                  x={options.nudgeXMm}
                  y={options.nudgeYMm}
                  maxXMm={profile.maxNudgeXMm}
                  maxYMm={profile.maxNudgeYMm}
                  onNudge={(dx, dy) =>
                    onStep((o) => ({
                      nudgeXMm: clampNudge(o.nudgeXMm + dx, profile.maxNudgeXMm),
                      nudgeYMm: clampNudge(o.nudgeYMm + dy, profile.maxNudgeYMm),
                    }))
                  }
                />
                <p className="mt-1.5 max-w-48 text-caption leading-relaxed text-muted-foreground">
                  Limited to the margin and padding this stock has spare — past
                  that the label would be cut, not moved.
                </p>
              </div>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function Stepper({
  value,
  step,
  label,
  onStep,
}: {
  value: number;
  step: number;
  label: string;
  onStep: (delta: number) => void;
}) {
  return (
    <div className="flex w-fit items-center overflow-hidden rounded-md border border-input">
      <button
        type="button"
        aria-label={`${label}: decrease`}
        onClick={() => onStep(-step)}
        className="grid size-7 place-items-center text-muted-foreground hover:bg-muted"
      >
        &minus;
      </button>
      <span className="grid h-7 w-12 place-items-center border-x border-input text-caption tabular-nums">
        {value}
      </span>
      <button
        type="button"
        aria-label={`${label}: increase`}
        onClick={() => onStep(step)}
        className="grid size-7 place-items-center text-muted-foreground hover:bg-muted"
      >
        +
      </button>
    </div>
  );
}

function NudgePad({
  x,
  y,
  maxXMm,
  maxYMm,
  onNudge,
}: {
  x: number;
  y: number;
  maxXMm: number;
  maxYMm: number;
  onNudge: (dx: number, dy: number) => void;
}) {
  const arrow =
    "grid size-8 place-items-center rounded-md border border-input bg-card text-foreground hover:bg-muted disabled:pointer-events-none disabled:opacity-40";

  return (
    <div className="grid w-fit grid-cols-3 gap-1">
      <span />
      <button
        type="button"
        aria-label="Move up"
        disabled={y <= -maxYMm}
        className={arrow}
        onClick={() => onNudge(0, -NUDGE_STEP_MM)}
      >
        &uarr;
      </button>
      <span />
      <button
        type="button"
        aria-label="Move left"
        disabled={x <= -maxXMm}
        className={arrow}
        onClick={() => onNudge(-NUDGE_STEP_MM, 0)}
      >
        &larr;
      </button>
      <span className="grid size-8 place-items-center font-mono text-micro text-muted-foreground">
        {x > 0 ? "+" : ""}
        {x}/{y > 0 ? "+" : ""}
        {y}
      </span>
      <button
        type="button"
        aria-label="Move right"
        disabled={x >= maxXMm}
        className={arrow}
        onClick={() => onNudge(NUDGE_STEP_MM, 0)}
      >
        &rarr;
      </button>
      <span />
      <button
        type="button"
        aria-label="Move down"
        disabled={y >= maxYMm}
        className={arrow}
        onClick={() => onNudge(0, NUDGE_STEP_MM)}
      >
        &darr;
      </button>
      <span />
    </div>
  );
}
