/** Single date locale for the whole app — keep every surface consistent. */
const DATE_LOCALE = "en-IN";

/** "10 Jul 2026" style date, or an em dash for missing/invalid values. */
export function formatDate(value?: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(DATE_LOCALE, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * "just now", "5m ago", "2h ago", "3d ago"; past a month it hands over to
 * {@link formatDate}, because "47d ago" is harder to place than a date.
 * Empty string for a missing or invalid value so a caller can fall back to
 * its own wording rather than print "Synced —".
 */
export function formatRelativeTime(value?: string | null, now: number = Date.now()): string {
  if (!value) return "";
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return "";
  const elapsedMs = Math.max(0, now - at);
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatDate(value);
}

/** Date + time variant of {@link formatDate}. */
export function formatDateTime(value?: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(DATE_LOCALE, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
