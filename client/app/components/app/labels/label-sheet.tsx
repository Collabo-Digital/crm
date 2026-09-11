/**
 * Every page of the run, in document order. THIS is what gets printed.
 *
 * Structural rules the print path depends on — see `label-print-styles.tsx`:
 *  - `.label-sheet` must be a DIRECT child of the route root and a sibling of
 *    the screen UI. No ancestor between it and <body> may carry padding,
 *    `overflow`, `max-height`, `position: sticky/fixed` or — most importantly —
 *    `transform`. A transform ancestor establishes a containing block and
 *    breaks CSS fragmentation, so `break-after: page` stops working and every
 *    page collapses onto one.
 *  - It is hidden on screen by `@media screen { .label-sheet { display: none } }`
 *    and never by an unconditional rule. The preview in the rail is a separate,
 *    scaled render of the same `<LabelPage>`.
 */
import type { BarcodePlan } from "~/lib/barcode";
import type { LabelOptions } from "~/lib/label-options";
import type { ResolvedProfile } from "~/lib/label-stock";
import type { LabelData } from "~/types/api";
import { LabelPage } from "./label-page";

export function LabelSheet({
  pages,
  profile,
  plans,
  options,
  currency,
  hriPossible,
}: {
  pages: Array<Array<LabelData | null>>;
  profile: ResolvedProfile;
  plans: Map<string, BarcodePlan>;
  options: LabelOptions;
  currency: string;
  hriPossible: boolean;
}) {
  return (
    <div className="label-sheet">
      {pages.map((page, pi) => (
        <LabelPage
          key={pi}
          page={page}
          profile={profile}
          plans={plans}
          options={options}
          currency={currency}
          hriPossible={hriPossible}
        />
      ))}
    </div>
  );
}
