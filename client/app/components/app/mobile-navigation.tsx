import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router";
import { ArrowUpRight, ChevronRight, Grid2X2, Lock, Settings, User, type LucideIcon } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { cn } from "~/lib/utils";

type MobileNavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
  target: string | null;
  badge?: number;
  children?: { label: string; href: string; icon: LucideIcon }[];
};

const PRIMARY_PATHS = ["/dashboard", "/orders", "/inbox", "/products"];

export function MobileNavigation({ items, workspace, canAccess, lockReason }: {
  items: MobileNavItem[];
  workspace?: string;
  canAccess: (path: string) => boolean;
  lockReason: string;
}) {
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [pathname]);
  const primary = PRIMARY_PATHS.flatMap((path) => items.filter((item) => item.href === path && item.target));
  const matches = (href: string) => pathname === href || pathname.startsWith(`${href}/`);
  const moreActive = !primary.some((item) => matches(item.href));

  return (
    <>
      <nav aria-label="Main navigation" className="mobile-bottom-nav md:hidden">
        {primary.map(({ href, target, label, icon: Icon, badge }) => (
          <Link key={href} to={target!} aria-current={matches(href) ? "page" : undefined} className="mobile-nav-item">
            <span className="mobile-nav-icon">
              <Icon className="size-[21px]" strokeWidth={matches(href) ? 2.25 : 1.7} />
              {!!badge && <span className="mobile-unread">{badge > 99 ? "99+" : badge}</span>}
            </span>
            <span>{href === "/dashboard" ? "Home" : label}</span>
          </Link>
        ))}
        <button type="button" onClick={() => setOpen(true)} aria-expanded={open} aria-haspopup="dialog" aria-label="More navigation" className={cn("mobile-nav-item", moreActive && "is-active")}>
          <span className="mobile-nav-icon"><Grid2X2 className="size-[21px]" strokeWidth={1.7} /></span>
          <span>More</span>
        </button>
      </nav>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="mobile-menu max-w-lg gap-5">
          <DialogHeader>
            <DialogTitle className="text-2xl font-semibold tracking-tight">Your workspace</DialogTitle>
            <DialogDescription className="truncate">{workspace || "Everything you need, in one place."}</DialogDescription>
          </DialogHeader>
          <div className="space-y-5 overflow-y-auto overscroll-contain">
            <div className="grid grid-cols-2 gap-2.5">
              {items.map(({ href, target, label, icon: Icon }) => target ? (
                <Link key={href} to={target} onClick={() => setOpen(false)} className={cn("flex min-h-24 flex-col justify-between gap-3 rounded-2xl bg-surface-sunken p-4", matches(href) && "bg-brand/35")}>
                  <span className="flex items-center justify-between"><Icon className="size-5 text-brand-strong" strokeWidth={1.7} /><ArrowUpRight className="size-4 text-muted-foreground" /></span>
                  <span className="text-sm font-semibold">{label}</span>
                </Link>
              ) : (
                <div key={href} aria-disabled="true" title={lockReason} className="flex min-h-24 flex-col justify-between gap-3 rounded-2xl bg-muted/50 p-4 text-muted-foreground">
                  <span className="flex items-center justify-between"><Icon className="size-5" /><Lock className="size-3.5" /></span>
                  <span className="text-sm">{label}<span className="block text-xs">Access required</span></span>
                </div>
              ))}
            </div>
            <div className="divide-y divide-border rounded-2xl border border-border px-4">
              {[{ label: "Settings", href: "/settings", icon: Settings }, { label: "My profile", href: "/profile", icon: User }].filter((item) => canAccess(item.href)).map(({ label, href, icon: Icon }) => (
                <Link key={href} to={href} onClick={() => setOpen(false)} className="flex min-h-14 items-center gap-3 text-sm font-medium"><Icon className="size-5 text-muted-foreground" strokeWidth={1.7} />{label}<ChevronRight className="ml-auto size-4 text-muted-foreground" /></Link>
              ))}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
