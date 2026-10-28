import { useEffect, useRef } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { motion, LayoutGroup } from "framer-motion";
import {
  LayoutDashboard,
  ShoppingCart,
  Package,
  Boxes,
  Users,
  BarChart3,
  Bell,
  Settings,
  ChevronDown,
  LogOut,
  User,
  Receipt,
  ShieldCheck,
  ArrowLeftRight,
  FileText,
  Lock,
  MessageSquare,
  Contact,
  Megaphone,
  Send,
  LayoutTemplate,
  Filter,
  Workflow,
  MessagesSquare,
  ShoppingBag,
  QrCode,
  Star,
  Target,
  Store,
  PackageCheck,
  ChevronLeft,
} from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "~/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuLabel,
} from "~/components/ui/dropdown-menu";
import { cn } from "~/lib/utils";
import { MobileNavigation } from "~/components/app/mobile-navigation";
import { BrandLogo } from "~/components/app/brand-logo";
import { APP_BAR_ACTIONS_ID } from "~/components/app/app-bar-actions";
import { Tip } from "~/components/ui/tooltip";
import { useAuthStore, normalizeOrganizations } from "~/stores/auth.store";
import { signOut } from "~/lib/sign-out";
import { authService } from "~/services/auth.service";
import { useStopImpersonating } from "~/hooks/use-admin-queries";
import { useSectionAccess } from "~/hooks/use-section-access";
import { useCurrentRole } from "~/hooks/use-current-role";
import { useInboxCounts } from "~/hooks/use-inbox-queries";
import { toast } from "sonner";
import { roleLabel } from "~/lib/labels";
import { LIST_QUERY_KEYS, parentScreen, withQuery, type Screen } from "~/lib/app-bar";
import { isString, readSessionState } from "~/hooks/use-session-state";

type NavChild = { label: string; href: string; icon: typeof LayoutDashboard };
type NavItem = {
  label: string;
  href: string;
  icon: typeof LayoutDashboard;
  badge?: number;
  /** Renders a secondary nav strip under the bar while this section is active. */
  children?: NavChild[];
};

/** Sub-nav for the Orders section — these used to be four separate top-level pills. */
const ORDERS_CHILDREN: NavChild[] = [
  { label: "All orders", href: "/orders", icon: ShoppingCart },
  // Gated on inventory.pack, not the Orders section (see lib/sections.ts), so
  // a Packer's Orders pill opens straight onto it.
  { label: "Packing", href: "/orders/packing", icon: PackageCheck },
  { label: "Point of sale", href: "/orders/pos", icon: Store },
  { label: "Drafts", href: "/orders/drafts", icon: FileText },
  { label: "Customers", href: "/orders/customers", icon: Users },
  { label: "Invoices", href: "/orders/invoices", icon: Receipt },
];

/**
 * Sub-nav for the Products section — Inventory used to be its own top-level
 * pill. Warehouses and the movement ledger stay reachable from inside the
 * Inventory page rather than the strip, so this stays a two-item section.
 */
const PRODUCTS_CHILDREN: NavChild[] = [
  { label: "All products", href: "/products", icon: Package },
  { label: "Inventory", href: "/products/inventory", icon: Boxes },
];

/** Sub-nav for the Inbox section. */
const INBOX_CHILDREN: NavChild[] = [
  { label: "Conversations", href: "/inbox", icon: MessageSquare },
  { label: "Contacts", href: "/inbox/contacts", icon: Contact },
  { label: "Groups", href: "/inbox/groups", icon: Users },
];

/** Sub-nav for Campaigns. Overview keeps the parent href, like "All orders". */
const CAMPAIGNS_CHILDREN: NavChild[] = [
  { label: "Overview", href: "/campaigns", icon: Megaphone },
  { label: "Broadcasts", href: "/campaigns/broadcasts", icon: Send },
  { label: "Templates", href: "/campaigns/templates", icon: LayoutTemplate },
  { label: "Segments", href: "/campaigns/segments", icon: Filter },
  { label: "Automations", href: "/campaigns/automations", icon: Workflow },
  { label: "Catalog", href: "/campaigns/catalog", icon: ShoppingBag },
  { label: "Growth", href: "/campaigns/growth", icon: QrCode },
  { label: "Ads", href: "/campaigns/ads", icon: Target },
  { label: "Reviews", href: "/campaigns/reviews", icon: Star },
];

