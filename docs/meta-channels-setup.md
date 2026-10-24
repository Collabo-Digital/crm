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
RAZORPAY_MERCHANT_API_BASE=         # leave unset in production (https://api.razorpay.com);
                                    # local tests point it at the Razorpay stand-in
ANTHROPIC_API_KEY=                  # Collabo's own key, for the AI template writer;
                                    # unset, the writer is hidden
ANTHROPIC_BASE_URL=                 # leave unset in production; local tests point it
                                    # at the Anthropic stand-in
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
| WhatsApp → Configuration | `{APP_URL}/api/v1/webhooks/whatsapp` | `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | messages, smb_message_echoes, history, smb_app_state_sync, account_update, message_template_status_update, message_template_quality_update, template_category_update, message_template_components_update, phone_number_quality_update, phone_number_name_update, business_capability_update, user_preferences, group_lifecycle_update, group_participants_update, group_settings_update, group_status_update, calls |
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
- **Writing with AI** (Templates → New template → Write with AI): the
  merchant describes the message, picks the language and optionally the
  category, and Claude (`claude-opus-5-5`, low effort, structured JSON
  output) writes a draft that opens in the normal editor. Nothing is sent to
  Meta until the merchant submits it. The draft is checked against Meta's
  rules (the components limits, no variable at the start or end of the body,
  no formatting characters in the header, coupon buttons only on marketing,
  quick replies grouped); one that breaks a rule goes back to Claude once with
  the problem. Marketing drafts get the "Stop promotions" button that records
  an opt-out, and the name is made free in that language. What reaches
  Anthropic: the description and the store's name, industry, website and
  currency, with the organization identified only by a hash. Requests opt
  into server-side refusal fallbacks (`fallbacks: "default"`, beta
  `server-side-fallback-2026-07-01`). Each organization gets 50 drafts a UTC
  day. The key is Collabo's own (`ANTHROPIC_API_KEY`); without it the option
  is not shown.

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
  An automation on these runs once for each order (or invoice, payment, cart
  or checkout), so a returning buyer's next order runs it too; "once a day"
  still limits each person to one run in 24 hours.
  Shopify has no delivered order state; a fulfilment whose carrier
  `shipment_status` is `delivered` counts, as does marking it delivered in
  Collabo.
- **Cash on delivery** is read from Shopify's `payment_gateway_names` (for
  example "Cash on Delivery (COD)"), stored on the order from live webhooks.
  Orders imported by the historical backfill do not carry it. The “Confirm
  cash-on-delivery orders” playbook decides only on whole replies: “Confirm
  order”, “Confirm” or “Yes” tags the order `cod-confirmed`; “Cancel order” or
  “Cancel” cancels it; any other reply (“Please don't cancel”, “When will it
  arrive?”) goes to the team (tag `cod-check`, assigned, with a note). Each
  order is asked once, including a returning buyer's.
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
  card; two to ten as product cards to swipe through (Meta's product
  carousel, `interactive.type: carousel`, one body and no header, footer or
  buttons) or as a product list; up to thirty as a product list (text header,
  a section title of at most 24 characters). Only items already synced can go
  as cards. Elsewhere — Instagram, Messenger, a number without a catalog, or a
  number shared with the WhatsApp Business app (which Meta does not allow to
  send catalog messages through the API) — products go as a message with
  names, prices and links.
- **The catalog beside the chat** (the conversation's Products tab): search
  the store or pick a Shopify collection (collections sync with their product
  order), then drag a product into the chat, or use Add, to put it in the
  reply, or Send it on its own. Products with options list each variant. A
  whole collection goes as one product list under its name, or as a link to
  the collection page where product cards cannot be sent. Files dragged in
  from the computer attach to the reply too. On phones, Add and Send replace
  dragging; the panel lists 100 variants at a time.
- **Carts to orders.** A cart sent from the catalog starts “sends a cart”
  automations; the store action makes a draft order and mirrors it to Shopify
  (`draftOrderCreate`), whose `invoiceUrl` is the checkout link
  (`{{draft.checkout_url}}`). The inbox shows “Create draft order” under a cart
  for doing it by hand. Without a Shopify store the draft stays in Collabo and
  there is no link.
- **GST invoices to every buyer.** Invoice PDFs are rendered on the server
  (`GET /invoices/:id/pdf`, `server/src/invoice/pdf/invoice-pdf.tsx`); the
  browser download uses the same file. Every newly issued invoice raises the
  “A GST invoice is issued” trigger, whether it was issued on payment, on
  shipping, at an offline sale or by hand. The “Send the GST invoice” playbook
  sends it with the **Send invoice** step: the PDF is uploaded to WhatsApp and
  sent as the document header of an approved utility template (the “GST
  invoice” starter), named after the invoice number. Publishing refuses a
  template without a document header. Meta's template reference does not show
  `filename` on a template's document header, although its media object
  accepts it for documents. That the name reaches the customer is **not yet
  verified** live.
- **When invoices are issued** (Settings → Orders, both off by default because
  they consume invoice serials). “Auto-generate GST invoices for paid Shopify
  orders” invoices a live Shopify order when it becomes paid. “Invoice
  cash-on-delivery orders when they ship” invoices a COD order when it is
  fulfilled, in Shopify or from Shipments in Collabo: GST wants the invoice
  by dispatch, and a COD order is only paid after delivery. The later payment
  finds the invoice and issues nothing more. Both need GST enabled with a
  registered GSTIN, and a failure is recorded on the order instead of blocking
  it.

### Payments in chat (each merchant's own Razorpay)

Payment links are made in the **merchant's own Razorpay account**, connected
under Settings → Orders → "Payments with your Razorpay account" by an owner
or admin. That is a different account from Collabo's own subscription billing
(`RAZORPAY_KEY_*`, `/webhooks/razorpay`), which this never uses.

- **Connecting.** The merchant pastes a key id and key secret from Razorpay →
  Account & Settings → API keys (test keys work for trying it). Collabo checks
  them with Razorpay, stores them AES-encrypted, and shows a webhook URL
  (`/api/v1/webhooks/razorpay/merchant/<token>`, a per-account secret path) and
  a webhook secret, shown once. In Razorpay → Webhooks the merchant adds that
  URL and secret with the events `payment_link.paid`,
  `payment_link.partially_paid`, `payment_link.expired` and
  `payment_link.cancelled`. Every webhook must be signed with that account's
  secret (HMAC-SHA256 of the raw body, `X-Razorpay-Signature`), and touches
  only that account's links. Without the webhook, open links are checked with
  Razorpay every 10 minutes and on "Check status". Disconnecting clears the
  keys and keeps the links' history; links already sent stay payable in
  Razorpay, but Collabo no longer sees those payments.
- **Sending a link.** In the inbox, the contact panel's Payments section lists
  the customer's unpaid orders ("Request ₹2,398 for #1101") and takes any other
  amount. Under a cart, "Send payment link" pays the draft order. Automations
  have a **Send a payment link** step (a template whose button is
  `https://rzp.io/{{1}}` with `{{payment.link_path}}`, or a text with
  `{{payment.link}}` inside the 24-hour window), and a **"A payment link is
  paid"** trigger with `{{payment.amount}}`, `{{payment.method}}` and the
  order. Starters: "Pay for your order" and "Pay online instead of cash";
  playbooks: "Turn COD orders into prepaid", "Cart to payment", "Thank buyers
  when they pay". Links are in rupees, at least ₹1, and expire after 48 hours
  by default (1 to 720). An open link for the same order is reused rather than
  made twice.
