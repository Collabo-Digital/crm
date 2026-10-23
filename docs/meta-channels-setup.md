# Meta channels setup (Instagram + WhatsApp)

Both channels are served by **one Meta app**. This is the setup needed before
Settings → Channels can connect either of them.

Mirrors `docs/shopify-app-setup.md` in shape: dashboard → server environment →
connect flows → webhooks → local testing.

---

## 1. Meta app

Create an app at <https://developers.facebook.com/apps> of type **Business**.

Add these products:

| Product | Used by |
|---|---|
| Facebook Login for Business | WhatsApp Embedded Signup |
| Instagram — **API setup with Instagram login** | Instagram connect, messaging and comments |
| WhatsApp | WhatsApp Business messaging |

Copy the **App ID** and **App Secret** from Settings → Basic (`META_APP_*`).

### Instagram Login

Instagram connects with **Instagram Login** (Instagram API with Instagram Login,
`graph.instagram.com`), not Facebook Login. No Facebook Page is needed, and the
account subscribes itself to webhooks — the Facebook Login flow could not,
because `POST /{page-id}/subscribed_apps` needs `pages_manage_metadata` from the
Messenger use case.

Instagram → **API setup with Instagram login**:

1. Copy the **Instagram app ID** and **Instagram app secret** into
   `INSTAGRAM_APP_ID` / `INSTAGRAM_APP_SECRET`. They are a different pair from
   `META_APP_ID` / `META_APP_SECRET`, even on the same app.
2. *Set up Instagram business login* → Business login settings →
   **OAuth redirect URIs**:

   ```
   {APP_URL}/api/v1/channels/instagram/callback
   ```

   `APP_URL` is the public URL of this API, not the frontend. Instagram rejects
   the authorization if the redirect URI does not match exactly.
3. While the app is in Development mode, add the account under App roles →
   Roles → **Instagram Testers**, then accept the invite in the Instagram app
   (Settings → Apps and websites → Tester invites). The account must be a
   Business or Creator account.

Rows connected with the old Facebook Login flow keep working for display and
disconnect (their credentials still carry `pageId`); reconnecting one moves it to
Instagram Login.

### WhatsApp Embedded Signup configuration

Facebook Login for Business → **Configurations** → create one from the
"WhatsApp Embedded Signup" template, with the products **Cloud API** and
**WhatsApp Business app onboarding** selected. Copy its **Configuration ID**
into `WHATSAPP_CONFIG_ID`.

### Messenger configuration

A second Facebook Login for Business configuration, token type **System-user
access token**, assets **Pages** and **Instagram accounts**, permissions
`pages_show_list`, `pages_manage_metadata`, `pages_messaging`,
`pages_read_engagement`, `pages_manage_engagement`, `business_management`,
`instagram_basic`, `instagram_manage_messages`, `instagram_manage_comments`.
Copy its **Configuration ID** into `MESSENGER_CONFIG_ID`.

Without it, `POST /api/v1/channels/whatsapp/install` returns 400 and the
WhatsApp dialog cannot open the popup.

### Scopes

Instagram requests these on the authorization URL:

```
instagram_business_basic, instagram_business_manage_messages,
instagram_business_manage_comments
```

The connect is refused if the merchant unticks `instagram_business_basic` or
`instagram_business_manage_messages` on Instagram's consent screen
(`reason=scopes_declined`), and for a personal account
(`reason=not_professional_account`).

On connect the server subscribes the account with
`POST graph.instagram.com/{version}/me/subscribed_apps` to `messages,
messaging_postbacks, messaging_seen, message_reactions, comments`, retrying
without `comments` (which needs Advanced Access) if that fails. The outcome is
stored in `channels.metadata.webhookSubscription` (`ok`, `fields`, `error`) —
check it there rather than assuming a connected account receives events.

Tokens are long-lived (60 days) and are refreshed by `InstagramTokenScheduler`
once a day when they are within 10 days of expiry and at least 24 hours old. An
expired token cannot be refreshed; the account has to be reconnected.

WhatsApp's are granted by the Embedded Signup configuration itself
(`whatsapp_business_management`, `whatsapp_business_messaging`).

While the app is in Development mode only users added under App Roles (admins,
developers, testers) can complete either flow. Live mode needs App Review for
the scopes above.

---

## 2. Environment

Server (`server/.env`):

