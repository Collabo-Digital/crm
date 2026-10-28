import { z } from "zod";

// Zod builds object parsers with `new Function`, after checking whether eval
// is allowed. The app's Content-Security-Policy forbids eval, and the check
// alone is reported as a CSP violation, so it is turned off before any schema
// is built: root.tsx imports this first.
z.config({ jitless: true });
