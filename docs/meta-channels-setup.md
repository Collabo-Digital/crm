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
| Facebook Login for Business | Instagram connect, WhatsApp Embedded Signup |
| Instagram Graph API | Instagram messaging and comments |
| WhatsApp | WhatsApp Business messaging |

Copy the **App ID** and **App Secret** from Settings → Basic.

### Valid OAuth redirect URI

Facebook Login for Business → Settings → **Valid OAuth Redirect URIs**:

```
{APP_URL}/api/v1/channels/instagram/callback
```

`APP_URL` is the public URL of this API, not the frontend. Meta rejects the
whole authorization if the redirect URI does not match this list exactly,
including the scheme and any trailing path.

### WhatsApp Embedded Signup configuration

Facebook Login for Business → **Configurations** → create one from the
"WhatsApp Embedded Signup" template. Copy its **Configuration ID** into
`WHATSAPP_CONFIG_ID`.

Without it, `POST /api/v1/channels/whatsapp/install` returns 400 and the
WhatsApp dialog cannot open the popup.

### Scopes

Instagram requests these on the authorization URL:

```
instagram_basic, instagram_manage_messages, pages_show_list,
pages_messaging, pages_read_engagement, instagram_manage_comments
```

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
INSTAGRAM_WEBHOOK_VERIFY_TOKEN=     # any string you choose; echoed back to Meta
WHATSAPP_WEBHOOK_VERIFY_TOKEN=
WHATSAPP_CONFIG_ID=
WHATSAPP_GRAPH_VERSION=v21.0        # optional; used by BOTH Meta channels
APP_URL=                            # public URL of THIS API
FRONTEND_URL=                       # where OAuth sends the merchant back
ENCRYPTION_KEY=                     # exactly 32 chars; encrypts stored tokens
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

1. `POST /api/v1/channels/instagram/install` returns a Facebook authorize URL.
2. The merchant authorizes; Meta redirects to
   `{APP_URL}/api/v1/channels/instagram/callback`.
3. The server exchanges the code, lists every Facebook Page the login granted,
   and collects the Instagram business account on each.
4. Accounts already connected to this organization are removed from the list.
   - one left  → connected, redirect to `?connected=instagram`
   - several   → parked in Redis, redirect to `?select=instagram&pending=<id>`
     and the merchant picks one
   - none left → 409, redirect to `?error=instagram_connect_failed&reason=...`

**WhatsApp — Embedded Signup popup.**

1. `POST /api/v1/channels/whatsapp/install` returns `{ configId, state }`.
2. The client opens `FB.login` with that config; the merchant picks or creates a
   WhatsApp Business Account and phone number inside Meta's UI.
3. The popup returns a code; the client posts it to
   `POST /api/v1/channels/whatsapp/callback`, which exchanges it and stores the
   channel.

Because the popup returns to the page rather than navigating, WhatsApp has no
browser callback route and needs no redirect URI.

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

Meta app → Webhooks:

| Object | Callback URL | Verify token |
|---|---|---|
| Instagram | `{APP_URL}/api/v1/webhooks/instagram` | `INSTAGRAM_WEBHOOK_VERIFY_TOKEN` |

Subscribe to `messages` and `messaging_postbacks`. The server subscribes each
Page automatically on connect and unsubscribes it on disconnect.

There is no WhatsApp webhook controller yet, so `WHATSAPP_WEBHOOK_VERIFY_TOKEN`
is configured but unused: WhatsApp delivery and read receipts are not ingested.

---

## 5. Local testing

Meta will not redirect to `localhost`, so `APP_URL` must be a public tunnel
(this repo uses a VS Code dev tunnel):

```
APP_URL=https://<subdomain>.devtunnels.ms
FRONTEND_URL=http://localhost:5173
```

Whatever `APP_URL` is set to must also be the Valid OAuth Redirect URI on the
Meta app, and `FRONTEND_URL` must be the origin actually being browsed, or the
post-OAuth redirect lands somewhere the merchant is not.

The return states can be exercised without Meta by visiting them directly:

```
/settings/channels?connected=instagram&channelId=<id>
/settings/channels?connected=instagram&channelId=<id>&note=refreshed
/settings/channels?error=instagram_connect_failed&reason=cancelled
/settings/channels?error=instagram_connect_failed&reason=no_instagram_account
/settings/channels?select=instagram&pending=<expired-id>
```

The `reason` slugs and their copy live in `client/app/lib/channel-providers.ts`.
