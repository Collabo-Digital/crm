import { useEffect, useRef, type ReactNode } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { cn } from "~/lib/utils";

/**
 * One step of a sale — the cart, the customer, payment — as the whole screen
 * on a phone and a dialog on anything wider. Children are a PosScreenHeader,
 * a PosScreenBody that scrolls and an optional PosScreenFooter for the
 * primary button.
 *
 * On a phone the screen follows the visual viewport, so the on-screen
 * keyboard never covers the footer: Android resizes the page
 * (interactive-widget=resizes-content), iOS Safari does not.
 */
export function PosScreen({
  open,
  onOpenChange,
  title,
  description,
  children,
  className,
  onOpenAutoFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** For screen readers; the visible title is in PosScreenHeader. */
  title: string;
  description: string;
  children: ReactNode;
  className?: string;
  onOpenAutoFocus?: (event: Event) => void;
}) {
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!open || !vv) return;
    const fit = () => {
      const el = contentRef.current;
      if (!el) return;
      el.style.setProperty("--pos-vv-height", `${vv.height}px`);
      el.style.setProperty("--pos-vv-top", `${vv.offsetTop}px`);
    };
    // The content mounts a frame after `open` flips.
    const raf = requestAnimationFrame(fit);
    vv.addEventListener("resize", fit);
    vv.addEventListener("scroll", fit);
    return () => {
      cancelAnimationFrame(raf);
      vv.removeEventListener("resize", fit);
      vv.removeEventListener("scroll", fit);
    };
  }, [open]);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/30 duration-100 max-md:hidden data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <DialogPrimitive.Content
          ref={contentRef}
          data-slot="pos-screen"
          onOpenAutoFocus={onOpenAutoFocus}
          className={cn(
            "fixed z-50 flex flex-col overflow-hidden bg-background text-foreground outline-none",
            "max-md:inset-x-0 max-md:top-[var(--pos-vv-top,0px)] max-md:h-[var(--pos-vv-height,100dvh)]",
            "md:top-1/2 md:left-1/2 md:max-h-[min(92dvh,820px)] md:w-full md:max-w-lg md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-2xl md:shadow-xl md:ring-1 md:ring-foreground/10",
            "duration-150 data-open:animate-in data-open:fade-in-0 max-md:data-open:slide-in-from-bottom-4 md:data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0",
            className,
          )}
        >
          <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">{description}</DialogPrimitive.Description>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** Close on the left, the title, and one secondary action on the right ("Skip – walk-in"). */
export function PosScreenHeader({ left, title, right }: { left?: ReactNode; title: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex min-h-14 shrink-0 items-center gap-1 border-b px-2 max-md:pt-[env(safe-area-inset-top)]">
      {left}
      <h2 className={cn("min-w-0 flex-1 truncate font-heading text-section", !left && "pl-2")}>{title}</h2>
      {right}
    </div>
  );
}

export function PosScreenBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4", className)}>{children}</div>;
}

export function PosScreenFooter({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("shrink-0 space-y-2 border-t bg-background px-4 pt-3 pb-[max(12px,env(safe-area-inset-bottom))]", className)}>
      {children}
    </div>
  );
}
