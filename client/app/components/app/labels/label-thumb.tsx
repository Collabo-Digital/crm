/**
 * A proportional glyph of one row of stock, for the size cards.
 *
 * Derived entirely from geometry the preset already carries — there is no
 * thumbnail field and there must not be one, or the picture and the print can
 * disagree.
 */
export function LabelThumb({
  widthMm,
  heightMm,
  across,
  gapXMm,
  maxW = 46,
  maxH = 30,
}: {
  widthMm: number;
  heightMm: number;
  across: number;
  gapXMm: number;
  maxW?: number;
  maxH?: number;
}) {
  // Cap the drawn count: a 5-across sheet at this size would be five hairlines.
  const cols = Math.min(3, Math.max(1, across));
  const rowWmm = cols * widthMm + (cols - 1) * gapXMm;
  const scale = Math.min(maxW / rowWmm, maxH / heightMm);
  const cellW = Math.max(3, widthMm * scale);
  const cellH = Math.max(4, heightMm * scale);
  const gap = gapXMm * scale;

  return (
    <span
      aria-hidden
      className="flex flex-none items-center"
      style={{ gap: `${gap}px`, height: maxH }}
    >
      {Array.from({ length: cols }, (_, i) => (
        // `bg-muted`, not `bg-card`: the glyph sits ON a card, so bg-card would
        // make it vanish into its own background in dark mode.
        <span
          key={i}
          className="block flex-none rounded-[2px] border border-muted-foreground/60 bg-muted"
          style={{ width: cellW, height: cellH }}
        />
      ))}
    </span>
  );
}
