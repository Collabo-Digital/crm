import { lookup } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

/** The eight 16-bit groups of an IPv6 address, or null when it is not one. */
function ipv6Groups(address: string): number[] | null {
    let a = address.toLowerCase().replace(/%.*$/, '');
    if (!net.isIPv6(a)) return null;
    const tail: number[] = [];
    const quad = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(a);
    if (quad) {
        const [b0, b1, b2, b3] = quad.slice(1).map(Number);
        tail.push((b0 << 8) | b1, (b2 << 8) | b3);
        a = a.slice(0, quad.index);
        if (!a.endsWith('::')) a = a.slice(0, -1);
    }
    const groups = (s: string) => (s ? s.split(':').map((h) => parseInt(h, 16)) : []);
    const [head, rest] = a.split('::');
    if (rest === undefined) return [...groups(head), ...tail];
    const left = groups(head);
    const right = [...groups(rest), ...tail];
    return [...left, ...new Array<number>(8 - left.length - right.length).fill(0), ...right];
}

const ipv4Of = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

/**
 * Loopback, private, link-local (cloud metadata lives at 169.254.169.254),
 * carrier-grade NAT and multicast addresses. An automation's HTTP request
 * must not reach the server's own network.
 *
 * IPv6 is compared by value, never by spelling: the URL parser writes
 * [::ffff:127.0.0.1] as ::ffff:7f00:1, and an address that carries an IPv4
 * address (mapped, compatible, translated, NAT64, 6to4) is judged by it.
 * Anything that is not an IP address counts as private.
 */
export function isPrivateAddress(address: string): boolean {
    if (net.isIPv4(address)) {
        const [a, b] = address.split('.').map(Number);
        return (
            a === 0 || a === 10 || a === 127 || a >= 224 ||
            (a === 169 && b === 254) ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 168) ||
            (a === 100 && b >= 64 && b <= 127) ||
            (a === 198 && (b === 18 || b === 19))
        );
    }
    const g = ipv6Groups(address);
    if (!g) return true;
    const zeros = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
    const carriesIpv4 =
        (zeros(0, 5) && (g[5] === 0 || g[5] === 0xffff)) || // ::a.b.c.d and ::ffff:a.b.c.d
        (zeros(0, 4) && g[4] === 0xffff && g[5] === 0) || // ::ffff:0:a.b.c.d
        (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)); // 64:ff9b::a.b.c.d
    if (carriesIpv4) return isPrivateAddress(ipv4Of(g[6], g[7]));
    if (g[0] === 0x2002) return isPrivateAddress(ipv4Of(g[1], g[2])); // 6to4
    return (
        (g[0] & 0xff00) === 0 || // ::/8, reserved
        (g[0] === 0x100 && zeros(1, 4)) || // 100::/64, discard
        (g[0] === 0x2001 && g[1] < 0x200) || // 2001::/23, protocol assignments incl. Teredo
        (g[0] === 0x2001 && g[1] === 0xdb8) || // documentation
        (g[0] & 0xfe00) === 0xfc00 || // unique local
        (g[0] & 0xffc0) === 0xfe80 || // link-local
        (g[0] & 0xffc0) === 0xfec0 || // site-local
        (g[0] & 0xff00) === 0xff00 // multicast
    );
}

export class HttpRequestError extends Error { }

export interface GuardedResponse {
    status: number;
    body: unknown;
}

/**
 * One request from an automation. The address is checked after DNS
 * resolution, on the connection itself, so a hostname cannot resolve to an
 * internal address between a check and the connect. Redirects are not
 * followed; the response is capped in size and time.
 */
export function guardedRequest(opts: {
    method: 'GET' | 'POST';
    url: string;
    body?: string;
    allowPrivate: boolean;
    timeoutMs?: number;
    maxBytes?: number;
}): Promise<GuardedResponse> {
    const timeoutMs = opts.timeoutMs ?? 10_000;
    const maxBytes = opts.maxBytes ?? 256 * 1024;
    let url: URL;
    try {
        url = new URL(opts.url);
    } catch {
        return Promise.reject(new HttpRequestError('The URL is not valid.'));
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return Promise.reject(new HttpRequestError('Only http and https URLs can be called.'));
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) && !opts.allowPrivate && isPrivateAddress(host)) {
        return Promise.reject(new HttpRequestError('Requests to private or internal addresses are not allowed.'));
    }

    const guardedLookup: typeof lookup = ((hostname: string, options: object, callback: (...args: unknown[]) => void) => {
        lookup(hostname, { ...options, all: true }, (err, addresses) => {
            if (err) return callback(err);
            const list = addresses as Array<{ address: string; family: number }>;
            const bad = !opts.allowPrivate && list.find((a) => isPrivateAddress(a.address));
            if (bad) return callback(new HttpRequestError('Requests to private or internal addresses are not allowed.'));
            if ((options as { all?: boolean }).all) return callback(null, list);
            callback(null, list[0].address, list[0].family);
        });
    }) as typeof lookup;

    return new Promise((resolve, reject) => {
        const client = url.protocol === 'https:' ? https : http;
        const req = client.request(
            url,
            {
                method: opts.method,
                lookup: guardedLookup,
                timeout: timeoutMs,
                headers: {
                    'user-agent': 'CollaboAutomations/1.0',
                    accept: 'application/json',
                    ...(opts.body !== undefined ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(opts.body) } : {}),
                },
            },
            (res) => {
                const chunks: Buffer[] = [];
                let size = 0;
                res.on('data', (chunk: Buffer) => {
                    size += chunk.length;
                    if (size > maxBytes) {
                        req.destroy(new HttpRequestError(`The response is larger than ${Math.round(maxBytes / 1024)} KB.`));
                        return;
                    }
                    chunks.push(chunk);
                });
                res.on('end', () => {
                    const raw = Buffer.concat(chunks).toString('utf8');
                    let body: unknown = raw;
                    try {
                        body = raw ? JSON.parse(raw) : null;
                    } catch {
                        // Not JSON: kept as text, and nothing is saved from it.
                    }
                    resolve({ status: res.statusCode ?? 0, body });
                });
                res.on('error', reject);
            },
        );
        req.on('timeout', () => req.destroy(new HttpRequestError(`No response within ${timeoutMs / 1000} seconds.`)));
        req.on('error', (err) => reject(err instanceof HttpRequestError ? err : new HttpRequestError(err.message)));
        if (opts.body !== undefined) req.write(opts.body);
        req.end();
    });
}
