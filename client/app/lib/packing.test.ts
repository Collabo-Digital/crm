import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { OrderPacking, PackingQueueRow, PackScanResponse, PackTask, PackTaskLine } from "~/types/api";
import {
  canEnterCount,
  canStartPacking,
  finishOptions,
  packingStatusLine,
  paymentBadges,
  productName,
  queueBadges,
  scanFeedback,
  taskBadge,
} from "./packing.ts";

const line = (overrides: Partial<PackTaskLine> = {}): PackTaskLine => ({
  id: "l1",
  orderLineItemId: "oli1",
  title: "Cotton Kurta",
  variantTitle: "Blue / M",
  sku: "KUR-BL-M",
  barcode: "8901234567890",
  imageUrl: null,
  required: 3,
  packed: 0,
  handConfirmed: 0,
  counted: 0,
  problem: null,
  scannable: true,
  ...overrides,
});

const task = (overrides: Partial<PackTask> = {}): PackTask => ({
  id: "t1",
  orderId: "o1",
  orderName: "#1042",
  status: "PACKING",
  customerName: "Riya Sharma",
  city: "Pune",
  payment: "prepaid",
  codConfirmed: null,
  partialAllowed: true,
  partial: false,
  holdReason: null,
  holdNote: null,
  heldAt: null,
  warehouse: null,
  updatedAt: "2026-10-28T08:00:00.000Z",
  packedAt: null,
  lines: [line()],
  ...overrides,
});

const scan = (overrides: Partial<PackScanResponse>): PackScanResponse => ({
  result: "matched",
  task: task(),
  ...overrides,
});

describe("scan feedback", () => {
  it("counts a match and asks for the next unit", () => {
    const fb = scanFeedback(scan({ result: "matched", lineId: "l1", task: task({ lines: [line({ packed: 1 })] }) }), "8901234567890");
    assert.equal(fb.tone, "success");
    assert.equal(fb.sound, "ok");
    assert.equal(fb.vibrate, false);
    assert.equal(fb.title, "Cotton Kurta (Blue / M): 1 of 3 packed");
    assert.equal(fb.detail, "Scan the next one.");
  });

  it("says when the last unit of the whole order went in", () => {
    const fb = scanFeedback(scan({ result: "matched", lineId: "l1", task: task({ lines: [line({ packed: 3 })] }) }), "x");
    assert.equal(fb.title, "Cotton Kurta (Blue / M): all 3 packed");
    assert.equal(fb.detail, "Everything is packed. Tap Mark packed.");
  });

  it("does not claim the order is done while other lines are short", () => {
    const fb = scanFeedback(
      scan({ result: "matched", lineId: "l1", task: task({ lines: [line({ packed: 3 }), line({ id: "l2", packed: 0, required: 1 })] }) }),
      "x",
    );
    assert.equal(fb.detail, undefined);
  });

  it("warns in amber, without a buzz, for one too many", () => {
    const fb = scanFeedback(scan({ result: "over", lineId: "l1", task: task({ lines: [line({ packed: 3 })] }) }), "x");
    assert.equal(fb.tone, "warning");
    assert.equal(fb.sound, "error");
    assert.equal(fb.vibrate, false);
    assert.equal(fb.title, "You already have all 3 of Cotton Kurta (Blue / M)");
  });

  it("names the wrong product in red, with low beeps and a buzz", () => {
    const fb = scanFeedback(scan({ result: "not_in_order", product: { title: "Silk Saree", variantTitle: "Red" } }), "x");
    assert.equal(fb.tone, "danger");
    assert.equal(fb.sound, "error");
    assert.equal(fb.vibrate, true);
    assert.equal(fb.title, "Silk Saree (Red) is not in this order");
  });

  it("still says not in this order when the product is unnamed", () => {
    assert.equal(scanFeedback(scan({ result: "not_in_order" }), "x").title, "This item is not in this order");
  });

  it("quotes an unknown code back", () => {
    const fb = scanFeedback(scan({ result: "unknown" }), "ABC-999");
    assert.equal(fb.tone, "danger");
    assert.equal(fb.title, "No product has the code ABC-999");
  });
});

