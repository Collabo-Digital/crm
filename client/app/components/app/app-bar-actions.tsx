import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export const APP_BAR_ACTIONS_ID = "app-bar-actions";

/**
 * A page's own buttons, shown in the phone's app bar beside the account
 * avatar. The slot lives in the navbar, which commits alongside the page, so
 * it is looked up after mount.
 */
export function AppBarActions({ children }: { children: ReactNode }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => setSlot(document.getElementById(APP_BAR_ACTIONS_ID)), []);
  return slot ? createPortal(children, slot) : null;
}
