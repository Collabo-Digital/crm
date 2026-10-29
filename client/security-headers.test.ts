import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { apiOrigin, contentSecurityPolicy, inlineScriptHashes, writeSecurityHeaders } from "./security-headers.ts";

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("base64");

function directive(policy: string, name: string): string[] {
  const found = policy.split("; ").find((part) => part.startsWith(`${name} `));
  assert.ok(found, `${name} is missing`);
  return found.split(" ").slice(1);
}

describe("apiOrigin", () => {
  it("is null for a path on the app's own origin", () => {
    assert.equal(apiOrigin(undefined), null);
    assert.equal(apiOrigin(""), null);
    assert.equal(apiOrigin("/api/v1"), null);
  });

  it("is the origin of an API on another host", () => {
    assert.equal(apiOrigin("https://api.collabo.store/api/v1"), "https://api.collabo.store");
    assert.equal(apiOrigin("http://localhost:5055/api/v1"), "http://localhost:5055");
    assert.equal(apiOrigin("//api.collabo.store/api/v1"), "https://api.collabo.store");
  });
});

describe("inlineScriptHashes", () => {
  it("hashes the exact text of each inline script and skips loaded ones", () => {
    const html = `<head><script>a()</script><script type="module" async="">import "/x.js";\n</script></head>`
      + `<body><script src="/assets/app.js"></script><SCRIPT>b()</SCRIPT></body>`;
    assert.deepEqual(inlineScriptHashes(html), [sha256("a()"), sha256('import "/x.js";\n'), sha256("b()")]);
  });
});

describe("contentSecurityPolicy", () => {
  const policy = contentSecurityPolicy({ apiOrigin: "https://api.collabo.store", scriptHashes: ["abc="] });

  it("runs only the app's own scripts, the hashed inline ones and the third-party SDKs", () => {
    assert.deepEqual(directive(policy, "script-src"), [
      "'self'",
      "'sha256-abc='",
      "https://connect.facebook.net",
      "https://apis.google.com",
      "https://checkout.razorpay.com",
      "https://cdn.razorpay.com",
    ]);
    assert.doesNotMatch(policy, /unsafe-eval/);
  });

  it("lets the app call its API and refuses framing and plugins", () => {
    assert.ok(directive(policy, "connect-src").includes("https://api.collabo.store"));
    assert.deepEqual(directive(policy, "frame-ancestors"), ["'none'"]);
    assert.deepEqual(directive(policy, "object-src"), ["'none'"]);
  });

  it("needs no API origin when the API is the app's own", () => {
    const sameOrigin = contentSecurityPolicy({ apiOrigin: null, scriptHashes: [] });
    assert.deepEqual(directive(sameOrigin, "connect-src").slice(0, 2), ["'self'", "https://connect.facebook.net"]);
  });
});

describe("writeSecurityHeaders", () => {
  async function built(headers: string) {
    const dir = await mkdtemp(join(tmpdir(), "security-headers-"));
    await mkdir(join(dir, "nested"));
    await writeFile(join(dir, "_headers"), headers);
    await writeFile(join(dir, "index.html"), "<script>theme()</script><script>boot()</script>");
    await writeFile(join(dir, "nested", "index.html"), "<script>theme()</script><script>other()</script>");
    return dir;
  }

  it("adds the policy, with every page's inline scripts, to the /* rule", async () => {
    const dir = await built("# comment\n/*\n  X-Content-Type-Options: nosniff\n");
    try {
      await writeSecurityHeaders(dir, "https://api.collabo.store/api/v1");
      const lines = (await readFile(join(dir, "_headers"), "utf8")).trimEnd().split("\n");
      assert.equal(lines[2], "  X-Content-Type-Options: nosniff");
      assert.match(lines[3], /^ {2}Content-Security-Policy: default-src 'self'; /);
      const scripts = directive(lines[3].replace("  Content-Security-Policy: ", ""), "script-src");
      for (const body of ["theme()", "boot()", "other()"]) assert.ok(scripts.includes(`'sha256-${sha256(body)}'`), body);
      assert.equal(scripts.filter((source) => source.startsWith("'sha256-")).length, 3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses a _headers file that already sets a policy, or does not end with /*", async () => {
    for (const headers of ["/*\n  Content-Security-Policy: default-src *\n", "/*\n  A: b\n/assets/*\n  C: d\n"]) {
      const dir = await built(headers);
      try {
        await assert.rejects(writeSecurityHeaders(dir, undefined));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });
});
