import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router";

import { inboxService } from "~/services/inbox.service";
import { inboxKeys } from "./use-inbox-queries";

const STORAGE_KEY = "collabo-message-alerts";
/** Faster than the inbox's 60-second floor, so a new chat is noticed on any page. */
const POLL_MS = 20_000;

/** Whether alerts are on for this browser. On unless switched off. */
export function alertsEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setAlertsEnabled(on: boolean) {
  try {
    localStorage.setItem(STORAGE_KEY, on ? "on" : "off");
  } catch {
    // Private windows may refuse storage; the setting then lasts for this page only.
  }
  window.dispatchEvent(new Event(STORAGE_KEY));
}

/** The alerts switch for a button: its state, and a toggle that asks for notification permission when turning on. */
export function useAlertsSwitch() {
  const [on, setOn] = useState(alertsEnabled);
  useEffect(() => {
    const sync = () => setOn(alertsEnabled());
    window.addEventListener(STORAGE_KEY, sync);
    return () => window.removeEventListener(STORAGE_KEY, sync);
  }, []);
  const toggle = () => {
    const next = !on;
    setAlertsEnabled(next);
    if (next && "Notification" in window && Notification.permission === "default") void Notification.requestPermission();
  };
  return { on, toggle };
}

/** A short two-note chime, made in the browser so there is no file to load. */
function chime() {
  try {
    const ctx = new AudioContext();
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.45);
    [880, 1320].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      osc.frequency.value = freq;
      osc.connect(gain);
      osc.start(ctx.currentTime + i * 0.12);
      osc.stop(ctx.currentTime + 0.45);
    });
    setTimeout(() => void ctx.close(), 800);
  } catch {
    // Browsers without Web Audio, or before any user gesture: no sound.
  }
}

/**
 * New-message alerts anywhere in the app: when the number of unread chats goes
 * up, a chime, and a browser notification while the tab is in the background
 * (if the person allowed notifications). Off with the bell in the inbox.
 */
export function useNewMessageAlerts(enabled: boolean) {
  const navigate = useNavigate();
  const { data } = useQuery({
    queryKey: inboxKeys.counts(),
    queryFn: () => inboxService.counts(),
    enabled,
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: true,
  });
  const previous = useRef<number | null>(null);
  const unread = data?.unread;

  useEffect(() => {
    if (unread === undefined) return;
    const before = previous.current;
    previous.current = unread;
    if (before === null || unread <= before || !alertsEnabled()) return;
    chime();
    if (document.visibilityState === "visible" || !("Notification" in window) || Notification.permission !== "granted") return;
    const added = unread - before;
    const note = new Notification(added === 1 ? "New WhatsApp message" : `${added} new WhatsApp chats`, {
      body: `${unread} unread in your Collabo inbox.`,
      tag: "collabo-inbox",
    });
    note.onclick = () => {
      window.focus();
      navigate("/inbox");
      note.close();
    };
  }, [unread, navigate]);
}
