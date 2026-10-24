# Collabo public API and webhooks

For other systems to send WhatsApp messages, add contacts, and hear about
messages, orders and payments as they happen. Everything belongs to one
organization: the one whose API key or webhook it is.

Owners and admins manage both under **Settings → Developers**.

## Authentication

Make a key under Settings → Developers, choosing what it may do. It is shown
once; Collabo keeps only its SHA-256.

```
Authorization: Bearer ck_live_…
```

(`X-Api-Key: ck_live_…` also works.) A key without the scope a route needs
gets `403`; a missing, wrong or revoked key gets `401`. Revoking a key stops
it at once and switches off the webhooks it made.

| Scope | Allows |
|---|---|
| `messages:send` | `POST /messages` |
| `contacts:read` | `GET /contacts` |
| `contacts:write` | `POST /contacts` |
| `templates:read` | `GET /templates` |
| `webhooks:manage` | `GET/POST/DELETE /webhooks` |

Base URL: `https://<your API host>/api/v1/public/v1`. Responses are JSON,
wrapped as `{ "success": true, "data": … }`; errors carry `message`.

## Rate limits

Each key may call each endpoint 600 times a minute. Past that the answer is
`429` with a `Retry-After` header (seconds); wait that long and send again,
with the same `Idempotency-Key` for `POST /messages`. Every answer carries
`X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset`
(seconds). Calls without a key are limited by address instead.

## Endpoints

### `GET /me`

The key's organization and scopes, for a connection test.

### `GET /templates`

Approved WhatsApp templates with the values each needs:

```json
[{ "name": "order_confirmation", "language": "en_US", "category": "utility",
   "values": [{ "key": "1", "kind": "text", "example": "Ananya" }, { "key": "2", "kind": "text", "example": "#1042" }],
   "preview": "Hi {{1}}, order {{2}} is confirmed." }]
```

### `POST /messages`

A template (any time) or a text (only within 24 hours of the person's last
message, WhatsApp's rule) to a WhatsApp number:

```json
{ "to": "+919876543210",
  "template": { "name": "order_confirmation", "values": { "1": "Ananya", "2": "#1042" } } }
```

```json
{ "to": "+919876543210", "text": "Your table is ready." }
```

- Value keys follow the template: `"1"`, `"2"` for positional templates,
  `"first_name"` for named ones, `"button.0"` for a link button's variable part.
- A template with an image, video or document header needs
  `"header_url": "https://…"`, a public file WhatsApp downloads.
- `channel_id` picks the WhatsApp number when the organization has several.
- Send an `Idempotency-Key` header to make a retry send once
  (the answer then says `"status": "duplicate"`).
- Answer: `201 { "message_id", "conversation_id", "contact_id", "status": "queued" }`.
  `422` when WhatsApp's rules refuse it, with `code`: `window_closed`,
  `opted_out` (a marketing template to someone who opted out), `contact_blocked`,
  `channel_unavailable`.

The message appears in the Collabo inbox as sent through the API.

### `POST /contacts`

Adds or updates a WhatsApp contact by number:

```json
{ "phone": "+919876543210", "name": "Ananya Rao", "tags": ["zapier-lead"],
  "attributes": { "plan": "gold" }, "opt_in": true, "opt_in_evidence": "Ticked the box on our Typeform" }
```

New tags start "A contact gets a tag" automations. `opt_in: true` records
their consent to marketing messages with your evidence; `false` records an
opt-out. Attribute names are lower-case letters, digits and `_`.

### `GET /contacts?phone=+919876543210`

The contacts with that number.

## Webhooks

Add an endpoint under Settings → Developers (or through the API, below) and
choose its events. Collabo `POST`s JSON to it:

```json
{ "id": "<delivery id>", "event": "order.paid", "created_at": "2026-10-24T09:30:00.000Z",
  "data": { "order": { "id": "…", "name": "#1042", "financial_status": "paid", "total": "1199",
            "currency": "INR", "customer": { "name": "Ananya Rao", "phone": "+919876543210" }, "items": [ … ] } } }
```

| Event | `data` |
|---|---|
| `message.received` | `message { id, conversation_id, kind, text, received_at }`, `contact` |
| `contact.tag_added` | `tag`, `contact` |
| `order.created`, `order.paid`, `order.fulfilled`, `order.delivered`, `order.cancelled` | `order` |
| `payment.received` | `payment { id, provider, amount, currency, method, order_id, paid_at }` |
| `website.signup` | `name`, `page`, `contact` (from the website pop-up, with consent) |
| `ad.referral` | `ad { id, headline, body, url }`, `contact` (a chat from a click-to-message ad) |
| `ping` | a test from Settings → Developers |

`contact` is `{ id, platform, name, phone, username, tags, customer_id, opted_in }`.

### Verifying a delivery

Headers: `Collabo-Event`, `Collabo-Delivery` (the delivery id, the same in
every retry), and

```
Collabo-Signature: t=1761298200,v1=5257a869e7ec…
```

`v1` is the hex HMAC-SHA256 of `"<t>.<raw body>"` with the endpoint's signing
secret (`whsec_…`, shown once). Recompute it over the raw body before parsing,
compare in constant time, and reject a `t` more than five minutes old:

```js
const [t, v1] = header.split(',');
const ts = t.slice(2);
const expected = 'v1=' + crypto.createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');
const ok = crypto.timingSafeEqual(Buffer.from(v1), Buffer.from(expected)) && Math.abs(Date.now() / 1000 - ts) < 300;
```

### Delivery

- Answer with any `2xx` within 10 seconds. Anything else is retried: after
  30 seconds, then 1, 2, 4, 8, 16, 32 and 64 minutes.
- Each event reaches an endpoint once; use `Collabo-Delivery` to ignore a
  retry you already handled.
- After 20 failed deliveries in a row the endpoint is switched off with the
  reason; switch it back on in Settings → Developers once it is fixed.
- URLs must be `https://` and public: private and internal addresses are
  refused, also after DNS.

### Subscribing through the API (REST hooks, for Zapier)

With `webhooks:manage`:

- `POST /webhooks { "url", "events": [...] }` → `{ "id", "secret", … }`
  (subscribe when a zap is turned on);
- `DELETE /webhooks/:id` (unsubscribe when it is turned off);
- `GET /webhooks` lists the subscriptions this key made;
- `GET /webhooks/events` lists the event names.

A key can remove only its own subscriptions, not webhooks made in Settings.

## Building the Zapier app

Zapier integrations are made in the Zapier Developer Platform under your own
Zapier account:

- **Authentication:** API key, sent as `Authorization: Bearer {{api_key}}`;
  test with `GET /me`.
- **Triggers:** REST hooks: subscribe with `POST /webhooks`, unsubscribe with
  `DELETE /webhooks/{{id}}`, one trigger per event (New message, New paid
  order, Payment received, Website sign-up …).
- **Actions:** Send WhatsApp template (`POST /messages`, with the template
  list from `GET /templates` as a dynamic dropdown), Add or update contact
  (`POST /contacts`).
