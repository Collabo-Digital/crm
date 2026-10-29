/**
 * The browser end of a WhatsApp call: one RTCPeerConnection with the
 * microphone as its only audio track, as Meta requires (one stream, one
 * track, Opus). Meta's side is ICE-lite and offers no STUN or TURN, so the
 * browser runs full ICE with its own candidates and sends them all in its
 * SDP; no trickle.
 */
export class CallSession {
  readonly pc: RTCPeerConnection;
  private readonly audio: HTMLAudioElement;
  private mic: MediaStream | null = null;

  private constructor() {
    this.pc = new RTCPeerConnection({ bundlePolicy: "max-bundle", iceServers: [] });
    this.audio = new Audio();
    this.audio.autoplay = true;
    this.pc.ontrack = (event) => {
      this.audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
      void this.audio.play().catch(() => undefined);
    };
  }

  private async withMicrophone() {
    this.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    for (const track of this.mic.getAudioTracks()) this.pc.addTrack(track, this.mic);
  }

  /** Every local candidate in the SDP before it goes to Meta. */
  private gathered(): Promise<string> {
    return new Promise((resolve) => {
      const done = () => resolve(this.pc.localDescription?.sdp ?? "");
      if (this.pc.iceGatheringState === "complete") return done();
      const timer = setTimeout(done, 3000);
      this.pc.addEventListener("icegatheringstatechange", () => {
        if (this.pc.iceGatheringState === "complete") {
          clearTimeout(timer);
          done();
        }
      });
    });
  }

  /** A person's call: answer Meta's offer. The microphone stays silent until Meta confirms the accept (`setMuted(false)`). */
  static async answer(offerSdp: string): Promise<{ session: CallSession; sdp: string }> {
    const session = new CallSession();
    try {
      await session.pc.setRemoteDescription({ type: "offer", sdp: offerSdp });
      await session.withMicrophone();
      session.setMuted(true);
      await session.pc.setLocalDescription(await session.pc.createAnswer());
      return { session, sdp: await session.gathered() };
    } catch (err) {
      session.close();
      throw err;
    }
  }

  /** A business call: the offer Meta answers on the calls webhook. */
  static async offer(): Promise<{ session: CallSession; sdp: string }> {
    const session = new CallSession();
    try {
      await session.withMicrophone();
      await session.pc.setLocalDescription(await session.pc.createOffer());
      return { session, sdp: await session.gathered() };
    } catch (err) {
      session.close();
      throw err;
    }
  }

  async applyAnswer(sdp: string) {
    if (this.pc.signalingState === "have-local-offer") await this.pc.setRemoteDescription({ type: "answer", sdp });
  }

  setMuted(muted: boolean) {
    for (const track of this.mic?.getAudioTracks() ?? []) track.enabled = !muted;
  }

  close() {
    for (const track of this.mic?.getTracks() ?? []) track.stop();
    this.audio.srcObject = null;
    this.pc.close();
  }
}

/** Why the microphone could not be used, in words. */
export function microphoneProblem(err: unknown): string {
  const name = err instanceof DOMException ? err.name : "";
  if (name === "NotAllowedError") return "Allow the microphone for this site to take calls.";
  if (name === "NotFoundError") return "No microphone was found on this device.";
  return err instanceof Error ? err.message : "The call could not start.";
}
