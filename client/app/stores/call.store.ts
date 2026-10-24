import { create } from "zustand";
import type { CallSession } from "~/lib/whatsapp-call";

/** The one call this browser is on: its WebRTC session, shared by the call dock and the chat's call button. */
interface CallState {
  callId: string | null;
  session: CallSession | null;
  muted: boolean;
  set: (callId: string, session: CallSession) => void;
  setMuted: (muted: boolean) => void;
  clear: () => void;
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
}));
