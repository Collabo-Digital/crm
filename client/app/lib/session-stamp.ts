// Relative import with its extension so `node --test` can load this file.
import { readTokenOrgId } from "./jwt.ts";

/**
 * Which session something belongs to: the user plus the org the access token
 * was minted for. The org comes from the TOKEN, not `currentOrgId`, because
 * the server resolves the tenant from the token — that is what decides whose
 * rows a request reads or writes.
 *
 * A workspace switch keeps the token's `sid`, so the sid alone would not tell
 * two workspaces of the same login apart.
 */
export function sessionStamp(state: {
  user: { id: string } | null;
  accessToken: string | null;
}): string {
  return `${state.user?.id ?? ""}|${readTokenOrgId(state.accessToken) ?? ""}`;
}

type Stamped = { sessionStamp?: string };

/**
 * Stamps a request with the session it is being sent in. A replay after a
 * token refresh keeps the stamp of its first send; returns false when that is
 * no longer the current session, and the replay must not go out.
 */
export function stampRequest(config: Stamped, current: string): boolean {
  config.sessionStamp ??= current;
  return config.sessionStamp === current;
}

/**
 * Was this request sent in a session that has since been replaced (signed
 * out, signed in as someone else, switched workspace)? Then its response is
 * not this session's to use, and its 401 must not be refreshed and replayed.
 */
export function sentInOtherSession(config: Stamped, current: string): boolean {
  return config.sessionStamp !== undefined && config.sessionStamp !== current;
}

/** A request outlived the session it was sent in, so its result was dropped. */
export class SessionChangedError extends Error {
  constructor() {
    super("Your account or workspace changed before this finished. Check the page before trying again.");
    this.name = "SessionChangedError";
  }
}
