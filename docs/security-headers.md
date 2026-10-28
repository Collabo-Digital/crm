# Web app security headers

The web app keeps its sign-in tokens in browser storage, so the browser must
refuse any script the app did not ship. These headers are sent with every page
and file of the app.

## Where they come from

- `client/public/_headers` holds the fixed headers: `X-Content-Type-Options:
  nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy:
  strict-origin-when-cross-origin`, `Permissions-Policy: camera=(self),
  microphone=(self), geolocation=()` (the till's barcode camera, voice notes and
  WhatsApp calls) and `Strict-Transport-Security: max-age=31536000`.
- After each build, `client/security-headers.ts` (run from
  `react-router.config.ts`) adds the `Content-Security-Policy` line to
  `client/build/client/_headers`. It has to be written per build: it names the
  API's origin from `VITE_API_BASE_URL` and the SHA-256 hashes of the inline
  scripts in `index.html` (the theme script in `root.tsx` and React Router's
  start-up scripts, which change with every build). The build fails rather
  than write a policy Cloudflare would ignore (a line over 2,000 characters).
- Cloudflare (Workers static assets, `client/wrangler.jsonc`) sends the `/*`
  rule of that file. When the API hosts the app itself (`SERVE_STATIC=true`:
  the root Dockerfile and compose, Render, Railway), it reads the same file and
  sends the same headers with the app's pages and files
  (`server/src/common/utils/spa-headers.util.ts`); API routes and `/uploads`
  do not get them.

## The policy

| Directive | Allows | Why |
|---|---|---|
| `script-src` | `'self'`, the inline-script hashes, `connect.facebook.net`, `apis.google.com`, `checkout.razorpay.com`, `cdn.razorpay.com` | the app's bundles; Meta's SDK (WhatsApp, Messenger, Ads connect), the Sheets picker, plan checkout and the fraud check it adds. No `'unsafe-inline'`, no `'unsafe-eval'` |
| `connect-src` | `'self'`, the API origin, `connect.facebook.net`, `www`/`web.facebook.com`, `api.razorpay.com`, Razorpay's `lumberjack*` hosts | API calls and the inbox stream; Meta's and Razorpay's own calls |
| `frame-src` | `www`/`web.facebook.com`, `docs.google.com`, `api.razorpay.com`, `maps.google.com`, `www.google.com` | Meta's login frames, the Sheets picker, Razorpay's payment window, the map on a customer |
| `img-src`, `media-src` | `'self'`, `data:`, `blob:`, any `https:` origin, the API origin | avatars, product pictures and chat media from Meta, Shopify and storage CDNs |
| `style-src` | `'self' 'unsafe-inline'` | components, toasts and the third-party windows set inline styles |
| `font-src` | `'self' data:` | fonts are bundled |
| `worker-src` | `'self'` | pdf.js's worker |
| `object-src 'none'`, `base-uri 'self'`, `form-action 'self' api.razorpay.com`, `frame-ancestors 'none'` | | no plugins, no `<base>` hijack, forms post only here or to Razorpay, no framing (clickjacking) |

Zod is switched to `jitless` (`client/app/lib/zod-jitless.ts`): its check for
`eval` is otherwise reported as a violation. A new third-party script, frame or
API host must be added to `security-headers.ts`, or the browser blocks it.

## How to check it

After a build:

```sh
cd client && VITE_API_BASE_URL=https://<api-host>/api/v1 npm run build
grep Content-Security-Policy build/client/_headers   # one line, with sha256 hashes
```

`npm run dev` and `vite preview` do not send `_headers`. To try the policy
locally, serve `build/client` with a small server that applies the `/*` rule
and falls back to `index.html`, then open the pages with DevTools open.

After a deploy:

1. `curl -sI https://<app-host>/orders | grep -i -e content-security-policy -e x-frame-options`
   shows both headers on a deep link.
2. In the browser console, sign-in, the dashboard, inbox, orders, settings and
   a `/b/…` bill link show no "violates the following Content Security Policy
   directive" errors. Also try connecting WhatsApp or Messenger, the Ads page,
   choosing a sheet in Sheets automations, and plan checkout.
3. If Cloudflare injects scripts into the app's host (Web Analytics automatic
   setup, Rocket Loader, Email Address Obfuscation), turn that off for the host
   or add its hosts to the policy; otherwise the browser blocks it.

If something breaks in production, switch to report-only while fixing it:
write `Content-Security-Policy-Report-Only` instead of
`Content-Security-Policy` in `security-headers.ts` and redeploy.
