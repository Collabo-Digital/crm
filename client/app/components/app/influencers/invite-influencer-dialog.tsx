import { useEffect, useState } from "react";
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
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { useInviteInfluencerMutation } from "~/hooks/use-org-mutations";

/** Same shape the server's @IsEmail accepts, so the inline error matches the API's. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Invite someone to join as an influencer.
 *
 * The role is shown but not editable: it is fixed by the endpoint this posts to,
 * so offering a picker would imply a choice that does not exist. Validation is
 * inline on the field rather than a toast, because the thing to fix is the field.
 */
export function InviteInfluencerDialog({
  open,
  onOpenChange,
  orgId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgId: string;
}) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [touched, setTouched] = useState(false);
  const invite = useInviteInfluencerMutation(orgId);

  // Start clean each time it opens, so a cancelled attempt does not reappear
  // half-filled the next time.
  useEffect(() => {
    if (open) {
      setEmail("");
      setName("");
      setTouched(false);
    }
  }, [open]);

  const trimmed = email.trim();
  const emailError =
    touched && !trimmed
      ? "Enter an email address"
      : touched && !EMAIL_PATTERN.test(trimmed)
        ? "Enter a valid email address"
        : null;

  function submit() {
    setTouched(true);
    if (!trimmed || !EMAIL_PATTERN.test(trimmed)) return;
    invite.mutate(
      { email: trimmed, name: name.trim() || undefined },
      { onSuccess: () => onOpenChange(false) },
    );
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !invite.isPending && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Invite influencer</DialogTitle>
          <DialogDescription>
            They will be emailed a link to join this organization and connect
            their own Instagram account.
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="influencer-email">Email</Label>
            <Input
              id="influencer-email"
              type="email"
              autoFocus
              placeholder="influencer@example.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              onBlur={() => setTouched(true)}
              aria-invalid={!!emailError}
              aria-describedby={emailError ? "influencer-email-error" : undefined}
              disabled={invite.isPending}
            />
            {emailError && (
              <p id="influencer-email-error" className="text-caption text-danger">
                {emailError}
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="influencer-name">Name</Label>
            <Input
              id="influencer-name"
              placeholder="Optional"
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={invite.isPending}
            />
            <p className="text-caption text-muted-foreground">
              Used to address the invitation email. They can change it when they
              create their account.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="influencer-role">Role</Label>
            {/* Read-only by design: this dialog invites influencers, and the
                server fixes the role regardless of what is sent. */}
            <Input id="influencer-role" value="Influencer" readOnly disabled />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={invite.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" variant="accent" disabled={invite.isPending}>
              {invite.isPending && <Loader2 className="animate-spin" />}
              Send invitation
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
