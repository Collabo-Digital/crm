import { useState } from "react";
import { FlaskConical, Loader2 } from "lucide-react";

import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { useTestAutomationMutation } from "~/hooks/use-automation-mutations";
import { BLOCKS } from "~/lib/automation-blocks";
import { cn } from "~/lib/utils";

/** Walk the draft for a sample person: what would be sent, which branches taken. Nothing is sent. */
export function TestRunDialog({ automationId, hasReplyStep, onClose }: { automationId: string; hasReplyStep: boolean; onClose: () => void }) {
  const test = useTestAutomationMutation();
  const [text, setText] = useState("");
  const [reply, setReply] = useState("");
  const result = test.data;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Try it out</DialogTitle>
          <DialogDescription>See what would happen for a sample person. Nothing is sent, tagged or saved.</DialogDescription>
        </DialogHeader>
        <form
          id="test-run"
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            test.mutate({ id: automationId, text, ...(hasReplyStep && reply.trim() ? { reply } : {}) });
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="test-text">Their message or comment</Label>
            <Input id="test-text" value={text} maxLength={1000} onChange={(e) => setText(e.target.value)} placeholder="What’s the price?" />
          </div>
          {hasReplyStep && (
            <div className="space-y-1.5">
              <Label htmlFor="test-reply">Their reply</Label>
              <Input id="test-reply" value={reply} maxLength={1000} onChange={(e) => setReply(e.target.value)} placeholder="Leave empty for no reply" />
            </div>
          )}
        </form>
        {result && (
          <div className="max-h-80 space-y-2 overflow-y-auto rounded-lg border p-3">
            {result.issues.length > 0 && (
              <p className="rounded-md bg-warning-subtle p-2 text-caption text-warning">
                {result.issues.length} thing{result.issues.length === 1 ? "" : "s"} must be fixed before publishing.
              </p>
            )}
            <ol className="space-y-2">
              {result.steps.map((s, i) => {
                const Icon = BLOCKS[s.type]?.icon ?? FlaskConical;
                return (
                  <li key={`${s.stepId}-${i}`} className="flex gap-2 text-caption">
                    <Icon className={cn("mt-0.5 size-3.5 shrink-0", s.status === "error" ? "text-danger" : "text-muted-foreground")} />
                    <span className={cn("min-w-0 break-words", s.status === "error" && "text-danger")}>{s.detail}</span>
                  </li>
                );
              })}
              {result.steps.length === 0 && <li className="text-caption text-muted-foreground">No steps after the trigger.</li>}
            </ol>
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button type="submit" form="test-run" variant="accent" disabled={test.isPending}>
            {test.isPending ? <Loader2 className="animate-spin" /> : <FlaskConical />}
            Run test
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
