import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tailwindcss(), reactRouter(), tsconfigPaths()],
  // Only reached at runtime (pdf.js loads when a PDF is first shown), so the dev
  // server would otherwise find them mid-session, re-bundle, and break open pages.
  optimizeDeps: { include: ["pdfjs-dist/legacy/build/pdf.mjs", "libphonenumber-js/min"] },
  // Two dev servers on one checkout (the preview and the E2E harness) must not
  // share a bundle cache: one re-bundling breaks pages the other is serving.
  cacheDir: process.env.VITE_CACHE_DIR,
});
