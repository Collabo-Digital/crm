import { useEffect, useState } from "react";

const isActive = () => typeof document !== "undefined" && document.visibilityState === "visible" && document.hasFocus();

/**
 * Whether someone is looking at this tab: it is visible and its window has
 * focus. A tab left open in the background keeps receiving live updates, and
 * must not act as if a person had seen them.
 */
export function usePageActive(): boolean {
  const [active, setActive] = useState(isActive);

  useEffect(() => {
    const update = () => setActive(isActive());
    update();
    document.addEventListener("visibilitychange", update);
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    return () => {
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
    };
  }, []);

  return active;
}
