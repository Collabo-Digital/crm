import { join } from "node:path";
import type { Config } from "@react-router/dev/config";

import { writeSecurityHeaders } from "./security-headers.ts";

export default {
  ssr: false,
  // After index.html is written: its inline scripts' hashes go into the
  // Content-Security-Policy in build/client/_headers.
  async buildEnd({ reactRouterConfig, viteConfig }) {
    await writeSecurityHeaders(join(reactRouterConfig.buildDirectory, "client"), viteConfig.env.VITE_API_BASE_URL);
  },
} satisfies Config;
