import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { readableVariables } from "./automation-variables.ts";

describe("readableVariables", () => {
  it("names the placeholders a store owner meets most", () => {
    assert.equal(readableVariables("Your order {{order.name}} has shipped: {{order.tracking_url}}"), "Your order ‹order number› has shipped: ‹tracking link›");
    assert.equal(readableVariables("Hi {{first_name}}!"), "Hi ‹first name›!");
  });

  it("spells out any other placeholder", () => {
    assert.equal(readableVariables("Row {{sheet.order_id}}"), "Row ‹sheet order id›");
    assert.equal(readableVariables("{{ attr.review_rating }} stars"), "‹attr review rating› stars");
  });

  it("leaves text without placeholders alone", () => {
    assert.equal(readableVariables("Thanks for your order!"), "Thanks for your order!");
  });
});
