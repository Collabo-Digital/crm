import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { calcMargin, formatMargin, NO_COST_MARGIN } from "./utils.ts";

describe("margin", () => {
  it("has no margin while the cost box is empty", () => {
    assert.equal(calcMargin("499", ""), null);
    assert.equal(calcMargin("499", "  "), null);
    assert.equal(calcMargin(499, null), null);
    assert.equal(formatMargin("499", "", "INR"), NO_COST_MARGIN);
    assert.equal(formatMargin(499, undefined, "INR"), "Add a cost to see margin");
  });

  it("works out profit and margin once a cost is entered", () => {
    assert.deepEqual(calcMargin("500", "200"), { profit: 300, marginPct: 60 });
    // A cost of zero is a real cost: everything is profit.
    assert.deepEqual(calcMargin(500, 0), { profit: 500, marginPct: 100 });
  });

  it("shows a dash when the price makes margin meaningless", () => {
    assert.equal(formatMargin("", "200", "INR"), "—");
    assert.equal(formatMargin(0, 200, "INR"), "—");
  });
});