- **When it is paid.** The link is marked paid once, whichever of webhook or
  sweep sees it first, and only when the amount paid equals the link's amount.
  An order is marked paid (`orderMarkAsPaid` in Shopify), tagged if the step
  says so (cod-to-prepaid), invoiced if invoicing on payment is on, and the
  invoice automation sends the GST invoice. A cart's draft is completed into a
  paid order (Shopify `draftOrderComplete`, or a local order with an invoice).
  If the order or draft cannot follow, the payment is kept and the reason is
  shown on the link.
- **WhatsApp Pay (India), checkout inside the chat.** Under Campaigns →
  Catalog → WhatsApp Pay, an owner or admin picks the number's payment
  configuration, or creates one (`POST /{waba}/payment_configuration`) and
  opens Meta's link to connect their own Razorpay, PayU, BillDesk or Zaakpay
  account; Meta lists it as Active once it is connected and tested in WhatsApp
  Manager. The WhatsApp account needs WhatsApp's payments terms accepted, and
  the `payment_configuration_update` webhook field keeps the status current.
  In the inbox ("WhatsApp Pay" on an unpaid order, "Request in WhatsApp Pay"
  under a cart) and in automations (Send a payment link → WhatsApp Pay) Collabo
  sends an `order_details` "Review and Pay" bill: the order's items (from the
  number's catalog when every item is in it, else with the importer from your
  GSTIN registration), its total in paise adding up the way Meta checks, and
  the delivery address in India, which Meta requires. Bills go only within 24
  hours of the customer's last message and up to ₹5,00,000 (UPI's cap). A
  payment arrives as a `statuses[]` entry with `type: payment`; Collabo
  confirms it with `GET /{phone_number_id}/payments/{configuration}/{reference_id}`
  before the order follows, exactly like a paid link, then sends `order_status`
  "processing", and "shipped" and "completed" as the order ships and is
  delivered. A paid order is never marked cancelled on the order page (Meta
  refuses it). Unconfirmed bills are checked every 10 minutes.
  Not verified live: whether payments work on a number shared with the
  WhatsApp Business app (Meta's payments pages do not say).
- **Not built, and why.** A discount for paying online would change the
  order's total, which needs Shopify's `write_order_edits` scope; adding it to
  the app's access scopes makes every connected store re-approve the app. So
  "Turn COD orders into prepaid" collects the full amount. WhatsApp's own
  payment card (Enhanced Payment Links) and payment links inside
  `order_details` are allowlist-only at Meta; plain links work for everyone.
  Razorpay's partner OAuth ("Connect with Razorpay" without copying keys)
  needs Collabo registered as a Razorpay technology partner.

### Shopify customer segments (Campaigns → Segments)

Segments built in the Shopify admin (Customers → Segments) can be linked as
audiences. Collabo lists them (`segments`), reads a linked one's members
(`customerSegmentMembers`, 1,000 a page, up to 100,000; `read_customers`,
which the app already has), matches them to the store customers it has by
Shopify customer id, and re-reads every linked segment daily at 4 am and on
"Sync". A Collabo segment rule **Shopify segment is / is not …** then picks
those customers' contacts, for broadcasts like any segment. Members Collabo
has no customer for are counted but cannot be messaged. Shopify does not say
whether a member id is a Customer or a CustomerSegmentMember gid; both end in
the customer's number, which is what Collabo matches.

### Growth tools (Campaigns → Growth)

- **Chat links and QR codes.** A link per campaign, poster or bio, on
  WhatsApp (`wa.me/<number>?text=…`), Messenger (`m.me/<page>?ref=<code>`) or
  Instagram (`ig.me/m/<username>`). Collabo's short link
  `/api/v1/l/<code>` counts the click and redirects (no login, not rate
  limited, `noindex`). A WhatsApp link's pre-filled message ends with
  `Ref: <code>`; when a customer's message carries it, the contact gets the
  link's tag (which "A contact gets a tag" automations can follow up) and the
  link is credited with the chat, once per person. Customers may edit the text,
  and then the chat is simply not attributed. QR codes download as PNG (for
  print) or SVG and encode the short link, so scans are counted too.
- **Website chat button and pop-up.** One per organization, loaded with
  `<script src="<APP_URL>/api/v1/widget/<key>.js" async></script>` before
  `</body>` (in Shopify: theme.liquid). The script is plain JavaScript in a
  shadow root, so the site's CSS cannot reach it; it writes merchant text as
  text, never HTML, and does nothing while the widget is off. The button opens
  WhatsApp through its own chat link (tag `website-chat`), so its clicks and
  chats are counted like any link. The pop-up shows once a week per visitor
  and asks for a number and an explicit consent tick; a sign-up is accepted
  only from the sites listed in the settings (checked against Origin/Referer),
  a filled honeypot field is answered as if it worked, and the same number
  within a day changes nothing. A sign-up becomes a WhatsApp contact, opted in
  with `source: widget` and the consent text and page as evidence, gets the
  pop-up's tag, and starts "Someone signs up on your website" automations,
  which must send a template since the person has not written. CORS for
  `/api/v1/widget/*` accepts any origin without credentials (like the
  storefront pixel); the rest of the API stays locked to the CRM.

### Click-to-message ads (Campaigns → Ads)

- **Chats from ads, no extra permission.** The first message of a chat from
  a click-to-WhatsApp ad carries `referral` (`source_type: ad`, `source_id`,
  `headline`, `body`, media, `ctwa_clid`; Status ads have no `ctwa_clid`);
  click-to-Messenger and click-to-Instagram messages carry `ad_id` and
  `ads_context_data`, and an ad tapped in an existing Messenger thread sends a
  standalone `messaging_referrals` event (the Page must subscribe to it).
  Each is recorded per message (`ad_referrals`), shown in the inbox's contact
  panel ("From an ad"), and starts **"Someone messages you from an ad"**
  automations (any ad, or the ad ids you list) with `{{ad.id}}`,
  `{{ad.headline}}`, `{{ad.body}}` and `{{ad.url}}`; they may reply in text,
  since the customer has just written. The Ads page counts people per ad and
  credits each ad with the orders those customers place within 7 days.
- **Meta's results (spend, impressions, conversations).** Needs a Facebook
  Login for Business configuration with `ads_read` (`META_ADS_CONFIG_ID`), and
  for other businesses' ad accounts Advanced access to `ads_read` plus the
  Marketing API Access Tier (app review). A manager connects; the code becomes
  a long-lived user token (about 60 days, stored encrypted) and the active ad
  account is chosen. The page reads `GET /act_{id}/insights?level=ad` for the
  period (cached 15 minutes) and shows "Messaging Conversations Started"
  (`onsite_conversion.messaging_conversation_started_7d`), cost per chat and
  return on ad spend. **Not verified live** until that access is granted.
- **Purchases to the Conversions API.** Per WhatsApp number, an owner or admin
  turns on "Report purchases to Meta": `POST /{waba_id}/dataset` gives the
  account's dataset (needs `whatsapp_business_manage_events`, auto-approved
  with Advanced `whatsapp_business_messaging`). A payment collected in the
  chat (payment link or WhatsApp Pay) from someone who came from a
  click-to-WhatsApp ad in the last 7 days is sent once as `Purchase` with the
  ad's `ctwa_clid` (`action_source: business_messaging`); Meta does not
  de-duplicate, so `conversion_events` does. Website orders are counted on the
  page but not sent: Meta wants messaging events to happen in the chat.
  Messenger and Instagram conversions are not sent yet.

