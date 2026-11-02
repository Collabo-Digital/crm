/**
 * The arithmetic behind phone bottom sheets (components/ui/dialog.tsx): how far
 * the on-screen keyboard covers them, and when a drag on the handle closes one.
 */

/** Phones, where every dialog opens as a bottom sheet (app.css). */
export const SHEET_QUERY = "(max-width: 767px)";

/**
 * How much of the bottom of the layout viewport is hidden, in px: the
 * keyboard on iOS Safari, which shrinks only the visual viewport. Android
 * resizes the page itself (interactive-widget=resizes-content), so it reads 0.
 */
export function keyboardInset(layoutHeight: number, visualHeight: number, visualTop: number): number {
  return Math.max(0, Math.round(layoutHeight - visualTop - visualHeight));
}

/**
 * A drag down from the handle closes the sheet when it travels far enough
 * (a third of the sheet, at most 160px) or ends in a quick flick.
 * `velocity` is in px per ms.
 */
export function dismissesSheet(distance: number, sheetHeight: number, velocity: number): boolean {
  if (distance <= 0) return false;
  if (distance >= Math.min(160, sheetHeight / 3)) return true;
  return velocity >= 0.6 && distance >= 24;
}
