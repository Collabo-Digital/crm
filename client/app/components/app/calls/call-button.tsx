import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Phone } from "lucide-react";
import { toast } from "sonner";

import { Button } from "~/components/ui/button";
import { callKeys } from "~/hooks/use-calls";
import { handleMutationError } from "~/lib/handle-mutation-error";
import { CallSession, microphoneProblem } from "~/lib/whatsapp-call";
import { callsService } from "~/services/calls.service";
import { useCallStore } from "~/stores/call.store";

/**
 * Calls the person in this WhatsApp chat from the browser. WhatsApp needs
 * their permission first; without it this offers to ask in the chat.
 */
export function CallButton({ conversationId, name, className }: { conversationId: string; name: string; className?: string }) {
  const queryClient = useQueryClient();
  const onCall = useCallStore((s) => !!s.callId);
  const set = useCallStore((s) => s.set);
  const [busy, setBusy] = useState(false);

  async function call() {
    setBusy(true);
    let started: CallSession | null = null;
    try {
      const permission = await callsService.permission(conversationId);
      if (!permission.canCall) {
        if (permission.canAsk && window.confirm(`${name} has not allowed calls from your business yet. Send a message asking for permission?`)) {
          const sent = await callsService.askPermission(conversationId);
          if (sent.ok) toast.success("Asked. You can call once they allow it.");
          else toast.error(sent.message);
        } else if (!permission.canAsk) {
          toast.error(permission.status === "unavailable" ? "Calls are not available in this chat." : `${name} cannot be asked again yet. WhatsApp limits how often you can ask.`);
        }
        return;
      }
      const { session, sdp } = await CallSession.offer();
      started = session;
      const placed = await callsService.start(conversationId, sdp);
      set(placed.id, session);
      started = null;
      void queryClient.invalidateQueries({ queryKey: callKeys.live });
    } catch (err) {
      started?.close();
      if (err instanceof DOMException) toast.error(microphoneProblem(err));
      else handleMutationError(err, "The call could not start.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button variant="ghost" size="icon-sm" className={className} disabled={busy || onCall} onClick={() => void call()} aria-label={`Call ${name} on WhatsApp`} title="WhatsApp call">
      {busy ? <Loader2 className="animate-spin" /> : <Phone />}
    </Button>
  );
}
