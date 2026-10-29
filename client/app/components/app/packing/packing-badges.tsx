import { StatusBadge } from "~/components/ui/status-badge";
import type { BadgeTone, PackingBadge } from "~/lib/packing";
import type { StatusTone } from "~/lib/status-tone";
import { cn } from "~/lib/utils";

const TONE: Record<BadgeTone, StatusTone> = {
  neutral: "neutral",
  info: "info",
  success: "success",
  warning: "attention",
  danger: "critical",
};

export function PackingBadges({ badges, className }: { badges: PackingBadge[]; className?: string }) {
  if (badges.length === 0) return null;
  return (
    <span className={cn("flex min-w-0 flex-wrap items-center gap-1", className)}>
      {badges.map((b) => (
        <StatusBadge key={b.label} tone={TONE[b.tone]}>
          {b.label}
        </StatusBadge>
      ))}
    </span>
  );
}
