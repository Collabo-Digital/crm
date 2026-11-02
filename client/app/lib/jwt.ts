/**
 * Read the organization a JWT was minted for.
 *
 * Deliberately does NOT verify the signature — the server is the only
 * authority on what a token permits. This exists so the UI can default its
 * "current organization" to the one the token actually names, instead of
 * guessing `organizations[0]` and drifting out of step with the session the
 * server will resolve.
 *
 * Returns null for anything unparseable, including tokens minted during
 * onboarding that carry no org yet.
 */
export function readTokenOrgId(token: string | null | undefined): string | null {
  const claims = readClaims(token);
  return typeof claims?.orgId === "string" && claims.orgId ? claims.orgId : null;
}

/** When a JWT expires, in milliseconds since the epoch; null when unreadable. Not verified either. */
export function readTokenExpiry(token: string | null | undefined): number | null {
  const exp = readClaims(token)?.exp;
  return typeof exp === "number" ? exp * 1000 : null;
}

function readClaims(token: string | null | undefined): { orgId?: unknown; exp?: unknown } | null {
  if (!token) return null;

  const payload = token.split(".")[1];
  if (!payload) return null;

  try {
    // base64url → base64, then pad to a multiple of 4.
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(
      base64.length + ((4 - (base64.length % 4)) % 4),
      "=",
    );
    return JSON.parse(atob(padded)) as { orgId?: unknown; exp?: unknown };
  } catch {
    return null;
  }
}
