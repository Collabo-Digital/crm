import { lookup } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

/**
 * Loopback, private, link-local (cloud metadata lives at 169.254.169.254),
 * carrier-grade NAT and multicast addresses. An automation's HTTP request
 * must not reach the server's own network.
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
    const v6 = address.toLowerCase();
    if (v6.startsWith('::ffff:')) return isPrivateAddress(v6.slice(7));
    return v6 === '::' || v6 === '::1' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80') || v6.startsWith('ff');
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
