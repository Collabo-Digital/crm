/**
 * The one status palette. Every status pill in the app maps its states to one
 * of these five tones, never to colour classes of its own, so the same word
 * always wears the same colour:
 *
 * - success   — done and good: paid, fulfilled, issued, delivered, live, approved
 * - info      — in progress or informational: partial, scheduled, sending
 * - attention — needs someone to act: pending, unfulfilled, unpaid, paused
 * - critical  — failed or blocked: failed, rejected, cancelled invoice
 * - neutral   — inactive or not started: draft, archived, refunded
 *
 * Lime is not a status. It stays the brand, the selection and the main action.
 *
 * Text uses the `-text` tokens, which pass 4.5:1 on their tint in both themes;
 * the plain status colour is only for dots and icons.
 */
export type StatusTone = "success" | "info" | "attention" | "critical" | "neutral";

export const STATUS_TONE_CLASSES: Record<StatusTone, string> = {
  success: "bg-success-subtle text-success-text",
  info: "bg-info-subtle text-info-text",
  attention: "bg-warning-subtle text-warning-text",
  critical: "bg-danger-subtle text-danger-text",
  neutral: "bg-muted text-muted-foreground",
};

/** A leading dot or icon fill in the same tone. */
export const STATUS_TONE_DOTS: Record<StatusTone, string> = {
  success: "bg-success",
  info: "bg-info",
  attention: "bg-warning",
  critical: "bg-danger",
  neutral: "bg-muted-foreground/60",
};

/** Turn a state → tone map into the state → classes map the pills take. */
export function toneClasses<K extends string>(tones: Record<K, StatusTone>): Record<K, string> {
  return Object.fromEntries(
    Object.entries<StatusTone>(tones).map(([state, tone]) => [state, STATUS_TONE_CLASSES[tone]]),
  ) as Record<K, string>;
}
