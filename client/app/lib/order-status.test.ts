import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { orderPaymentBadges } from "./order-status.ts";

const labels = (order: Parameters<typeof orderPaymentBadges>[0]) =>
  orderPaymentBadges(order).map((b) => `${b.label}:${b.tone}`);

describe("orderPaymentBadges", () => {
  it("tags unpaid cash on delivery the way Packing does", () => {
    assert.deepEqual(labels({ financialStatus: "PENDING", cashOnDelivery: true, tags: [] }), [
      "COD:neutral",
      "Not confirmed:attention",
    ]);
    assert.deepEqual(labels({ financialStatus: "PENDING", cashOnDelivery: true, tags: [" COD-Confirmed "] }), [
      "COD:neutral",
    ]);
  });

  it("shows a COD order that has been paid as paid", () => {
    assert.deepEqual(labels({ financialStatus: "PAID", cashOnDelivery: true }), ["Paid:success"]);
  });

  it("shows every other order by its payment status", () => {
    assert.deepEqual(labels({ financialStatus: "PENDING" }), ["Pending:attention"]);
    assert.deepEqual(labels({ financialStatus: "REFUNDED" }), ["Refunded:neutral"]);
    assert.deepEqual(labels({ financialStatus: "PARTIALLY_REFUNDED" }), ["Partially refunded:attention"]);
    assert.deepEqual(labels({ financialStatus: "VOIDED", cashOnDelivery: true }), ["Voided:critical"]);
  });

  it("shows nothing on a vendor's row, which carries no payment", () => {
    assert.deepEqual(labels({}), []);
  });
});
