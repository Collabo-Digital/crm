/**
 * One physical page: an A4 sheet, or one die-cut row on a roll.
 *
 * Geometry is inline in millimetres — not Tailwind — because the same numbers
 * have to hold on screen and on paper, and Tailwind cannot generate arbitrary
 * runtime values. Nothing here decides its own size from its container.
 *
 * Carries NO margin, shadow or centring: the print sheet and the rail preview
 * want different chrome around an identical page, so spacing belongs to the two
 * callers.
 */
import type { BarcodePlan } from "~/lib/barcode";
import type { LabelOptions } from "~/lib/label-options";
import type { ResolvedProfile } from "~/lib/label-stock";
import type { LabelData } from "~/types/api";
import { LabelCell, type LabelField } from "./label-artwork";

export function LabelPage({
  page,
  profile,
  plans,
  options,
  currency,
  hriPossible,
  className,
  highlight = null,
}: {
  page: Array<LabelData | null>;
  profile: ResolvedProfile;
  plans: Map<string, BarcodePlan>;
  options: LabelOptions;
  currency: string;
  hriPossible: boolean;
  className?: string;
  highlight?: LabelField | null;
}) {
  return (
    <div
      className={`label-page bg-white ${className ?? ""}`}
      style={{
        width: `${profile.pageWidthMm}mm`,
        height: `${profile.pageHeightMm}mm`,
        // The page carries only the stock's own margins. The nudge moves the
        // GRID (below), not the page: as padding here it could only ever be
        // positive — CSS drops a negative padding silently, which is why
        // nudging left or up used to do nothing — and on a roll, where the page
        // is exactly one label wide, any positive value pushed the last label
        // straight out through `overflow: hidden`.
        paddingTop: `${profile.marginTopMm}mm`,
        paddingLeft: `${profile.marginLeftMm}mm`,
        boxSizing: "border-box",
        overflow: "hidden",
      }}
    >
      <div
        className="label-grid"
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${profile.across}, ${profile.widthMm}mm)`,
          gridAutoRows: `${profile.heightMm}mm`,
          columnGap: `${profile.gapXMm}mm`,
          rowGap: `${profile.gapYMm}mm`,
          // Margins take a negative value, so both directions work. The range
          // is clamped upstream to what the stock can absorb (`maxNudgeXMm`),
          // so this can shift content within the margin and padding but never
          // off the media.
          marginLeft: `${options.nudgeXMm}mm`,
          marginTop: `${options.nudgeYMm}mm`,
        }}
      >
        {page.map((label, ci) => (
          <LabelCell
            key={ci}
            label={label}
            plan={label ? plans.get(label.variantId) : undefined}
            options={options}
            profile={profile}
            currency={currency}
            hriPossible={hriPossible}
            highlight={highlight}
          />
        ))}
      </div>
    </div>
  );
}
