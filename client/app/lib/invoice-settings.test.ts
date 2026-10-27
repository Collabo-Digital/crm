import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { InvoiceSettings } from "~/types/api";
import {
  contrastOnWhite,
  defaultSample,
  draftErrors,
  isLightBrandColor,
  panFromGstin,
  previewSamples,
  previewSettings,
  rebaseDraft,
  settingsPatch,
  toDraft,
} from "./invoice-settings.ts";

/** The server's defaults (InvoiceSettingsSchema.parse({})), plus one ID. */
function saved(overrides: Partial<InvoiceSettings> = {}): InvoiceSettings {
  return {
    theme: "modern",
    classicForB2b: true,
    brandColor: "#0F766E",
    showPan: true,
    businessIds: [{ type: "FSSAI", label: "", value: "11223344556677", onA4: true, onReceipt: false }],
    registeredOffice: "",
    showSupportContact: true,
    terms: "Subject to Bengaluru jurisdiction.",
    returnPolicy: "",
    returnPolicyUrl: "",
    footerNote: "Thank you for shopping with us.",
    signatureMode: "computer",
    signature: { storageKey: "org/sig.png", url: "https://app.example/uploads/products/org/sig.png" },
    signatoryName: "",
    signatoryDesignation: "",
    showSku: true,
    amountInWords: true,
    taxSummary: "auto",
    customerContact: "hide",
    receiptCustomerContact: "mask",
    upiQr: "unpaid",
    receiptQr: "ebill",
    ...overrides,
  };
}

describe("settingsPatch", () => {
  it("is empty when nothing changed", () => {
    assert.deepEqual(settingsPatch(saved(), toDraft(saved())), {});
  });

  it("carries only the fields that changed", () => {
    const draft = { ...toDraft(saved()), theme: "classic" as const, showSku: false };
    assert.deepEqual(settingsPatch(saved(), draft), { theme: "classic", showSku: false });
  });

  it("ignores what the server would trim or upper-case anyway", () => {
    const draft = { ...toDraft(saved()), terms: "  Subject to Bengaluru jurisdiction.\n", brandColor: " #0f766e" };
    assert.deepEqual(settingsPatch(saved(), draft), {});
  });

  it("sends the cleaned value", () => {
    const draft = { ...toDraft(saved()), returnPolicy: "  Exchange within 15 days. ", brandColor: "#9f1239" };
    assert.deepEqual(settingsPatch(saved(), draft), { returnPolicy: "Exchange within 15 days.", brandColor: "#9F1239" });
  });

  it("compares business IDs by content and sends the whole list when one changes", () => {
    const copy = toDraft(saved());
    copy.businessIds = copy.businessIds.map((id) => ({ ...id }));
    assert.deepEqual(settingsPatch(saved(), copy), {});

    const onReceipt = { ...copy, businessIds: [{ ...copy.businessIds[0], onReceipt: true }] };
    assert.deepEqual(settingsPatch(saved(), onReceipt), { businessIds: [{ ...copy.businessIds[0], onReceipt: true }] });

    const removed = { ...copy, businessIds: [] };
    assert.deepEqual(settingsPatch(saved(), removed), { businessIds: [] });
  });

  it("can clear the brand colour", () => {
    assert.deepEqual(settingsPatch(saved(), { ...toDraft(saved()), brandColor: null }), { brandColor: null });
  });

  it("never sends the signature image, which only its upload changes", () => {
    const patch = settingsPatch(saved({ signature: null }), toDraft(saved()));
    assert.equal("signature" in patch, false);
  });
});

describe("draftErrors", () => {
  it("passes the defaults", () => {
    assert.deepEqual(draftErrors(toDraft(saved())), {});
  });

  it("wants a full #RRGGBB colour, or none", () => {
    assert.ok(draftErrors({ ...toDraft(saved()), brandColor: "#0F766" }).brandColor);
    assert.ok(draftErrors({ ...toDraft(saved()), brandColor: "teal" }).brandColor);
    assert.equal(draftErrors({ ...toDraft(saved()), brandColor: "#abcdef" }).brandColor, undefined);
    assert.equal(draftErrors({ ...toDraft(saved()), brandColor: null }).brandColor, undefined);
  });

  it("wants a web link for the return policy, or nothing", () => {
    assert.ok(draftErrors({ ...toDraft(saved()), returnPolicyUrl: "yourstore.com/returns" }).returnPolicyUrl);
    assert.equal(draftErrors({ ...toDraft(saved()), returnPolicyUrl: " https://yourstore.com/returns " }).returnPolicyUrl, undefined);
    assert.equal(draftErrors({ ...toDraft(saved()), returnPolicyUrl: "" }).returnPolicyUrl, undefined);
  });

  it("wants a value on every ID and a name on a custom one", () => {
    const draft = {
      ...toDraft(saved()),
      businessIds: [
        { type: "CIN" as const, label: "", value: "  ", onA4: true, onReceipt: false },
        { type: "CUSTOM" as const, label: " ", value: "BIS-123", onA4: true, onReceipt: false },
        { type: "CUSTOM" as const, label: "BIS", value: "BIS-123", onA4: true, onReceipt: true },
      ],
    };
    assert.deepEqual(Object.keys(draftErrors(draft)).sort(), ["businessIds.0.value", "businessIds.1.label"]);
  });
});

