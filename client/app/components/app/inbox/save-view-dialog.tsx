import { useState } from "react";

import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { RadioGroup, RadioGroupItem } from "~/components/ui/radio-group";
import type { InboxShareScope, InboxTeamRef, SaveInboxViewRequest } from "~/types/api";

/**
 * Save the list's current filters under a name. Sharing with a team or
 * everyone is for managers; a shared view still shows each member only what
 * they may see.
 */
export function SaveViewDialog({
  open,
  filters,
  canShare,
  teams,
  isSaving,
  onOpenChange,
  onSave,
}: {
  open: boolean;
  filters: SaveInboxViewRequest["filters"];
  canShare: boolean;
  teams: InboxTeamRef[];
  isSaving: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (data: SaveInboxViewRequest) => void;
}) {
  const [name, setName] = useState("");
  const [scope, setScope] = useState<InboxShareScope>("PERSONAL");
  const [teamId, setTeamId] = useState(teams[0]?.id ?? "");
  const valid = name.trim().length > 0 && (scope !== "TEAM" || !!teamId);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Save view</DialogTitle>
          <DialogDescription>Keeps the current folder, status and filters one click away.</DialogDescription>
        </DialogHeader>
        <form
          id="save-view"
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!valid) return;
            onSave({ name: name.trim(), filters, scope, ...(scope === "TEAM" ? { teamId } : {}) });
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="view-name">Name</Label>
            <Input id="view-name" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder="e.g. VIP on WhatsApp" autoFocus />
          </div>
          {canShare && (
            <div className="space-y-2">
              <Label>Who sees it</Label>
              <RadioGroup value={scope} onValueChange={(value) => setScope(value as InboxShareScope)} className="gap-2">
                <label className="flex items-center gap-2 text-body">
                  <RadioGroupItem value="PERSONAL" /> Just me
                </label>
                {teams.length > 0 && (
                  <label className="flex items-center gap-2 text-body">
                    <RadioGroupItem value="TEAM" /> A team
                    {scope === "TEAM" && (
                      <select
                        value={teamId}
                        onChange={(e) => setTeamId(e.target.value)}
                        className="ml-1 h-7 rounded-md border bg-background px-2 text-caption"
                        aria-label="Team"
                      >
                        {teams.map((team) => (
                          <option key={team.id} value={team.id}>
                            {team.name}
                          </option>
                        ))}
                      </select>
                    )}
                  </label>
                )}
                <label className="flex items-center gap-2 text-body">
                  <RadioGroupItem value="ORGANIZATION" /> Everyone in the inbox
                </label>
              </RadioGroup>
            </div>
          )}
        </form>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="save-view" variant="accent" disabled={!valid || isSaving}>
            Save view
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
