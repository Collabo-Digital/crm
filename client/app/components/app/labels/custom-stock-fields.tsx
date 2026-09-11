/**
 * Custom stock: measure the label, not the backing paper.
 *
 * Values are clamped in `sanitizeCustom` at resolve time rather than on each
 * keystroke, so a half-typed "5" on the way to "50" does not snap under the
 * cursor.
 */
import { SegmentedTabs } from "~/components/app/segmented-tabs";
import { Input } from "~/components/ui/input";
import type { CustomStock, StockKind } from "~/lib/label-stock";

export function CustomStockFields({
  custom,
  onChange,
}: {
  custom: CustomStock;
  onChange: (patch: Partial<CustomStock>) => void;
}) {
  const fields: Array<{
    key: keyof CustomStock;
    label: string;
    step: number;
    min: number;
  }> = [
    { key: "widthMm", label: "Width (mm)", step: 0.5, min: 5 },
    { key: "heightMm", label: "Height (mm)", step: 0.5, min: 5 },
    { key: "across", label: "Labels across", step: 1, min: 1 },
    { key: "gapXMm", label: "Gap between (mm)", step: 0.5, min: 0 },
  ];
  if (custom.kind === "sheet") {
    fields.push({ key: "down", label: "Rows down", step: 1, min: 1 });
  }

  return (
    <div className="space-y-3 rounded-lg border border-border bg-muted/40 p-3">
      <SegmentedTabs
        ariaLabel="Custom stock kind"
        behaviour="filter"
        value={custom.kind}
        onChange={(kind) => onChange({ kind: kind as StockKind })}
        items={[
          { value: "roll", label: "Roll" },
          { value: "sheet", label: "A4 sheet" },
        ]}
      />

      <div className="flex flex-wrap gap-3">
        {fields.map((f) => (
          <label key={f.key} className="grid gap-1">
            <span className="text-caption text-muted-foreground">{f.label}</span>
            <Input
              type="number"
              min={f.min}
              step={f.step}
              value={custom[f.key] as number}
              onChange={(e) => onChange({ [f.key]: Number(e.target.value) || 0 })}
              className="h-8 w-24"
            />
          </label>
        ))}
      </div>

      <p className="text-caption text-muted-foreground">
        Measure the label itself, not the backing paper.
      </p>
    </div>
  );
}
