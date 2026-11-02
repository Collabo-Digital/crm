import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { accessGrants, capabilitiesFor, editorAccess, matchingTemplate, type JobTemplate } from "./member-access.ts";

/** The templates as GET /organizations/:orgId/members/job-templates serves them. */
const TEMPLATES: JobTemplate[] = [
  { id: "support", label: "Support agent", description: "", grants: ["section.chat", "chat.view_unassigned"] },
  {
    id: "marketing",
    label: "Marketing",
    description: "",
    grants: ["section.campaigns", "campaigns.view", "campaigns.manage", "broadcasts.send", "templates.manage"],
  },
  { id: "accountant", label: "Accountant", description: "", grants: ["section.invoices", "section.analytics", "reports.finance"] },
  {
    id: "warehouse",
    label: "Warehouse",
    description: "",
    grants: ["section.products", "inventory.view", "inventory.receive", "inventory.pick", "inventory.pack", "inventory.dispatch", "inventory.labels"],
  },
  { id: "packer", label: "Packer", description: "", grants: ["section.products", "inventory.pack"] },
  { id: "cashier", label: "Cashier", description: "", grants: ["section.products", "pos.sell"] },
];

const sorted = (list: readonly string[]) => [...list].sort();

describe("job templates in the access editor", () => {
  for (const template of TEMPLATES) {
    it(`${template.label}: picking it saves exactly its grants, and shows as picked`, () => {
      const { sections, capabilities } = editorAccess(template.grants);
      assert.deepEqual(sorted(accessGrants("AGENT", sections, capabilities)), sorted(template.grants));
      assert.equal(matchingTemplate(TEMPLATES, "AGENT", sections, capabilities)?.id, template.id);
    });
  }

  it("keeps a key with no checkbox (inventory.pick) through a save", () => {
    const { sections, capabilities } = editorAccess(TEMPLATES[3].grants);
    assert.ok(accessGrants("AGENT", sections, capabilities).includes("inventory.pick"));
  });

  it("stops matching once an ability is unticked", () => {
    const { sections, capabilities } = editorAccess(TEMPLATES[3].grants);
    const without = capabilities.filter((key) => key !== "inventory.labels");
    assert.equal(matchingTemplate(TEMPLATES, "AGENT", sections, without), undefined);
  });

  it("matches nothing for an empty list", () => {
    assert.equal(matchingTemplate([], "AGENT", ["chat"], ["chat.view_unassigned"]), undefined);
  });
});

describe("accessGrants", () => {
  it("gives the Invoices section reports.finance, and Campaigns campaigns.view", () => {
    const grants = accessGrants("AGENT", ["invoices", "campaigns"], []);
    assert.deepEqual(sorted(grants), sorted(["section.invoices", "section.campaigns", "reports.finance", "campaigns.view"]));
  });

  it("takes reports.finance away with the section", () => {
    const { capabilities } = editorAccess(TEMPLATES[2].grants);
    assert.deepEqual(accessGrants("AGENT", ["analytics"], capabilities), ["section.analytics"]);
  });

  it("drops an ability whose section is unticked", () => {
    assert.deepEqual(accessGrants("AGENT", ["products"], ["chat.view_all", "inventory.view"]), ["section.products", "inventory.view"]);
  });

  it("drops a stock ability without stock to work on", () => {
    assert.deepEqual(accessGrants("AGENT", ["products"], ["inventory.receive"]), ["section.products"]);
  });

  it("gives a viewer no agent-only ability", () => {
    assert.deepEqual(accessGrants("VIEWER", ["products", "chat"], ["pos.sell", "inventory.view", "chat.view_all"]), [
      "section.products",
      "section.chat",
      "chat.view_all",
    ]);
  });
});

describe("capabilitiesFor", () => {
  it("offers the till and packing whatever the sections, to agents", () => {
    const keys = capabilitiesFor("AGENT", ["chat"], []).map((c) => c.key);
    assert.ok(keys.includes("pos.sell"));
    assert.ok(keys.includes("inventory.pack"));
    assert.ok(!keys.includes("inventory.view"));
  });

  it("offers receiving, adjusting and labels once stock is ticked", () => {
    const before: string[] = capabilitiesFor("AGENT", ["products"], []).map((c) => c.key);
    const after: string[] = capabilitiesFor("AGENT", ["products"], ["inventory.view"]).map((c) => c.key);
    assert.ok(!before.includes("inventory.receive"));
    assert.ok(["inventory.receive", "inventory.adjust", "inventory.labels"].every((key) => after.includes(key)));
  });
});

describe("editorAccess", () => {
  it("opens a member with no section (full access) with every section ticked", () => {
    assert.equal(editorAccess(["reports.finance"]).sections.length > 5, true);
    assert.deepEqual(editorAccess(["reports.finance"]).capabilities, ["reports.finance"]);
  });

  it("leaves out sections this build does not show", () => {
    assert.deepEqual(editorAccess(["section.logistics", "section.orders"]).sections, ["orders"]);
  });
});
