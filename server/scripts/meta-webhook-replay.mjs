#!/usr/bin/env node
/**
 * Replay a Meta webhook payload against a running API, signed the way Meta
 * signs it, so the whole intake → queue → handler path can be exercised
 * without Meta, a tunnel or a real number.
 *
 *   META_APP_SECRET=... node scripts/meta-webhook-replay.mjs test/fixtures/meta/wa-statuses.json \
 *     [--url http://localhost:5000] [--replace 102290129340398=<your WABA id> ...] [--fresh]
 *
 * The endpoint (whatsapp / messenger / instagram) follows the payload's
 * `object`. --replace swaps ids in the raw text before signing; --fresh
 * stamps a unique key into the body so a repeat run is not treated as Meta
 * redelivering the same bytes.
 */
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--') && !args[args.indexOf(a) - 1]?.match(/^--(url|replace|secret)$/));
if (!file) {
    console.error('usage: meta-webhook-replay.mjs <payload.json> [--url URL] [--replace FROM=TO]... [--fresh]');
    process.exit(2);
}
const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
};
const url = (flag('--url') ?? process.env.APP_URL ?? 'http://localhost:5000').replace(/\/$/, '');
const secret = flag('--secret') ?? process.env.META_APP_SECRET;
if (!secret) {
    console.error('META_APP_SECRET is not set (or pass --secret)');
    process.exit(2);
}

let text = readFileSync(file, 'utf8');
args.forEach((a, i) => {
    if (a !== '--replace') return;
    const [from, to] = String(args[i + 1]).split('=');
    text = text.split(from).join(to);
});
if (args.includes('--fresh')) {
    const body = JSON.parse(text);
    body.replay_nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    text = JSON.stringify(body);
}

const object = JSON.parse(text).object;
const endpoint = { whatsapp_business_account: 'whatsapp', page: 'messenger', instagram: 'instagram' }[object];
if (!endpoint) {
    console.error(`unknown object "${object}"`);
    process.exit(2);
}

const raw = Buffer.from(text);
const signature = 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex');
const res = await fetch(`${url}/api/v1/webhooks/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signature },
    body: raw,
});
console.log(`POST /api/v1/webhooks/${endpoint} ${file} -> ${res.status} ${await res.text()}`);
