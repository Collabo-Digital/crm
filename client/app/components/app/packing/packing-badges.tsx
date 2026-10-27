import { StatusPill } from "~/components/app/data-table";
import type { BadgeTone, PackingBadge } from "~/lib/packing";
import { cn } from "~/lib/utils";

const TONE: Record<BadgeTone, string> = {
  neutral: "bg-muted text-foreground",
  info: "bg-info-subtle text-info",
  success: "bg-success-subtle text-success",
  warning: "bg-warning-subtle text-warning",
  danger: "bg-danger-subtle text-danger",
};

export function PackingBadges({ badges, className }: { badges: PackingBadge[]; className?: string }) {
  if (badges.length === 0) return null;
  return (
    <span className={cn("flex min-w-0 flex-wrap items-center gap-1", className)}>
      {badges.map((b) => (
        <StatusPill key={b.label} className={TONE[b.tone]}>
          {b.label}
        </StatusPill>
      ))}
    </span>
  );
}
