import type { ReactNode } from "react";
import { TrendingUp, TrendingDown } from "lucide-react";
import { cn } from "~/lib/utils";

interface StatCardProps {
  label: string;
  value: string;
  change: number;
  changeLabel?: string;
  className?: string;
  icon?: ReactNode;
}

/** Displays a single KPI metric with its current value, trend percentage, and optional icon. */
export function StatCard({ label, value, change, changeLabel, className, icon }: StatCardProps) {
  const isPositive = change >= 0;

  return (
    <div className={cn("rounded-xl bg-white dark:bg-gray-900 p-5 shadow-sm ring-1 ring-border", className)}>
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        {icon && (
          <div className="flex size-8 shrink-0 items-center justify-center rounded-full border border-gray-100 dark:border-gray-700 text-gray-400">
            {icon}
          </div>
        )}
      </div>
      <div className="mt-3 flex items-end justify-between gap-3">
        <p className="text-2xl font-bold text-gray-900 dark:text-gray-100 leading-none">{value}</p>
        <span
          className={cn(
            "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold",
            isPositive
              ? "bg-[#CEF17B]/30 text-[#084734]"
              : "bg-red-100 text-red-600"
          )}
        >
          {isPositive ? (
            <TrendingUp className="size-3" />
          ) : (
            <TrendingDown className="size-3" />
          )}
          {Math.abs(change)}%
        </span>
      </div>
      {changeLabel && (
        <p className="mt-1.5 text-xs text-muted-foreground">{changeLabel}</p>
      )}
    </div>
  );
}
