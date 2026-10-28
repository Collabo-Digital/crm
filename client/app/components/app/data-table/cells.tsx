import type { ReactNode } from "react";
import { Link } from "react-router";
import { Package } from "lucide-react";

import { ChannelBadge } from "~/components/app/channel-badge";
import { StatusBadge } from "~/components/ui/status-badge";
import { formatDate, formatDateTime } from "~/lib/format-date";
import { cn, formatCurrency } from "~/lib/utils";
import type { ChannelPlatform } from "~/types/api";

/**
 * The cell vocabulary of the shared DataTable. Pages compose these inside a
 * column's `cell` so every list prints an id, a date, a sum, a person or a
 * status the same way. Each is a plain span/div — the grid cell around it
 * handles alignment, padding and clipping.
 *
 * Anything interactive inside a cell (a link, a button) is skipped by the
 * row's click handler, so none of these need to stop propagation.
 */

const TRUNCATE = "min-w-0 truncate";

/** Primary identifier — order number, invoice number. Underlines on hover like a link. */
export function IdCell({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        TRUNCATE,
        "font-medium tabular-nums text-foreground underline-offset-3 group-hover/row:underline",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function TextCell({
  children,
  muted = false,
  title,
  className,
}: {
  children: ReactNode;
  muted?: boolean;
  title?: string;
  className?: string;
}) {
  return (
    <span
      title={title}
      // A bare dash is an empty value; the phone card leaves those fields off.
      data-empty={children === "—" || undefined}
      className={cn(TRUNCATE, muted && "text-muted-foreground", className)}
    >
      {children}
    </span>
  );
}

/** Code-like values — SKU, barcode, GSTIN. Empty prints a dash. */
export function MonoCell({ value, className }: { value?: string | null; className?: string }) {
  if (!value) return <DashCell />;
  return (
    <span className={cn(TRUNCATE, "font-mono text-caption text-muted-foreground", className)}>
      {value}
    </span>
  );
}

export function DateCell({ value, time = false }: { value?: string | null; time?: boolean }) {
  return (
    <span className="whitespace-nowrap tabular-nums text-muted-foreground">
      {time ? formatDateTime(value) : formatDate(value)}
    </span>
  );
}

export function NumCell({ value, strong = false }: { value: number; strong?: boolean }) {
  return (
    <span className={cn("whitespace-nowrap tabular-nums", strong && "font-medium text-foreground")}>
      {value.toLocaleString("en-IN")}
    </span>
  );
}

export function MoneyCell({
  amount,
  currency,
  strong = false,
  muted = false,
}: {
  amount: number | string;
  currency: string;
  strong?: boolean;
  muted?: boolean;
}) {
  return (
    <span
      className={cn(
        "whitespace-nowrap tabular-nums",
        strong && "font-semibold text-foreground",
        muted && "text-muted-foreground",
      )}
    >
      {formatCurrency(amount, currency)}
    </span>
  );
}

/** A stock movement: `+12` in green, `−3` in red. */
export function SignedCell({ value }: { value: number }) {
  const positive = value > 0;
  return (
    <span
      className={cn(
        "whitespace-nowrap font-medium tabular-nums",
        positive ? "text-brand-strong" : "text-danger",
      )}
    >
      {positive ? "+" : "−"}
      {Math.abs(value).toLocaleString("en-IN")}
    </span>
  );
}

export function DashCell() {
  return <span data-empty className="text-muted-foreground">—</span>;
}

/** Name on top, a muted detail line under it; optional initials avatar. */
export function PersonCell({
  name,
  sub,
  initials,
  title,
}: {
  name: ReactNode;
  sub?: ReactNode;
  initials?: string;
  title?: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-3" title={title}>
      {initials !== undefined && (
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-brand text-caption font-semibold text-brand-foreground">
          {initials}
        </span>
      )}
      <div className="flex min-w-0 flex-col gap-0.5 leading-[1.35]">
        <span className={cn(TRUNCATE, "font-medium text-foreground")}>{name}</span>
        {sub != null && sub !== "" && (
          <span className={cn(TRUNCATE, "text-caption text-muted-foreground")}>{sub}</span>
        )}
      </div>
    </div>
  );
}

/** Thumbnail (or a box placeholder) beside a title and a muted variant/SKU line. */
export function ProductCell({
  title,
  sub,
  imageUrl,
  to,
}: {
  title: ReactNode;
  sub?: ReactNode;
  imageUrl?: string | null;
  /** Links the title to a detail route; the row click is skipped for it. */
  to?: string;
}) {
  const heading = to ? (
    <Link
      to={to}
      className={cn(TRUNCATE, "font-medium text-foreground underline-offset-3 hover:underline")}
    >
      {title}
    </Link>
  ) : (
    <span className={cn(TRUNCATE, "font-medium text-foreground")}>{title}</span>
  );
  return (
    <div className="flex min-w-0 items-center gap-3">
      {imageUrl ? (
        <img src={imageUrl} alt="" className="size-9 shrink-0 rounded-md object-cover ring-1 ring-border" />
      ) : (
        <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground/60 ring-1 ring-border">
          <Package className="size-4" />
        </span>
      )}
      <div className="flex min-w-0 flex-col gap-0.5 leading-[1.35]">
        {heading}
        {sub != null && sub !== "" && (
          <span className={cn(TRUNCATE, "text-caption text-muted-foreground")}>{sub}</span>
        )}
      </div>
    </div>
  );
}

/**
 * The status pill in table cells — the shared StatusBadge. Colour comes from a
 * `tone`, or from a feature's class map (`lib/order-status.ts` and friends),
 * which resolve to the same palette.
 */
export const StatusPill = StatusBadge;

export function ChannelCell({
  platform,
  name,
}: {
  platform?: ChannelPlatform | null;
  name?: string | null;
}) {
  return (
    <ChannelBadge platform={platform} name={name} size={14} className="min-w-0 truncate text-foreground" />
  );
}

/** A quantity with a dot that turns amber at or under the reorder point and red at zero. */
export function StockCell({
  value,
  lowAt = 0,
  title,
}: {
  value: number;
  /** Inclusive threshold for "low"; `0` means only out-of-stock is flagged. */
  lowAt?: number;
  title?: string;
}) {
  const out = value <= 0;
  const low = !out && lowAt > 0 && value <= lowAt;
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap tabular-nums" title={title}>
      <span
        aria-hidden
        className={cn(
          "size-1.5 rounded-full",
          out ? "bg-danger" : low ? "bg-warning" : "bg-muted-foreground/40",
        )}
      />
      {value.toLocaleString("en-IN")}
    </span>
  );
}

/** Up to two tags, then "+N". */
export function TagsCell({ tags }: { tags: ReadonlyArray<string> }) {
  if (tags.length === 0) return <DashCell />;
  const shown = tags.slice(0, 2);
  const more = tags.length - shown.length;
  return (
    <div className="flex min-w-0 items-center gap-1 overflow-hidden" title={tags.join(", ")}>
      {shown.map((tag) => (
        <span
          key={tag}
          className="whitespace-nowrap rounded-full bg-muted px-2 text-caption leading-[1.4] text-muted-foreground"
        >
          {tag}
        </span>
      ))}
      {more > 0 && <span className="text-caption text-muted-foreground">+{more}</span>}
    </div>
  );
}
