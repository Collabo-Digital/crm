/**
 * "smooth", unless the person has asked their device to reduce motion. The
 * rule in app.css covers scrolling done by CSS; a scroll started from code
 * (scrollIntoView, scrollTo) needs this.
 */
export function scrollBehavior(): ScrollBehavior {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ? "auto"
    : "smooth";
}
