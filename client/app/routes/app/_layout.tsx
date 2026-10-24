import { Outlet, Navigate, useLocation, useMatches } from "react-router";
import { CallDock } from "~/components/app/calls/call-dock";
import { Navbar } from "~/components/app/navbar";
import { ImpersonationBanner } from "~/components/app/impersonation-banner";
import { AuthGuard } from "~/components/guards/auth-guard";
import { useMembershipSync, useSectionAccess } from "~/hooks/use-section-access";
import { cn } from "~/lib/utils";
import { useNewMessageAlerts } from "~/hooks/use-new-message-alerts";
import { useAuthStore } from "~/stores/auth.store";

// Routes that fill the window height and scroll their own panes instead of the
// page. The inbox needs this so its composer stays pinned and each column
// scrolls independently. It does NOT change the content width — these pages sit
// in the same container as every other page; only the order detail page opts
// out of the shared width (see FULL_WIDTH_ROUTE_IDS below).
//
// Matched by route id, like FULL_WIDTH_ROUTE_IDS: /inbox/contacts is an
// ordinary scrolling list under the same prefix.
//
// A flex column rather than h-[calc(100vh-Npx)] in the route, because the
// chrome above it is not a fixed height — the navbar is 72px, a sub-nav row
// appears for sections that have children, and ImpersonationBanner adds 40px
// when a super admin is impersonating. Any calc() is wrong in at least one of
// those states; the flex column is exact in all of them with no magic number.
const FULL_HEIGHT_ROUTE_IDS = ["routes/app/inbox"];

// Routes that drop the shared page width. The order detail page flanks its
// line-items table with two fixed-width rails (200px + 240px), which leaves the
// table cramped once the container caps the row at 1280px.
//
// Matched by route id rather than pathname prefix: "/orders/<x>" is also
// /orders/new, /orders/drafts, /orders/customers and /orders/invoices, so a
// pathname test would need an exclusion list that silently rots as sibling
// routes are added. The id is the route file path minus its extension — see
// routes.ts, where only files reused across several routes declare their own.
//
// The navbar keeps its own max-w-screen-xl, so on a wide viewport this page is
// deliberately wider than the chrome above it.
const FULL_WIDTH_ROUTE_IDS = ["routes/app/orders/$id"];

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

  const isFullWidth = matches.some((m) => FULL_WIDTH_ROUTE_IDS.includes(m.id));

  return (
    <AuthGuard>
      <div
        className={cn(
          "app-shell bg-surface-sunken",
          isMobileThread && "app-shell-thread",
          isFullHeight ? "flex h-dvh flex-col overflow-hidden" : "min-h-screen",
        )}
      >
        <ImpersonationBanner />
        <Navbar immersive={isMobileThread} />
        {/* Same container on every route except a full-width one — otherwise
            only the vertical behaviour differs. */}
        <main
          className={cn(
            // Identical padding on every route, and an identical container on
            // every route but a full-width one, so the inbox lines up with
            // Orders and Products rather than sitting flush against the navbar.
            "app-main mx-auto w-full px-4 py-4 md:py-6 lg:px-6",
            !isFullWidth && "max-w-screen-xl",
            isFullHeight && "min-h-0 flex-1 overflow-hidden",
            isFullHeight && !isMobileThread && "app-main-contained",
            isMobileThread && "max-md:p-0",
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
