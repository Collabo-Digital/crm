/**
 * Which workspace AuthGuard may show, given the access token's org.
 *
 * The server runs every request in the org the token names. A token with no
 * org (minted at sign-up, before any workspace existed) is run in whichever
 * org the server's session cache or the first membership resolves to — so the
 * UI must never name a workspace until the token is scoped to it.
 *
 * - "show": the token names one of the user's workspaces. Show that one;
 *   `currentOrgId` follows the token. Following it, rather than switching the
 *   token back, keeps two tabs from undoing each other's switch: another tab's
 *   storage write can arrive with the new token before the new `currentOrgId`.
 * - "switch": the token names no workspace the user has here. Get a token
 *   scoped to `orgId` (the selected workspace if it is still one of theirs,
 *   else the first) before showing anything.
 */
export type WorkspaceScope =
  | { kind: "show"; orgId: string }
  | { kind: "switch"; orgId: string }
  | { kind: "none" };

export function workspaceScope(
  organizations: { organization: { id: string } }[],
  tokenOrgId: string | null,
  currentOrgId: string | null,
): WorkspaceScope {
  if (organizations.length === 0) return { kind: "none" };

  const isMember = (orgId: string) =>
    organizations.some((m) => m.organization.id === orgId);

  if (tokenOrgId && isMember(tokenOrgId)) return { kind: "show", orgId: tokenOrgId };

  return {
    kind: "switch",
    orgId: currentOrgId && isMember(currentOrgId) ? currentOrgId : organizations[0].organization.id,
  };
}
