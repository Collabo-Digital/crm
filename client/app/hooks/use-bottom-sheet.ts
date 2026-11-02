import { useEffect, useRef, type PointerEvent, type RefObject } from "react";

import { SHEET_QUERY, dismissesSheet, keyboardInset } from "~/lib/sheet-gestures";

/**
 * Phone behaviour shared by every sheet (components/ui/dialog.tsx, sheet.tsx
 * and the till's PosScreen). Each hook belongs in a component that mounts
 * with the sheet's content, so it runs only while the sheet is open.
 */

const ENTRY = "collaboSheet";
const openEntries = new Set<string>();
let skipsStaleEntries = false;

/**
 * A sheet closed by a link or a navigation inside it leaves its history entry
 * behind the new page. Back from that page would land on the leftover entry
 * and look like it did nothing, so step over it.
 */
function skipStaleEntries() {
  if (skipsStaleEntries) return;
  skipsStaleEntries = true;
  window.addEventListener("popstate", () => {
    const entry = window.history.state?.[ENTRY];
    if (entry && !openEntries.has(entry)) window.history.back();
  });
}

/**
 * Back (the Android button, the iOS swipe, the browser's arrow) closes the
 * open sheet instead of leaving the page. The sheet adds a history entry for
 * the same URL, with the router's own state, and gives it back when it closes
 * any other way.
 */
export function useCloseOnBack(close: () => void) {
  const latest = useRef(close);
  useEffect(() => {
    latest.current = close;
  });

  useEffect(() => {
    if (!window.matchMedia(SHEET_QUERY).matches) return;
    const id = Math.random().toString(36).slice(2);
    let added = false;
    let wentBack = false;
    const onPop = () => {
      // Still on this sheet's entry: a sheet above it was the one closed.
      if (window.history.state?.[ENTRY] === id) return;
      wentBack = true;
      latest.current();
    };
    // Deferred, so React's development double-mount adds one entry, not two.
    const timer = window.setTimeout(() => {
      skipStaleEntries();
      window.history.pushState({ ...window.history.state, [ENTRY]: id }, "");
      openEntries.add(id);
      added = true;
      window.addEventListener("popstate", onPop);
    });
    return () => {
      window.clearTimeout(timer);
      if (!added) return;
      window.removeEventListener("popstate", onPop);
      openEntries.delete(id);
      if (!wentBack && window.history.state?.[ENTRY] === id) window.history.back();
    };
  }, []);
}

/**
 * Keeps a bottom sheet above the iOS keyboard, which covers the page without
 * resizing it. Sets --sheet-keyboard (the covered height) and --sheet-viewport
 * (the visible height) on the sheet for app.css to place it with.
 */
export function useKeyboardInset(sheet: () => HTMLElement | null | undefined) {
  const latest = useRef(sheet);
  useEffect(() => {
    latest.current = sheet;
  });

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const fit = () => {
      const el = latest.current();
      if (!el) return;
      el.style.setProperty("--sheet-keyboard", `${keyboardInset(window.innerHeight, viewport.height, viewport.offsetTop)}px`);
      el.style.setProperty("--sheet-viewport", `${viewport.height}px`);
    };
    fit();
    viewport.addEventListener("resize", fit);
    viewport.addEventListener("scroll", fit);
    return () => {
      viewport.removeEventListener("resize", fit);
      viewport.removeEventListener("scroll", fit);
    };
  }, []);
}

/**
 * Pointer handlers for a sheet's drag handle: the sheet follows the finger
 * down, and slides away and closes once dismissesSheet says so.
 */
export function useSheetDrag(handle: RefObject<HTMLElement | null>, close: () => void) {
  const start = useRef<{ y: number; time: number } | null>(null);
  const sheet = () => handle.current?.parentElement ?? null;
  const distance = (event: PointerEvent) => Math.max(0, event.clientY - (start.current?.y ?? event.clientY));

  return {
    onPointerDown(event: PointerEvent<HTMLElement>) {
      const el = sheet();
      if (!el || event.button !== 0) return;
      start.current = { y: event.clientY, time: event.timeStamp };
      event.currentTarget.setPointerCapture(event.pointerId);
      el.style.transition = "none";
    },
    onPointerMove(event: PointerEvent<HTMLElement>) {
      const el = sheet();
      if (!el || !start.current) return;
      el.style.transform = `translateY(${distance(event)}px)`;
    },
    onPointerUp(event: PointerEvent<HTMLElement>) {
      const el = sheet();
      if (!el || !start.current) return;
      const moved = distance(event);
      const velocity = moved / Math.max(1, event.timeStamp - start.current.time);
      start.current = null;
      el.style.transition = "transform 180ms ease-out";
      if (!dismissesSheet(moved, el.offsetHeight, velocity)) {
        el.style.transform = "";
        return;
      }
      el.style.transform = "translateY(100%)";
      // Already off screen: skip the closing fade so it does not flash back.
      window.setTimeout(() => {
        el.style.animation = "none";
        close();
      }, 180);
    },
    onPointerCancel() {
      const el = sheet();
      start.current = null;
      if (!el) return;
      el.style.transition = "transform 180ms ease-out";
      el.style.transform = "";
    },
  };
}
