import type { ReactNode } from "react";
import { Link } from "react-router";
import { BarChart3, ChevronDown, Lock, LogOut, MoreVertical, Settings, Store } from "lucide-react";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import type { PosStore } from "~/types/api";

/**
 * The till's own slim bar on a phone, in place of the app bar and tabs: the
 * store (tap to switch), who is billing, and a menu with the way out.
 */
export function TillPhoneHeader({
  title,
  stores,
  storeId,
  onStore,
  staffBadge,
  canManage,
  onLock,
  exitTo,
}: {
  title: string;
  stores: PosStore[];
  storeId: string | undefined;
  onStore: (id: string) => void;
  staffBadge: ReactNode;
  canManage: boolean;
  /** Set when a staff PIN unlocked the till. */
  onLock: (() => void) | null;
  /** Orders, or the member's landing page when Orders is not theirs. */
  exitTo: string;
}) {
  return (
    <header className="flex shrink-0 items-center gap-1 border-b bg-background pt-[env(safe-area-inset-top)] pr-1 pl-2 md:hidden">
      <div className="flex min-h-14 min-w-0 flex-1 items-center">
        {stores.length > 1 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className="flex min-h-11 min-w-0 items-center gap-1.5 rounded-lg px-2 text-left hover:bg-muted" aria-label={`${title}. Switch store`}>
                <Store className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate font-heading text-section">{title}</span>
                <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64">
              <DropdownMenuLabel className="text-caption text-muted-foreground">Store</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={storeId} onValueChange={onStore}>
                {stores.map((s) => (
                  <DropdownMenuRadioItem key={s.id} value={s.id}>
                    {s.name}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <span className="flex min-w-0 items-center gap-1.5 px-2">
            <Store className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate font-heading text-section">{title}</span>
          </span>
        )}
      </div>
      {staffBadge}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="size-11 rounded-full" aria-label="Point of sale menu">
            <MoreVertical />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          {canManage && (
            <>
              <DropdownMenuItem asChild>
                <Link to="/orders/pos/settings">
                  <Settings /> POS settings
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link to="/orders/pos/reports">
                  <BarChart3 /> Reports
                </Link>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          {onLock && (
            <DropdownMenuItem onSelect={onLock}>
              <Lock /> Lock point of sale
            </DropdownMenuItem>
          )}
          <DropdownMenuItem asChild>
            <Link to={exitTo}>
              <LogOut /> {exitTo === "/orders" ? "Exit to Orders" : "Exit point of sale"}
            </Link>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}
