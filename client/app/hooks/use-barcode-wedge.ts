import { useEffect, useRef } from "react";

/**
 * USB and Bluetooth barcode scanners are keyboards ("keyboard wedge"): they
 * type the code in one fast burst and press Enter. People type far slower
 * than one key per 50 ms, which is how a burst is told apart from typing.
 */
const BURST_GAP_MS = 50;
const MIN_CODE_LENGTH = 3;

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

/**
 * Key timing for a text field the scanner may type into. Feed it every
 * keydown; on Enter, `scanned` returns the code when the keys before it came
 * as a burst, and null when someone typed them.
 */
export function createBurstTracker() {
  let count = 0;
  let last = 0;
  return {
    key(key: string) {
      if (key.length !== 1) return;
      const now = performance.now();
      count = now - last > BURST_GAP_MS ? 1 : count + 1;
      last = now;
    },
    scanned(value: string): string | null {
      const fresh = performance.now() - last < BURST_GAP_MS * 2;
      const code = fresh && count >= MIN_CODE_LENGTH ? value.slice(-count).trim() : null;
      count = 0;
      return code || null;
    },
  };
}

/**
 * Catches a scanner burst typed while no text field has focus (focus on a
 * button, or on nothing). The Enter that ends it is swallowed, so it cannot
 * also press whatever button has focus.
 */
export function useKeyboardWedge(onScan: (code: string) => void, enabled: boolean) {
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;

  useEffect(() => {
    if (!enabled) return;
    let buffer = "";
    let last = 0;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isEditable(e.target)) {
        buffer = "";
        return;
      }
      const now = performance.now();
      if (e.key === "Enter") {
        if (buffer.length >= MIN_CODE_LENGTH && now - last < BURST_GAP_MS * 2) {
          e.preventDefault();
          e.stopPropagation();
          onScanRef.current(buffer);
        }
        buffer = "";
        return;
      }
      if (e.key.length !== 1) return;
      buffer = now - last > BURST_GAP_MS ? e.key : buffer + e.key;
      last = now;
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [enabled]);
}
