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
import { BrandLogo } from "~/components/app/brand-logo";
import { Tip } from "~/components/ui/tooltip";
import { useAuthStore, normalizeOrganizations } from "~/stores/auth.store";
import { apiClient } from "~/lib/api-client";
import { authService } from "~/services/auth.service";
import { useStopImpersonating } from "~/hooks/use-admin-queries";
import { useSectionAccess } from "~/hooks/use-section-access";
import { useCurrentRole } from "~/hooks/use-current-role";
import { useInboxCounts } from "~/hooks/use-inbox-queries";
import { toast } from "sonner";

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
];

/** Sub-nav for Campaigns. Overview keeps the parent href, like "All orders". */
const CAMPAIGNS_CHILDREN: NavChild[] = [
  { label: "Overview", href: "/campaigns", icon: Megaphone },
  { label: "Broadcasts", href: "/campaigns/broadcasts", icon: Send },
  { label: "Templates", href: "/campaigns/templates", icon: LayoutTemplate },
  { label: "Segments", href: "/campaigns/segments", icon: Filter },
  { label: "Automations", href: "/campaigns/automations", icon: Workflow },
];

const NAV_LINKS: NavItem[] = [
  { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  { label: "Orders", href: "/orders", icon: ShoppingCart, children: ORDERS_CHILDREN },
  { label: "Products", href: "/products", icon: Package, children: PRODUCTS_CHILDREN },
  { label: "Inbox", href: "/inbox", icon: MessageSquare, children: INBOX_CHILDREN },
  { label: "Campaigns", href: "/campaigns", icon: Megaphone, children: CAMPAIGNS_CHILDREN },
  { label: "Analytics", href: "/analytics", icon: BarChart3 },
];

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
export function Navbar() {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, organizations, currentOrgId, impersonatedBy, logout, refreshToken, setCurrentOrg, setTokens, setOrganizations } =
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
    try {
      if (refreshToken) {
        await apiClient.post("/auth/logout", { refreshToken });
      }
    } catch {
      // silent
    } finally {
      logout();
      navigate("/auth/login");
    }
  }

  const initials = user ? `${user.firstName[0]}${user.lastName[0]}`.toUpperCase() : "?";
  const currentOrg = organizations.find((membership) => membership.organization.id === currentOrgId);

  return (
    <header className="sticky top-0 z-50 w-full bg-[#f1f7fa] dark:bg-gray-950">
      <div className="mx-auto flex h-[72px] max-w-screen-xl items-center justify-between px-6">

        {/* ── Logo ──────────────────────────────────────────────────── */}
        <Link to={landingPath} className="flex shrink-0 items-center">
          <BrandLogo className="h-7" />
        </Link>

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
                      className="flex shrink-0 cursor-not-allowed items-center gap-1 rounded-full p-2.5 text-sm font-medium text-background/40 select-none dark:text-gray-600"
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
                    "relative flex shrink-0 items-center gap-1.5 rounded-full px-4 py-1.5 text-sm select-none p-2.5",
                    isActive
                      ? "font-semibold text-gray-900 dark:text-gray-900"
                      : "font-medium text-background hover:text-background/70 dark:text-gray-400 dark:hover:text-gray-200"
                  )}
                >
                  {isActive && (
                    <motion.span
                      layoutId="nav-pill"
                      initial={false}
                      className="absolute inset-0 rounded-full bg-[#CEF17B]"
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

                  {badge && (
                    <span
                      className={cn(
                        "relative z-10 flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 text-[10px] font-bold text-white",
                        isActive ? "bg-gray-800" : "bg-red-500"
                      )}
                    >
                      {badge}
                    </span>
                  )}
                </Link>
              );
            })}
          </nav>
        </LayoutGroup>

        {/* ── Right: icons + user ───────────────────────────────────── */}
        <div className="flex items-center gap-3">

          <button onClick={() => navigate("/settings")} className="flex size-9 items-center justify-center rounded-full bg-white dark:bg-gray-900 text-gray-500 dark:text-gray-400 shadow-sm ring-1 ring-black/[0.06] dark:ring-gray-700 hover:text-gray-800 dark:hover:text-gray-200 transition-colors">
            <Settings className="size-4" />
          </button>
          {/* 
          <button className="relative flex size-9 items-center justify-center rounded-full bg-white dark:bg-gray-900 text-gray-500 dark:text-gray-400 shadow-sm ring-1 ring-black/[0.06] dark:ring-gray-700 hover:text-gray-800 dark:hover:text-gray-200 transition-colors">
            <Bell className="size-4" />
            <span className="absolute right-2 top-2 size-1.5 rounded-full bg-orange-400 ring-1 ring-white dark:ring-gray-900" />
          </button> */}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="flex items-center gap-2 rounded-full bg-white dark:bg-gray-900 py-1.5 pl-1.5 pr-3 shadow-sm ring-1 ring-black/[0.06] dark:ring-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
                <Avatar size="sm">
                  <AvatarImage src={user?.avatarUrl ?? ""} alt={user?.firstName} />
                  <AvatarFallback className="bg-[#CEF17B] text-gray-900 text-xs font-bold">
                    {initials}
                  </AvatarFallback>
                </Avatar>
                <div className="hidden flex-col text-left lg:flex">
                  <span className="text-xs font-semibold text-gray-900 dark:text-gray-100 leading-tight">
                    {user?.firstName ?? "Steve"} {user?.lastName ?? "Rogers"}
                  </span>
                  <span className="text-[10px] text-gray-400 leading-tight">
                    {impersonatedBy
                      ? "Impersonating"
                      : user?.isSuperAdmin
                        ? "Super Admin"
                        : currentOrg?.role === "OWNER"
                          ? "Owner"
                          : currentOrg?.role?.toLowerCase() ?? "Member"}
                  </span>
                </div>
                <ChevronDown className="size-3.5 text-gray-400" />
              </button>
            </DropdownMenuTrigger>

            <DropdownMenuContent align="end" className="w-56">
              {impersonatedBy && (
                <>
                  <DropdownMenuItem
                    onClick={() => stopImpersonating.mutate()}
                    disabled={stopImpersonating.isPending}
                    className="font-semibold text-amber-700 focus:text-amber-800"
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
                      className={cn(membership.organization.id === currentOrgId && "bg-[#CEF17B]/20 text-[#084734]")}
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
          <div className="mx-auto hidden max-w-screen-xl px-6 pb-3 mt-3 md:block">
            <nav
              aria-label={`${activeTop?.label} section`}
              className="inline-flex items-center gap-0.5 rounded-full bg-white dark:bg-gray-900 px-1.5 py-1 shadow-sm ring-1 ring-black/[0.06] dark:ring-gray-700"
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
                      "relative flex items-center gap-1.5 rounded-full p-2.5 text-xs select-none",
                      isActive
                        ? "font-semibold text-gray-900"
                        : "font-medium text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200"
                    )}
                  >
                    {isActive && (
                      <motion.span
                        layoutId="section-nav-pill"
                        initial={false}
                        className="absolute inset-0 rounded-full bg-[#CEF17B]"
                        transition={{ type: "spring", stiffness: 380, damping: 32, mass: 1 }}
                      />
                    )}
                    <Icon className="relative z-10 size-3.5" />
                    <span className="relative z-10">{label}</span>
                  </Link>
                );
              })}
            </nav>
          </div>
        </LayoutGroup>
      )}

    </header>
  );
}
