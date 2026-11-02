import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { addressProblem } from "./address.ts";

const complete = { address1: "12 MG Road", city: "Pune", zip: "411001", country: "India", country_code: "IN" };

describe("addressProblem", () => {
  it("passes a complete Indian address", () => {
    assert.equal(addressProblem(complete), null);
  });

  it("asks for the first line, the city and the PIN code", () => {
    assert.equal(addressProblem({ ...complete, address1: " " }), "Enter the first line of the address.");
    assert.equal(addressProblem({ ...complete, city: "" }), "Enter the city.");
    assert.equal(addressProblem({ ...complete, zip: undefined }), "Enter the PIN code.");
  });

  it("holds an Indian PIN code to 6 digits, and leaves other postcodes alone", () => {
    assert.equal(addressProblem({ ...complete, zip: "4110" }), "An Indian PIN code is 6 digits, like 400001.");
    assert.equal(addressProblem({ ...complete, zip: "SW1A 1AA", country: "United Kingdom", country_code: "GB" }), null);
  });
});
