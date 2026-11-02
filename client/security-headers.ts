/**
 * The web app's Content-Security-Policy, added to build/client/_headers after
 * every build (see react-router.config.ts and public/_headers). It is written
 * per build because it names the API's origin (VITE_API_BASE_URL) and the
 * hashes of the inline scripts in index.html: the theme script in root.tsx and
 * React Router's start-up scripts, whose text changes with every build.
 *
 * A feature that loads code, frames or data from another site needs its host
 * here; docs/security-headers.md says how to check the policy.
 */
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Cloudflare ignores a `_headers` line longer than this. */
const MAX_LINE = 2000;

const META_SDK = "https://connect.facebook.net"; // lib/meta-sdk.ts: WhatsApp, Messenger and Ads connect
const META_WWW = ["https://www.facebook.com", "https://web.facebook.com"]; // the SDK's login status and logging
const GOOGLE_API = "https://apis.google.com"; // lib/google-picker.ts: the Sheets picker's loader
const RAZORPAY_CHECKOUT = "https://checkout.razorpay.com"; // routes/onboarding/choose-plan.tsx
const RAZORPAY_CDN = "https://cdn.razorpay.com"; // a fraud-check script Checkout adds to the page
const RAZORPAY_API = "https://api.razorpay.com"; // its payment window and calls
const RAZORPAY_LOGS = ["https://lumberjack.razorpay.com", "https://lumberjack-cx.razorpay.com", "https://lumberjack-metrics.razorpay.com"];

/**
 * The policy for one build. `apiOrigin` is null when the API is on the app's
 * own origin; `scriptHashes` are base64 SHA-256 digests of inline scripts.
 */
export function contentSecurityPolicy({ apiOrigin, scriptHashes }: { apiOrigin: string | null; scriptHashes: string[] }): string {
  const api = apiOrigin ? [apiOrigin] : [];
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    // No 'unsafe-inline' or 'unsafe-eval': an injected script does not run.
    "script-src": ["'self'", ...scriptHashes.map((hash) => `'sha256-${hash}'`), META_SDK, GOOGLE_API, RAZORPAY_CHECKOUT, RAZORPAY_CDN],
    // Components, toasts and the third-party windows set inline styles.
    "style-src": ["'self'", "'unsafe-inline'"],
    // Avatars, product pictures and chat media also come from Meta, Shopify
    // and storage CDNs; previews are blob: and data: URLs.
    "img-src": ["'self'", "data:", "blob:", "https:", ...api],
    "media-src": ["'self'", "blob:", "https:", ...api],
    "font-src": ["'self'", "data:"],
    "connect-src": ["'self'", ...api, META_SDK, ...META_WWW, RAZORPAY_API, ...RAZORPAY_LOGS],
    // Meta's login frames, the Sheets picker, Razorpay's payment window and
    // the map on a customer's page (maps.google.com moves to www.google.com).
    "frame-src": [...META_WWW, "https://docs.google.com", RAZORPAY_API, "https://maps.google.com", "https://www.google.com"],
    // pdf.js's worker (components/app/pdf-pages.tsx).
    "worker-src": ["'self'"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    // Razorpay posts a form to its own site for some payment methods.
    "form-action": ["'self'", RAZORPAY_API],
    // No other site may frame the app (clickjacking).
    "frame-ancestors": ["'none'"],
  };
  return Object.entries(directives)
    .map(([name, sources]) => [name, ...sources].join(" "))
    .join("; ");
}

/** The origin VITE_API_BASE_URL points at, or null when it is a path on the app's own origin. */
export function apiOrigin(apiBaseUrl: string | undefined): string | null {
  if (!apiBaseUrl) return null;
  const sameOrigin = "https://app.invalid";
  const { origin } = new URL(apiBaseUrl, sameOrigin);
  return origin === sameOrigin ? null : origin;
}

/** Base64 SHA-256 of every inline `<script>` in a page, as CSP hashes them. */
export function inlineScriptHashes(html: string): string[] {
  const hashes: string[] = [];
  for (const [, attributes, body] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/\bsrc\s*=/i.test(attributes)) continue;
    hashes.push(createHash("sha256").update(body, "utf8").digest("base64"));
  }
  return hashes;
}

async function htmlFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".html")).map((entry) => join(entry.parentPath, entry.name));
}

/**
 * Adds the Content-Security-Policy to the `/*` rule that ends `_headers` in
 * the built client folder, with the hashes of every built page's inline
 * scripts. Fails the build rather than ship a policy that would break the app.
 */
export async function writeSecurityHeaders(clientDir: string, apiBaseUrl: string | undefined): Promise<string> {
  const file = join(clientDir, "_headers");
  const headers = await readFile(file, "utf8");
  const lines = headers.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
  if (lines.some((line) => /^content-security-policy\s*:/i.test(line))) {
    throw new Error(`${file} already has a Content-Security-Policy; the build writes it.`);
  }
  if (lines.filter((line) => line.startsWith("/")).at(-1) !== "/*") {
    throw new Error(`${file} must end with its /* rule, which the build adds the Content-Security-Policy to.`);
  }

  const hashes = new Set<string>();
  for (const page of await htmlFiles(clientDir)) {
    for (const hash of inlineScriptHashes(await readFile(page, "utf8"))) hashes.add(hash);
  }
  const policy = contentSecurityPolicy({ apiOrigin: apiOrigin(apiBaseUrl), scriptHashes: [...hashes].sort() });
  const line = `  Content-Security-Policy: ${policy}`;
  if (line.length > MAX_LINE) {
    throw new Error(`The Content-Security-Policy is ${line.length} characters; Cloudflare ignores a _headers line over ${MAX_LINE}.`);
  }
  await writeFile(file, `${headers.trimEnd()}\n${line}\n`);
  return policy;
}