```
META_APP_ID=
META_APP_SECRET=
INSTAGRAM_APP_ID=                   # "Instagram app ID" from API setup with Instagram login
INSTAGRAM_APP_SECRET=               # "Instagram app secret" from the same page
INSTAGRAM_WEBHOOK_VERIFY_TOKEN=     # any string you choose; echoed back to Meta
WHATSAPP_WEBHOOK_VERIFY_TOKEN=
WHATSAPP_CONFIG_ID=
MESSENGER_WEBHOOK_VERIFY_TOKEN=
MESSENGER_CONFIG_ID=
WHATSAPP_GRAPH_VERSION=v25.0        # optional; used by every Meta surface
APP_URL=                            # public URL of THIS API
FRONTEND_URL=                       # where OAuth sends the merchant back
ENCRYPTION_KEY=                     # exactly 32 chars; encrypts stored tokens
AUTOMATION_HTTP_ALLOW_PRIVATE=      # leave unset in production; "true" lets an
                                    # automation's "Call a URL" step reach
                                    # localhost and private networks (local tests)
```

Client (`client/.env`):

```
VITE_META_APP_ID=                   # same app as META_APP_ID
```

`VITE_*` variables are baked in at **build** time. Setting `VITE_META_APP_ID`
only on the runtime host leaves the WhatsApp popup unable to start.

`ENCRYPTION_KEY` is not optional in practice: access tokens are stored
AES-encrypted in `Channel.credentials`, and without the key nothing can be
connected.

---

## 3. Connect flows

The two channels differ in shape, which is why the code paths are separate.

**Instagram — browser redirect.**

1. `POST /api/v1/channels/instagram/install` returns an `instagram.com/oauth/authorize`
   URL (with `force_reauth=true`, so a second account can be signed into).
2. The merchant signs in to Instagram and allows access; Instagram redirects to
   `{APP_URL}/api/v1/channels/instagram/callback`.
3. The server exchanges the code (`api.instagram.com/oauth/access_token`), swaps
   it for a long-lived token, and reads `/me` for `user_id`, username and
   account type. `user_id` — the professional account id webhooks carry as
   `entry.id` — becomes `channels.external_store_id`.
4. One sign-in grants one account:
   - new account → connected, redirect to `?connected=instagram`
   - account already connected here by the same member → tokens refreshed,
     redirect to `?connected=instagram&note=refreshed`
   - held by someone else → 409, redirect to `?error=instagram_connect_failed&reason=...`

The `?select=instagram&pending=<id>` picker routes remain only so an old link
fails cleanly; Instagram Login never parks a selection.

**WhatsApp — Embedded Signup popup.**

1. `POST /api/v1/channels/whatsapp/install` returns `{ configId, state }`.
2. The client opens `FB.login` with that config; the merchant picks or creates a
   WhatsApp Business Account and phone number inside Meta's UI.
3. The popup returns a code; the client posts it to
   `POST /api/v1/channels/whatsapp/callback`, which exchanges it and stores the
   channel.

Because the popup returns to the page rather than navigating, WhatsApp has no
browser callback route and needs no redirect URI.

### WhatsApp: existing Business app number (coexistence) or a new number

The dialog runs Embedded Signup **v5**, where onboarding the business's
WhatsApp Business app number is the default; "A new number for Collabo only"
passes the opt-out (`features: [{ name: "whatsapp_business_app_onboarding",
enabled: false }]`). On `FINISH` the popup posts `phone_number_id`,
`messaging_account_ids` and `is_on_biz_app`, which the client forwards with
the code (the code expires after 30 seconds).

The server then:

1. exchanges the code for a business integration system user token (no
   expiry, so no long-lived exchange);
2. reads the number, writes the channel row;
3. subscribes the app to the account's webhooks;
4. for a new number, registers it (`POST /{phone_number_id}/register`) with a
   six-digit PIN it keeps encrypted; a Business app number is never registered;
5. for a Business app number, queues `coexistence-sync` on
   `whatsapp-onboarding`, which calls `POST /{phone_number_id}/smb_app_data`
   with `smb_app_state_sync` (contacts) and then `history`. Each may run once,
   within 24 hours of onboarding; the job retries for about four hours and
   records failures on the channel.

A failure in steps 3 or 4 leaves a connected channel with an error and a
**Retry setup** action (`POST /channels/:id/whatsapp/retry-setup`). Number
health is re-read daily and on demand (`POST /channels/:id/whatsapp/refresh-health`).

Coexistence numbers send at most 20 messages per second, cannot use groups,
calls, broadcast lists or catalogs through the API, and are disconnected by
Meta if the phone app is not opened for about 14 days (`account_update` →
`PARTNER_REMOVED` / `PRIMARY_INACTIVITY`, shown on the channel).

