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
"WhatsApp Embedded Signup" template. Copy its **Configuration ID** into
`WHATSAPP_CONFIG_ID`.

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

Instagram → API setup with Instagram login → **Configure webhooks**:

| Object | Callback URL | Verify token |
|---|---|---|
| Instagram | `{APP_URL}/api/v1/webhooks/instagram` | `INSTAGRAM_WEBHOOK_VERIFY_TOKEN` |

Subscribe to `messages`, `messaging_postbacks` and `comments`. The server
subscribes each account automatically on connect and unsubscribes it on
disconnect.

Meta's documentation says the app must be **Live** to receive real
notifications, and `comments` needs Advanced Access. The dashboard's *Test*
button delivers in Development mode.

The webhook controller is diagnostic for now: it verifies the signature against
`INSTAGRAM_APP_SECRET` or `META_APP_SECRET` and logs which one matched, then logs
each entry's event kinds and whether `entry.id` matched a connected channel.
Nothing is stored yet.

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
