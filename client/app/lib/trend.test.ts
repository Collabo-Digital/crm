import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { comparedChange, comparedLabel, trendBadge } from "./trend.ts";

describe("trendBadge", () => {
  it("shows no change as neutral, not as growth", () => {
    assert.deepEqual(
      { direction: trendBadge(0).direction, tone: trendBadge(0).tone, text: trendBadge(0).text },
      { direction: "flat", tone: "neutral", text: "0%" },
    );
    // Rounds to zero too.
    assert.equal(trendBadge(0.4).direction, "flat");
  });

  it("colours a rise good for sales and bad for a backlog", () => {
    assert.equal(trendBadge(12).tone, "success");
    const pending = trendBadge(700, "down");
    assert.equal(pending.direction, "up");
    assert.equal(pending.tone, "critical");
    assert.equal(pending.label, "Up 700%, worse than the previous period");
  });

  it("colours a fall bad for sales and good for abandoned carts", () => {
    assert.equal(trendBadge(-8).tone, "critical");
    assert.equal(trendBadge(-8).text, "8%");
    assert.equal(trendBadge(-8, "down").tone, "success");
  });

  it("keeps a figure that is neither better up nor down neutral", () => {
    assert.equal(trendBadge(40, "neither").tone, "neutral");
    assert.equal(trendBadge(40, "neither").label, "Up 40%");
  });

  it("groups big numbers the Indian way", () => {
    assert.equal(trendBadge(123456).text, "1,23,456%");
  });
});

describe("comparedChange", () => {
  it("signs the server's percentage by its direction", () => {
    assert.equal(comparedChange({ previous: 10, change: { percentage: 20, direction: "down" } }), -20);
    assert.equal(comparedChange({ previous: "5", change: { percentage: 20, direction: "up" } }), 20);
  });

  it("shows no percentage when the previous period had nothing", () => {
    const metric = { previous: 0, change: { percentage: 100, direction: "up" as const } };
    assert.equal(comparedChange(metric), undefined);
    assert.equal(comparedLabel(metric), "None in the previous period");
  });

  it("says nothing when there is no comparison at all (All Time)", () => {
    const metric = { previous: 0, change: null };
    assert.equal(comparedChange(metric), undefined);
    assert.equal(comparedLabel(metric), undefined);
  });
});
