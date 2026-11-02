import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { unconvertedNote } from "./unconverted.ts";

describe("unconvertedNote", () => {
  it("says how many orders the total leaves out, and why", () => {
    assert.equal(unconvertedNote(3), "3 orders not counted yet (currency rate pending)");
    assert.equal(unconvertedNote(1), "1 order not counted yet (currency rate pending)");
    assert.equal(unconvertedNote(2, "bill"), "2 bills not counted yet (currency rate pending)");
  });
});
