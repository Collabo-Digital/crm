import { useEffect, type ReactNode } from "react";
import { useBlocker } from "react-router";
import { Check, Loader2 } from "lucide-react";

import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { cn } from "~/lib/utils";

/**
 * How every settings form saves. Fields stay on the page until Save; this bar
 * at the end of the form says whether anything is unsaved, pins itself to the
 * bottom of the screen while something is, and leaving the page (or closing
 * the tab) with unsaved changes asks first.
 *
 * A switch that stands on its own is not a form: it saves the moment it is
 * flipped and says so in a toast. Use this bar for everything typed or picked.
 *
 * One per page: React Router allows a single navigation blocker at a time.
 */
export function SaveBar({
  dirty,
  saving,
  invalid = false,
  form,
  onSave,
  onDiscard,
  what = "these settings",
  pinned = false,
  className,
  children,
}: {
  dirty: boolean;
  saving: boolean;
  /** Something typed is wrong: Save stays off until it is fixed. */
  invalid?: boolean;
  /** Submit this form (by id) rather than calling onSave. */
  form?: string;
  onSave?: () => void;
  onDiscard?: () => void;
  /** Named in the leave prompt: "Your changes to {what} aren't saved yet." */
  what?: string;
  /** Pin the bar even with nothing to save, when it holds another action. */
  pinned?: boolean;
  className?: string;
  /** Extra actions before Discard, such as Preview. */
  children?: ReactNode;
}) {
  const leaving = useBlocker(({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  return (
    <>
      <div className={cn("mobile-action-dock bottom-4 z-10", (dirty || pinned) && "sticky", className)}>
        <div role="group" aria-label="Save changes" className="flex items-center gap-2 rounded-xl bg-card px-4 py-3 shadow-lg ring-1 ring-border">
          <p className="min-w-0 flex-1 text-caption text-muted-foreground max-md:sr-only" aria-live="polite">
            {saving ? "Saving…" : dirty ? (invalid ? "Fix the marked fields to save." : "You have unsaved changes.") : "All changes saved."}
          </p>
          {children}
          {dirty && onDiscard && (
            <Button type="button" variant="ghost" onClick={onDiscard} disabled={saving}>
              Discard
            </Button>
          )}
          <Button
            type={onSave ? "button" : "submit"}
            form={onSave ? undefined : form}
            onClick={onSave}
            disabled={!dirty || invalid || saving}
            className="max-md:flex-1"
          >
            {saving ? <Loader2 className="animate-spin" /> : !dirty && <Check />}
            {dirty || saving ? "Save changes" : "Saved"}
          </Button>
        </div>
      </div>

      <Dialog open={leaving.state === "blocked"} onOpenChange={(open) => !open && leaving.reset?.()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Leave without saving?</DialogTitle>
            <DialogDescription>Your changes to {what} aren't saved yet.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => leaving.reset?.()}>
              Stay
            </Button>
            <Button variant="destructive" onClick={() => leaving.proceed?.()}>
              Leave
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
