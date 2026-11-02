import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { documentLabel } from "./invoice-status.ts";

describe("documentLabel", () => {
  it("names a credit note whatever it was issued against", () => {
    assert.equal(documentLabel({ status: "CREDIT_NOTE", metadata: { render: { documentType: "BILL_OF_SUPPLY" } } }), "Credit note");
    assert.equal(documentLabel({ status: "CREDIT_NOTE", metadata: null }), "Credit note");
  });

  it("names the type the invoice was issued as, cancelled or not", () => {
    assert.equal(documentLabel({ status: "ISSUED", metadata: { render: { documentType: "BILL_OF_SUPPLY" } } }), "Bill of supply");
    assert.equal(documentLabel({ status: "CANCELLED", metadata: { render: { documentType: "BILL_OF_SUPPLY" } } }), "Bill of supply");
    assert.equal(documentLabel({ status: "ISSUED", metadata: { render: { documentType: "TAX_INVOICE" } } }), "Tax invoice");
  });

  it("calls an invoice from before the snapshot a tax invoice", () => {
    assert.equal(documentLabel({ status: "ISSUED", metadata: null }), "Tax invoice");
    assert.equal(documentLabel({ status: "ISSUED", metadata: {} }), "Tax invoice");
    assert.equal(documentLabel({ status: "ISSUED" }), "Tax invoice");
  });
});
