import { Link, useLocation, useSearchParams } from "react-router";

import { cn } from "~/lib/utils";

/**
 * Navigation across the three inventory screens.
 *
 * They were reachable only from two ghost links buried in the stock page's
 * filter row, and are deliberately kept out of the main nav strip (which stays
 * at two children under Products) — so without this, most merchants never found
 * the movement history or the locations list at all.
 *
 * These are links between routes, not tabs over panels, so they carry
 * `aria-current` rather than tab/tabpanel roles that would describe a structure
 * this page does not have. The pill styling matches `SegmentedTabs` on purpose.
 *
 * The selected location rides along in the query string so switching screens
 * keeps you at the same location.
 */
const TABS = [
  { to: "/products/inventory", label: "Stock" },
  { to: "/products/inventory/warehouses", label: "Locations" },
  { to: "/products/inventory/ledger", label: "Movement history" },
] as const;

export function InventoryTabs() {
  const { pathname } = useLocation();
  const [searchParams] = useSearchParams();
  const warehouseId = searchParams.get("warehouseId");

  return (
    <nav
      aria-label="Inventory sections"
      className="flex w-fit flex-wrap gap-1 rounded-full bg-muted p-1"
    >
      {TABS.map((tab) => {
        const active = pathname === tab.to;
        const to = warehouseId
          ? `${tab.to}?warehouseId=${encodeURIComponent(warehouseId)}`
          : tab.to;
        return (
          <Link
            key={tab.to}
            to={to}
            aria-current={active ? "page" : undefined}
            className={cn(
              "inline-flex items-center rounded-full px-3 py-1 text-caption font-medium transition-colors",
              active
                ? "bg-ink font-semibold text-brand"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
