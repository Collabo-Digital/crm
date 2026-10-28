import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";

/**
 * Asks before a switch that changes tax or prices takes effect. Such a switch
 * still saves the moment it is confirmed, like every other switch.
 */
export function ConfirmChangeDialog({
  open,
  title,
  points,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  /** What happens from now on, one sentence each. */
  points: string[];
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>From now on:</DialogDescription>
        </DialogHeader>
        <ul className="list-disc space-y-1.5 pl-5 text-body">
          {points.map((point) => (
            <li key={point}>{point}</li>
          ))}
        </ul>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={onConfirm}>{confirmLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
