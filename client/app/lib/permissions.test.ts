import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { canEditProducts } from "./permissions.ts";

describe("canEditProducts", () => {
  it("lets owners, admins and managers change products without any grant", () => {
    for (const role of ["OWNER", "ADMIN", "MANAGER"] as const) {
      assert.equal(canEditProducts(role, []), true);
    }
  });

  it("asks an agent for products.edit: the Products section alone only reads", () => {
    assert.equal(canEditProducts("AGENT", ["section.products", "products.edit"]), true);
    assert.equal(canEditProducts("AGENT", ["section.products"]), false);
    assert.equal(canEditProducts("AGENT", ["section.products", "inventory.pack"]), false);
  });

  it("refuses a viewer and an influencer, whatever they hold", () => {
    assert.equal(canEditProducts("VIEWER", ["section.products", "products.edit"]), false);
    assert.equal(canEditProducts("INFLUENCER", ["products.edit"]), false);
  });

  it("lets a vendor edit, since the server confines it to its own products", () => {
    assert.equal(canEditProducts("VENDOR", []), true);
  });

  it("refuses when the role is not known yet", () => {
    assert.equal(canEditProducts(undefined, ["products.edit"]), false);
  });
});
