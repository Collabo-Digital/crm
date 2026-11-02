import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { useTransferOwnershipMutation } from "~/hooks/use-org-mutations";
import type { OrgMember } from "~/types/api";

const nameOf = (member: OrgMember) => `${member.user.firstName} ${member.user.lastName}`.trim();

/**
 * The owner hands the workspace to one of its admins and stays on as an
 * admin. It takes the owner's password, which the server checks: only the
 * owner changes the plan or deletes the workspace, so a signed-in session
 * alone (an unlocked laptop) is not enough to give that away.
 */
export function TransferOwnershipDialog({
  orgId,
  admins,
  onClose,
}: {
  orgId: string;
  admins: OrgMember[];
  onClose: () => void;
}) {
  const [newOwnerId, setNewOwnerId] = useState(admins.length === 1 ? admins[0].user.id : "");
  const [password, setPassword] = useState("");
  const transfer = useTransferOwnershipMutation(orgId);
  const chosen = admins.find((admin) => admin.user.id === newOwnerId);
  const ready = !!chosen && password.length > 0;

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!chosen || !password || transfer.isPending) return;
    transfer.mutate({ newOwnerId, password, newOwnerName: nameOf(chosen) }, { onSuccess: onClose });
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !transfer.isPending && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Transfer ownership</DialogTitle>
          <DialogDescription>
            The new owner can change the plan and billing, pass the workspace on, or delete it. You stay on as an
            admin, and only they can make you the owner again.
          </DialogDescription>
        </DialogHeader>
        <form id="transfer-ownership" onSubmit={submit} className="space-y-3">
          <div className="space-y-1.5">
            <Label id="transfer-ownership-to-label" htmlFor="transfer-ownership-to">
              New owner
            </Label>
            <Select value={newOwnerId} onValueChange={setNewOwnerId}>
              <SelectTrigger id="transfer-ownership-to" aria-labelledby="transfer-ownership-to-label" className="w-full">
                <SelectValue placeholder="Choose an admin" />
              </SelectTrigger>
              <SelectContent>
                {admins.map((admin) => (
                  <SelectItem key={admin.user.id} value={admin.user.id}>
                    {nameOf(admin)}
                    {admin.user.email && <span className="text-muted-foreground"> · {admin.user.email}</span>}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-caption text-muted-foreground">Only an admin can become the owner.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="transfer-ownership-password">Your password</Label>
            <Input
              id="transfer-ownership-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
            />
          </div>
        </form>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={transfer.isPending}>
            Cancel
          </Button>
          <Button type="submit" form="transfer-ownership" variant="destructive" disabled={!ready || transfer.isPending}>
            {transfer.isPending && <Loader2 className="animate-spin" />}
            Transfer ownership
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
