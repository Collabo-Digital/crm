import { Outlet, Navigate, Link, isRouteErrorResponse, useLocation, useMatches } from "react-router";
import { AlertTriangle } from "lucide-react";
import type { Route } from "./+types/_layout";
import { CallDock } from "~/components/app/calls/call-dock";
import { EmptyState } from "~/components/app/empty-state";
import { Navbar } from "~/components/app/navbar";
import { ImpersonationBanner } from "~/components/app/impersonation-banner";
import { Button } from "~/components/ui/button";
import { AuthGuard } from "~/components/guards/auth-guard";
import { useMembershipSync, useSectionAccess } from "~/hooks/use-section-access";
import { cn } from "~/lib/utils";
import { useNewMessageAlerts } from "~/hooks/use-new-message-alerts";
import { useAuthStore } from "~/stores/auth.store";
import { SkipToContent } from "~/components/app/route-announcer";

// Routes that fill the window height and scroll their own panes instead of the
// page. The inbox needs this so its composer stays pinned and each column
// scrolls independently, and the point of sale so its Pay button never scrolls
// away. It does NOT change the content width — that is FULL_WIDTH_ROUTE_IDS
// below.
//
// Matched by route id, like FULL_WIDTH_ROUTE_IDS: /inbox/contacts is an
// ordinary scrolling list under the same prefix.
//
// A flex column rather than h-[calc(100vh-Npx)] in the route, because the
// chrome above it is not a fixed height — the navbar is 72px, a sub-nav row
// appears for sections that have children, and ImpersonationBanner adds 40px
// when a super admin is impersonating. Any calc() is wrong in at least one of
// those states; the flex column is exact in all of them with no magic number.
const FULL_HEIGHT_ROUTE_IDS = ["routes/app/inbox", "routes/app/orders/pos"];

// Routes that drop the shared page width. The order detail page flanks its
// line-items table with two fixed-width rails (200px + 240px), which leaves the
// table cramped once the container caps the row at 1280px. The point of sale
// uses a wide till screen for more product tiles beside the cart.
//
// Matched by route id rather than pathname prefix: "/orders/<x>" is also
// /orders/new, /orders/drafts, /orders/customers and /orders/invoices, so a
// pathname test would need an exclusion list that silently rots as sibling
// routes are added. The id is the route file path minus its extension — see
// routes.ts, where only files reused across several routes declare their own.
//
// The navbar keeps its own max-w-screen-xl, so on a wide viewport this page is
// deliberately wider than the chrome above it.
const FULL_WIDTH_ROUTE_IDS = ["routes/app/orders/$id", "routes/app/orders/pos"];

