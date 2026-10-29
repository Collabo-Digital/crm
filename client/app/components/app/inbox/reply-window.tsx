import { Clock } from "lucide-react";

import { useSessionCountdown } from "~/hooks/use-session-countdown";
import { windowPhase } from "~/lib/inbox-format";
import { cn } from "~/lib/utils";
import type { ChannelPlatform, ReplyWindowState } from "~/types/api";

/**
 * The live "Reply window · 6h 12m" pill in the thread header.
 *
 * A leaf on purpose: it owns the only ticking state on the page, so a minute
 * passing re-renders this span and nothing else. See useSessionCountdown.
 */
export function ReplyWindowPill({
  platform,
  window,
  className,
}: {
  platform: ChannelPlatform;
  window: ReplyWindowState;
  className?: string;
}) {
  // Counts down to whichever deadline is next; the phase decides the wording.
  const phaseNow = windowPhase(platform, window, Date.now());
  const deadline = phaseNow.phase === "open" || phaseNow.phase === "human_agent" ? phaseNow.until : null;
  const { label, isOpen, isClosingSoon } = useSessionCountdown(deadline);

  if (phaseNow.phase === "none") return null;
  const closed = !deadline || !isOpen;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap text-micro font-medium",
        closed ? "text-danger" : isClosingSoon || phaseNow.phase === "human_agent" ? "text-warning-strong" : "text-muted-foreground",
        className,
      )}
    >
      <Clock className="size-3" />
      {closed
        ? platform === "WHATSAPP"
          ? "Window closed · template only"
          : "Reply window closed"
        : phaseNow.phase === "human_agent"
          ? `Human reply · ${label} left`
          : `Reply window · ${label}`}
    </span>
  );
}

/**
 * The composer's version — a sentence stating the consequence, because that
 * is where the agent is about to type.
 */
export function ReplyWindowHint({ platform, window }: { platform: ChannelPlatform; window: ReplyWindowState }) {
  const phaseNow = windowPhase(platform, window, Date.now());
  const deadline = phaseNow.phase === "open" || phaseNow.phase === "human_agent" ? phaseNow.until : null;
  const { label, isOpen, isClosingSoon } = useSessionCountdown(deadline);

  if (phaseNow.phase === "open" && isOpen) {
    return (
      <p className={cn("text-micro", isClosingSoon ? "text-warning-strong" : "text-muted-foreground")}>
        Reply window closes in {label}
      </p>
    );
  }
  if (phaseNow.phase === "human_agent" && isOpen) {
    return (
      <p className="text-micro text-warning-strong">
        Past 24 hours — you can still reply for {label}. Automations cannot.
      </p>
    );
  }
  return null;
}