### Messenger and Page-linked Instagram

`POST /channels/messenger/install` returns `MESSENGER_CONFIG_ID` and a state
for a Facebook Login for Business popup; `POST /channels/messenger/callback`
connects every Page the business shared (a `FACEBOOK` channel each) and the
Instagram professional account linked to each Page (an `INSTAGRAM` channel with
`authFlow: "facebook_login"`). Page tokens derived this way do not expire.

Meta allows an app to use Facebook Login **or** Instagram Login for Instagram,
not both. The Instagram Login flow above is kept for influencer accounts that
have no Page; check which Instagram setup the app actually has in the dashboard.

### Connection limits

Enforced in `channel-connection.util.ts` and again by partial unique indexes
(migration `20260910090000_channel_connected_accounts`):

- **WhatsApp** — one *active* account per organization. A disconnected row stays
  as history and does not occupy the slot.
- **Instagram** — unlimited accounts per organization, but any one Instagram
  account may be connected only once anywhere, enforced by the account id in
  `channels.external_store_id`.

---

## 4. Webhooks

Three callbacks, one per product. Each is verified with its own token and every
delivery is signed with `META_APP_SECRET` (Instagram Login accounts are signed
with `INSTAGRAM_APP_SECRET`, which is also accepted on the Instagram endpoint).

