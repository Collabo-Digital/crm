import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Mic, Pause, Play } from "lucide-react";
import { toast } from "sonner";

import { cn } from "~/lib/utils";

import { formatClock } from "./voice-recorder";

const SPEEDS = [1, 1.5, 2];

/** One voice note plays at a time, as on the phone. */
let nowPlaying: HTMLAudioElement | null = null;

/**
 * A voice note in a bubble: the sender's picture with a mic until it is
 * started (then the speed toggle in its place), play, a seek bar, and the
 * length. The mic turns blue once the customer has played one we sent.
 */
export function VoiceNotePlayer({
  src,
  durationMs,
  isOutbound,
  played = false,
  avatar,
  footer,
}: {
  /** A link, or the recording itself while it uploads. */
  src: string | Blob;
  /** Known up front for notes we sent; otherwise read from the file. */
  durationMs?: number | null;
  isOutbound: boolean;
  played?: boolean;
  avatar: ReactNode;
  /** The bubble's time and ticks, on the line under the seek bar. */
  footer?: ReactNode;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [url, setUrl] = useState(typeof src === "string" ? src : null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [fileSeconds, setFileSeconds] = useState<number | null>(null);
  const [speed, setSpeed] = useState(1);
  const duration = durationMs ? durationMs / 1000 : fileSeconds;
  const started = isPlaying || position > 0;

  useEffect(() => {
    if (typeof src === "string") {
      setUrl(src);
      return;
    }
    const local = URL.createObjectURL(src);
    setUrl(local);
    return () => URL.revokeObjectURL(local);
  }, [src]);

  // timeupdate fires four times a second; follow the playhead every frame instead.
  useEffect(() => {
    if (!isPlaying) return;
    let frame = 0;
    const follow = () => {
      setPosition(audioRef.current?.currentTime ?? 0);
      frame = requestAnimationFrame(follow);
    };
    frame = requestAnimationFrame(follow);
    return () => cancelAnimationFrame(frame);
  }, [isPlaying]);

  function toggle() {
    const audio = audioRef.current;
    if (!audio) return;
    if (!audio.paused) {
      audio.pause();
      return;
    }
    if (nowPlaying && nowPlaying !== audio) nowPlaying.pause();
    nowPlaying = audio;
    audio.playbackRate = speed;
    audio.play().catch(() => toast.error("This voice note could not be played."));
  }

  function cycleSpeed() {
    const next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
    setSpeed(next);
    if (audioRef.current) audioRef.current.playbackRate = next;
  }

  const fill = played ? "var(--chat-read)" : isOutbound ? "var(--chat-icon)" : "var(--chat-send)";
  const progress = duration ? Math.min(100, (position / duration) * 100) : 0;

  return (
    <div className="flex w-64 max-w-full items-center gap-1 sm:w-72">
      {url && (
        <audio
          ref={audioRef}
          src={url}
          preload="metadata"
          onLoadedMetadata={(event) => Number.isFinite(event.currentTarget.duration) && setFileSeconds(event.currentTarget.duration)}
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          onEnded={(event) => {
            event.currentTarget.currentTime = 0;
            setIsPlaying(false);
            setPosition(0);
          }}
        />
      )}

      {started ? (
        <button
          type="button"
          onClick={cycleSpeed}
          aria-label={`Playback speed ${speed} times. Change speed`}
          className="flex size-11 shrink-0 items-center justify-center"
        >
          <span className="rounded-full bg-chat-quote px-2 py-0.5 text-[13px] font-semibold tabular-nums text-chat-bubble-foreground">{speed}×</span>
        </button>
      ) : (
        <div className="relative shrink-0">
          {avatar}
          <Mic
            aria-hidden
            className={cn("absolute -bottom-0.5 size-4", isOutbound ? "-left-1" : "-right-1", played ? "text-chat-read" : isOutbound ? "text-chat-icon" : "text-chat-send")}
            strokeWidth={2.5}
          />
        </div>
      )}

      <button
        type="button"
        onClick={toggle}
        disabled={!url}
        aria-label={isPlaying ? "Pause voice note" : "Play voice note"}
        className="flex size-11 shrink-0 items-center justify-center text-chat-icon"
      >
        {isPlaying ? <Pause className="size-6 fill-current" /> : <Play className="size-6 fill-current" />}
      </button>

      <div className="min-w-0 flex-1 pt-1 md:pt-3">
        <input
          type="range"
          min={0}
          max={duration ?? 0}
          step={0.01}
          value={position}
          disabled={!duration}
          onChange={(event) => {
            const at = Number(event.target.value);
            setPosition(at);
            if (audioRef.current) audioRef.current.currentTime = at;
          }}
          aria-label="Position in the voice note"
          aria-valuetext={`${formatClock(position * 1000)} of ${formatClock((duration ?? 0) * 1000)}`}
          // Phones give inputs a 44px touch height; the length tucks up under it.
          className="voice-seek -mb-3 block h-11 w-full md:mb-0 md:h-4"
          style={{ "--voice-fill": fill, "--voice-progress": `${progress}%` } as CSSProperties}
        />
        <div className="mt-0.5 flex items-center justify-between gap-2">
          <span className="text-[11px] tabular-nums text-chat-meta">{formatClock((started ? position : (duration ?? 0)) * 1000)}</span>
          {footer}
        </div>
      </div>
    </div>
  );
}
