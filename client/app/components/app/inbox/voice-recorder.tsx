import { useEffect, useRef, useState } from "react";
import { Loader2, SendHorizontal, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

/** WhatsApp shows a play button only for voice notes up to 512 KB; two minutes keeps the converted file under it. */
export const VOICE_NOTE_MAX_MS = 120_000;
const VOICE_NOTE_MIN_MS = 1_000;
const TICK_MS = 100;
const LEVEL_BARS = 64;

/** In order of preference. The server converts whichever it gets to Ogg Opus. */
const RECORDING_TYPES = [
  { mime: "audio/ogg;codecs=opus", extension: "ogg" },
  { mime: "audio/webm;codecs=opus", extension: "webm" },
  { mime: "audio/mp4", extension: "m4a" },
];

function recordingType() {
  if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) return null;
  return RECORDING_TYPES.find((type) => MediaRecorder.isTypeSupported(type.mime)) ?? null;
}

/** Whether this browser can record a voice note at all. */
export function canRecordVoice(): boolean {
  return typeof window !== "undefined" && recordingType() !== null;
}

/** "1:05" */
export function formatClock(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Stop once; resolves after the last chunk has arrived, which comes just before the stop event. */
function stopRecorder(recorder: MediaRecorder, stopped: { current: Promise<void> | null }): Promise<void> {
  stopped.current ??= new Promise<void>((resolve) => {
    recorder.addEventListener("stop", () => resolve(), { once: true });
    if (recorder.state !== "inactive") recorder.stop();
    else resolve();
  });
  return stopped.current;
}

function microphoneProblem(err: unknown): string {
  const name = err instanceof DOMException ? err.name : "";
  if (name === "NotAllowedError") return "Allow the microphone for this site to record a voice note.";
  if (name === "NotFoundError") return "No microphone was found on this device.";
  return "The microphone could not be opened.";
}

/**
 * The composer while a voice note records: a red dot, the time, a live level
 * trace, a bin and Send. It asks for the microphone when it opens and lets it
 * go when it closes, whichever way it closes.
 */
export function VoiceRecorder({
  onCancel,
  onSend,
}: {
  onCancel: () => void;
  onSend: (file: File, durationMs: number) => void;
}) {
  const [live, setLive] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [levels, setLevels] = useState<number[]>([]);
  const [atLimit, setAtLimit] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const stopped = useRef<Promise<void> | null>(null);
  const chunks = useRef<Blob[]>([]);
  const startedAt = useRef(0);
  const closed = useRef(false);
  // The parent's callbacks change every render; the recording must not restart with them.
  const cancelRef = useRef(onCancel);
  useEffect(() => {
    cancelRef.current = onCancel;
  });

  useEffect(() => {
    const type = recordingType();
    let stream: MediaStream | null = null;
    let context: AudioContext | null = null;
    let timer: ReturnType<typeof setInterval> | undefined;
    let active = true;
    closed.current = false;

    function start(mic: MediaStream) {
      stream = mic;
      const recorder = new MediaRecorder(mic, { mimeType: type!.mime, audioBitsPerSecond: 32_000 });
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunks.current.push(event.data);
      };
      recorder.start(250);
      startedAt.current = performance.now();
      setLive(true);

      // The level trace is decoration: without Web Audio it stays flat and the recording is unaffected.
      let analyser: AnalyserNode | null = null;
      try {
        context = new AudioContext();
        void context.resume();
        analyser = context.createAnalyser();
        analyser.fftSize = 512;
        context.createMediaStreamSource(mic).connect(analyser);
      } catch {
        analyser = null;
      }
      const samples = new Uint8Array(analyser?.fftSize ?? 0);

      timer = setInterval(() => {
        const ms = Math.min(performance.now() - startedAt.current, VOICE_NOTE_MAX_MS);
        let peak = 0;
        if (analyser) {
          analyser.getByteTimeDomainData(samples);
          for (const sample of samples) peak = Math.max(peak, Math.abs(sample - 128) / 128);
        }
        setElapsed(ms);
        setLevels((list) => [...list.slice(1 - LEVEL_BARS), Math.min(1, Math.sqrt(peak) * 1.3)]);
        if (ms >= VOICE_NOTE_MAX_MS) {
          clearInterval(timer);
          void stopRecorder(recorder, stopped);
          setAtLimit(true);
        }
      }, TICK_MS);
    }

    navigator.mediaDevices
      .getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
      .then((mic) => {
        if (!active) for (const track of mic.getTracks()) track.stop();
        else start(mic);
      })
      .catch((err: unknown) => {
        if (!active) return;
        toast.error(microphoneProblem(err));
        cancelRef.current();
      });

    return () => {
      active = false;
      closed.current = true;
      clearInterval(timer);
      const recorder = recorderRef.current;
      if (recorder) {
        recorder.ondataavailable = null;
        if (recorder.state !== "inactive") recorder.stop();
      }
      for (const track of stream?.getTracks() ?? []) track.stop();
      void context?.close();
    };
  }, []);

  async function send() {
    const recorder = recorderRef.current;
    if (!recorder) return;
    const durationMs = Math.min(performance.now() - startedAt.current, VOICE_NOTE_MAX_MS);
    if (durationMs < VOICE_NOTE_MIN_MS) {
      toast.error("That recording was too short to send.");
      onCancel();
      return;
    }
    setFinishing(true);
    await stopRecorder(recorder, stopped);
    if (closed.current) return;
    const type = RECORDING_TYPES.find((t) => recorder.mimeType.startsWith(t.mime.split(";")[0])) ?? recordingType()!;
    onSend(new File(chunks.current, `voice-note.${type.extension}`, { type: type.mime.split(";")[0] }), durationMs);
  }

  return (
    <div className="flex items-center gap-2">
      <Button
        variant="ghost"
        size="icon"
        onClick={onCancel}
        aria-label="Delete the recording"
        title="Delete"
        className="size-11 shrink-0 rounded-full text-chat-icon hover:bg-chat-input"
      >
        <Trash2 className="size-5" />
      </Button>

      <div className="flex min-h-12 min-w-0 flex-1 items-center gap-3 rounded-3xl bg-chat-input px-4">
        <span
          aria-hidden
          className={cn("size-2.5 shrink-0 rounded-full", live && !atLimit ? "animate-pulse bg-chat-recording" : "bg-chat-meta")}
        />
        <span className="w-10 shrink-0 text-[15px] tabular-nums text-chat-bubble-foreground">{formatClock(elapsed)}</span>
        {atLimit ? (
          <p className="min-w-0 flex-1 truncate text-caption text-chat-meta">Two minutes is the longest a voice note can be.</p>
        ) : live ? (
          <div aria-hidden className="flex h-7 min-w-0 flex-1 items-center justify-end gap-[2px] overflow-hidden">
            {levels.map((level, index) => (
              <span key={index} className="w-[3px] shrink-0 rounded-full bg-chat-meta" style={{ height: `${Math.max(12, level * 100)}%` }} />
            ))}
          </div>
        ) : (
          <p className="min-w-0 flex-1 truncate text-caption text-chat-meta">Waiting for the microphone…</p>
        )}
        <span className="sr-only" role="status">
          {atLimit ? "Recording stopped at two minutes." : live ? "Recording a voice note." : "Waiting for the microphone."}
        </span>
      </div>

      <Button
        size="icon"
        onClick={() => void send()}
        disabled={!live || finishing}
        aria-label="Send the voice note"
        title="Send"
        className="size-12 shrink-0 rounded-full bg-chat-send text-chat-send-foreground shadow-sm hover:bg-chat-send-hover"
      >
        {finishing ? <Loader2 className="size-5 animate-spin" /> : <SendHorizontal className="size-5" />}
      </Button>
    </div>
  );
}
