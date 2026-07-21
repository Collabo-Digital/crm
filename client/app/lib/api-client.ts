import axios from "axios";
import { useAuthStore } from "~/stores/auth.store";

/**
 * Pre-configured Axios instance for all API communication.
 *
 * - Attaches the access token to every outgoing request.
 * - Unwraps the backend `{ success, data }` envelope automatically.
 * - Performs a silent token refresh on 401 responses (once per request).
 */
export const apiClient = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || "/api/v1",
  headers: { "Content-Type": "application/json" },
  withCredentials: true,
});

// Attach access token to every request
apiClient.interceptors.request.use((config) => {
  const { accessToken } = useAuthStore.getState();
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

/** Refresh the access token using the stored refresh token. Returns the new access token. */
async function refreshAccessToken(): Promise<string> {
  const { refreshToken, setTokens } = useAuthStore.getState();
  if (!refreshToken) {
    throw new Error("No refresh token");
  }

  const baseURL = import.meta.env.VITE_API_BASE_URL || "/api/v1";
  // Use a raw axios call to avoid interceptor loops
  const res = await axios.post(`${baseURL}/auth/refresh`, { refreshToken });

  const tokens = res.data?.data ?? res.data;
  setTokens(tokens.accessToken, tokens.refreshToken);
  return tokens.accessToken;
}

// Unwrap backend response envelope: { success: true, data: T } → T
apiClient.interceptors.response.use(
  (response) => {
    if (response.data?.success && "data" in response.data) {
      response.data = response.data.data;
    }
    return response;
  },
  async (error) => {
    const originalRequest = error.config;

    // Attempt silent token refresh on 401 (only once per request)
    if (error.response?.status === 401 && !originalRequest._hasRetried) {
      originalRequest._hasRetried = true;

      try {
        // Single-flight: first 401 starts the refresh; others await the same promise.
        refreshPromise = refreshPromise ?? refreshAccessToken();
        const newAccessToken = await refreshPromise;

        originalRequest.headers.Authorization = `Bearer ${newAccessToken}`;
        return apiClient(originalRequest);
      } catch {
        useAuthStore.getState().logout();
        return Promise.reject(error);
      } finally {
        // Reset so the next genuine expiry can refresh again.
        refreshPromise = null;
      }
    }

    return Promise.reject(error);
  }
);
