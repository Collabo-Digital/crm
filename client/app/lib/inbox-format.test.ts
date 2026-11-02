import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { SOURCE_LABEL } from "./inbox-format.ts";

/**
 * A sent message names who sent it: the agent, or one of these labels. A
 * message sent through the public API once showed no sender at all, because
 * the server's MessageSource had a value the web app didn't know.
 */
describe("SOURCE_LABEL", () => {
  const schema = readFileSync(fileURLToPath(new URL("../../../server/prisma/schema.prisma", import.meta.url)), "utf8");
  const body = /enum MessageSource \{([^}]*)\}/.exec(schema)?.[1] ?? "";
  const sources = body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[A-Z_]+$/.test(line));

  it("reads the server's message sources", () => {
    assert.ok(sources.includes("SYSTEM"), `no MessageSource enum found: ${sources.join(", ")}`);
  });

  it("labels every sender but the customer and the agent", () => {
    // The customer's messages are inbound; an agent's carry the agent's name.
    const unlabelled = sources.filter((s) => s !== "CUSTOMER" && s !== "AGENT" && !(s in SOURCE_LABEL));
    assert.deepEqual(unlabelled, []);
  });
});
