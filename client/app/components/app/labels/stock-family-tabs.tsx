/**
 * "What are you printing on?" — the media family pills.
 *
 * Family is derived from each preset's `group`, never stored, so a returning
 * merchant lands on the right pill with no migration. See `familyOfPreset`.
 */
import { SegmentedTabs } from "~/components/app/segmented-tabs";
import { presetsInFamily, type StockFamily } from "~/lib/label-stock";

/**
 * Proportional glyphs, not lucide icons: the point is the SHAPE of the media —
 * a wide sticker, a thin jewellery flag, a portrait sheet — which no icon set
 * draws. `currentColor` so they invert with the active pill.
 */
const GLYPH: Record<StockFamily, React.CSSProperties> = {
  roll: { width: 22, height: 12, border: "1px solid currentColor", borderRadius: 2 },
  jewellery: { width: 26, height: 7, border: "1px solid currentColor", borderRadius: 2 },
  sheet: { width: 10, height: 14, border: "1px solid currentColor" },
  custom: {
    width: 20,
    height: 12,
    border: "1px dashed currentColor",
    borderRadius: 2,
  },
};

const FAMILIES: Array<{ value: StockFamily; label: string }> = [
  { value: "roll", label: "Sticker roll" },
  { value: "jewellery", label: "Jewellery tag" },
  { value: "sheet", label: "A4 sheet" },
  { value: "custom", label: "Custom" },
];

export function StockFamilyTabs({
  value,
  onChange,
}: {
  value: StockFamily;
  onChange: (next: StockFamily) => void;
}) {
  return (
    <SegmentedTabs
      ariaLabel="Label stock type"
      behaviour="filter"
      value={value}
      onChange={onChange}
      items={FAMILIES.map((f) => ({
        value: f.value,
        label: f.label,
        icon: <span aria-hidden style={{ ...GLYPH[f.value], opacity: 0.75 }} />,
      }))}
    />
  );
}

export function familySizeCount(family: StockFamily): number {
  return presetsInFamily(family).length;
}
