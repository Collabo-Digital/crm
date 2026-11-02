import { join } from "node:path";
import type { Config } from "@react-router/dev/config";

import { writeSecurityHeaders } from "./security-headers.ts";

// Mirrors resolveApiBaseUrl() in app/lib/api-client.ts: a build whose
// VITE_API_BASE_URL is unset, blank or relative still calls the production
// API, so the Content-Security-Policy must allow that origin.
const PRODUCTION_API_BASE_URL = "https://api.collabo.store/api/v1";

function buildApiBaseUrl(configured: string | undefined): string {
  const value = (configured ?? "").trim();
  return /^https?:\/\//.test(value) ? value : PRODUCTION_API_BASE_URL;
}

export default {
  ssr: false,
  // After index.html is written: its inline scripts' hashes go into the
  // Content-Security-Policy in build/client/_headers.
  async buildEnd({ reactRouterConfig, viteConfig }) {
    await writeSecurityHeaders(join(reactRouterConfig.buildDirectory, "client"), buildApiBaseUrl(viteConfig.env.VITE_API_BASE_URL));
  },
} satisfies Config;
