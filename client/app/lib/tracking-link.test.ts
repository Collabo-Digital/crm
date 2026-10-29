import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { trackingStep } from "./tracking-link.ts";

describe("trackingStep", () => {
  it("opens a known courier's https page at once", () => {
    assert.deepEqual(trackingStep({ trackingUrl: "https://www.delhivery.com/track/package/1", knownCourier: true }), {
      kind: "open",
      url: "https://www.delhivery.com/track/package/1",
    });
  });

  it("names any other site and waits for the customer to continue", () => {
    assert.deepEqual(trackingStep({ trackingUrl: "https://pay-cod-fee.example/track?awb=1", knownCourier: false }), {
      kind: "confirm",
      url: "https://pay-cod-fee.example/track?awb=1",
      host: "pay-cod-fee.example",
    });
  });

  it("asks first when the server does not say, and for a courier's plain http page", () => {
    assert.equal(trackingStep({ trackingUrl: "https://www.delhivery.com/track/package/1" }).kind, "confirm");
    assert.equal(trackingStep({ trackingUrl: "http://www.delhivery.com/track/package/1", knownCourier: true }).kind, "confirm");
  });

  it("shows the real site of an address dressed up as a courier", () => {
    const step = trackingStep({ trackingUrl: "https://www.delhivery.com.pay-cod-fee.example/x", knownCourier: false });
    assert.equal(step.kind === "confirm" && step.host, "www.delhivery.com.pay-cod-fee.example");
  });

  it("follows nothing that is not a web address", () => {
    assert.deepEqual(trackingStep({ trackingUrl: null }), { kind: "none" });
    assert.deepEqual(trackingStep({ trackingUrl: "javascript:alert(1)", knownCourier: true }), { kind: "none" });
    assert.deepEqual(trackingStep({ trackingUrl: "not a url" }), { kind: "none" });
  });
});
