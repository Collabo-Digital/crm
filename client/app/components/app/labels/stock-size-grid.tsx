/**
 * "Choose your size" — the size cards for one media family.
 *
 * Fit badges are the reason this screen exists in its new shape: a merchant
 * used to pick a size blind from a 22-entry <select> and only learn it was too
 * narrow afterwards, from a red chip whose remedy hid in a `title` attribute.
 */
import { RadioGroup } from "~/components/ui/radio-group";
import type { LabelPreset } from "~/lib/label-stock";
import { StockSizeCard, type StockFitSummary } from "./stock-size-card";

export function StockSizeGrid({
  presets,
  hiddenCount,
  showAll,
  onShowAllChange,
  value,
  onSelect,
  fitByPreset,
  selectedHint,
}: {
  presets: LabelPreset[];
  /** How many more this family has behind the disclosure. */
  hiddenCount: number;
  showAll: boolean;
  onShowAllChange: (next: boolean) => void;
  value: string;
  onSelect: (presetId: string) => void;
  fitByPreset: Map<string, StockFitSummary>;
  /** The selected preset's `hint` — printer-operation advice, once it matters. */
  selectedHint?: string;
}) {
  return (
    <div className="space-y-2.5">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-label text-muted-foreground">Choose your size</h3>
        {(hiddenCount > 0 || showAll) && (
          <button
            type="button"
            onClick={() => onShowAllChange(!showAll)}
            className="text-caption font-medium text-brand-strong hover:underline"
          >
            {showAll
              ? "Show common sizes"
              : `Show all ${presets.length + hiddenCount} sizes`}
          </button>
        )}
      </div>

      <RadioGroup
        value={value}
        onValueChange={onSelect}
        aria-label="Label size"
        className="grid grid-cols-1 gap-2.5 sm:grid-cols-2"
      >
        {presets.map((p) => (
          <StockSizeCard
            key={p.id}
            preset={p}
            selected={p.id === value}
            fit={fitByPreset.get(p.id)}
          />
        ))}
      </RadioGroup>

      {selectedHint && (
        <p className="text-caption leading-relaxed text-muted-foreground">{selectedHint}</p>
      )}
    </div>
  );
}
