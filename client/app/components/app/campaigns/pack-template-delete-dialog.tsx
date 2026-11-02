import { Loader2 } from "lucide-react";

import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { useDeleteTemplateMutation } from "~/hooks/use-campaign-mutations";
import { packSlotTitle } from "~/lib/template-pack";
import type { MessageTemplate } from "~/types/api";

/**
 * The warning before deleting a template Collabo manages: unlike the merchant's
 * own, automations send it, and they stop when it goes. Stays open when the
 * delete fails, so the toast is not hidden behind a page that looks done.
 */
export function PackTemplateDeleteDialog({ template, onOpenChange }: { template: MessageTemplate | null; onOpenChange: (open: boolean) => void }) {
  const remove = useDeleteTemplateMutation();
  if (!template) return null;

  return (
    <Dialog open onOpenChange={(open) => !remove.isPending && onOpenChange(open)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete a template Collabo manages?</DialogTitle>
          <DialogDescription>
            Collabo manages this template. Deleting it stops the automations that send it, and Collabo won't create it again unless you press Repair on the Recommended
            templates card.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 text-caption text-muted-foreground">
          <p>
            <span className="font-mono text-foreground">{template.name}</span> ({template.language}) is Collabo’s “{packSlotTitle(template.packSlot ?? "")}” template. It is
            deleted at Meta, and its name cannot be used again for 30 days.
          </p>
          <p>To send your own wording instead, choose “Use my own template” in the automation’s step, then delete this one.</p>
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={remove.isPending} onClick={() => onOpenChange(false)}>
            Keep it
          </Button>
          <Button variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate(template.id, { onSuccess: () => onOpenChange(false) })}>
            {remove.isPending && <Loader2 className="animate-spin" />}
            Delete at Meta
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
