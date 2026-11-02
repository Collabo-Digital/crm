import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Every path the web app calls must exist on the API with the same method.
 * The GST return's payment fees once called /inward-supplies while the API
 * served /payment-fees, so every list, save and delete there was a 404.
 *
 * Read from the sources: the client's `apiClient.<method>("<path>")` and
 * `apiUrl("<path>")` calls, and the server's @Controller / @Get… decorators.
 */
const CLIENT_APP = fileURLToPath(new URL("..", import.meta.url));
const SERVER_SRC = fileURLToPath(new URL("../../../server/src", import.meta.url));

function walk(dir: string, keep: (file: string) => boolean): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : walk(path, keep);
    return keep(path) ? [path] : [];
  });
}

const segments = (path: string) => path.split("/").filter(Boolean);

interface ServerRoute {
  method: string;
  segments: string[];
}

function serverRoutes(): ServerRoute[] {
  const routes: ServerRoute[] = [];
  const files = walk(SERVER_SRC, (f) => f.endsWith(".controller.ts"));
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    // One file can hold several controllers: each one's routes follow it.
    const parts = source.split(/@Controller\(/).slice(1);
    for (const part of parts) {
      const base = /^\s*(?:\{[^}]*?path:\s*)?(['"`])([^'"`]*)\1/.exec(part)?.[2] ?? "";
      for (const m of part.matchAll(/@(Get|Post|Put|Patch|Delete|All)\(\s*(?:(['"`])([^'"`]*)\2)?\s*\)/g)) {
        routes.push({ method: m[1].toUpperCase(), segments: segments(`${base}/${m[3] ?? ""}`) });
      }
    }
  }
  return routes;
}

/** Reads the string or template literal that starts at `from`; spans become `${}`. */
function readLiteral(source: string, from: number): string | null {
  const quote = source[from];
  if (quote !== '"' && quote !== "'" && quote !== "`") return null;
  let out = "";
  for (let i = from + 1; i < source.length; i++) {
    const ch = source[i];
    if (ch === "\\") {
      out += source[++i];
    } else if (ch === quote) {
      return out;
    } else if (quote === "`" && ch === "$" && source[i + 1] === "{") {
      let depth = 1;
      i += 2;
      while (depth > 0 && i < source.length) {
        if (source[i] === "{") depth++;
        else if (source[i] === "}") depth--;
        if (depth > 0) i++;
      }
      out += "${}";
    } else {
      out += ch;
    }
  }
  return null;
}

interface ClientCall {
  where: string;
  method: string;
  path: string;
}

function clientCalls(): ClientCall[] {
  const calls: ClientCall[] = [];
  const files = walk(CLIENT_APP, (f) => /\.tsx?$/.test(f) && !f.endsWith(".test.ts"));
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const call = /\bapiClient\s*\.\s*(get|post|put|patch|delete)\b|\bapiUrl\b/g;
    for (const m of source.matchAll(call)) {
      let i = m.index + m[0].length;
      while (/\s/.test(source[i])) i++;
      if (source[i] === "<") {
        // The response type: apiClient.get<Paginated<Order>>(…)
        let depth = 0;
        for (; i < source.length; i++) {
          if (source[i] === "<") depth++;
          else if (source[i] === ">" && --depth === 0) break;
        }
        i++;
      }
      while (/\s/.test(source[i])) i++;
      if (source[i] !== "(") continue;
      i++;
      while (/\s/.test(source[i])) i++;
      const literal = readLiteral(source, i);
      // A path held in a variable (a link the API handed out) can't be checked here.
      if (literal === null || !literal.startsWith("/")) continue;
      const line = source.slice(0, m.index).split("\n").length;
      calls.push({
        where: `${relative(CLIENT_APP, file)}:${line}`,
        method: m[1] ? m[1].toUpperCase() : "GET",
        // A query string built into the path is not part of the route.
        path: literal.split("?")[0],
      });
    }
  }
  return calls;
}

function matches(call: ClientCall, route: ServerRoute): boolean {
  if (route.method !== call.method && route.method !== "ALL") return false;
  const wanted = segments(call.path);
  if (wanted.length !== route.segments.length) return false;
  return wanted.every((segment, i) => {
    const served = route.segments[i];
    if (served.startsWith(":")) return true;
    const pattern = segment
      .split("${}")
      .map((part) => part.replace(/[.*+?^$()|[\]\\]/g, "\\$&"))
      .join("[^/]+");
    return new RegExp(`^${pattern}$`).test(served);
  });
}

describe("client API calls", () => {
  const routes = serverRoutes();
  const calls = clientCalls();

  it("finds the server routes and the client calls", () => {
    assert.ok(routes.length > 300, `only ${routes.length} server routes found`);
    assert.ok(calls.length > 300, `only ${calls.length} client calls found`);
  });

  it("only calls routes the API serves, with the same method", () => {
    const missing = calls
      .filter((call) => !routes.some((route) => matches(call, route)))
      .map((call) => `${call.method} ${call.path} (${call.where})`);
    assert.deepEqual(missing, []);
  });
});
