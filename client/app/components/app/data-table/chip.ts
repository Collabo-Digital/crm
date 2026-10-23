import { cn } from "~/lib/utils";

/**
 * The filter-row pill. Tinted lime-on-forest while it narrows the list,
 * a plain hairline card otherwise. Shared by the date chip and filter chips
 * so the row reads as one family.
 */
export function chipClass(active: boolean, className?: string): string {
  return cn(
    "inline-flex h-10 items-center rounded-full text-label md:h-7",
    active ? "bg-brand/30 text-brand-strong" : "bg-card text-foreground ring-1 ring-border",
    className,
  );
}

/** The small round × that sits inside a chip. */
export const CHIP_CLEAR_CLASS =
  "mr-0.5 flex size-9 shrink-0 items-center justify-center rounded-full hover:bg-brand-strong/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 md:size-6";

/** An option row inside a chip or scope popover. */
export const OPTION_CLASS =
  "flex min-h-11 w-full shrink-0 items-center gap-2 rounded-md px-2 text-left text-label text-foreground hover:bg-muted focus-visible:bg-muted focus-visible:outline-none md:min-h-8";