| Product (dashboard) | Callback URL | Verify token | Fields |
|---|---|---|---|
| WhatsApp → Configuration | `{APP_URL}/api/v1/webhooks/whatsapp` | `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | messages, smb_message_echoes, history, smb_app_state_sync, account_update, message_template_status_update, message_template_quality_update, template_category_update, message_template_components_update, phone_number_quality_update, phone_number_name_update, business_capability_update, user_preferences |
| Messenger → Settings | `{APP_URL}/api/v1/webhooks/messenger` | `MESSENGER_WEBHOOK_VERIFY_TOKEN` | messages, message_echoes, message_deliveries, message_reads, message_reactions, message_edits, messaging_postbacks, messaging_referrals, messaging_handovers, standby, feed |
| Instagram | `{APP_URL}/api/v1/webhooks/instagram` | `INSTAGRAM_WEBHOOK_VERIFY_TOKEN` | messages, messaging_postbacks, messaging_seen, message_reactions, message_edit, messaging_referral, messaging_handover, standby, comments, mentions |

Per-account subscription happens at connect time and is undone at disconnect:

- **WhatsApp:** `POST /{waba_id}/subscribed_apps` with the business token.
  Before this branch nothing subscribed the account, so no WhatsApp webhook
  ever arrived.
- **Pages:** `POST /{page_id}/subscribed_apps?subscribed_fields=...` with the
  Page token. One Page subscription carries both Messenger and the Instagram
  account linked to the Page, so it is only removed when neither is connected.

### What happens to a delivery

1. The endpoint checks `X-Hub-Signature-256` against the raw body, stores the
   body in `meta_webhook_deliveries` (unique on its sha256, so Meta's
   byte-identical redeliveries are no-ops), queues it on `meta-inbound`, and
   answers 200. A bad signature is answered 200 with `received: false` and
   not stored.
2. The `meta-inbound` worker parses it (`whatsapp-webhook.parser.ts`,
   `messenger-webhook.parser.ts`), routes it by account id to the channel, and
   applies it. Errors are written to the row and the job retries.
3. `MetaWebhookMaintenance` re-queues rows whose job was lost and prunes rows
   after 14 days.

### Templates and broadcasts

- **Templates** live on the WhatsApp Business Account. Collabo reads them
  with `GET /{waba_id}/message_templates` (every six hours, from the
  Templates page, and whenever a webhook names one it has not seen), creates
  them with `POST /{waba_id}/message_templates`, edits with
  `POST /{template_id}` and deletes with `DELETE /{waba_id}/message_templates`
  — all with the business token. Status, quality and category changes arrive
  on the template webhook fields above; they always go to the app-level
  callback, never to a per-account override.
- **Media header samples** go through the Resumable Upload API on the app
  (`POST /{META_APP_ID}/uploads`, then the bytes with `Authorization: OAuth`).
  Meta documents that call with a user access token; that it accepts the
  business system-user token is **not yet verified** — check it with the
  first live image template.
- **Marketing Messages API.** Meta is moving marketing templates off the Cloud
  API (new accounts from Apr 13, 2027; everyone from Oct 13, 2027). Once an
  account accepts the API's terms in WhatsApp Manager — Collabo reads
  `marketing_messages_onboarding_status` during template sync, listens for
  `account_update` `MM_LITE_TERMS_SIGNED`, and also switches on a `131063`
  refusal — marketing templates are sent to
  `POST /{phone_number_id}/marketing_messages` with
  `product_policy: CLOUD_API_FALLBACK`. Utility templates and everything else
  stay on `/messages`.
- **Broadcast pace:** 10 messages a second on a coexistence number (fixed at
  20 by Meta), 40 otherwise (numbers start at 80), leaving room for the inbox.
- **Cost estimates** use the per-message rates each business copies from its
  own Meta rate card (Campaigns → Message rates). Collabo ships no prices.

### Automations and inbox rules

- **How work flows.** Every live inbound message, comment, story mention and
  button tap is stored as an automation event in the same transaction as the
  message, then queued on the `automation` BullMQ queue (Redis). A sweeper runs
  every minute for anything a failed enqueue lost, waits whose wake-up never
  fired, and runs whose worker died. Tags added in the inbox (one contact or
  in bulk) or by automations raise `tag_added` events the same way (an
  automation-added tag can start at most three further hops); contact imports
  do not.
- **Order of work for one event:** a contact waiting at a “Wait for a reply”
  step gets the message as their reply (comments never count as replies). One
  reply answers one waiting run: a reply that answers an automation's message
  (quotes it, as tapping a WhatsApp template's button does, or taps one of its
  Instagram or Messenger buttons) goes to that message's run, or to none if it
  has stopped waiting; any other reply goes to the run of a live automation
  that started waiting most recently. Otherwise the single most specific matching automation starts (a chosen post
  beats any post, exact words beat keywords, keywords beat “any message”; tag
  and webhook triggers start every match). Inbox rules run either way: routing
  and round-robin for a new conversation, then the welcome or away message
  unless an automation took the message.
- **Comment replies** use the private-reply send (`recipient.comment_id`, one
  per comment) and public replies with `POST /{ig-comment-id}/replies`
  (Instagram) or `POST /{comment-id}/comments` (Facebook); they need
  `instagram_manage_comments` / `pages_manage_engagement`.
- **Post picker** (comment trigger on Instagram): Instagram Login accounts read
  `graph.instagram.com/me/media`; Page-linked accounts read
  `GET /{ig-user-id}/media` on the Graph API with the Page token. Meta's
  reference lists `instagram_basic` plus `pages_read_engagement` or
  `pages_show_list`, and names a *user* access token. That the stored Page token
  is accepted is **not yet verified** — check it on the first live account.
- **Conversation starters** (Campaigns → Automations → Conversation starters)
  write ice breakers (at most four), Messenger's Get Started button and the
  persistent menu with `POST /me/messenger_profile` and clear removed ones with
  `DELETE`, using the Page token (Page-linked Instagram adds
  `platform=instagram`; Instagram Login accounts call graph.instagram.com).
  Meta allows 10 such calls per 10 minutes per Page, and setting ice breakers
  this way replaces any written in Meta's own inbox tools. The exact permission
  Meta checks for this call is **not yet verified** live.
- **Spam → block on WhatsApp** calls `POST /{phone_number_id}/block_users`
  with the contact's phone number. Meta only allows it for people who messaged
  in the last 24 hours; its docs do not cover BSUID-only contacts or
  coexistence numbers, so a refusal is written as a note on the conversation.
- **Webhook trigger.** Publishing an automation whose trigger is “Another app
  calls a URL” issues a secret URL,
  `POST {APP_URL}/api/v1/automations/hooks/{token}`. Only the server issues the
  token (18 random bytes), each token belongs to one automation, and only people
  who can edit automations (owners, admins, managers, and influencers with
  `campaigns.manage`) are shown it. The body is JSON with the person's phone
  number (international format) at the field the trigger names; other
  top-level fields become `{{webhook.<field>}}`. Send an `Idempotency-Key`
  header to make retries safe. The contact with exactly that number is used.
  On WhatsApp an unknown number becomes a new contact; on Instagram and
  Messenger the person must be the one contact linked to a store customer with
  that number (matched the same way as linking, below). A number starting with
  00 is read as international, a trunk 0 after the country code
  ("+91 098…") is dropped, and a number that still starts with 0 is refused.
  The global rate limit applies.
- **“Call a URL” steps** refuse private, loopback, link-local and metadata
  addresses, written as IPv4 or as any IPv6 form that carries one (mapped,
  NAT64, 6to4), both for literal addresses and after DNS resolution, follow no
  redirects, time out after 10 seconds and read at most 256 KB.
- **Templates in automations.** Publishing checks that a template step gives
  every value its chosen template needs (and the header file, for a media
  header); otherwise each run would stop at that step. Playbooks pre-fill the
  values under both the starter templates' names (`{{first_name}}`…) and
  `{{1}}`, `{{2}}`… for a template of your own.
- **Free-form messages from automations** still obey the 24-hour window (7-day
  human-agent tag is for people only): a run whose message cannot go stops,
  and the reason shows on the automation.

### Selling in chat (commerce)

- **Store events for automations.** Order placed, paid, shipped, delivered and
  cancelled — from Shopify's order webhooks and from the same actions taken in
  Collabo — and checkout abandoned. Each is raised once per order and kind,
  and only when an active automation listens. The buyer is found by the
  order's (or checkout's) phone number on each listening WhatsApp number; a new
  number becomes a contact linked to the store customer. (Any WhatsApp contact
  links to the one store customer with the same number. The last ten digits
  must match, and before them the store's number may have only the rest of the
  national number (for numbers longer than ten digits, such as Brazilian or
  German mobiles), alone, after the country code, or after the country code
  and a trunk 0, as in "+44 (0)7911 123456"; Mexican and Argentine WhatsApp
  numbers also match without their mobile 1 or 9. So +44 7911 123456 never
  links to a customer saved as +91 79111 23456.)
  Messages from these
  triggers must be approved templates: the builder refuses free text there.
  Shopify has no delivered order state; a fulfilment whose carrier
  `shipment_status` is `delivered` counts, as does marking it delivered in
  Collabo.
- **Cash on delivery** is read from Shopify's `payment_gateway_names` (for
  example "Cash on Delivery (COD)"), stored on the order from live webhooks.
  Orders imported by the historical backfill do not carry it. The “Confirm
  cash-on-delivery orders” playbook decides only on whole replies: “Confirm
  order”, “Confirm” or “Yes” tags the order `cod-confirmed`; “Cancel order” or
  “Cancel” cancels it; any other reply (“Please don't cancel”, “When will it
  arrive?”) goes to the team (tag `cod-check`, assigned, with a note). For
  buyers who order more than once, set it to run every time.
- **Store actions** an automation can take: tag the order or add to its note
  (Shopify `orderUpdate`), cancel it (Shopify `orderCancel` — customer
  notified, restocked, no refund), tag the store customer (Shopify `tagsAdd`
  for a Shopify customer, which needs the app's protected customer data
  access; Collabo only for other customers), and
  turn a WhatsApp cart into a draft order. They run in WhatsApp automations
  only. Changes are recorded against the automation's creator, or the
  organization's owner.
- **The old order message is gone.** Shopify `orders/create` used to send
  Meta's sample `hello_world` template to every consenting customer whenever a
  WhatsApp number was connected; order messages now come only from
  automations the business sets up (the Order confirmation playbook).
- **Abandoned checkouts** come from the `checkouts/create|update|delete`
  webhooks the app already subscribes to. A checkout with a phone number and
  Shopify's `abandoned_checkout_url` that stays quiet for an hour without an
  order raises one `crm.checkout.abandoned` event (a sweep every 10 minutes,
  up to 3 days back). An order completes its checkout by `checkout_id` or
  token, even when the checkout's last update arrives after the order. The
  buyer's phone, name and addresses in these webhooks need Shopify's
  **protected customer data** access for the app. A WhatsApp link button adds
  only the end of a URL to a fixed address, so the recovery template's button
  is the store's address followed by `{{1}}` (for example
  `https://yourstore.com/{{1}}`, using the domain of Shopify's recovery links)
  and gets `{{checkout.url_path}}`, the part of the link after that address;
  `{{checkout.url}}` is the whole link, for message text.
