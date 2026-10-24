import { create } from "zustand";
import type { CallSession } from "~/lib/whatsapp-call";
import { callsService } from "~/services/calls.service";
import { useAuthStore } from "~/stores/auth.store";

/** The one call this browser is on: its WebRTC session, shared by the call dock and the chat's call button. */
interface CallState {
  callId: string | null;
  session: CallSession | null;
  muted: boolean;
  set: (callId: string, session: CallSession) => void;
  setMuted: (muted: boolean) => void;
  clear: () => void;
  /** End the call for both sides: the microphone first, then the call at Meta. */
  hangUp: () => Promise<void>;
}

export const useCallStore = create<CallState>()((set, get) => ({
  callId: null,
  session: null,
  muted: false,
  set: (callId, session) => set({ callId, session, muted: false }),
  setMuted: (muted) => {
    get().session?.setMuted(muted);
    set({ muted });
  },
  clear: () => {
    get().session?.close();
    set({ callId: null, session: null, muted: false });
  },
  hangUp: async () => {
    const { callId } = get();
    if (!callId) return;
    get().clear();
    try {
      await callsService.terminate(callId);
    } catch {
      // Best effort: the microphone is already off.
    }
  },
}));

// The call dock, the only hang-up control, leaves with the session. A session
// that ends without signOut() (expired, or signed out in another tab) must
// still let the microphone go.
useAuthStore.subscribe((state, previous) => {
  if (previous.accessToken && !state.accessToken) useCallStore.getState().clear();
});
