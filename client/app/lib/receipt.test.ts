import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { PosReceipt } from "~/types/api";
import {
  computerGeneratedNote,
  contactParts,
  customerLine,
  gstSummaryTotal,
  hasTaxCodes,
  itemCount,
  legalNameLine,
  lineDetail,
  lineName,
  qrCaption,
  rollAmount,
  rollDateTime,
  showsPlaceOfSupply,
  taxHeads,
} from "./receipt.ts";

const line = (overrides: Partial<PosReceipt["lines"][number]> = {}): PosReceipt["lines"][number] => ({
  taxCode: "A",
  title: "Cotton Kurta",
  variantTitle: "Blue / M",
  hsn: "6211",
  quantity: 1,
  unitPrice: 1299,
  discount: 129,
  taxableValue: 1114.29,
  gstRate: 5,
  cgst: 27.86,
  sgst: 27.85,
  igst: 0,
  total: 1170,
  ...overrides,
});

describe("receipt amounts and dates", () => {
  it("groups the Indian way, with a true minus", () => {
    assert.equal(rollAmount(124534), "1,24,534.00");
    assert.equal(rollAmount(-358), "−358.00");
    assert.equal(rollAmount(0.5), "0.50");
  });

  it("prints the date and time the counter way", () => {
    assert.equal(rollDateTime(new Date(2026, 9, 27, 14, 5).toISOString()), "27-10-2026 14:05");
    assert.equal(rollDateTime(new Date(2026, 0, 3, 9, 7).toISOString()), "03-01-2026 09:07");
  });
});

describe("receipt header", () => {
  it("prints the legal name only when it differs from the store name", () => {
    assert.equal(legalNameLine({ name: "Saanjh", legalName: "Saanjh Apparel Private Limited" }), "Saanjh Apparel Private Limited");
    assert.equal(legalNameLine({ name: "SAANJH", legalName: "Saanjh " }), null);
    assert.equal(legalNameLine({ name: "Saanjh", legalName: null }), null);
  });

  it("labels the phone and WhatsApp numbers that are set", () => {
    assert.deepEqual(contactParts({ phone: "+91 80 4000 0001", whatsapp: "+91 90000 00000" }), ["Ph +91 80 4000 0001", "WhatsApp +91 90000 00000"]);
    assert.deepEqual(contactParts({ phone: null, whatsapp: "+91 90000 00000" }), ["WhatsApp +91 90000 00000"]);
    assert.deepEqual(contactParts({ phone: null, whatsapp: null }), []);
  });

  it("shows the customer as far as the receipt setting allows", () => {
    assert.equal(customerLine({ name: null, phone: "+919800000010", gstin: null, phoneShown: "+91 98XXXXXX10" }), "Customer: +91 98XXXXXX10");
    assert.equal(customerLine({ name: "Priya", phone: "+919800000010", gstin: null, phoneShown: null }), "Customer: Priya");
    assert.equal(customerLine({ name: null, phone: "+919800000010", gstin: null, phoneShown: null }), null);
    assert.equal(customerLine(null), null);
  });

  it("prints the place of supply for a business customer or another state only", () => {
    const invoice = { number: "INV-26-27/000126", date: "2026-10-27T08:35:00Z", placeOfSupply: "29", gstType: "INTRA" as const };
    assert.equal(showsPlaceOfSupply({ invoice, customer: null }), false);
    assert.equal(showsPlaceOfSupply({ invoice, customer: { name: "Acme", phone: null, gstin: "29ABCDE1234F1Z5", phoneShown: null } }), true);
    assert.equal(showsPlaceOfSupply({ invoice: { ...invoice, placeOfSupply: "32", gstType: "INTER" }, customer: null }), true);
    assert.equal(showsPlaceOfSupply({ invoice: null, customer: null }), false);
  });
});

describe("receipt items and tax codes", () => {
  it("numbers each item and names its variant", () => {
    assert.equal(lineName(line(), 0), "1. Cotton Kurta – Blue / M");
    assert.equal(lineName(line({ variantTitle: null, title: "Silk Stole" }), 2), "3. Silk Stole");
  });

  it("puts the HSN beside the quantity and price", () => {
    assert.equal(lineDetail(line({ quantity: 2, unitPrice: 297 })), "HSN 6211 · 2 × 297.00");
    assert.equal(lineDetail(line({ hsn: null })), "1 × 1,299.00");
  });

  it("shows the GST letter column when any line carries a code", () => {
    assert.equal(hasTaxCodes([line({ taxCode: null }), line({ taxCode: "B" })]), true);
    assert.equal(hasTaxCodes([line({ taxCode: null })]), false);
  });

  it("counts items and units", () => {
    assert.equal(itemCount([line(), line({ quantity: 2 }), line()]), "Items 3 · Qty 4");
  });

  it("totals the GST summary by code", () => {
    const rows = [
      { code: "A", rate: 5, taxable: 1680, cgst: 42, sgst: 42, igst: 0 },
      { code: "B", rate: 18, taxable: 2347.46, cgst: 211.27, sgst: 211.27, igst: 0 },
    ];
    assert.deepEqual(gstSummaryTotal(rows), { taxable: 4027.46, cgst: 253.27, sgst: 253.27, igst: 0 });
    assert.deepEqual(gstSummaryTotal([]), { taxable: 0, cgst: 0, sgst: 0, igst: 0 });
  });

  it("uses IGST for a sale to another state", () => {
    const totals = { subtotal: 0, discount: 0, taxable: 0, cgst: 0, sgst: 0, igst: 0, roundOff: 0, total: 0, payable: 0 };
    assert.equal(taxHeads({ invoice: { number: "X", date: "", placeOfSupply: "32", gstType: "INTER" }, totals }), "IGST");
    assert.equal(taxHeads({ invoice: null, totals: { ...totals, igst: 12 } }), "IGST");
    assert.equal(taxHeads({ invoice: null, totals }), "CGST_SGST");
  });
});

describe("receipt footer", () => {
  it("captions the QR by what it does", () => {
    assert.equal(qrCaption({ kind: "ebill", url: "https://app.example/b/abc" }), "Scan for your e-bill and returns");
    assert.equal(qrCaption({ kind: "upi", uri: "upi://pay?pa=shop@okaxis", amount: 1500 }), "Scan to pay ₹1,500.00");
  });

  it("calls a bill a bill", () => {
    assert.equal(computerGeneratedNote("TAX INVOICE"), "This is a computer-generated invoice.");
    assert.equal(computerGeneratedNote("BILL OF SUPPLY"), "This is a computer-generated bill.");
    assert.equal(computerGeneratedNote("BILL"), "This is a computer-generated bill.");
  });
});
