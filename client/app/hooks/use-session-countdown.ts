import { useEffect, useState } from "react";

import {
  describeSessionWindow,
  msUntilLabelChange,
  type WindowState,
} from "~/lib/session-window";

/**
 * A live countdown on a reply window.
 *
 * ## Call this in a LEAF component only
 *
 * Every tick sets state. Holding that state in the inbox route would re-render
 * the folder rail, the conversation list, the entire message stream and the
 * customer panel once a minute, forever, for a label two components care about.
 * Two leaves each owning a timer is cheaper than one shared state at the top,
 * and far cheaper than a context.
 *
 * ## Why it recomputes instead of decrementing
 *
 * Each tick reads `Date.now()` afresh rather than subtracting an interval from
 * a running total. `setInterval` fires late when the tab is backgrounded and
 * stops entirely while the machine sleeps, so a decrementing counter drifts and
 * then freezes at whatever it held when the lid closed. Recomputing from the
 * absolute `expiresAt` self-corrects on the very next tick.
 *
 * ## Why the interval is not a constant
 *
 * Above an hour the finest unit shown is minutes, so a 1s interval would
 * re-render 60 times for no visible change. Under an hour the label switches to
 * m:ss and the exact number starts mattering, so it ticks every second. The
 * timer re-arms itself against the *next label change* rather than on a fixed
 * cadence, so the text updates on the transition instead of up to a full period
 * after it.
 */
export function useSessionCountdown(expiresAt: string | null | undefined): WindowState {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    // Re-sync immediately: this effect re-runs when `expiresAt` changes (a new
    // conversation was selected) and the previous `now` may be a minute stale.
    setNow(Date.now());

    if (!expiresAt) return;

    let timer: ReturnType<typeof setTimeout>;

    const schedule = () => {
      const current = Date.now();
      const remaining = new Date(expiresAt).getTime() - current;

      // Nothing left to count. Not rescheduling here is what stops an expired
      // window from holding a timer open for the life of the page.
      if (!Number.isFinite(remaining) || remaining <= 0) return;

      timer = setTimeout(() => {
        setNow(Date.now());
        schedule();
      }, msUntilLabelChange(remaining));
    };

    schedule();
    return () => clearTimeout(timer);
  }, [expiresAt]);

  return describeSessionWindow(expiresAt, now);
}
