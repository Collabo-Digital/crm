import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { pageTitle, spokenTitle } from "./page-title.ts";

describe("pageTitle", () => {
  it("puts the page first and the app name last", () => {
    assert.equal(pageTitle("Order #4706"), "Order #4706 | Collabo CRM");
  });

  it("names the tab or record before its section", () => {
    assert.equal(pageTitle("Tax & GST", "Settings"), "Tax & GST · Settings | Collabo CRM");
  });

  it("skips parts that are empty or not loaded yet", () => {
    assert.equal(pageTitle(undefined, "Settings"), "Settings | Collabo CRM");
    assert.equal(pageTitle("  ", null, "Inbox"), "Inbox | Collabo CRM");
    assert.equal(pageTitle(), "Collabo CRM");
  });
});

describe("spokenTitle", () => {
  it("drops the app name a screen reader would repeat on every page", () => {
    assert.equal(spokenTitle("Movement history · Inventory | Collabo CRM"), "Movement history · Inventory");
  });

  it("leaves a title without the app name alone", () => {
    assert.equal(spokenTitle("Your cart"), "Your cart");
  });
});

/**
 * Every page the router can show names itself in the browser tab, which is
 * also what a screen reader reads when the page opens. Inventory, Movement
 * history and Locations once had no title at all.
 */
describe("route titles", () => {
  const APP_DIR = fileURLToPath(new URL("..", import.meta.url));
  const routes = readFileSync(`${APP_DIR}routes.ts`, "utf8");
  const files = [...new Set([...routes.matchAll(/"(routes\/[^"]+\.tsx)"/g)].map((m) => m[1]))];
  // Layouts wrap pages that have titles; redirects never show anything.
  const NO_TITLE = new Set([
    "routes/home.tsx",
    "routes/app/_layout.tsx",
    "routes/auth/_layout.tsx",
    "routes/onboarding/_layout.tsx",
    "routes/app/legacy-redirect.tsx",
  ]);

  it("finds the route files", () => {
    assert.ok(files.length > 40, `only ${files.length} route files found in routes.ts`);
  });

  for (const file of files.filter((f) => !NO_TITLE.has(f))) {
    it(`${file} sets a title`, () => {
      const source = readFileSync(`${APP_DIR}${file}`, "utf8");
      assert.match(source, /export (async )?function meta\b[\s\S]*?title/, `${file} exports no meta title`);
    });
  }
});
