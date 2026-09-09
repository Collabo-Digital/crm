import { Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Button } from "~/components/ui/button";
import { useCancelInviteMutation } from "~/hooks/use-org-mutations";
import type { InfluencerRow } from "~/types/api";

/**
 * Confirm cancelling an invitation.
 *
 * The consequence worth stating is that the link dies immediately — the invited
 * person may already have the email open, and an admin cancelling "just to
 * resend it" should know the old link stops working either way.
 *
 * Stays open when the mutation fails, so the toast is not hidden behind a page
 * the admin believes succeeded.
 */
export function CancelInviteDialog({
  invite,
  orgId,
  onOpenChange,
}: {
  invite: InfluencerRow | null;
  orgId: string;
  onOpenChange: (open: boolean) => void;
}) {
  const cancel = useCancelInviteMutation(orgId);

  if (!invite || !invite.inviteId) return null;

  return (
    <Dialog open onOpenChange={(next) => !cancel.isPending && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Cancel invitation?</DialogTitle>
          <DialogDescription>
            The invitation sent to {invite.email} will no longer be valid, and
            the link in that email will stop working immediately.
          </DialogDescription>
        </DialogHeader>

        <p className="text-caption text-muted-foreground">
          You can invite them again at any time. Doing so sends a fresh link.
        </p>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={cancel.isPending}
          >
            Keep invitation
          </Button>
          <Button
            variant="destructive"
            disabled={cancel.isPending}
            onClick={() =>
              cancel.mutate(invite.inviteId!, { onSuccess: () => onOpenChange(false) })
            }
          >
            {cancel.isPending && <Loader2 className="animate-spin" />}
            Cancel invitation
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
