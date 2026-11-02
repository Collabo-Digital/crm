import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { dismissesSheet, keyboardInset } from "./sheet-gestures.ts";

describe("keyboardInset", () => {
  it("is 0 with no keyboard", () => {
    assert.equal(keyboardInset(844, 844, 0), 0);
  });

  it("is the part of the page the iOS keyboard covers", () => {
    assert.equal(keyboardInset(844, 508, 0), 336);
  });

  it("allows for Safari scrolling the visual viewport", () => {
    assert.equal(keyboardInset(844, 508, 120), 216);
  });

  it("never goes negative while the page settles after a resize", () => {
    assert.equal(keyboardInset(500, 508, 0), 0);
  });

  it("rounds fractional viewport sizes", () => {
    assert.equal(keyboardInset(844, 507.6, 0), 336);
  });
});

describe("dismissesSheet", () => {
  it("keeps the sheet for a nudge", () => {
    assert.equal(dismissesSheet(30, 600, 0.2), false);
  });

  it("closes after a third of a short sheet", () => {
    assert.equal(dismissesSheet(101, 300, 0.1), true);
    assert.equal(dismissesSheet(99, 300, 0.1), false);
  });

  it("closes a tall sheet after 160px", () => {
    assert.equal(dismissesSheet(160, 800, 0.1), true);
  });

  it("closes on a quick flick", () => {
    assert.equal(dismissesSheet(40, 800, 0.9), true);
  });

  it("ignores a fast twitch that barely moved", () => {
    assert.equal(dismissesSheet(10, 800, 2), false);
  });

  it("never closes on an upward drag", () => {
    assert.equal(dismissesSheet(0, 800, 3), false);
    assert.equal(dismissesSheet(-80, 800, 3), false);
  });
});
