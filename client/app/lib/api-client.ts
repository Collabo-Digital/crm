import axios from "axios";
import { currentSessionStamp } from "~/lib/session-cache";
import { SessionChangedError, sentInOtherSession, stampRequest } from "~/lib/session-stamp";
import { useAuthStore } from "~/stores/auth.store";

declare module "axios" {
  interface AxiosRequestConfig {
    /** The session this request was first sent in — see session-stamp.ts. */
    sessionStamp?: string;
  }
}

/**
 * Pre-configured Axios instance for all API communication.
 *
 * - Attaches the access token to every outgoing request.
 * - Unwraps the backend `{ success, data }` envelope automatically.
 * - Performs a silent token refresh on 401 responses (once per request).
 * - Drops the result of a request that outlived the session it was sent in.
 */
const API_BASE: string = import.meta.env.VITE_API_BASE_URL || "/api/v1";

/**
 * A path the API hands out for the browser to load directly (signed media
 * links such as `/inbox/media/…`), resolved against the API base. Absolute
 * URLs (files kept at Meta or a CDN) pass through.
 */
export function apiUrl(path: string): string {
  return path.startsWith("/") ? `${API_BASE}${path}` : path;
}

export const apiClient = axios.create({
  baseURL: API_BASE,
  headers: { "Content-Type": "application/json" },
  withCredentials: true,
  timeout: 30_000,
});

// Attach access token to every request, stamped with the session it belongs to.
// A replay after a token refresh keeps its first stamp, and never goes out
// once another session (account or workspace) has replaced that one.
apiClient.interceptors.request.use((config) => {
  const { accessToken } = useAuthStore.getState();
  if (!stampRequest(config, currentSessionStamp())) {
    throw new SessionChangedError();
  }
  if (accessToken) {
    config.headers.Authorization = `Bearer ${accessToken}`;
  }
  return config;
});

/**
 * Single-flight refresh guard.
 *
 * When several requests 401 at the same time (e.g. on a page refresh after the
 * access token has expired), they must NOT each call `/auth/refresh` — the
 * server rotates refresh tokens single-use, so the first call invalidates the
 * token the others are holding and they would be logged out. Instead, the first
 * 401 starts one refresh and every other concurrent 401 awaits the same promise.
 */
let refreshPromise: Promise<string> | null = null;

/**
 * The server refused the refresh token itself (401 / 403), or there is none:
 * this session is over. Anything else — no response, a 5xx while the API
 * restarts or Redis is down, a 429 — says nothing about the session, so the
 * tokens stay and the next request tries the refresh again.
 */
class SessionEndedError extends Error {
  constructor() {
    super("Session ended");
  }
}

/** A refresh that hangs must not hold every waiting request with it. */
const REFRESH_TIMEOUT_MS = 15_000;

/** Refresh the access token using the stored refresh token. Returns the new access token. */
async function refreshAccessToken(): Promise<string> {
  const { refreshToken, setTokens } = useAuthStore.getState();
  if (!refreshToken) {
    throw new SessionEndedError();
  }
  const sessionChanged = () =>
    useAuthStore.getState().refreshToken !== refreshToken;

  const baseURL = import.meta.env.VITE_API_BASE_URL || "/api/v1";
  let res;
  try {
    // Use a raw axios call to avoid interceptor loops
    res = await axios.post(`${baseURL}/auth/refresh`, { refreshToken }, { timeout: REFRESH_TIMEOUT_MS });
  } catch (error) {
    // The session was replaced while this refresh was in flight — signed out,
    // signed in as someone else, or switched organization. A failure for the
    // old session says nothing about the new one.
    if (sessionChanged()) throw new SessionChangedError();
    const status = axios.isAxiosError(error) ? error.response?.status : undefined;
    if (status === 401 || status === 403) throw new SessionEndedError();
    throw error;
  }

  // Writing these would put the previous account's (or org's) tokens back on
  // top of the session that replaced it.
  if (sessionChanged()) throw new SessionChangedError();

  const tokens = res.data?.data ?? res.data;
  setTokens(tokens.accessToken, tokens.refreshToken);
  return tokens.accessToken;
}

// Unwrap backend response envelope: { success: true, data: T } → T
apiClient.interceptors.response.use(
  (response) => {
    // Sent before the session changed: the data is the old account's or
    // workspace's, so it must not reach the screen or the cache.
    if (sentInOtherSession(response.config, currentSessionStamp())) {
      return Promise.reject(new SessionChangedError());
    }
    if (response.data?.success && "data" in response.data) {
      response.data = response.data.data;
    }
    return response;
  },
  async (error) => {
    const originalRequest = error.config;

    // Likewise for a failure, above all a 401: refreshing would rotate the new
    // session's refresh token, and the replay would run this request (a write,
    // perhaps) as the new account or in the new workspace.
    if (originalRequest && sentInOtherSession(originalRequest, currentSessionStamp())) {
      return Promise.reject(new SessionChangedError());
    }

    // Attempt silent token refresh on 401 (only once per request)
    if (error.response?.status === 401 && !originalRequest._hasRetried) {
      originalRequest._hasRetried = true;

      try {
        // Single-flight: first 401 starts the refresh; others await the same promise.
        refreshPromise = refreshPromise ?? refreshAccessToken();
        const newAccessToken = await refreshPromise;

        // The request interceptor refuses this replay if the session changed
        // while refreshing.
        originalRequest.headers.Authorization = `Bearer ${newAccessToken}`;
        return apiClient(originalRequest);
      } catch (refreshError) {
        // Only a refused refresh ends the session, and only the one it
        // belonged to (a replaced session throws SessionChangedError). The
        // page is kept to return to after signing in again.
        if (refreshError instanceof SessionEndedError) {
          useAuthStore.getState().logout(window.location.pathname + window.location.search);
        }
        if (refreshError instanceof SessionChangedError) {
          return Promise.reject(refreshError);
        }
        return Promise.reject(error);
      } finally {
        // Reset so the next genuine expiry can refresh again.
        refreshPromise = null;
      }
    }

    // The server refused a section the UI still showed as open — an admin
    // changed this member's access. Re-sync it (see useMembershipSync) so the
    // nav locks and the layout redirects without waiting for the next poll.
    const message = error.response?.data?.message;
    if (
      error.response?.status === 403 &&
      typeof message === "string" &&
      message.startsWith("Section access denied") &&
      typeof window !== "undefined"
    ) {
      window.dispatchEvent(new Event("crm:access-changed"));
    }

    return Promise.reject(error);
  }
);