### WhatsApp groups (Inbox → Groups)

Meta's Groups API (Cloud API): small groups of customers on the business's
number, for VIP drops, workshops or order help.

- **Who can:** numbers with an Official Business Account (the blue tick) on
  the Cloud API. Never a number shared with the WhatsApp Business app; Collabo
  says so and refuses before asking Meta. Meta's own refusal (131215) is shown
  in words. Owners, admins and managers make and run groups; everyone in the
  inbox can see them.
- **Making one:** `POST /{phone_number_id}/groups` (subject up to 128
  characters, description up to 2048, join approval `auto_approve` or
  `approval_required`). Creation is asynchronous: the group shows as being
  created until the `group_lifecycle_update` webhook brings its id and invite
  link (matched by `request_id`); a refusal there is shown with Meta's reason.
- **People:** at most 8 besides the business, and they join only with the
  invite link (copy, QR code, or a new link that retires the old one,
  `POST /{group_id}/invite_link`). With approval required, join requests wait
  in Collabo to be approved or declined (`POST`/`DELETE
  /{group_id}/join_requests`). Removing someone (`DELETE
  /{group_id}/participants`) stops them rejoining with the link. Joins,
  removals and leaves arrive on `group_participants_update` and show as
  notices in the chat. "Refresh from WhatsApp" re-reads the group
  (`GET /{group_id}?fields=...`, the invite link and join requests).
