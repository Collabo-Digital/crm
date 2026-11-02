import { cn } from "~/lib/utils";
import type { BroadcastStats } from "~/types/api";

const STAGES: Array<{ key: keyof BroadcastStats; label: string; fill: string; hint: string }> = [
  { key: "sent", label: "Sent", fill: "bg-info", hint: "Accepted by WhatsApp" },
  { key: "delivered", label: "Delivered", fill: "bg-brand", hint: "Reached the phone" },
  { key: "read", label: "Read", fill: "bg-success", hint: "Opened, where read receipts are on" },
  { key: "replied", label: "Replied", fill: "bg-foreground/60", hint: "Wrote back within three days" },
  { key: "clicked", label: "Tapped a button", fill: "bg-warning", hint: "Quick-reply taps on the template" },
];

const pct = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : "—");

/**
 * Sent → delivered → read → replied → tapped, each as a share of what was
 * sent. These stages nest (a read message was delivered), so unlike a status
 * breakdown each bar is measured against the first, not against the total.
 */
export function DeliveryFunnel({ stats, className }: { stats: BroadcastStats; className?: string }) {
  const base = Math.max(stats.sent, 0);
  return (
    <div className={cn("space-y-4", className)}>
      <div className="space-y-2.5">
        {STAGES.map((stage) => {
          const value = stats[stage.key] as number;
          return (
            <div key={stage.key} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 sm:grid-cols-[8rem_minmax(0,1fr)_5rem]" title={stage.hint}>
              <span className="text-caption text-muted-foreground">{stage.label}</span>
              <div className="col-span-2 row-start-2 h-2 overflow-hidden rounded-full bg-muted sm:col-span-1 sm:row-auto">
                {/* Computed geometry — the one case DESIGN.md allows `style`. */}
                <div className={cn("h-full rounded-full", stage.fill)} style={{ width: base ? `${Math.min(100, (value / base) * 100)}%` : "0%" }} />
              </div>
              <span className="text-right text-caption tabular-nums">
                <span className="font-semibold text-foreground">{value.toLocaleString("en-IN")}</span>
                <span className="ml-1 text-muted-foreground">{stage.key === "sent" ? "" : pct(value, base)}</span>
              </span>
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-1 border-t pt-3 text-caption text-muted-foreground">
        <span>
          <span className="font-semibold tabular-nums text-foreground">{stats.total.toLocaleString("en-IN")}</span> in the audience
        </span>
        <span>
          <span className="font-semibold tabular-nums text-danger">{stats.failed.toLocaleString("en-IN")}</span> failed
        </span>
        <span>
          <span className="font-semibold tabular-nums text-foreground">{stats.skipped.toLocaleString("en-IN")}</span> left out
        </span>
        {stats.pending > 0 && (
          <span>
            <span className="font-semibold tabular-nums text-foreground">{stats.pending.toLocaleString("en-IN")}</span> still sending
          </span>
        )}
      </div>
    </div>
  );
}