- **WhatsApp catalog** (Campaigns → Catalog). Meta documents no API for
  linking a catalog to a WhatsApp account: the business connects it in
  WhatsApp Manager or Commerce Manager (one catalog per account) and pastes the
  catalog id into Collabo, which checks it with `GET /{catalog_id}`. Products
  are pushed with the Catalog Batch API, `POST /{catalog_id}/items_batch`
  (`item_type: PRODUCT_ITEM`, `allow_upsert: true`, up to 1,000 records per
  call): one item per variant, keyed by the variant's id — which is also the
  `product_retailer_id` in product messages and carts. Each item has title,
  description, price (with `sale_price` when a compare-at price is higher),
  availability, condition, brand, image and the Shopify product page as link;
  variants without an image or a product page are held back with the reason.
  Unchanged items are not re-sent; products taken off sale are deleted.
  Catalog visibility and the cart are `POST /{phone_number_id}/whatsapp_commerce_settings`.
  Connecting, changing and syncing the catalog is for owners, admins and
  managers; agents with campaign access can see it.
  The token is the WhatsApp business token: Meta's reference names no specific
  permission for catalog writes ("Marketing API access level"), so whether the
  system user needs `catalog_management` or a catalog assignment in Business
  Settings is **not yet verified** live.
- **Product messages** from the inbox's product tray: one product as a product
  card, two to thirty as a product list (text header), only for items already
  synced. Elsewhere — Instagram, Messenger, a number without a catalog, or a
  number shared with the WhatsApp Business app (which Meta does not allow to
  send catalog messages through the API) — products go as a message with
  names, prices and links.
