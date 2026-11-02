import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { sentInOtherSession, sessionStamp, stampRequest } from "./session-stamp.ts";

/** An unsigned JWT carrying `claims` — enough for the client, which never verifies. */
function token(claims: Record<string, unknown>): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part(claims)}.`;
}

const userA = { id: "user-a" };
const userB = { id: "user-b" };

describe("sessionStamp", () => {
  it("is the user plus the org the access token names", () => {
    assert.equal(
      sessionStamp({ user: userA, accessToken: token({ sub: "user-a", orgId: "org-1" }) }),
      "user-a|org-1",
    );
  });

  it("stays the same across a token refresh in the same workspace", () => {
    const before = sessionStamp({ user: userA, accessToken: token({ orgId: "org-1", exp: 1 }) });
    const after = sessionStamp({ user: userA, accessToken: token({ orgId: "org-1", exp: 2 }) });
    assert.equal(before, after);
  });

  it("changes when the workspace, the user or the sign-in state changes", () => {
    const base = sessionStamp({ user: userA, accessToken: token({ orgId: "org-1" }) });
    assert.notEqual(base, sessionStamp({ user: userA, accessToken: token({ orgId: "org-2" }) }));
    assert.notEqual(base, sessionStamp({ user: userB, accessToken: token({ orgId: "org-1" }) }));
    assert.notEqual(base, sessionStamp({ user: null, accessToken: null }));
  });

  it("tells a token with no org apart from one scoped to a workspace", () => {
    const unscoped = sessionStamp({ user: userA, accessToken: token({ sub: "user-a" }) });
    assert.equal(unscoped, "user-a|");
    assert.notEqual(unscoped, sessionStamp({ user: userA, accessToken: token({ orgId: "org-1" }) }));
  });
});

describe("stampRequest", () => {
  it("stamps a first send with the current session", () => {
    const config: { sessionStamp?: string } = {};
    assert.equal(stampRequest(config, "user-a|org-1"), true);
    assert.equal(config.sessionStamp, "user-a|org-1");
  });

  it("lets a replay go out in the session it was first sent in", () => {
    const config = { sessionStamp: "user-a|org-1" };
    assert.equal(stampRequest(config, "user-a|org-1"), true);
  });

  it("refuses a replay once another session has replaced the first, and keeps the first stamp", () => {
    const config = { sessionStamp: "user-a|org-1" };
    assert.equal(stampRequest(config, "user-a|org-2"), false);
    assert.equal(stampRequest(config, "user-b|org-1"), false);
    assert.equal(config.sessionStamp, "user-a|org-1");
  });
});

describe("sentInOtherSession", () => {
  it("is false while the session the request was sent in is still current", () => {
    assert.equal(sentInOtherSession({ sessionStamp: "user-a|org-1" }, "user-a|org-1"), false);
  });

  it("is true after a sign-out, another account or another workspace", () => {
    const config = { sessionStamp: "user-a|org-1" };
    assert.equal(sentInOtherSession(config, "|"), true);
    assert.equal(sentInOtherSession(config, "user-b|org-3"), true);
    assert.equal(sentInOtherSession(config, "user-a|org-2"), true);
  });

  it("is true when an unscoped request finds the session scoped to a workspace", () => {
    assert.equal(sentInOtherSession({ sessionStamp: "user-a|" }, "user-a|org-1"), true);
  });

  it("leaves an unstamped request alone", () => {
    assert.equal(sentInOtherSession({}, "user-a|org-1"), false);
  });
});
