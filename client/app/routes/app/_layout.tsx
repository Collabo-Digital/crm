import { Outlet, Navigate, useLocation, useMatches } from "react-router";
import { Navbar } from "~/components/app/navbar";
import { ImpersonationBanner } from "~/components/app/impersonation-banner";
import { AuthGuard } from "~/components/guards/auth-guard";
import { useCurrentRole } from "~/hooks/use-current-role";
import { showPreviewModules, isPreviewPath } from "~/lib/feature-flags";
import { cn } from "~/lib/utils";

// Vendors may only reach these sections (the server enforces the real boundary;
// this is UX so a vendor never lands on a forbidden, empty/403 page).
const VENDOR_ALLOWED_PREFIXES = ["/orders", "/products", "/profile"];

// Section sub-pages that are NOT vendor-facing. Checked before the allow list,
// which is a prefix match and would otherwise sweep these in now that Drafts /
// Customers / Invoices live under /orders/* and Inventory under /products/*.
// The inventory entry matters: the API denies vendors every stock endpoint
// (no @AllowVendor), so without this they would reach pages that only 403.
const VENDOR_DENIED_PREFIXES = [
  "/orders/drafts",
  "/orders/customers",
  "/orders/invoices",
  // A package slip prints the customer's full postal address. The server's
  // /orders/slips/data has no @AllowVendor for the same reason; this stops a
  // vendor reaching a page that would only 403.
  "/orders/slips",
  "/products/inventory",
];

// Influencers are an outside party, like vendors, so the same shape applies:
// an allow list rather than a deny list, because a section added tomorrow must
// be closed to them until someone decides otherwise.
//
// /settings is here and NOT in the vendor list on purpose: connecting their own
// Instagram is the whole reason an influencer has an account. /campaigns is
// added at render time only while they hold `campaigns.view`.
const INFLUENCER_ALLOWED_PREFIXES = ["/settings", "/profile"];

// Settings pages an influencer must not reach. Checked first, because the allow
// list is a prefix match that would otherwise sweep every settings tab in —
// including the team page, where they could see and manage other members.
const INFLUENCER_DENIED_PREFIXES = [
  "/settings/members",
  "/settings/general",
  "/settings/store-profile",
  "/settings/products",
  "/settings/orders",
  "/settings/tax-gst",
  "/settings/loyalty",
];

/** Prefix match on a segment boundary, so /orders never matches /ordersomething. */
function isUnder(pathname: string, prefix: string) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

// Routes that fill the window height and scroll their own panes instead of the
// page. The inbox needs this so its composer stays pinned and each column
// scrolls independently. It does NOT change the content width — these pages sit
// in the same container as every other page; only the order detail page opts
// out of the shared width (see FULL_WIDTH_ROUTE_IDS below).
//
// A flex column rather than h-[calc(100vh-Npx)] in the route, because the
// chrome above it is not a fixed height — the navbar is 72px, a sub-nav row
// appears for sections that have children, and ImpersonationBanner adds 40px
// when a super admin is impersonating. Any calc() is wrong in at least one of
// those states; the flex column is exact in all of them with no magic number.
const FULL_HEIGHT_PREFIXES = ["/conversation"];

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
  const { isVendor, isInfluencer, can } = useCurrentRole();
  const location = useLocation();
  // Read before the print-route early return below, so the hook order is the
  // same on every route.
  const matches = useMatches();

  const vendorBlocked =
    isVendor &&
    (VENDOR_DENIED_PREFIXES.some((p) => isUnder(location.pathname, p)) ||
      !VENDOR_ALLOWED_PREFIXES.some((p) => isUnder(location.pathname, p)));

  // Influencers reach their own settings, their profile, and whatever their
  // permissions name. Campaigns is in the allow list only while they hold
  // `campaigns.view` — revoking that grant removes the section with no edit
  // here, which is the point of routing it through the permission model.
  const influencerAllowed = [
    ...INFLUENCER_ALLOWED_PREFIXES,
    ...(can("campaigns.view") ? ["/campaigns"] : []),
  ];
  const influencerBlocked =
    isInfluencer &&
    (INFLUENCER_DENIED_PREFIXES.some((p) => isUnder(location.pathname, p)) ||
      !influencerAllowed.some((p) => isUnder(location.pathname, p)));

  // Chat / Campaigns / Logistics are UI-only previews running on mock data.
  // The navbar already hides their pills outside dev; this stops a typed or
  // bookmarked URL from rendering placeholder data in a production build.
  //
  // Influencers are exempt for Campaigns: it is the section they were invited
  // to use, so hiding it from them in a production build would leave them with
  // an invitation to nothing. Everyone else still waits for the flag.
  const previewExempt = isInfluencer && isUnder(location.pathname, "/campaigns") && can("campaigns.view");
  const previewBlocked =
    !previewExempt && !showPreviewModules && isPreviewPath(location.pathname);

  // Vendors bounce to /orders (their home), influencers to their channels page,
  // everyone else to /dashboard. The role checks come first on purpose: someone
  // outside their allow list should land where every other blocked route sends
  // them, not on a dashboard they also cannot see.
  const redirectTo = vendorBlocked
    ? "/orders"
    : influencerBlocked
      ? "/settings/channels"
      : previewBlocked
        ? "/dashboard"
        : null;

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

  const isFullHeight = FULL_HEIGHT_PREFIXES.some((p) =>
    isUnder(location.pathname, p),
  );

  const isFullWidth = matches.some((m) => FULL_WIDTH_ROUTE_IDS.includes(m.id));

  return (
    <AuthGuard>
      <div
        className={cn(
          "bg-surface-sunken",
          isFullHeight ? "flex h-dvh flex-col overflow-hidden" : "min-h-screen",
        )}
      >
        <ImpersonationBanner />
        <Navbar />
        {/* Same container on every route except a full-width one — otherwise
            only the vertical behaviour differs. */}
        <main
          className={cn(
            // Identical padding on every route, and an identical container on
            // every route but a full-width one, so the inbox lines up with
            // Orders and Products rather than sitting flush against the navbar.
            "mx-auto w-full px-4 py-6 lg:px-6",
            !isFullWidth && "max-w-screen-xl",
            isFullHeight && "min-h-0 flex-1 overflow-hidden",
          )}
        >
          {redirectTo ? <Navigate to={redirectTo} replace /> : <Outlet />}
        </main>
      </div>
    </AuthGuard>
  );
}
