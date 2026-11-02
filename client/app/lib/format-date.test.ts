import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { formatDate, formatDayMonth } from "./format-date.ts";

describe("dates are written day first", () => {
  it("in short, without the year", () => {
    assert.equal(formatDayMonth("2026-10-21T10:00:00"), "21 Oct");
    // Early in a month too, where a month-first form reads as another date.
    assert.equal(formatDayMonth("2026-11-05T10:00:00"), "5 Nov");
  });

  it("in full, with the year", () => {
    assert.equal(formatDate("2026-10-28T10:00:00"), "28 Oct 2026");
  });

  it("as a dash when there is no date", () => {
    assert.equal(formatDayMonth(null), "—");
    assert.equal(formatDayMonth("not a date"), "—");
  });
});
