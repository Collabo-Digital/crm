import * as React from "react";
import { Slot } from "radix-ui";
import { X } from "lucide-react";

import { cn } from "~/lib/utils";

/**
 * Dark pill fixed to the bottom of the viewport that carries the bulk actions
 * for the rows ticked in a list. Render it only while something is selected —
 * it has no empty state of its own.
 *
 * z-40 keeps it under dialogs and dropdown menus (z-50), so a menu opened from
 * the dock or a confirm it raises always sits on top of it. Pages that show it
 * should add bottom padding while it is up so it never covers pagination.
 */
export function FloatingDock({
  count,
  noun,
  summary,
  onClear,
  children,
}: {
  count: number;
  /** Text after the count badge, e.g. "selected" or "orders". */
  noun: string;
  /** Optional muted detail after the noun, e.g. a total. */
  summary?: React.ReactNode;
  onClear: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="mobile-action-dock pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center px-4 pb-5">
      <div
        role="group"
        aria-label="Bulk actions"
        className="pointer-events-auto flex max-w-full animate-in items-center gap-0.5 overflow-x-auto whitespace-nowrap rounded-full bg-ink p-1.5 text-label font-medium text-ink-foreground shadow-[0_10px_30px_rgba(0,0,0,.22),0_2px_6px_rgba(0,0,0,.12)] ring-1 ring-white/10 duration-200 fade-in slide-in-from-bottom-4"
      >
        <div className="flex shrink-0 items-center gap-2 pl-1.5 pr-3">
          <span className="flex h-[22px] min-w-[22px] items-center justify-center rounded-full bg-brand px-1.5 text-caption font-bold tabular-nums text-brand-forest">
            {count}
          </span>
          <span>{noun}</span>
          {summary != null && <span className="text-ink-foreground/60">· {summary}</span>}
        </div>
        <DockDivider />
        {children}
        <DockDivider />
        <button
          type="button"
          onClick={onClear}
          aria-label="Clear selection"
          title="Clear selection"
          className="flex size-[34px] shrink-0 items-center justify-center rounded-full bg-white/8 transition-colors hover:bg-brand hover:text-brand-forest focus-visible:outline-brand"
        >
          <X className="size-4" />
        </button>
      </div>
    </div>
  );
}

export function DockDivider() {
  return <div aria-hidden className="mx-1 h-5 w-px shrink-0 bg-white/16" />;
}

/**
 * Pill button for use inside {@link FloatingDock}. `asChild` lets it wrap a
 * `<Link>` or act as a Radix menu trigger.
 */
export function DockButton({
  tone = "default",
  iconOnly = false,
  asChild = false,
  className,
  ...props
}: React.ComponentProps<"button"> & {
  tone?: "default" | "danger";
  iconOnly?: boolean;
  asChild?: boolean;
}) {
  const Comp = asChild ? Slot.Root : "button";
  return (
    <Comp
      type={asChild ? undefined : "button"}
      className={cn(
        "flex h-[34px] shrink-0 items-center justify-center gap-1.5 rounded-full transition-colors outline-none disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-3.5 [&_svg]:shrink-0 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand",
        iconOnly ? "w-[34px]" : "px-3",
        tone === "danger" && "text-red-300 hover:bg-red-500/20",
        // Plain until hovered, focused or holding an open menu, then lime.
        tone === "default" &&
          "hover:bg-brand hover:text-brand-forest focus-visible:bg-brand focus-visible:text-brand-forest aria-expanded:bg-brand aria-expanded:text-brand-forest",
        className,
      )}
      {...props}
    />
  );
}