- **Carts to orders.** A cart sent from the catalog starts “sends a cart”
  automations; the store action makes a draft order and mirrors it to Shopify
  (`draftOrderCreate`), whose `invoiceUrl` is the checkout link
  (`{{draft.checkout_url}}`). The inbox shows “Create draft order” under a cart
  for doing it by hand. Without a Shopify store the draft stays in Collabo and
  there is no link.
- **Not built:** sending a GST invoice from an automation (invoice PDFs are
  only rendered in the browser today).

### Messaging analytics (Analytics → Messaging)

For owners, admins and managers; days are counted in the organization's time
zone. How each figure is worked out:

- **Messages in / out:** live messages in the period, not imported history.
  Comments, platform notices and reactions are counted apart.
- **First reply by a person:** each time a customer writes after a business
  message (or opens the conversation), until the next reply sent from the
  inbox or the WhatsApp Business app. Automation and welcome/away replies are
  shown separately (“Who answered first”). Clock time, not business hours.
- **Time to close:** from when a conversation was opened (a customer's message,
  or a reopen) to when it was closed. Conversations opened before this release
  have no open time and are counted but not timed.
- **Revenue after messages:** store orders (not cancelled) by a customer who
  got a broadcast or automation message in the 7 days before, credited to the
  latest one. Revenue is in the organization's currency at each order's booked
  rate. Customers never linked to a chat contact cannot be credited.
- **Meta charges (estimate):** Meta's `pricing` (category, billable) on each
  WhatsApp status webhook, priced by recipient country from the rates in
  Campaigns → Message rates. Meta bills from its own records.
- **CSV:** the team table and daily volume download as UTF-8 CSV; cells that
  would start a spreadsheet formula are quoted.

## 5. Local testing

Meta will not redirect to `localhost`, so `APP_URL` must be a public tunnel
(this repo uses a VS Code dev tunnel):

```
APP_URL=https://<subdomain>.devtunnels.ms
FRONTEND_URL=http://localhost:5173
```

Whatever `APP_URL` is set to must also be the Instagram Login OAuth redirect URI
and the webhook callback on the Meta app, and `FRONTEND_URL` must be the origin
actually being browsed, or the post-OAuth redirect lands somewhere the merchant
is not.

The return states can be exercised without Meta by visiting them directly:

```
/settings/channels?connected=instagram&channelId=<id>
/settings/channels?connected=instagram&channelId=<id>&note=refreshed
/settings/channels?error=instagram_connect_failed&reason=cancelled
/settings/channels?error=instagram_connect_failed&reason=not_professional_account
/settings/channels?error=instagram_connect_failed&reason=scopes_declined
/settings/channels?select=instagram&pending=<expired-id>
```

The `reason` slugs and their copy live in `client/app/lib/channel-providers.ts`.

### Replaying webhooks without Meta

`server/test/fixtures/meta/` holds payloads built from Meta's documented
examples. `server/scripts/meta-webhook-replay.mjs` signs one with
`META_APP_SECRET` and posts it to a running API:

```
META_APP_SECRET=... node scripts/meta-webhook-replay.mjs test/fixtures/meta/wa-statuses.json \
  --url http://localhost:5000 --replace 102290129340398=<your WABA id>
```

The endpoint follows the payload's `object`; `--fresh` makes a repeat run a
new delivery rather than a redelivery.
