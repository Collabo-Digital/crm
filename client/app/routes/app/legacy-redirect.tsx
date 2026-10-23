import { Navigate, useLocation } from "react-router";
import { getLandingPath } from "~/lib/sections";

/**
 * Top-level paths that moved under a section pill, so the navbar could present
 * each group as one section. Keeps old bookmarks (and any internal link we
 * missed) alive.
 */
const MOVED: Record<string, string> = {
  "/drafts": "/orders/drafts",
  "/customers": "/orders/customers",
  "/invoices": "/orders/invoices",
  "/inventory": "/products/inventory",
  "/channel": "/settings/channels",
  "/conversation": "/inbox",
};

export default function LegacyRedirect() {
  const { pathname, search, hash } = useLocation();
  // Segment-boundary match, so deeper paths carry over: /inventory/labels/print
  // becomes /products/inventory/labels/print with its query string intact.
  const from = Object.keys(MOVED).find(
    (p) => pathname === p || pathname.startsWith(`${p}/`)
  );
  const to = from ? `${MOVED[from]}${pathname.slice(from.length)}` : getLandingPath();
  return <Navigate to={`${to}${search}${hash}`} replace />;
}
