import { Link, useLocation, useNavigate } from "react-router";
import { motion, LayoutGroup } from "framer-motion";
import {
  LayoutDashboard,
  ShoppingCart,
  Package,
  Megaphone,
  Layers,
  MessageSquare,
  Users,
  BarChart3,
  Bell,
  Settings,
  ChevronDown,
  LogOut,
  User,
  Leaf,
  Receipt,
  ShieldCheck,
  ArrowLeftRight,
  FileText,
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
import { useAuthStore } from "~/stores/auth.store";
import { apiClient } from "~/lib/api-client";
import { authService } from "~/services/auth.service";
import { useStopImpersonating } from "~/hooks/use-admin-queries";
import { useCurrentRole } from "~/hooks/use-current-role";
import { toast } from "sonner";

const NAV_LINKS: Array<{ label: string; href: string; icon: typeof LayoutDashboard; badge?: number }> = [
  { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  { label: "Orders", href: "/orders", icon: ShoppingCart },
  { label: "Drafts", href: "/drafts", icon: FileText },
  { label: "Products", href: "/products", icon: Package },
  // { label: "Marketing", href: "/marketing", icon: Megaphone },
  { label: "Channel", href: "/channel", icon: Layers },
  // { label: "Conversation", href: "/conversation", icon: MessageSquare, badge: 6 },
  { label: "Customers", href: "/customers", icon: Users },
  { label: "Invoices", href: "/invoices", icon: Receipt },
  { label: "Analytics", href: "/analytics", icon: BarChart3 },
];

/** Top navigation bar with pill-style nav links, notification icons, and user/workspace dropdown. */
export function Navbar() {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, organizations, currentOrgId, impersonatedBy, logout, refreshToken, setCurrentOrg, setTokens, setOrganizations } =
    useAuthStore();
  const stopImpersonating = useStopImpersonating();

  const { isVendor } = useCurrentRole();

  // Vendors are locked down to Orders + Products only. Otherwise, an extra
  // Super Admin link is visible to real Collabo-team super admins (never while
  // impersonating — the impersonation token has isSuperAdmin=false).
  const navLinks = isVendor
    ? [
        { label: "Orders", href: "/orders", icon: ShoppingCart },
        { label: "Products", href: "/products", icon: Package },
      ]
    : user?.isSuperAdmin && !impersonatedBy
      ? [...NAV_LINKS, { label: "Super Admin", href: "/admin/users", icon: ShieldCheck }]
      : NAV_LINKS;

  async function handleSwitchOrg(orgId: string) {
    if (orgId === currentOrgId) return;
    try {
      const data = await authService.switchOrg({ orgId });
      // Update tokens (new JWT scoped to selected org)
      setTokens(data.accessToken, data.refreshToken);
      // Update org list from backend (freshest data)
      const normalized = data.organizations.map((o) => ({
        id: crypto.randomUUID(),
        organizationId: o.id,
        role: o.role,
        isActive: true,
        organization: {
          id: o.id,
          name: o.name,
          slug: o.slug,
          type: o.type,
          logo: null,
          timezone: "UTC",
          currency: "USD",
          industry: null,
          website: null,
          billingPlan: "BASIC" as const,
          billingInterval: null,
          onboardingStatus: "COMPLETED" as const,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      }));
      setOrganizations(normalized);
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
        <Link to="/dashboard" className="flex shrink-0 items-center gap-2">
          <div className="flex size-9 items-center justify-center rounded-xl bg-[#CEF17B] shadow-sm dark:shadow-none">
            <Leaf className="size-4 text-gray-900" />
          </div>
          <span className="hidden text-base font-bold text-gray-900 dark:text-gray-100 sm:block">Collabo</span>
        </Link>

        {/* ── Nav — pill container ─────────────────────────────── */}
        <LayoutGroup id="navbar">
          <nav className="hidden md:flex items-center gap-0.5 rounded-full bg-white dark:bg-gray-900 px-2 py-1.5 shadow-sm ring-1 ring-black/[0.06] dark:ring-gray-700">
            {navLinks.map(({ label, href, icon: Icon, badge }) => {
              const isActive = location.pathname === href;
              return (
                <Link
                  key={href}
                  to={href}
                  className={cn(
                    "relative flex items-center gap-1.5 rounded-full px-4 py-1.5 text-sm select-none p-2.5",
                    isActive
                      ? "font-semibold text-gray-900 dark:text-gray-900"
                      : "font-medium text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200"
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
    </header>
  );
}
