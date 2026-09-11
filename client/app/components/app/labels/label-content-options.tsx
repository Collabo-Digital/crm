/**
 * "What should appear on each label?"
 *
 * Hovering a row highlights the matching element in the rail preview — which is
 * why `onHover` exists at all. On windowed jewellery dies the text and the bars
 * land on different panels, so the help copy changes to say so.
 */
import { Checkbox } from "~/components/ui/checkbox";
import type { LabelOptions } from "~/lib/label-options";
import { cn } from "~/lib/utils";
import type { LabelField } from "./label-artwork";

type ContentKey = "showTitle" | "showSku" | "showPrice" | "showHri";

const FIELD_OF: Record<ContentKey, LabelField> = {
  showTitle: "title",
  showSku: "sku",
  showPrice: "price",
  showHri: "hri",
};

export function LabelContentOptions({
  options,
  onToggle,
  onHover,
  inWindow,
  anyHri,
  currencyLabel,
}: {
  options: LabelOptions;
  onToggle: (key: ContentKey) => void;
  onHover: (field: LabelField | null) => void;
  /** Jewellery die — barcode and text sit on opposite panels. */
  inWindow: boolean;
  /** At least one code is an EAN/UPC, so the digits row is meaningful. */
  anyHri: boolean;
  currencyLabel: string;
}) {
  const rows: Array<{ key: ContentKey; label: string; help: string }> = [
    {
      key: "showTitle",
      label: "Product name",
      help: inWindow
        ? "Product and variant, on the panel opposite the barcode"
        : "Product and variant, on the top line",
    },
    {
      key: "showSku",
      label: "SKU",
      help: "Your internal code — the one you search inventory by",
    },
    { key: "showPrice", label: "Price", help: `Selling price in ${currencyLabel}` },
  ];
  if (anyHri) {
    rows.push({
      key: "showHri",
      label: "Barcode number",
      help: "The digits printed under the bars. Retail scanners don't need them, but shop staff read them when a code won't scan.",
    });
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      {rows.map((row, i) => (
        <label
          key={row.key}
          onMouseEnter={() => onHover(FIELD_OF[row.key])}
          onMouseLeave={() => onHover(null)}
          onFocus={() => onHover(FIELD_OF[row.key])}
          onBlur={() => onHover(null)}
          className={cn(
            "flex cursor-pointer items-start gap-3 px-3 py-2.5 transition-colors hover:bg-muted/60",
            i < rows.length - 1 && "border-b border-border",
          )}
        >
          <Checkbox
            checked={options[row.key]}
            onCheckedChange={() => onToggle(row.key)}
            className="mt-0.5"
          />
          <span className="min-w-0">
            <span className="block text-label text-foreground">{row.label}</span>
            <span className="block text-caption leading-relaxed text-muted-foreground">
              {row.help}
            </span>
          </span>
        </label>
      ))}
    </div>
  );
}