export default function AppLayout() {
  const { canAccess, landingPath } = useSectionAccess();
  useMembershipSync();
  const location = useLocation();
  // Read before the print-route early return below, so the hook order is the
  // same on every route.
  const matches = useMatches();
  const signedIn = useAuthStore((state) => state.isAuthenticated);
  useNewMessageAlerts(signedIn && canAccess("/inbox"));

  // A section this member was not given, or a page outside a vendor's allow
  // list (the server enforces the real boundary; this is UX so nobody lands on
  // a page that would only 403). The navbar shows the same sections as locked.
  const accessBlocked = !canAccess(location.pathname);

  // Back to the member's first open section — /orders for a vendor,
  // /dashboard for most people.
  const redirectTo = accessBlocked ? landingPath : null;

  // Print/document routes render bare (no navbar/sidebar) so the app chrome
  // never bleeds into the printed PDF. AuthGuard still gates them.
  const isPrintRoute = /\/(packing-slip|pick-slip|print)$/.test(location.pathname);
  if (isPrintRoute) {
    return (
      <AuthGuard>
        {redirectTo ? <Navigate to={redirectTo} replace /> : <Outlet />}
      </AuthGuard>
    );
  }

  const isFullHeight = matches.some((m) => FULL_HEIGHT_ROUTE_IDS.includes(m.id));

  const isMobileThread = location.pathname === "/inbox" && new URLSearchParams(location.search).has("c");

  // Phone screens that bring their own header and drop the app bar, section
  // tabs and bottom tab bar: an open chat, the till (which has its own bottom
  // bar with Charge), and packing an order, so the camera and the line being
  // packed fit and no tab sits beside Scan and Finish. The chat and the till
  // also run edge to edge.
  const edgeToEdge = isMobileThread || matches.some((m) => m.id === "routes/app/orders/pos");
  const immersive = edgeToEdge || matches.some((m) => m.id === "routes/app/orders/packing/$orderId");

  const isFullWidth = matches.some((m) => FULL_WIDTH_ROUTE_IDS.includes(m.id));

  return (
    <AuthGuard>
      <div
        className={cn(
          "app-shell bg-surface-sunken",
          immersive && "app-shell-immersive",
          isFullHeight ? "flex h-dvh flex-col overflow-hidden" : "min-h-screen",
        )}
      >
        <SkipToContent targetId="main-content" />
        <ImpersonationBanner />
        <Navbar immersive={immersive} />
        {/* Same container on every route except a full-width one — otherwise
            only the vertical behaviour differs. */}
        <main
          id="main-content"
          className={cn(
            // Identical padding on every route, and an identical container on
            // every route but a full-width one, so the inbox lines up with
            // Orders and Products rather than sitting flush against the navbar.
            "app-main mx-auto w-full px-4 py-4 md:py-6 lg:px-6",
            !isFullWidth && "max-w-screen-xl",
            isFullHeight && "min-h-0 flex-1 overflow-hidden",
            isFullHeight && !immersive && "app-main-contained",
            edgeToEdge && "max-md:p-0",
            // Without the app bar, the page itself clears the phone's status bar.
            immersive && !edgeToEdge && "max-md:pt-[max(16px,env(safe-area-inset-top))]",
          )}
        >
          {redirectTo ? <Navigate to={redirectTo} replace /> : <Outlet />}
        </main>
        {/* WhatsApp calls ring on every page for members who work the inbox. */}
        {canAccess("/inbox") && <CallDock />}
      </div>
    </AuthGuard>
  );
}

/** A code chunk from before a deploy is gone; only a reload fetches the new one. */
const STALE_CHUNK =
  /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS/i;

/**
 * A page that crashed, shown inside the app's chrome so the navbar stays and
 * there is a way on. An error in the chrome itself falls through to root's
 * boundary.
 */
export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const { landingPath } = useSectionAccess();
  const stale = error instanceof Error && STALE_CHUNK.test(error.message);
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  const reload = (
    <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
      Reload page
    </Button>
  );
  return (
    <AuthGuard>
      <div className="app-shell min-h-screen bg-surface-sunken">
        <ImpersonationBanner />
        <Navbar />
        <main className="app-main mx-auto w-full max-w-screen-xl px-4 py-16 lg:px-6">
          {stale ? (
            <EmptyState
              icon={AlertTriangle}
              title="Collabo has been updated"
              description="Reload the page to get the latest version."
              action={reload}
            />
          ) : (
            <EmptyState
              icon={AlertTriangle}
              title={notFound ? "Page not found" : "This page ran into a problem"}
              description={
                notFound
                  ? "This link is mistyped, or the page it pointed to has moved or been removed."
                  : "Reload to try again. If it keeps happening, let us know which page and what you clicked."
              }
              action={
                <div className="flex flex-wrap justify-center gap-2">
                  {!notFound && reload}
                  <Button variant="outline" size="sm" asChild>
                    <Link to={landingPath}>Go to your workspace</Link>
                  </Button>
                </div>
              }
            />
          )}
          {import.meta.env.DEV && error instanceof Error && (
            <pre className="mx-auto mt-6 max-w-3xl overflow-x-auto rounded-lg bg-muted p-4 text-xs">{error.stack}</pre>
          )}
        </main>
      </div>
    </AuthGuard>
  );
}
