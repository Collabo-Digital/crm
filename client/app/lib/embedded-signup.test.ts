import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { readEmbeddedSignupMessage } from "./embedded-signup.ts";

const finish = JSON.stringify({
  type: "WA_EMBEDDED_SIGNUP",
  event: "FINISH",
  data: { phone_number_id: "106540352242922", messaging_account_ids: ["102290129340398"], business_id: "2729063490586005", is_on_biz_app: true },
});

describe("readEmbeddedSignupMessage", () => {
  it("reads a finished signup from Meta's signup pages", () => {
    for (const origin of ["https://www.facebook.com", "https://web.facebook.com", "https://business.facebook.com"]) {
      assert.deepEqual(readEmbeddedSignupMessage({ origin, data: finish }), {
        kind: "finish",
        phoneNumberId: "106540352242922",
        wabaId: "102290129340398",
        isOnBizApp: true,
        businessId: "2729063490586005",
      });
    }
  });

  it("ignores the same message from any other site", () => {
    for (const origin of [
      "https://notfacebook.com",
      "https://evilfacebook.com",
      "https://www.facebook.com.evil.example",
      "https://facebook.com",
      "http://www.facebook.com",
      "https://www.facebook.com:8443",
      "null",
    ]) {
      assert.equal(readEmbeddedSignupMessage({ origin, data: finish }), null, origin);
    }
  });

  it("ignores messages of another shape", () => {
    const origin = "https://www.facebook.com";
    for (const data of [
      "not json",
      JSON.stringify({ type: "OTHER", event: "FINISH", data: {} }),
      JSON.stringify({ type: "WA_EMBEDDED_SIGNUP", event: 1, data: {} }),
      JSON.stringify({ type: "WA_EMBEDDED_SIGNUP", event: "FINISH", data: ["102290129340398"] }),
      JSON.stringify({ type: "WA_EMBEDDED_SIGNUP", event: "FINISH", data: "102290129340398" }),
      JSON.stringify({ type: "WA_EMBEDDED_SIGNUP", event: "STARTED", data: {} }),
      null,
      ["WA_EMBEDDED_SIGNUP"],
    ]) {
      assert.equal(readEmbeddedSignupMessage({ origin, data }), null, String(data));
    }
  });

  it("drops ids that are not Meta's numeric ids, keeping the rest", () => {
    const data = { type: "WA_EMBEDDED_SIGNUP", event: "FINISH", data: { phone_number_id: "../1", waba_id: 102290129340398, business_id: "2729063490586005" } };
    assert.deepEqual(readEmbeddedSignupMessage({ origin: "https://www.facebook.com", data }), {
      kind: "finish",
      phoneNumberId: undefined,
      wabaId: undefined,
      isOnBizApp: undefined,
      businessId: "2729063490586005",
    });
  });

  it("reads v4's account field and Business app finish", () => {
    const data = JSON.stringify({ type: "WA_EMBEDDED_SIGNUP", event: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING", data: { waba_id: "102290129340398" } });
    assert.deepEqual(readEmbeddedSignupMessage({ origin: "https://web.facebook.com", data }), {
      kind: "finish",
      phoneNumberId: undefined,
      wabaId: "102290129340398",
      isOnBizApp: true,
      businessId: undefined,
    });
  });

  it("reads a cancel with the step and Meta's reason", () => {
    const data = JSON.stringify({ type: "WA_EMBEDDED_SIGNUP", event: "CANCEL", data: { current_step: "PHONE_NUMBER_SETUP", error_message: "Number in use" } });
    assert.deepEqual(readEmbeddedSignupMessage({ origin: "https://www.facebook.com", data }), {
      kind: "cancel",
      step: "PHONE_NUMBER_SETUP",
      error: "Number in use",
    });
  });
});