describe("previewSettings", () => {
  it("sends the whole cleaned form", () => {
    const body = previewSettings({ ...toDraft(saved()), footerNote: " Visit again! " });
    assert.equal(body.footerNote, "Visit again!");
    assert.equal(body.theme, "modern");
    assert.equal("signature" in body, false);
  });

  it("leaves out a colour or link still being typed, so the saved one shows", () => {
    const body = previewSettings({ ...toDraft(saved()), brandColor: "#12", returnPolicyUrl: "https://" });
    assert.equal("brandColor" in body, false);
    assert.equal("returnPolicyUrl" in body, false);
  });

  it("keeps a cleared colour", () => {
    assert.equal(previewSettings({ ...toDraft(saved()), brandColor: null }).brandColor, null);
  });

  it("leaves out only the IDs that are not finished", () => {
    const done = { type: "IEC" as const, label: "", value: "0512345678", onA4: true, onReceipt: false };
    const body = previewSettings({
      ...toDraft(saved()),
      businessIds: [done, { type: "CUSTOM", label: "", value: "X1", onA4: true, onReceipt: false }],
    });
    assert.deepEqual(body.businessIds, [done]);
  });
});

describe("rebaseDraft", () => {
  it("takes the new saved value where the user changed nothing, and keeps their edits", () => {
    const base = saved();
    const next = saved({ theme: "classic", footerNote: "Thanks!", signature: null });
    const draft = { ...toDraft(base), footerNote: "Thank you, visit again." };
    const rebased = rebaseDraft(base, next, draft);
    assert.equal(rebased.theme, "classic");
    assert.equal(rebased.footerNote, "Thank you, visit again.");
    assert.equal("signature" in rebased, false);
  });

  it("follows a new list of IDs only when the user left theirs alone", () => {
    const base = saved();
    const next = saved({ businessIds: [] });
    assert.deepEqual(rebaseDraft(base, next, toDraft(base)).businessIds, []);
    const edited = { ...toDraft(base), businessIds: [{ ...base.businessIds[0], value: "99" }] };
    assert.deepEqual(rebaseDraft(base, next, edited).businessIds, edited.businessIds);
  });
});

describe("panFromGstin", () => {
  it("reads characters 3 to 12", () => {
    assert.equal(panFromGstin("29ABCDE1234F1Z5"), "ABCDE1234F");
  });

  it("has nothing to read without a GSTIN", () => {
    assert.equal(panFromGstin(null), null);
    assert.equal(panFromGstin(""), null);
    assert.equal(panFromGstin("29ABCDE"), null);
  });
});

describe("brand colour contrast", () => {
  it("measures against white", () => {
    assert.equal(contrastOnWhite("#FFFFFF"), 1);
    assert.equal(Math.round(contrastOnWhite("#000000")), 21);
    assert.equal(contrastOnWhite("#0F766E").toFixed(2), "5.47");
  });

  it("calls a colour light below 3:1, where the PDFs keep it off text", () => {
    assert.equal(isLightBrandColor("#0F766E"), false);
    assert.equal(isLightBrandColor("#CEF17B"), true);
    assert.equal(isLightBrandColor("#FACC15"), true);
    // Either side of the line: 3.03 and 2.99.
    assert.equal(isLightBrandColor("#949494"), false);
    assert.equal(isLightBrandColor("#959595"), true);
  });
});

describe("preview samples", () => {
  it("offers a Bill of supply only under composition, and a Bill only without GST", () => {
    assert.deepEqual(previewSamples({ gstEnabled: true, composition: false }), ["tax_invoice", "tax_invoice_b2b", "credit_note"]);
    assert.deepEqual(previewSamples({ gstEnabled: true, composition: true }), ["tax_invoice", "tax_invoice_b2b", "bill_of_supply", "credit_note"]);
    assert.deepEqual(previewSamples({ gstEnabled: false, composition: false }), ["tax_invoice", "tax_invoice_b2b", "credit_note", "bill"]);
  });

  it("starts on the merchant's everyday document", () => {
    assert.equal(defaultSample({ gstEnabled: true, composition: false }), "tax_invoice");
    assert.equal(defaultSample({ gstEnabled: true, composition: true }), "bill_of_supply");
    assert.equal(defaultSample({ gstEnabled: false, composition: false }), "bill");
  });
});