- **The chat:** each group is an inbox conversation of its own contact (flagged
  `is_group`; external id `group:<group id>`), assigned to whoever made it.
  Participants' messages carry `group_id` and land there under their names; a
  participant's message opens the reply window for the whole group, as Meta
  prices it. Replies go with `recipient_type: group`. Groups take text,
  files and templates only (no buttons, lists, products, payments or
  reactions), so the composer hides the rest. Group messages start no
  automation, link no customer and record no consent keyword.
- **Kept out of audiences:** segments, broadcasts and the contact list leave
  group chats out, because Meta bills a group send once per participant.
- **Suspended or deleted:** `group_status_update` suspends and restores
  sending; deleting (`DELETE /{group_id}`) removes everyone, the business
  included, closes the chat and keeps its history. A group made outside
  Collabo is recorded, under its own name, when its first message arrives.
- **Webhook fields:** subscribe the app to `group_lifecycle_update`,
  `group_participants_update`, `group_settings_update` and
  `group_status_update` (table above). Meta's "group invite link" utility
  template (template library) is not sent from Collabo yet.

### WhatsApp calls (call dock and the chat's call button)

Meta's Business Calling API, answered and placed in a teammate's browser.
Collabo relays the signalling; the audio goes over WebRTC between the browser
and Meta (Opus, one audio track). Meta gives no STUN or TURN servers, so the
teammate's network must allow outbound UDP.

