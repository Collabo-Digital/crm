/**
 * One physical page of slips, and the one cell it is made of.
 *
 * Shared by the print sheet and the rail preview, so the preview is the same
 * markup at the same millimetres under a transform — never a second drawing.
 * Geometry is inline rather than in classes for the reason documented on
 * `buildPageCss`.
 */
import {
  PackageSlip,
  type PackageSlipStore,
  type SlipZone,
} from "~/components/app/package-slip";
import type { ResolvedProfile } from "~/lib/label-stock";
import type { OrderSlipData } from "~/types/api";

export interface SlipRenderProps {
  profile: ResolvedProfile;
  store: PackageSlipStore;
  /** From `slipScale(profile)`. */
  scale: number;
  showBarcodeZone: boolean;
  showItems: boolean;
  /** Preview only. The print sheet never passes it. */
  highlight?: SlipZone | null;
}

export function SlipCell({
  order,
  profile,
  store,
  scale,
  showBarcodeZone,
  showItems,
  highlight,
}: SlipRenderProps & { order: OrderSlipData | null }) {
  return (
    <div
      className="label-cell slip-cell bg-white"
      style={{
        width: `${profile.widthMm}mm`,
        height: `${profile.heightMm}mm`,
        padding: `${profile.paddingMm}mm`,
        boxSizing: "border-box",
        overflow: "hidden",
        // Cut guides only when the sheet holds more than one slip.
        outline: profile.guides ? "0.2mm dashed #cbd5e1" : undefined,
        outlineOffset: "-0.1mm",
      }}
    >
      {order && (
        <PackageSlip
          order={order}
          store={store}
          scale={scale}
          showBarcodeZone={showBarcodeZone}
          showItems={showItems}
          highlight={highlight}
          contentWidthMm={profile.widthMm - 2 * profile.paddingMm}
        />
      )}
    </div>
  );
}

export function SlipPage({
  page,
  profile,
  ...rest
}: SlipRenderProps & { page: Array<OrderSlipData | null> }) {
  return (
    <div
      className="label-page bg-white"
      style={{
        width: `${profile.pageWidthMm}mm`,
        height: `${profile.pageHeightMm}mm`,
        paddingTop: `${profile.marginTopMm}mm`,
        paddingLeft: `${profile.marginLeftMm}mm`,
        boxSizing: "border-box",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${profile.across}, ${profile.widthMm}mm)`,
          gridAutoRows: `${profile.heightMm}mm`,
          columnGap: `${profile.gapXMm}mm`,
          rowGap: `${profile.gapYMm}mm`,
        }}
      >
        {page.map((order, ci) => (
          <SlipCell key={order?.id ?? `blank-${ci}`} order={order} profile={profile} {...rest} />
        ))}
      </div>
    </div>
  );
}