/** Sub-nav for Analytics: the storefront, and chats. */
const ANALYTICS_CHILDREN: NavChild[] = [
  { label: "Store", href: "/analytics", icon: BarChart3 },
  { label: "Messaging", href: "/analytics/messaging", icon: MessagesSquare },
];

/** Phone app-bar titles for screens outside the main sections. */
const SCREEN_TITLES: Record<string, string> = { settings: "Settings", profile: "Profile", admin: "Admin" };

const NAV_LINKS: NavItem[] = [
  { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  { label: "Orders", href: "/orders", icon: ShoppingCart, children: ORDERS_CHILDREN },
  { label: "Products", href: "/products", icon: Package, children: PRODUCTS_CHILDREN },
  { label: "Inbox", href: "/inbox", icon: MessageSquare, children: INBOX_CHILDREN },
  { label: "Campaigns", href: "/campaigns", icon: Megaphone, children: CAMPAIGNS_CHILDREN },
  { label: "Analytics", href: "/analytics", icon: BarChart3, children: ANALYTICS_CHILDREN },
];

/** Every screen a phone's back arrow can return to: the sections, their tabs and Settings. */
const SCREENS: Screen[] = [
  ...NAV_LINKS,
  ...NAV_LINKS.flatMap((item) => item.children ?? []).filter((child) => !NAV_LINKS.some((item) => item.href === child.href)),
  { href: "/settings", label: "Settings" },
].map(({ href, label }) => ({ href, label }));

/**
 * The nav entry owning `pathname`, longest matching href first — so
 * /orders/drafts/<id> selects "Drafts" rather than "All orders". Matching on a
 * segment boundary (not a bare startsWith) keeps /ordersomething from matching
 * /orders, and lights the parent pill on child routes like /orders/<id>, which
 * the old exact-equality check never did.
 */
function matchNav<T extends { href: string }>(items: T[], pathname: string): T | undefined {
  return items
    .filter((item) => pathname === item.href || pathname.startsWith(`${item.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0];
}

/** Top navigation bar with pill-style nav links, notification icons, and user/workspace dropdown. */
export function Navbar({ immersive = false }: { immersive?: boolean }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, organizations, currentOrgId, impersonatedBy, setCurrentOrg, setTokens, setOrganizations } =
    useAuthStore();
  const stopImpersonating = useStopImpersonating();

  const { canAccess, landingPath, lockReason } = useSectionAccess();
  const { isInfluencer } = useCurrentRole();

  // A pill opens its own page, or — when only a sub-page is granted (Customers
  // without Orders) — the first sub-page the member can open. It is locked only
  // when nothing under it is reachable.
  const pillTarget = (item: NavItem): string | null =>
    canAccess(item.href)
      ? item.href
      : item.children?.find((child) => canAccess(child.href))?.href ?? null;

  // Every member sees every pill; the ones they cannot open render locked
  // rather than hidden (see lib/sections.ts for who can open what). An extra
  // Super Admin link is visible to real Collabo-team super admins (never while
  // impersonating — the impersonation token has isSuperAdmin=false).
  //
  // Influencers are the exception: they are an outside party, so they see only
  // the sections their permissions open rather than a bar of locked staff tabs.
  const allLinks: NavItem[] =
    user?.isSuperAdmin && !impersonatedBy
      ? [...NAV_LINKS, { label: "Super Admin", href: "/admin/users", icon: ShieldCheck }]
      : NAV_LINKS;
  // Unread chats on the Inbox pill, for members who can open it.
  const { data: inboxCounts } = useInboxCounts(canAccess("/inbox") && !isInfluencer);
  const withBadges = allLinks.map((item) =>
    item.href === "/inbox" && inboxCounts?.unread ? { ...item, badge: inboxCounts.unread } : item,
  );
  const navLinks = isInfluencer ? withBadges.filter((item) => pillTarget(item) !== null) : withBadges;

  // Longest-prefix match, so a child route keeps its parent pill lit.
  const activeTop = matchNav(navLinks, location.pathname);
  const sectionChildren = activeTop?.children;
  const activeChild = sectionChildren ? matchNav(sectionChildren, location.pathname) : undefined;
  // Phones name the screen in the bar, as apps do; only Home shows the logo.
  const mobileTitle =
    location.pathname === "/dashboard"
      ? null
      : (activeTop?.label ?? SCREEN_TITLES[location.pathname.split("/")[1] ?? ""] ?? null);
  // A page under another screen (an order, a new draft, a settings tab) gets a
  // back arrow to it on a phone, in place of the title and section tabs. A
  // list comes back as it was left: its filters, search and page.
  const parent = parentScreen(location.pathname, SCREENS);
  const queryKey = parent ? LIST_QUERY_KEYS[parent.href] : undefined;
  const backTo = parent && withQuery(parent.href, queryKey ? readSessionState(queryKey, "", isString) : "");
  // On a phone the section tabs scroll sideways; keep the current one in view.
  const sectionNavRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = sectionNavRef.current;
    const tab = box?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!box || !tab || box.scrollWidth <= box.clientWidth) return;
    const b = box.getBoundingClientRect();
    const t = tab.getBoundingClientRect();
    box.scrollLeft += t.left - b.left - (b.width - t.width) / 2;
  }, [activeChild?.href]);

  async function handleSwitchOrg(orgId: string) {
    if (orgId === currentOrgId) return;
    try {
      const data = await authService.switchOrg({ orgId });
      // Update tokens (new JWT scoped to selected org)
      setTokens(data.accessToken, data.refreshToken);
      // Update org list from backend (freshest data)
      // The store's normaliser, so vendor scope and grants come across too.
      setOrganizations(normalizeOrganizations(data.organizations));
      setCurrentOrg(orgId);
      // Reload the page to refetch all data with new org context
      window.location.reload();
    } catch {
      toast.error("Failed to switch organization.");
    }
  }

  async function handleSignOut() {
    await signOut();
    navigate("/auth/login");
  }

  const initials = user ? `${user.firstName[0]}${user.lastName[0]}`.toUpperCase() : "?";
  const currentOrg = organizations.find((membership) => membership.organization.id === currentOrgId);

  return (
    <>
    <header className={cn("app-header sticky top-0 z-40 w-full bg-surface-sunken", immersive && "hidden md:block")}>
      <div className="mx-auto flex h-14 max-w-screen-xl items-center justify-between gap-2 px-4 md:h-[72px] md:px-6">

        {/* ── Logo ──────────────────────────────────────────────────── */}
        <Link to={landingPath} className={cn("shrink-0 items-center", mobileTitle ? "hidden md:flex" : "flex")}>
          <BrandLogo className="h-6 md:h-7" />
        </Link>
        {parent && backTo ? (
          <Link
            to={backTo}
            aria-label={`Back to ${parent.label}`}
            className="-ml-2.5 flex min-h-11 min-w-0 items-center gap-0.5 rounded-full pr-3 text-foreground md:hidden"
          >
            <ChevronLeft className="size-6 shrink-0" />
            <span className="truncate font-heading text-[19px] font-semibold tracking-tight">{parent.label}</span>
          </Link>
        ) : mobileTitle && (
          <span className="min-w-0 truncate font-heading text-[22px] font-semibold tracking-tight text-foreground md:hidden">{mobileTitle}</span>
        )}

        {/* ── Nav — pill container ─────────────────────────────── */}
        <LayoutGroup id="navbar">
          <nav className="hidden md:flex min-w-0 items-center gap-0.5 overflow-x-auto rounded-full bg-foreground/90 dark:bg-gray-900 px-2 py-1.5 shadow-sm ring-1 ring-black/[0.06] dark:ring-gray-700 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {navLinks.map((item) => {
              const { label, href, icon: Icon, badge } = item;
              const isActive = activeTop?.href === href;
              const target = pillTarget(item);
              if (!target) {
                return (
                  <Tip key={href} text={lockReason} side="bottom">
                    <span
                      role="link"
                      aria-disabled="true"
                      tabIndex={0}
                      className="flex shrink-0 cursor-not-allowed items-center gap-1 rounded-full p-2.5 text-sm font-medium text-background/40 select-none focus-visible:outline-brand dark:text-gray-600"
                    >
                      <Lock className="size-3" />
                      {label}
                    </span>
                  </Tip>
                );
              }
              return (
                <Link
                  key={href}
                  to={target}
                  className={cn(
                    "relative flex shrink-0 items-center gap-1.5 rounded-full px-4 py-1.5 text-sm select-none p-2.5 focus-visible:outline-brand",
                    isActive
                      ? "font-semibold text-brand-foreground"
                      : "font-medium text-background hover:text-background/70 dark:text-gray-400 dark:hover:text-gray-200"
                  )}
                >
                  {isActive && (
                    <motion.span
                      layoutId="nav-pill"
                      initial={false}
                      className="absolute inset-0 rounded-full bg-brand"
                      transition={{
                        type: "spring",
                        stiffness: 380,
                        damping: 32,
                        mass: 1,
                      }}
                    />
                  )}

                  <span
                    className={cn(
                      "relative z-10 transition-opacity duration-150",
                      isActive ? "opacity-100" : "opacity-0 absolute"
                    )}
                  >
                    <Icon className="size-3.5" />
                  </span>

                  <span className="relative z-10">{label}</span>

                  {/* Same badge as the phone tab bar's (.mobile-unread in app.css). */}
                  {badge && (
                    <span className="relative z-10 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-unread px-1 text-caption font-semibold text-unread-foreground">
                      {badge > 99 ? "99+" : badge}
                    </span>
                  )}
                </Link>
              );
            })}
          </nav>
        </LayoutGroup>

        {/* ── Right: icons + user ───────────────────────────────────── */}
        <div className="flex shrink-0 items-center gap-1 md:gap-3">
          <div id={APP_BAR_ACTIONS_ID} className="flex items-center gap-0.5 md:hidden" />

          <button aria-label="Settings" onClick={() => navigate("/settings")} className="hidden md:flex size-9 items-center justify-center rounded-full bg-white dark:bg-gray-900 text-gray-500 dark:text-gray-400 shadow-sm ring-1 ring-black/[0.06] dark:ring-gray-700 hover:text-gray-800 dark:hover:text-gray-200 transition-colors">
            <Settings className="size-4" />
          </button>
          {/* 
          <button className="relative flex size-9 items-center justify-center rounded-full bg-white dark:bg-gray-900 text-gray-500 dark:text-gray-400 shadow-sm ring-1 ring-black/[0.06] dark:ring-gray-700 hover:text-gray-800 dark:hover:text-gray-200 transition-colors">
            <Bell className="size-4" />
            <span className="absolute right-2 top-2 size-1.5 rounded-full bg-orange-400 ring-1 ring-white dark:ring-gray-900" />
          </button> */}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button aria-label="Account and workspace" className="flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-full transition-colors md:justify-start md:bg-white md:py-1.5 md:pl-1.5 md:pr-3 md:shadow-sm md:ring-1 md:ring-black/[0.06] md:hover:bg-gray-50 md:dark:bg-gray-900 md:dark:ring-gray-700 md:dark:hover:bg-gray-800">
                <Avatar size="sm">
                  <AvatarImage src={user?.avatarUrl ?? ""} alt={user?.firstName} />
                  <AvatarFallback className="bg-brand text-brand-foreground text-xs font-bold">
                    {initials}
                  </AvatarFallback>
                </Avatar>
                <div className="hidden flex-col text-left lg:flex">
                  <span className="text-xs font-semibold text-gray-900 dark:text-gray-100 leading-tight">
                    {user?.firstName ?? "Steve"} {user?.lastName ?? "Rogers"}
                  </span>
                  <span className="text-caption text-muted-foreground">
                    {impersonatedBy
                      ? "Impersonating"
                      : user?.isSuperAdmin
                        ? "Super Admin"
                        : roleLabel(currentOrg?.role)}
                  </span>
                </div>
                <ChevronDown className="hidden size-3.5 text-muted-foreground md:block" />
              </button>
            </DropdownMenuTrigger>

            <DropdownMenuContent align="end" className="w-56">
              {impersonatedBy && (
                <>
                  <DropdownMenuItem
                    onClick={() => stopImpersonating.mutate()}
                    disabled={stopImpersonating.isPending}
                    className="font-semibold text-warning-text focus:text-warning-text"
                  >
                    <ArrowLeftRight className="size-4" />
                    {stopImpersonating.isPending ? "Switching back..." : "Switch back to my account"}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                </>
              )}
              {currentOrg && (
                <>
                  <DropdownMenuLabel className="font-normal">
                    <div className="flex flex-col gap-0.5">
                      <span className="text-xs text-muted-foreground">Current workspace</span>
                      <span className="text-sm font-medium">{currentOrg.organization.name}</span>
                    </div>
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                </>
              )}
              {organizations.length > 1 && (
                <>
                  <DropdownMenuLabel className="text-xs text-muted-foreground">Switch workspace</DropdownMenuLabel>
                  {organizations.map((membership) => (
                    <DropdownMenuItem
                      key={membership.organization.id}
                      onClick={() => handleSwitchOrg(membership.organization.id)}
                      className={cn(membership.organization.id === currentOrgId && "bg-brand/20 text-brand-strong")}
                    >
                      {membership.organization.name}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                </>
              )}
              <DropdownMenuItem asChild>
                <Link to="/profile" className="flex items-center gap-2">
                  <User className="size-4" /> Profile
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link to="/settings" className="flex items-center gap-2">
                  <Settings className="size-4" /> Settings
                </Link>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={handleSignOut}>
                <LogOut className="size-4" /> Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

      </div>

      {/* ── Section sub-nav — only for a section that has children ─── */}
      {sectionChildren && (
        <LayoutGroup id="section-nav">
          <div ref={sectionNavRef} className={cn("mobile-section-nav mx-auto max-w-screen-xl overflow-x-auto px-1 max-md:border-b max-md:border-border/70 md:mt-3 md:px-6 md:pb-3", parent && "max-md:hidden")}>
            <nav
              aria-label={`${activeTop?.label} section`}
              className="inline-flex min-w-max items-center gap-0.5 md:rounded-full md:bg-white md:px-1.5 md:py-1 md:shadow-sm md:ring-1 md:ring-black/[0.06] md:dark:bg-gray-900 md:dark:ring-gray-700"
            >
              {sectionChildren.map(({ label, href, icon: Icon }) => {
                const isActive = activeChild?.href === href;
                if (!canAccess(href)) {
                  return (
                    <Tip key={href} text={lockReason} side="bottom">
                      <span
                        role="link"
                        aria-disabled="true"
                        tabIndex={0}
                        className="flex cursor-not-allowed items-center gap-1.5 rounded-full p-2.5 text-xs font-medium text-gray-300 select-none dark:text-gray-600"
                      >
                        <Lock className="size-3.5" />
                        {label}
                      </span>
                    </Tip>
                  );
                }
                return (
                  <Link
                    key={href}
                    to={href}
                    aria-current={isActive ? "page" : undefined}
                    className={cn(
                      "relative flex min-h-11 items-center gap-1.5 px-3 py-2.5 text-sm select-none md:min-h-0 md:rounded-full md:p-2.5 md:text-xs",
                      isActive
                        ? "font-semibold text-foreground md:text-brand-foreground"
                        : "font-medium text-muted-foreground hover:text-foreground"
                    )}
                  >
                    {isActive && (
                      <motion.span
                        layoutId="section-nav-pill"
                        initial={false}
                        className="absolute inset-x-3 bottom-0 h-[3px] rounded-full bg-foreground md:inset-0 md:h-auto md:bg-brand"
                        transition={{ type: "spring", stiffness: 380, damping: 32, mass: 1 }}
                      />
                    )}
                    <Icon className="relative z-10 size-3.5 max-md:hidden" />
                    <span className="relative z-10">{label}</span>
                  </Link>
                );
              })}
            </nav>
          </div>
        </LayoutGroup>
      )}

    </header>
    {!immersive && <MobileNavigation items={navLinks.map((item) => ({ ...item, target: pillTarget(item) }))} workspace={currentOrg?.organization.name} canAccess={canAccess} lockReason={lockReason} />}
    </>
  );
}
