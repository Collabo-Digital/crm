/**
 * The artwork that lands on paper. Shared byte-for-byte between the on-screen
 * preview and the print DOM — that is the whole point of the file, and the
 * reason all three components live together rather than being tidied apart.
 *
 * BARCODE GEOMETRY CONTRACT — a future edit will silently break this:
 *   One SVG user unit is one module. JsBarcode is used ONLY as an encoder; the
 *   bars are plain <rect>s. The SVG's width is set in MILLIMETRES to
 *   `totalModules × moduleMm` and must NEVER be `w-full`, a percentage, or
 *   anything else that lets the container decide it — that was the original
 *   bug: module width scaled with SKU length, so one roll printed X anywhere
 *   from 0.23 mm to 0.41 mm with no quiet zone. `preserveAspectRatio="none"`
 *   is correct *because* the width is exact: it pins the horizontal scale while
 *   bar height (a free parameter) varies. Module width is snapped to whole
 *   printer dots (25.4/dpi; 0.1251 mm at 203 dpi) so every bar edge rounds the
 *   same way.
 *
 * FIXED SLOTS. The cell is a stack of fixed-height boxes from `labelLayout` —
 * title, bars, HRI, meta — that sum to exactly the content height. Every slot
 * exists whether or not its checkbox is ticked and whether or not the product
 * has the value, so the bars are the same size and in the same place on every
 * label of a given stock. Nothing here may size itself from its content: the
 * previous `justify-between` + conditional children meant toggling a checkbox
 * moved the barcode, and a text-height under-estimate pushed the last row out
 * of the box entirely.
 *
 * PAPER IS NOT A SURFACE TOKEN. Everything here is literal `#fff` / `text-black`
 * / `fill="#000000"`, deliberately, against DESIGN.md's no-bare-colours rule.
 * These are ink and stock, not theme surfaces: `bg-card` would render a black
 * sticker in dark mode and — with `print-color-adjust: exact` on `.label-cell` —
 * risk printing one.
 */
import type { BarcodePlan } from "~/lib/barcode";
import { labelLayout, type PanelSlots } from "~/lib/label-fit";
import type { LabelOptions } from "~/lib/label-options";
import type { PrintableWindow, ResolvedProfile } from "~/lib/label-stock";
import { formatCurrency } from "~/lib/utils";
import type { LabelData } from "~/types/api";

/** Which content row the merchant is hovering. Preview-only; never printed. */
export type LabelField = "title" | "sku" | "price" | "hri";

/**
 * Drawn in the fixed brand pair (`--brand-forest` / `--brand`), not the
 * theme-flipping `--brand-strong`: this sits on white paper in both themes.
 */
function highlightStyle(
  field: LabelField,
  active: LabelField | null,
): React.CSSProperties | undefined {
  if (active !== field) return undefined;
  return {
    outline: "1.5px solid var(--brand-forest)",
    outlineOffset: 1,
    backgroundColor: "var(--brand)",
  };
}

