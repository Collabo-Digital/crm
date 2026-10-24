import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { Loader2, Mic, MicOff, Phone, PhoneOff } from "lucide-react";
import { toast } from "sonner";

import { Button } from "~/components/ui/button";
import { callKeys, useLiveCalls } from "~/hooks/use-calls";
import { useNow } from "~/hooks/use-now";
import { handleMutationError } from "~/lib/handle-mutation-error";
import { CallSession, microphoneProblem } from "~/lib/whatsapp-call";
import { callsService } from "~/services/calls.service";
import { useCallStore } from "~/stores/call.store";
import type { WhatsAppCallView } from "~/types/api";

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

/** A soft two-tone ring while a call waits, where the browser allows sound. */
function useRing(on: boolean) {
  useEffect(() => {
    if (!on || typeof AudioContext === "undefined") return;
    let ctx: AudioContext | null = null;
    try {
      ctx = new AudioContext();
    } catch {
      return;
    }
    const beep = () => {
      if (!ctx || ctx.state === "closed") return;
      for (const [freq, at] of [[880, 0], [660, 0.25]] as const) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = freq;
        gain.gain.value = 0.06;
        osc.connect(gain).connect(ctx.destination);
        osc.start(ctx.currentTime + at);
        osc.stop(ctx.currentTime + at + 0.2);
      }
    };
    beep();
    const timer = setInterval(beep, 2000);
    return () => {
      clearInterval(timer);
      void ctx?.close();
    };
  }, [on]);
}

function ActiveCall({ call }: { call: WhatsAppCallView }) {
  const now = useNow(1000);
  const { muted, setMuted, clear } = useCallStore();
  const queryClient = useQueryClient();
  const [ending, setEnding] = useState(false);
  const status =
    call.status === "ACTIVE" && call.answeredAt
      ? clock(Math.max(0, Math.round((now - new Date(call.answeredAt).getTime()) / 1000)))
      : call.status === "RINGING"
        ? "Ringing…"
        : "Connecting…";
  return (
    <div role="status" aria-label={`Call with ${call.contactName}`} className="flex items-center gap-3 rounded-2xl border bg-card p-3 shadow-lg">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-success/15 text-success">
        <Phone className="size-5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-body font-semibold">{call.contactName}</p>
        <p className="text-caption tabular-nums text-muted-foreground">{status}</p>
        {call.conversationId && (
          <Link to={`/inbox?c=${call.conversationId}`} className="text-micro text-brand-strong underline-offset-2 hover:underline">
            Open chat
          </Link>
        )}
      </div>
      <Button size="icon" variant="outline" aria-label={muted ? "Unmute" : "Mute"} aria-pressed={muted} onClick={() => setMuted(!muted)}>
        {muted ? <MicOff /> : <Mic />}
      </Button>
      <Button
        size="icon"
        variant="destructive"
        aria-label="Hang up"
        disabled={ending}
        onClick={() => {
          setEnding(true);
          void callsService
            .terminate(call.id)
            .catch((err) => handleMutationError(err, "The call could not be ended."))
            .finally(() => {
              clear();
              void queryClient.invalidateQueries({ queryKey: callKeys.live });
            });
        }}
      >
        <PhoneOff />
      </Button>
    </div>
  );
}

/**
 * WhatsApp calls in the corner of every page: a person's call rings for the
 * whole team and the first to answer takes it in their browser; the call this
 * browser is on shows its time, mute and hang-up.
 */
export function CallDock() {
  const queryClient = useQueryClient();
  const { data: calls = [] } = useLiveCalls(true);
  const { callId, session, set, clear } = useCallStore();
  const [answering, setAnswering] = useState<string | null>(null);
  const seen = useRef<string | null>(null);
  const applied = useRef<string | null>(null);

  const mine = callId ? calls.find((c) => c.id === callId) ?? null : null;
  const ringing = calls.filter((c) => c.direction === "USER_INITIATED" && c.status === "RINGING");
  useRing(ringing.length > 0 && !callId);

  // A business call: Meta's answer arrives on the calls webhook.
  useEffect(() => {
    if (!mine || mine.direction !== "BUSINESS_INITIATED" || !mine.hasAnswer || !session || applied.current === mine.id) return;
    applied.current = mine.id;
    void callsService
      .get(mine.id)
      .then((detail) => (detail.answerSdp ? session.applyAnswer(detail.answerSdp) : undefined))
      .catch(() => toast.error("The call's audio could not connect."));
  }, [mine, session]);

  // The call ended on either side: let the microphone go.
  useEffect(() => {
    if (mine) seen.current = mine.id;
    else if (callId && seen.current === callId) {
      seen.current = null;
      clear();
    }
  }, [mine, callId, clear]);

  async function answer(call: WhatsAppCallView) {
    setAnswering(call.id);
    let started: CallSession | null = null;
    try {
      const detail = await callsService.get(call.id);
      if (!detail.offerSdp) throw new Error("The call has no audio offer.");
      const { session: s, sdp } = await CallSession.answer(detail.offerSdp);
      started = s;
      await callsService.accept(call.id, sdp);
      // Meta: media flows once the accept is confirmed.
      s.setMuted(false);
      set(call.id, s);
      started = null;
    } catch (err) {
      started?.close();
      if (err instanceof DOMException || (err instanceof Error && !("isAxiosError" in err))) toast.error(microphoneProblem(err));
      else handleMutationError(err, "The call could not be answered.");
    } finally {
      setAnswering(null);
      void queryClient.invalidateQueries({ queryKey: callKeys.live });
    }
  }

  if (!mine && ringing.length === 0) return null;
  return (
    <div className="fixed bottom-4 right-4 z-50 w-[min(22rem,calc(100vw-2rem))] space-y-2 max-md:bottom-[calc(var(--mobile-nav-height)+12px)]">
      {mine && <ActiveCall call={mine} />}
      {!callId &&
        ringing.slice(0, 2).map((call) => (
          <div key={call.id} role="alertdialog" aria-label={`WhatsApp call from ${call.contactName}`} className="rounded-2xl border border-success/40 bg-card p-3 shadow-lg">
            <div className="flex items-center gap-3">
              <span className="flex size-10 shrink-0 animate-pulse items-center justify-center rounded-full bg-success/15 text-success">
                <Phone className="size-5" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-micro font-semibold uppercase tracking-wider text-success">WhatsApp call</p>
                <p className="truncate text-body font-semibold">{call.contactName}</p>
                {call.phone && <p className="text-micro text-muted-foreground">{call.phone}</p>}
              </div>
            </div>
            <div className="mt-3 flex gap-2">
              <Button className="flex-1 bg-success text-white hover:bg-success/90" disabled={!!answering} onClick={() => void answer(call)}>
                {answering === call.id ? <Loader2 className="animate-spin" /> : <Phone />}
                Answer
              </Button>
              <Button
                variant="outline"
                className="flex-1"
                disabled={!!answering}
                onClick={() =>
                  void callsService
                    .reject(call.id)
                    .catch((err) => handleMutationError(err, "The call could not be declined."))
                    .finally(() => void queryClient.invalidateQueries({ queryKey: callKeys.live }))
                }
              >
                <PhoneOff />
                Decline
              </Button>
            </div>
          </div>
        ))}
    </div>
  );
}
