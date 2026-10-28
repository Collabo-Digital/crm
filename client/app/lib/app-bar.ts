/**
 * The phone app bar's back arrow (components/app/navbar.tsx): which screen a
 * page sits under, and the list whose last filters the arrow should restore.
 */

export interface Screen {
  href: string;
  label: string;
}

/**
 * The screen the back arrow returns to from `pathname`: the deepest known
 * screen that contains it. Null on a screen of its own (a section's page, a
 * tab in its strip), which keeps its title and tabs instead.
 */
export function parentScreen(pathname: string, screens: ReadonlyArray<Screen>): Screen | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (screens.some((screen) => screen.href === path)) return null;
  return (
    screens
      .filter((screen) => path.startsWith(`${screen.href}/`))
      .sort((a, b) => b.href.length - a.href.length)[0] ?? null
  );
}

/**
 * Where lists keep their last query string in the session (useListUrlState's
 * `<list>.return`; the invoices page its own `invoices.params`), by path, so
 * back from a detail page lands on the list as it was left.
 */
export const LIST_QUERY_KEYS: Readonly<Record<string, string>> = {
  "/orders": "orders.return",
  "/orders/drafts": "drafts.return",
  "/orders/customers": "customers.return",
  "/orders/invoices": "invoices.params",
  "/orders/packing": "packing.return",
  "/products": "products.return",
  "/products/inventory": "inventory.return",
  "/campaigns/broadcasts": "broadcasts.return",
};

/** `href` with a saved query string, which is kept with or without its "?". */
export function withQuery(href: string, saved: string): string {
  if (!saved) return href;
  return `${href}${saved.startsWith("?") ? "" : "?"}${saved}`;
}
