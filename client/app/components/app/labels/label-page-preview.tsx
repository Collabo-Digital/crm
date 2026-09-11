/**
 * The rail's live preview: one real page, scaled to fit.
 *
 * It renders the SAME `<LabelPage>` the print sheet does, wrapped in a
 * `transform: scale()`. A transform is post-layout and purely visual — it
 * cannot feed back into the barcode SVG's millimetre width, so the geometry
 * contract holds. It is also strictly OUTSIDE `.label-sheet`; a transform on an
 * ancestor of the sheet would establish a containing block and kill
 * `break-after: page`.
 *
 * The whole thing carries `.no-print`. Under the print whitelist a non-listed
 * element is only `visibility: hidden`, which leaves its box in the flow — an
 * unmarked 400 px preview would push page 1 down and emit a blank leading
 * sheet.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { BarcodePlan } from "~/lib/barcode";
import type { LabelOptions } from "~/lib/label-options";
import type { ResolvedProfile } from "~/lib/label-stock";
import { cn } from "~/lib/utils";
import type { LabelData } from "~/types/api";
import type { LabelField } from "./label-artwork";
import { LabelPage } from "./label-page";

/**
 * CSS px per mm at the spec's 96 CSS-dpi — the same conversion the browser uses
 * to resolve `50mm`, so `scale === 1` is literally actual size at 100% zoom.
 */
export const PX_PER_MM = 96 / 25.4;

/**
 * Fallbacks for the first paint only, before the container has been measured.
 *
 * They must never be the real source of truth. They were, and the rail is
 * actually ~340-351 px, not 366: the clip box is a shrinkable flex item with
 * `overflow: hidden`, so it quietly narrowed to fit and cut the right off every
 * page wider than about 93 mm — the 2-up rolls and the 100 mm stock — with no
 * scrollbar and no cue, while the caption went on reporting the scale we had
 * *asked* for.
 */
const FALLBACK_W_PX = 340;
const FALLBACK_H_PX = 400;

export function previewScale(args: {
  pageWidthMm: number;
  pageHeightMm: number;
  boxWidthPx?: number;
  boxHeightPx?: number;
}) {
  const wPx = args.pageWidthMm * PX_PER_MM;
  const hPx = args.pageHeightMm * PX_PER_MM;
  const boxW = Math.max(1, args.boxWidthPx ?? FALLBACK_W_PX);
  const boxH = Math.max(1, args.boxHeightPx ?? FALLBACK_H_PX);

  const scale = Math.min(
    boxW / wPx,
    boxH / hPx,
    // Never magnify. A preview that made a 30 × 10 mm tag look roomy would be
    // lying about the one thing the merchant is here to check.
    1,
  );

  return {
    scale,
    // The transform does not affect layout, so the clip box has to carry the
    // scaled size itself or the rail opens a gap the size of the unscaled page.
    // `min` with the box is belt-and-braces against float dust in `ceil`: the
    // clip must never be asked to be wider than the space it has.
    clipWidthPx: Math.min(boxW, Math.ceil(wPx * scale)),
    clipHeightPx: Math.min(boxH, Math.ceil(hPx * scale)),
    /** The scale actually applied, so the caption cannot drift from the render. */
    pct: Math.round(scale * 100),
  };
}

/**
 * The preview container's content width.
 *
 * Measured rather than derived: the rail's width comes from a grid track, its
 * own padding, a border and whether a scrollbar is present, and every previous
 * attempt to add those up by hand was wrong.
 */
function useElementWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState<number | null>(null);

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const cs = getComputedStyle(el);
    const content =
      el.clientWidth - parseFloat(cs.paddingLeft || "0") - parseFloat(cs.paddingRight || "0");
    if (!Number.isFinite(content) || content <= 0) return;
    // Bail on an unchanged value so the no-dependency layout effect below
    // cannot loop: React skips the re-render when the state is Object.is-equal.
    setWidth((prev) => (prev !== null && Math.abs(prev - content) < 0.5 ? prev : content));
  }, []);

  // Synchronous, on every commit, BEFORE paint. A ResizeObserver on its own is
  // not enough: its first delivery is asynchronous and, in a hidden or
  // background tab, the callback may never arrive at all — which leaves the
  // preview on its fallback width while `max-w-full` quietly shrinks the clip
  // box around a page still drawn at the old scale. That is precisely the
  // silent right-hand crop this hook exists to prevent, so it must not be the
  // observer's job to get the first measurement right.
  useLayoutEffect(measure);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

  return [ref, width] as const;
}

export function LabelPagePreview({
  pages,
  index,
  onIndexChange,
  profile,
  plans,
  options,
  currency,
  hriPossible,
  highlight,
}: {
  pages: Array<Array<LabelData | null>>;
  index: number;
  onIndexChange: (next: number) => void;
  profile: ResolvedProfile;
  plans: Map<string, BarcodePlan>;
  options: LabelOptions;
  currency: string;
  hriPossible: boolean;
  highlight: LabelField | null;
}) {
  const page = pages[index] ?? [];
  const [boxRef, boxWidth] = useElementWidth<HTMLDivElement>();
  const { scale, clipWidthPx, clipHeightPx, pct } = previewScale({
    pageWidthMm: profile.pageWidthMm,
    pageHeightMm: profile.pageHeightMm,
    boxWidthPx: boxWidth ?? undefined,
  });

  const isSheet = profile.kind === "sheet";
  const scaleNote = isSheet
    ? "Whole sheet, scaled down"
    : pct === 100
      ? "Actual size"
      : `Shown at ${pct}%`;

  return (
    <div className="no-print space-y-2">
      <div
        ref={boxRef}
        className="flex min-h-[180px] items-center justify-center rounded-lg bg-muted/50 p-4 ring-1 ring-border"
      >
        <div
          className="max-w-full overflow-hidden bg-white shadow-sm ring-1 ring-border"
          style={{ width: clipWidthPx, height: clipHeightPx }}
        >
          <div style={{ transform: `scale(${scale})`, transformOrigin: "top left" }}>
            <LabelPage
              page={page}
              profile={profile}
              plans={plans}
              options={options}
              currency={currency}
              hriPossible={hriPossible}
              highlight={highlight}
            />
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 text-caption text-muted-foreground">
        <span>
          {profile.widthMm} × {profile.heightMm} mm ·{" "}
          {isSheet
            ? `${profile.across} × ${profile.down} on A4`
            : profile.across > 1
              ? `${profile.across} across`
              : "1 across"}
        </span>
        <span>{scaleNote}</span>
      </div>

      {pages.length > 1 && (
        <div className="flex items-center justify-center gap-2">
          <PageStep
            label="Previous page"
            disabled={index === 0}
            onClick={() => onIndexChange(index - 1)}
          >
            <ChevronLeft className="size-3.5" />
          </PageStep>
          <span className="text-caption tabular-nums text-muted-foreground">
            {isSheet ? "Sheet" : "Row"} {index + 1} of {pages.length}
          </span>
          <PageStep
            label="Next page"
            disabled={index >= pages.length - 1}
            onClick={() => onIndexChange(index + 1)}
          >
            <ChevronRight className="size-3.5" />
          </PageStep>
        </div>
      )}
    </div>
  );
}

function PageStep({
  children,
  label,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "grid size-6 place-items-center rounded-md border border-input bg-card transition-colors",
        "hover:bg-muted disabled:pointer-events-none disabled:opacity-40",
      )}
    >
      {children}
    </button>
  );
}
