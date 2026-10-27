import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { workspaceScope } from "./workspace-scope.ts";

const memberships = (...ids: string[]) => ids.map((id) => ({ organization: { id } }));

describe("workspaceScope", () => {
  it("sends a user with no workspace to onboarding", () => {
    assert.deepEqual(workspaceScope([], null, null), { kind: "none" });
  });

  it("shows the workspace the token is scoped to", () => {
    assert.deepEqual(workspaceScope(memberships("org-a", "org-b"), "org-b", "org-b"), {
      kind: "show",
      orgId: "org-b",
    });
  });

  it("follows the token when the selected workspace differs from it", () => {
    assert.deepEqual(workspaceScope(memberships("org-a", "org-b"), "org-b", "org-a"), {
      kind: "show",
      orgId: "org-b",
    });
    assert.deepEqual(workspaceScope(memberships("org-a", "org-b"), "org-a", null), {
      kind: "show",
      orgId: "org-a",
    });
  });

  it("scopes a token with no org to the selected workspace", () => {
    assert.deepEqual(workspaceScope(memberships("org-a", "org-b"), null, "org-b"), {
      kind: "switch",
      orgId: "org-b",
    });
  });

  it("scopes a token with no org to the first workspace when none is selected", () => {
    assert.deepEqual(workspaceScope(memberships("org-a", "org-b"), null, null), {
      kind: "switch",
      orgId: "org-a",
    });
  });

  it("never switches to a selected workspace the user no longer has", () => {
    assert.deepEqual(workspaceScope(memberships("org-a", "org-b"), null, "org-gone"), {
      kind: "switch",
      orgId: "org-a",
    });
  });

  it("re-scopes a token naming a workspace this browser does not know", () => {
    assert.deepEqual(workspaceScope(memberships("org-a", "org-b"), "org-other", "org-b"), {
      kind: "switch",
      orgId: "org-b",
    });
  });
});
