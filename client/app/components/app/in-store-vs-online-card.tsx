import { Link } from "react-router";
import { ArrowRight } from "lucide-react";
import { cn, formatCurrency } from "~/lib/utils";
import type { SalesProfitData } from "~/services/dashboard.service";

type Split = NonNullable<SalesProfitData["inStoreVsOnline"]>;

/**
 * The period's sales split between the counter (point-of-sale bills) and
 * every other order. Same orders and window as Total Sales, so the two halves
 * add up to it. The dashboard shows it only once there were in-store sales.
 */
export function InStoreVsOnlineCard({
  split,
  currency,
  periodLabel,
  showReportsLink,
  className,
}: {
  split: Split;
  currency: string;
  periodLabel: string;
  /** Store reports are for owners, admins and managers. */
  showReportsLink: boolean;
  className?: string;
}) {
  const total = split.inStore.sales + split.online.sales;
  const inStoreShare = total > 0 ? (split.inStore.sales / total) * 100 : 0;

  return (
    <section
      aria-label="In store vs online"
      className={cn("rounded-xl bg-card p-5 shadow-sm ring-1 ring-border", className)}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-body font-semibold text-foreground">In store vs online</p>
        <span className="shrink-0 text-caption text-muted-foreground">{periodLabel}</span>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-4">
        <Half
          label="In store"
          swatch="bg-brand-strong"
          amount={formatCurrency(split.inStore.sales, currency)}
          count={split.inStore.orders}
          noun="bill"
        />
        <Half
          label="Online"
          swatch="bg-brand-strong/20"
          amount={formatCurrency(split.online.sales, currency)}
          count={split.online.orders}
          noun="order"
        />
      </div>

      {/* The fill is in store; the rest of the track, a lighter step of the
          same colour, is online — the swatches above say which is which. */}
      <div className="mt-4 h-2 overflow-hidden rounded-full bg-brand-strong/20" aria-hidden>
        <div className="h-full rounded-full bg-brand-strong" style={{ width: `${inStoreShare}%` }} />
      </div>

      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-caption text-muted-foreground">
        <p>{Math.round(inStoreShare)}% of sales were made in store.</p>
        {showReportsLink && (
          <Link
            to="/orders/pos/reports"
            className="flex items-center gap-1 font-medium text-brand-strong hover:text-brand-strong-hover"
          >
            Store reports <ArrowRight className="size-3.5" />
          </Link>
        )}
      </div>
    </section>
  );
}

function Half({
  label,
  swatch,
  amount,
  count,
  noun,
}: {
  label: string;
  swatch: string;
  amount: string;
  count: number;
  noun: string;
}) {
  return (
    <div className="min-w-0">
      <p className="flex items-center gap-1.5 text-caption text-muted-foreground">
        <span className={cn("inline-block size-2.5 shrink-0 rounded-sm", swatch)} aria-hidden />
        {label}
      </p>
      <p className="mt-1 break-words text-subhead text-foreground">{amount}</p>
      <p className="text-caption text-muted-foreground">
        {count.toLocaleString("en-IN")} {count === 1 ? noun : `${noun}s`}
      </p>
    </div>
  );
}
