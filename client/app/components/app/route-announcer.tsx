import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router";

import { spokenTitle } from "~/lib/page-title";

/**
 * Focus something that is not normally focusable (the main area, a page
 * heading) for as long as it holds focus, without drawing a ring round it.
 */
export function focusQuietly(element: HTMLElement, options?: FocusOptions) {
  if (!element.hasAttribute("tabindex")) {
    element.setAttribute("tabindex", "-1");
    element.style.outline = "none";
    element.addEventListener(
      "blur",
      () => {
        element.removeAttribute("tabindex");
        element.style.removeProperty("outline");
      },
      { once: true },
    );
  }
  element.focus(options);
}

/**
 * The app swaps pages without loading a new one, so on its own a screen
 * reader says nothing when a link is followed. On every move to another page
 * (a new path, not a filter or search change in the address):
 *
 * - if the link or button that was used went away with the old page, focus
 *   moves to the new page's main heading, which is read out, or to the main
 *   area while the page is still loading, so Tab carries on in the new page
 *   instead of starting again at the top;
 * - otherwise the new page's title is read out and focus stays put (a link in
 *   the navigation, which is still there). Focus a page gives itself, such as
 *   a search box, is left alone.
 */
export function RouteAnnouncer() {
  const { pathname } = useLocation();
  const [message, setMessage] = useState("");
  // The browser reads the title of the page it loads, so only later moves
  // count. (A path, not a first-render flag: React runs effects twice on mount
  // in development.)
  const shownPath = useRef(pathname);

  useEffect(() => {
    if (shownPath.current === pathname) return;
    shownPath.current = pathname;
    setMessage("");
    // Long enough for the new page to draw its heading, or take focus itself.
    const timer = window.setTimeout(() => {
      const active = document.activeElement;
      if (!active || active === document.body) {
        const heading = document.querySelector<HTMLElement>("main h1") ?? document.querySelector<HTMLElement>("h1");
        if (heading) {
          focusQuietly(heading, { preventScroll: true });
          if (document.activeElement === heading) return;
        }
        const main = document.querySelector<HTMLElement>("main");
        if (main) focusQuietly(main, { preventScroll: true });
      }
      setMessage(spokenTitle(document.title));
    }, 150);
    return () => window.clearTimeout(timer);
  }, [pathname]);

  return (
    <p aria-live="polite" aria-atomic="true" className="sr-only">
      {message}
    </p>
  );
}

/** The first Tab stop on every app page: jumps past the navigation. */
export function SkipToContent({ targetId }: { targetId: string }) {
  return (
    <a
      href={`#${targetId}`}
      onClick={(event) => {
        // Focus, not a #hash in the address bar and a history entry.
        event.preventDefault();
        const target = document.getElementById(targetId);
        if (target) focusQuietly(target);
      }}
      className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-lg focus:bg-card focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-foreground focus:shadow-lg"
    >
      Skip to content
    </a>
  );
}
