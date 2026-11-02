import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { canAccessPath, firstAllowedPath, namesAccess, resolveAccess } from "./sections.ts";

/** The job templates as the server serves them (server/src/auth/permissions.ts). */
const CASHIER = ["pos.sell"];
const ACCOUNTANT = ["section.invoices", "section.analytics", "reports.finance"];
const PACKER = ["section.products", "inventory.pack"];
const WAREHOUSE = [
  "section.products",
  "inventory.view",
  "inventory.receive",
  "inventory.pick",
  "inventory.pack",
  "inventory.dispatch",
  "inventory.labels",
];

const agent = (grants: string[]) => resolveAccess("AGENT", grants);

describe("a Cashier", () => {
  const access = agent(CASHIER);

  it("lands on the till", () => {
    assert.equal(firstAllowedPath(access), "/orders/pos");
  });

  it("opens the till and its printed receipt", () => {
    assert.equal(canAccessPath(access, "/orders/pos"), true);
    assert.equal(canAccessPath(access, "/orders/pos/receipts/o1/print"), true);
  });

  it("does not open the till's settings, the store reports or the order book", () => {
    assert.equal(canAccessPath(access, "/orders/pos/settings"), false);
    assert.equal(canAccessPath(access, "/orders/pos/reports"), false);
    assert.equal(canAccessPath(access, "/orders"), false);
    assert.equal(canAccessPath(access, "/orders/o1"), false);
    assert.equal(canAccessPath(access, "/orders/customers"), false);
  });

  it("opens no section: not Products, where an Agent can change prices", () => {
    assert.equal(canAccessPath(access, "/products"), false);
    assert.equal(canAccessPath(access, "/dashboard"), false);
    assert.equal(canAccessPath(access, "/inbox"), false);
  });

  it("is not a way in for a vendor holding the key", () => {
    assert.equal(canAccessPath(resolveAccess("VENDOR", ["pos.sell"]), "/orders/pos"), false);
  });
});

describe("an Accountant", () => {
  const access = agent(ACCOUNTANT);

  it("lands on the invoices", () => {
    assert.equal(firstAllowedPath(access), "/orders/invoices");
  });

  it("opens invoices, their print view and the store analytics", () => {
    assert.equal(canAccessPath(access, "/orders/invoices"), true);
    assert.equal(canAccessPath(access, "/orders/invoices/i1"), true);
    assert.equal(canAccessPath(access, "/orders/invoices/i1/print"), true);
    assert.equal(canAccessPath(access, "/analytics"), true);
  });

  it("does not open orders, chats or the managers' messaging analytics", () => {
    assert.equal(canAccessPath(access, "/orders"), false);
    assert.equal(canAccessPath(access, "/orders/o1"), false);
    assert.equal(canAccessPath(access, "/inbox"), false);
    assert.equal(canAccessPath(access, "/analytics/messaging"), false);
  });
});

describe("the Invoices section", () => {
  it("is locked without reports.finance, which the server asks for", () => {
    assert.equal(canAccessPath(agent(["section.invoices", "section.orders"]), "/orders/invoices"), false);
    assert.equal(canAccessPath(resolveAccess("VIEWER", ["section.invoices", "reports.finance"]), "/orders/invoices"), true);
  });

  it("stays open to managers and to members who joined before section access", () => {
    assert.equal(canAccessPath(resolveAccess("MANAGER", []), "/orders/invoices"), true);
    assert.equal(canAccessPath(agent(["reports.finance"]), "/orders/invoices"), true);
  });

  it("lands a member who cannot open it on their next section", () => {
    assert.equal(firstAllowedPath(agent(["section.invoices", "section.analytics"])), "/analytics");
  });
});

describe("the other jobs", () => {
  it("still lands a Packer and a Warehouse member on the packing list", () => {
    assert.equal(firstAllowedPath(agent(PACKER)), "/orders/packing");
    assert.equal(firstAllowedPath(agent(WAREHOUSE)), "/orders/packing");
  });

  it("opens stock for the Warehouse member but not for the Packer", () => {
    assert.equal(canAccessPath(agent(WAREHOUSE), "/products/inventory"), true);
    assert.equal(canAccessPath(agent(PACKER), "/products/inventory"), false);
  });

  it("lands an agent with the Orders section on the orders, till or not", () => {
    assert.equal(firstAllowedPath(agent(["section.orders", "pos.sell"])), "/orders");
  });

  it("keeps the messaging analytics for managers", () => {
    assert.equal(canAccessPath(resolveAccess("MANAGER", []), "/analytics/messaging"), true);
    assert.equal(canAccessPath(agent(["section.analytics"]), "/analytics/messaging"), false);
  });
});

describe("namesAccess", () => {
  it("counts the till as access on its own, and nothing else without a section", () => {
    assert.equal(namesAccess(["pos.sell"]), true);
    assert.equal(namesAccess(["section.chat"]), true);
    assert.equal(namesAccess(["inventory.pack", "chat.view_all"]), false);
    assert.equal(namesAccess([]), false);
  });

  it("leaves a member with no section and no such job unrestricted", () => {
    assert.equal(canAccessPath(agent(["chat.view_all"]), "/dashboard"), true);
  });
});
