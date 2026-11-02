import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parentScreen, withQuery, type Screen } from "./app-bar.ts";

const SCREENS: Screen[] = [
  { href: "/orders", label: "Orders" },
  { href: "/orders/drafts", label: "Drafts" },
  { href: "/orders/packing", label: "Packing" },
  { href: "/products", label: "Products" },
  { href: "/products/inventory", label: "Inventory" },
  { href: "/settings", label: "Settings" },
];

describe("parentScreen", () => {
  it("has no back arrow on a section's own page or a tab in its strip", () => {
    assert.equal(parentScreen("/orders", SCREENS), null);
    assert.equal(parentScreen("/orders/drafts", SCREENS), null);
    assert.equal(parentScreen("/settings", SCREENS), null);
  });

  it("goes up from a detail page to its list", () => {
    assert.deepEqual(parentScreen("/orders/cmvr52hbm034", SCREENS), { href: "/orders", label: "Orders" });
    assert.deepEqual(parentScreen("/products/abc", SCREENS), { href: "/products", label: "Products" });
  });

  it("picks the deepest screen that contains the page", () => {
    assert.equal(parentScreen("/orders/drafts/new", SCREENS)?.href, "/orders/drafts");
    assert.equal(parentScreen("/orders/packing/ord_1", SCREENS)?.href, "/orders/packing");
    assert.equal(parentScreen("/products/inventory/ledger", SCREENS)?.href, "/products/inventory");
  });

  it("goes up from a settings tab to the settings index", () => {
    assert.equal(parentScreen("/settings/members", SCREENS)?.href, "/settings");
  });

  it("ignores a trailing slash", () => {
    assert.equal(parentScreen("/orders/", SCREENS), null);
    assert.equal(parentScreen("/orders/123/", SCREENS)?.href, "/orders");
  });

  it("matches whole path segments only", () => {
    assert.equal(parentScreen("/ordersomething/1", SCREENS), null);
  });

  it("has nothing to go up to outside the known screens", () => {
    assert.equal(parentScreen("/dashboard", SCREENS), null);
    assert.equal(parentScreen("/profile", SCREENS), null);
  });
});

describe("withQuery", () => {
  it("leaves the path alone when nothing was saved", () => {
    assert.equal(withQuery("/orders", ""), "/orders");
  });

  it("keeps a saved query that carries its ?", () => {
    assert.equal(withQuery("/orders", "?page=2&q=riya"), "/orders?page=2&q=riya");
  });

  it("adds the ? to one saved without it", () => {
    assert.equal(withQuery("/orders/invoices", "chip=unpaid"), "/orders/invoices?chip=unpaid");
  });
});
