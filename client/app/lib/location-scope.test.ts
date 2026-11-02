import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { Warehouse } from "~/types/api";
import {
  isLocationScopedRole,
  locationScopeLabel,
  scopeOptions,
  startLimiting,
  toggleLocation,
  usesStockLocations,
} from "./location-scope.ts";

function location(id: string, over: Partial<Warehouse> = {}): Warehouse {
  return {
    id,
    name: id,
    code: id.toUpperCase(),
    kind: "STORE",
    shopifyLocationId: null,
    shopifyLocation: null,
    gstWarning: null,
    address: null,
    gstinId: null,
    apobDeclared: false,
    isDefault: false,
    isActive: true,
    locationCount: 0,
    stockLineCount: 0,
    unitsAvailable: 0,
    createdAt: "2026-11-01T00:00:00.000Z",
    ...over,
  };
}

const LOCATIONS = [
  location("back", { name: "Back warehouse", kind: "WAREHOUSE", isDefault: true }),
  location("bandra", { name: "Bandra store" }),
  location("pune", { name: "Pune store", isActive: false }),
  location("andheri", { name: "Andheri store" }),
];

describe("store scoping in Team members", () => {
  it("applies to Managers and Agents only", () => {
    assert.equal(isLocationScopedRole("MANAGER"), true);
    assert.equal(isLocationScopedRole("AGENT"), true);
    for (const role of ["OWNER", "ADMIN", "VIEWER", "VENDOR", "INFLUENCER"] as const) {
      assert.equal(isLocationScopedRole(role), false);
    }
  });

  it("offers the active locations, stores first in their own order", () => {
    assert.deepEqual(
      scopeOptions(LOCATIONS, []).map((o) => o.id),
      ["bandra", "andheri", "back"],
    );
  });

  it("still shows a switched-off location the member has, so it can be taken away", () => {
    const options = scopeOptions(LOCATIONS, ["pune"]);
    assert.deepEqual(options.map((o) => o.id), ["bandra", "pune", "andheri", "back"]);
    assert.equal(options.find((o) => o.id === "pune")?.isActive, false);
  });

  it("shows the picker only when the workspace has a location", () => {
    assert.equal(usesStockLocations(undefined), false);
    assert.equal(usesStockLocations([location("x", { isActive: false })]), false);
    assert.equal(usesStockLocations(LOCATIONS), true);
  });

  it("ticks and unticks locations, but never empties the list, which would mean every location", () => {
    assert.deepEqual(toggleLocation(["bandra"], "back", true), ["bandra", "back"]);
    assert.deepEqual(toggleLocation(["bandra", "back"], "bandra", true), ["bandra", "back"]);
    assert.deepEqual(toggleLocation(["bandra", "back"], "bandra", false), ["back"]);
    assert.deepEqual(toggleLocation(["back"], "back", false), ["back"]);
  });

  it("starts limiting a member with the first active location ticked", () => {
    assert.deepEqual(startLimiting(scopeOptions(LOCATIONS, [])), ["bandra"]);
    assert.deepEqual(startLimiting([]), []);
  });

  it("labels the member's locations", () => {
    assert.equal(locationScopeLabel(undefined, LOCATIONS), "All locations");
    assert.equal(locationScopeLabel([], LOCATIONS), "All locations");
    assert.equal(locationScopeLabel(["bandra"], LOCATIONS), "Bandra store");
    assert.equal(locationScopeLabel(["gone"], LOCATIONS), "1 location");
    assert.equal(locationScopeLabel(["bandra", "back"], LOCATIONS), "2 locations");
  });
});