export function BarcodeSvg({
  plan,
  maxHeightMm,
}: {
  plan: BarcodePlan;
  /** The bars slot. `planBarcode` floors at `minBarHeightMm`, so on a label too
   *  short for the minimum it can exceed what the layout reserved — the plan's
   *  notice says so, but the render still must not spill. */
  maxHeightMm: number;
}) {
  if (plan.quality === "unfit" || plan.bars.length === 0 || plan.moduleMm <= 0) return null;

  const heightMm = Math.min(plan.barHeightMm, maxHeightMm);
  if (heightMm <= 0) return null;

  // Floor, never round. `chooseModuleWidth` step 4 returns `moduleMm = maxFit`
  // exactly, so the symbol can exactly fill a box that has `overflow: hidden`;
  // toFixed() rounds away from zero and would make it a micron too wide.
  const widthMm = Math.floor(plan.widthMm * 1000) / 1000;

  // Isotropic viewBox: one unit is `moduleMm` on both axes, so the pinned
  // horizontal scale is exactly one module per unit.
  const vbHeight = heightMm / plan.moduleMm;

  return (
    <svg
      className="barcode-svg"
      style={{
        width: `${widthMm.toFixed(3)}mm`,
        height: `${heightMm.toFixed(3)}mm`,
        display: "block",
        margin: "0 auto",
      }}
      viewBox={`0 0 ${plan.totalModules} ${vbHeight}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`${plan.symbology} ${plan.value}`}
    >
      {plan.bars.map((b) => (
        <rect key={b.x} x={b.x} y={0} width={b.w} height={vbHeight} fill="#000000" />
      ))}
    </svg>
  );
}

/**
 * One fixed-height row. Always rendered, even when empty — that is what keeps
 * everything below it from moving.
 */
function Slot({
  heightMm,
  center,
  children,
}: {
  heightMm: number;
  center?: boolean;
  children?: React.ReactNode;
}) {
  if (heightMm <= 0) return null;
  return (
    <div
      style={{ height: `${heightMm.toFixed(3)}mm`, overflow: "hidden" }}
      className={center ? "flex items-center justify-center" : undefined}
    >
      {children}
    </div>
  );
}

export function LabelBody({
  label,
  plan,
  options,
  currency,
  slots,
  showBarcode,
  showInfo,
  highlight = null,
}: {
  label: LabelData;
  plan: BarcodePlan | undefined;
  options: LabelOptions;
  currency: string;
  /** From `labelLayout` — the single source of truth for every height here. */
  slots: PanelSlots;
  showBarcode: boolean;
  showInfo: boolean;
  /** Preview affordance only — the print DOM always passes null. */
  highlight?: LabelField | null;
}) {
  const pt = (base: number) => `${(base * slots.scale).toFixed(2)}pt`;
  const hri = options.showHri && plan && plan.symbology !== "CODE128";
  const showMeta = showInfo && (options.showSku || options.showPrice);

  return (
    <>
      <Slot heightMm={slots.titleMm}>
        {showInfo && options.showTitle && (
          <p
            className="truncate font-semibold leading-tight text-black"
            style={{ fontSize: pt(7), ...highlightStyle("title", highlight) }}
          >
            {label.productTitle}
            {label.variantTitle !== "Default Title" ? ` · ${label.variantTitle}` : ""}
          </p>
        )}
      </Slot>

      <Slot heightMm={slots.barsMm} center>
        {showBarcode && plan && <BarcodeSvg plan={plan} maxHeightMm={slots.barsMm} />}
      </Slot>

      <Slot heightMm={slots.hriMm}>
        {showBarcode && hri && (
          <p
            className="text-center font-mono leading-tight tracking-[0.15em] text-black"
            style={{ fontSize: pt(6.5), ...highlightStyle("hri", highlight) }}
          >
            {plan!.value}
          </p>
        )}
      </Slot>

      <Slot heightMm={slots.metaMm}>
        {showMeta && (
          <div className="flex items-baseline justify-between gap-1">
            {options.showSku && (
              <p
                className="truncate font-mono font-medium leading-tight text-black"
                style={{ fontSize: pt(6.5), ...highlightStyle("sku", highlight) }}
              >
                {label.sku ?? label.barcode}
              </p>
            )}
            {options.showPrice && (
              <p
                className="shrink-0 font-bold leading-tight text-black"
                style={{ fontSize: pt(7), ...highlightStyle("price", highlight) }}
              >
                {formatCurrency(label.price, currency, { maximumFractionDigits: 0 })}
              </p>
            )}
          </div>
        )}
      </Slot>
    </>
  );
}

export function LabelCell({
  label,
  plan,
  options,
  profile,
  currency,
  hriPossible,
  highlight = null,
}: {
  label: LabelData | null;
  plan: BarcodePlan | undefined;
  options: LabelOptions;
  profile: ResolvedProfile;
  currency: string;
  /** Does the run contain any GS1 code? Decides whether an HRI slot exists. */
  hriPossible: boolean;
  highlight?: LabelField | null;
}) {
  const box: React.CSSProperties = {
    width: `${profile.widthMm}mm`,
    height: `${profile.heightMm}mm`,
    overflow: "hidden",
  };

  // Placeholder for a cell skipped by startOffset on a part-used sheet.
  if (!label) return <div className="label-cell" style={box} aria-hidden />;

  // `outline`, not `border`: a border on a border-box cell eats into the content
  // box (0.53 mm on both axes at 1 px), which shrank the width the barcode was
  // already planned against. An outline is painted outside the layout entirely.
  const guides: React.CSSProperties = profile.guides
    ? { outline: "1px dashed #cbd5e1", outlineOffset: "-1px" }
    : {};

  const layout = labelLayout(profile, hriPossible);

  // Jewellery dies: content is confined to the printable windows and hard
  // clipped, so nothing bleeds onto the tail that wraps the ring shank.
  if (profile.printableWindows?.length) {
    return (
      <div className="label-cell relative" style={{ ...box, ...guides }}>
        {profile.printableWindows.map((w: PrintableWindow, i: number) => (
          <div
            key={i}
            className="absolute flex flex-col justify-center overflow-hidden"
            style={{
              left: `${w.xMm}mm`,
              top: `${w.yMm}mm`,
              width: `${w.wMm}mm`,
              height: `${w.hMm}mm`,
              // The profile subtracts this padding from the window when sizing
              // the barcode, so it has to actually be rendered or the symbol is
              // planned against a box narrower than the one it lands in.
              padding: `${profile.paddingMm}mm`,
              boxSizing: "border-box",
            }}
          >
            <LabelBody
              label={label}
              plan={plan}
              options={options}
              currency={currency}
              slots={w.role === "barcode" ? layout.barcode : layout.info}
              showBarcode={w.role === "barcode"}
              showInfo={w.role === "info"}
              highlight={highlight}
            />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div
      className="label-cell flex flex-col overflow-hidden"
      style={{ ...box, ...guides, padding: `${profile.paddingMm}mm` }}
    >
      <LabelBody
        label={label}
        plan={plan}
        options={options}
        currency={currency}
        slots={layout.barcode}
        showBarcode
        showInfo
        highlight={highlight}
      />
    </div>
  );
}
