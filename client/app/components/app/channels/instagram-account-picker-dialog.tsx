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
import { Skeleton } from "~/components/ui/skeleton";
import { useInstagramPending } from "~/hooks/use-channel-queries";
import { useCompleteInstagramInstallMutation } from "~/hooks/use-channel-mutations";
import { ChannelAvatar } from "./channel-account-cell";
import { cn } from "~/lib/utils";

/**
 * "Which Instagram account?" — shown when one Facebook login grants several.
 *
 * The old flow read `pages[0]` and connected whatever it found, so a merchant
 * running three handles could only ever reach one of them. The server parks the
 * candidates in Redis and redirects here with `?select=instagram&pending=<id>`;
 * accounts already connected to this org are filtered out server-side, so
 * everything listed is genuinely connectable.
 */
export function InstagramAccountPickerDialog({
  pendingId,
  onOpenChange,
  onRetry,
}: {
  pendingId: string | null;
  onOpenChange: (open: boolean) => void;
  /** Start the whole flow again, after an expired selection. */
  onRetry: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const { data, isLoading, isError } = useInstagramPending(pendingId);
  const complete = useCompleteInstagramInstallMutation();

  const candidates = data?.candidates ?? [];

  // Preselect the only sensible default rather than making the merchant click
  // twice when the list is short.
  useEffect(() => {
    if (!selected && candidates.length > 0) setSelected(candidates[0].igUserId);
  }, [candidates, selected]);

  if (!pendingId) return null;

  return (
    <Dialog open onOpenChange={(open) => !complete.isPending && onOpenChange(open)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Choose an Instagram account</DialogTitle>
          <DialogDescription>
            That login gives access to more than one account. Pick the one to
            connect now — you can add the others afterwards.
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : isError || candidates.length === 0 ? (
          <div className="rounded-lg border border-border bg-muted p-4">
            <p className="text-body font-medium text-danger">
              This selection has expired.
            </p>
            <p className="mt-1 text-caption text-muted-foreground">
              For security the choice is only held for a few minutes. Start the
              connection again to pick an account.
            </p>
          </div>
        ) : (
          <div className="max-h-80 space-y-2 overflow-y-auto">
            {candidates.map((candidate) => {
              const isSelected = selected === candidate.igUserId;
              return (
                <button
                  key={candidate.igUserId}
                  type="button"
                  onClick={() => setSelected(candidate.igUserId)}
                  aria-pressed={isSelected}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors",
                    isSelected
                      ? "border-brand bg-brand/10"
                      : "border-border hover:bg-muted",
                  )}
                >
                  <ChannelAvatar
                    platform="INSTAGRAM"
                    avatarUrl={candidate.profilePictureUrl}
                    size={40}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-body font-medium text-foreground">
                      {candidate.username ? `@${candidate.username}` : candidate.name}
                    </p>
                    <p className="truncate text-caption text-muted-foreground">
                      Facebook Page: {candidate.pageName}
                    </p>
                  </div>
                  <span
                    className={cn(
                      "size-4 shrink-0 rounded-full border-2",
                      isSelected ? "border-brand bg-brand" : "border-border",
                    )}
                  />
                </button>
              );
            })}
          </div>
        )}

        <DialogFooter>
          {isError || (!isLoading && candidates.length === 0) ? (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Close
              </Button>
              <Button variant="accent" onClick={onRetry}>
                Connect Instagram
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={complete.isPending}
              >
                Cancel
              </Button>
              <Button
                variant="accent"
                disabled={!selected || complete.isPending || isLoading}
                onClick={() =>
                  selected &&
                  complete.mutate(
                    { pendingId, igUserId: selected },
                    { onSuccess: () => onOpenChange(false) },
                  )
                }
              >
                {complete.isPending && <Loader2 className="animate-spin" />}
                Connect account
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