- **Who can:** Cloud API numbers with a daily messaging limit of at least
  2,000. Never a number shared with the WhatsApp Business app: Meta keeps
  voice calls in the app there, and Collabo says so. Owners and admins switch
  calling on in Settings → Inbox → WhatsApp calls (`POST
  /{phone_number_id}/settings`: `calling.status`, `call_icon_visibility`
  `DEFAULT` or `DISABLE_ALL`, `callback_permission_status`); Meta warns that
  phones can take up to 7 days to show a change. Owners, admins, managers and
  agents take and place calls; viewers cannot. One-to-one WhatsApp chats only.
- **A person calls:** the `calls` webhook (`connect`, Meta's SDP offer) rings
  in the call dock on every page, for everyone in the inbox, for the 30 to 60
  seconds Meta allows. The first teammate to answer takes it: the browser
  makes its SDP answer with every ICE candidate in it (no trickle), Collabo
  sends `pre_accept` and then `accept` with the same answer, and the
  microphone stays silent until the accept is confirmed. Decline sends
  `reject`. The call opens the 24-hour reply window. Meta's `terminate`
  webhook ends it; an unanswered call is recorded as missed. The chat gets a
  note ("Incoming WhatsApp call · 1 min 35 s", "Missed WhatsApp call", …).
- **The business calls:** only someone who allowed it. The call button checks
  `GET /{phone_number_id}/call_permissions`; without permission it offers to
  ask with an interactive `call_permission_request` in the chat (inside the
  reply window; Meta allows 1 request in 24 hours and 2 in 7 days, reset by a
  connected call, and charges it as a message). The answer
  (`call_permission_reply`) is kept on the contact: temporary (7 days) or
  permanent. With callback permission on, a person who calls the business
  grants a temporary permission. WhatsApp's own grants and withdrawals
  (`response_source: automatic`) are noted in the chat, not taken as messages
  from the person. The call goes out with the browser's SDP offer (`action:
  connect`); Meta's answer, then `RINGING`, `ACCEPTED` and `REJECTED`
  statuses, come back on the `calls` webhook. Picking up opens the reply
  window. Meta revokes a permission after 4 unanswered calls in a
  row, and does not offer business calls from numbers in the United States,
  Canada, Egypt, Vietnam or Nigeria.
- **Cost:** calls people place are free. Business calls are billed by Meta in
  six-second pulses, by the called number's country and the month's volume
  tier.
- **Webhook field:** subscribe the app to `calls` (table above). Call hours,
  SIP, video and the permission-request template (for outside the reply
  window) are not set from Collabo yet.

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
