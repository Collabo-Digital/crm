import { useState } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { useStartChatMutation } from "~/hooks/use-inbox-mutations";

interface NewChatDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** "chat" opens the conversation afterwards; "contact" only adds the person. */
  mode: "chat" | "contact";
  onDone: (result: { contactId: string; conversationId: string; created: boolean }) => void;
}

/**
 * Start a WhatsApp chat with a number, or add it as a contact. The first
 * message to someone who has not written in 24 hours must be a template.
 */
export function NewChatDialog({ open, onOpenChange, mode, onDone }: NewChatDialogProps) {
  const [countryCode, setCountryCode] = useState("91");
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [optIn, setOptIn] = useState(false);
  const start = useStartChatMutation();
  const hasPlus = phone.trim().startsWith("+");

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!phone.trim()) return;
    start.mutate(
      { phone: phone.trim(), ...(hasPlus ? {} : { countryCode }), ...(name.trim() ? { name: name.trim() } : {}), optIn },
      {
        onSuccess: (result) => {
          setPhone("");
          setName("");
          setOptIn(false);
          onDone(result);
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>{mode === "chat" ? "New WhatsApp chat" : "Add a contact"}</DialogTitle>
            <DialogDescription>
              {mode === "chat"
                ? "Message someone who has not written to you yet. Your first message has to be an approved template."
                : "Add someone to your WhatsApp contacts. You can message them with an approved template."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="nc-phone">WhatsApp number</Label>
            <div className="flex gap-2">
              {!hasPlus && (
                <div className="flex w-20 shrink-0 items-center rounded-md border border-input px-2">
                  <span className="text-muted-foreground">+</span>
                  <input
                    aria-label="Country code"
                    inputMode="numeric"
                    value={countryCode}
                    maxLength={4}
                    onChange={(e) => setCountryCode(e.target.value.replace(/\D/g, ""))}
                    className="w-full bg-transparent px-1 py-2 text-body outline-none"
                  />
                </div>
              )}
              <Input id="nc-phone" type="tel" inputMode="tel" autoComplete="tel" autoFocus value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="98765 43210" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="nc-name">Name (optional)</Label>
            <Input id="nc-name" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} placeholder="Priya Sharma" />
          </div>
          <label className="flex items-start gap-2 text-caption text-foreground">
            <Checkbox checked={optIn} onCheckedChange={(v) => setOptIn(v === true)} className="mt-0.5" />
            <span>They agreed to get WhatsApp messages from us. This is recorded as their opt-in.</span>
          </label>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="accent" disabled={!phone.trim() || start.isPending}>
              {start.isPending && <Loader2 className="animate-spin" />}
              {mode === "chat" ? "Start chat" : "Add contact"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