describe("finish options", () => {
  it("offers only Mark packed when every line is full", () => {
    const o = finishOptions(task({ lines: [line({ packed: 3 })] }));
    assert.equal(o.allPacked, true);
    assert.equal(o.canPartial, false);
    assert.equal(o.partialNote, null);
  });

  it("offers the partial for a prepaid order with something packed", () => {
    const o = finishOptions(task({ payment: "prepaid", partialAllowed: true, lines: [line({ packed: 2 })] }));
    assert.equal(o.allPacked, false);
    assert.equal(o.canPartial, true);
    assert.equal(o.packedUnits, 2);
    assert.equal(o.requiredUnits, 3);
  });

  it("never splits a COD order, and says why", () => {
    const o = finishOptions(task({ payment: "cod", partialAllowed: false, lines: [line({ packed: 2 })] }));
    assert.equal(o.canPartial, false);
    assert.match(o.partialNote ?? "", /collects cash twice/);
  });

  it("never splits an unpaid order", () => {
    const o = finishOptions(task({ payment: "unpaid", partialAllowed: false, lines: [line({ packed: 1 })] }));
    assert.equal(o.canPartial, false);
    assert.match(o.partialNote ?? "", /isn't paid yet/);
  });

  it("needs one packed unit before a partial", () => {
    const o = finishOptions(task({ partialAllowed: true, lines: [line({ packed: 0 })] }));
    assert.equal(o.canPartial, false);
    assert.match(o.partialNote ?? "", /at least one item/);
  });
});

describe("queue badges", () => {
  const row = (overrides: Partial<PackingQueueRow>): Pick<PackingQueueRow, "payment" | "codConfirmed" | "task"> => ({
    payment: "cod",
    codConfirmed: null,
    task: null,
    ...overrides,
  });
  const taskRow = (overrides: Partial<NonNullable<PackingQueueRow["task"]>>): NonNullable<PackingQueueRow["task"]> => ({
    id: "t1",
    status: "PACKING",
    packedUnits: 2,
    requiredUnits: 5,
    holdReason: null,
    holdNote: null,
    updatedAt: "2026-10-28T08:00:00.000Z",
    lastPackerName: "Riya",
    ...overrides,
  });

  it("flags a COD order that is not confirmed", () => {
    assert.deepEqual(paymentBadges(row({ codConfirmed: false })), [
      { label: "COD", tone: "neutral" },
      { label: "Not confirmed", tone: "warning" },
    ]);
  });

  it("shows a plain COD badge once confirmed", () => {
    assert.deepEqual(paymentBadges(row({ codConfirmed: true })), [{ label: "COD", tone: "neutral" }]);
  });

  it("labels prepaid and unpaid orders", () => {
    assert.deepEqual(paymentBadges(row({ payment: "prepaid" })), [{ label: "Prepaid", tone: "success" }]);
    assert.deepEqual(paymentBadges(row({ payment: "unpaid" })), [{ label: "Not paid", tone: "warning" }]);
  });

  it("shows progress, the hold reason, or packed", () => {
    assert.deepEqual(taskBadge(taskRow({})), { label: "2 of 5 packed", tone: "info" });
    assert.deepEqual(taskBadge(taskRow({ status: "ON_HOLD", holdReason: "items_short" })), {
      label: "On hold: items short",
      tone: "warning",
    });
    assert.deepEqual(taskBadge(taskRow({ status: "PACKED", packedUnits: 5 })), { label: "Packed", tone: "success" });
    assert.deepEqual(taskBadge(taskRow({ status: "PACKED", packedUnits: 2 })), { label: "Packed 2 of 5", tone: "success" });
    assert.equal(taskBadge(null), null);
  });

  it("puts payment before progress", () => {
    const labels = queueBadges(row({ codConfirmed: false, task: taskRow({}) })).map((b) => b.label);
    assert.deepEqual(labels, ["COD", "Not confirmed", "2 of 5 packed"]);
  });
});

describe("line rules", () => {
  it("allows a typed count only on lines of 5 or more after one scan", () => {
    assert.equal(canEnterCount(line({ required: 4, packed: 1 })), false);
    assert.equal(canEnterCount(line({ required: 5, packed: 0 })), false);
    assert.equal(canEnterCount(line({ required: 5, packed: 1, handConfirmed: 1 })), false);
    assert.equal(canEnterCount(line({ required: 5, packed: 1 })), true);
  });

  it("drops Shopify's Default Title", () => {
    assert.equal(productName("Mug", "Default Title"), "Mug");
    assert.equal(productName("Mug", null), "Mug");
  });
});

describe("order page status line", () => {
  const now = Date.parse("2026-10-28T10:00:00.000Z");
  const packing = (overrides: Partial<OrderPacking>): OrderPacking => ({
    taskId: "t1",
    status: "PACKED",
    packedUnits: 3,
    requiredUnits: 3,
    holdReason: null,
    packedAt: "2026-10-28T08:40:00.000Z",
    packedByName: "Riya",
    ...overrides,
  });

  it("names the packer and the time", () => {
    assert.equal(packingStatusLine(packing({}), now, "Asia/Kolkata"), "Packed by Riya, 2:10 pm");
  });

  it("adds the date for an earlier day, and the split", () => {
    assert.equal(
      packingStatusLine(packing({ packedAt: "2026-10-27T08:40:00.000Z", packedUnits: 2 }), now, "Asia/Kolkata"),
      "Packed by Riya, 27 Oct, 2:10 pm (2 of 3 items, the rest later)",
    );
  });

  it("gives the hold reason and the progress", () => {
    assert.equal(packingStatusLine(packing({ status: "ON_HOLD", holdReason: "items_short" }), now), "On hold: items short");
    assert.equal(packingStatusLine(packing({ status: "PACKING", packedUnits: 1 }), now), "Packing: 1 of 3 items packed");
  });
});

describe("who can be packed", () => {
  const order = {
    cancelledAt: null,
    closedAt: null,
    financialStatus: "PAID" as const,
    fulfillmentStatus: "UNFULFILLED" as const,
    sourceName: "web",
    posSale: false,
  };

  it("takes an open, unshipped online order", () => {
    assert.equal(canStartPacking(order, true), true);
    assert.equal(canStartPacking({ ...order, fulfillmentStatus: "PARTIAL" }, true), true);
  });

  it("skips shipped, cancelled, refunded and counter sales", () => {
    assert.equal(canStartPacking({ ...order, fulfillmentStatus: "FULFILLED" }, true), false);
    assert.equal(canStartPacking({ ...order, cancelledAt: "2026-10-28T08:00:00.000Z" }, true), false);
    assert.equal(canStartPacking({ ...order, financialStatus: "REFUNDED" }, true), false);
    assert.equal(canStartPacking({ ...order, posSale: true }, true), false);
    assert.equal(canStartPacking({ ...order, sourceName: "pos" }, true), false);
    assert.equal(canStartPacking(order, false), false);
  });
});
