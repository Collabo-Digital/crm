# Plans, usage billing, trials and read-only

Collabo's own subscription, sold after a demo: a plan paid monthly or yearly,
plus fees for calling minutes, seats, stores and numbers over the plan,
billed after each month ends. Merchants pay Meta's WhatsApp message charges to
Meta directly: WhatsApp messages at Meta's price, no markup.

## Plans

Prices are before 18% GST, in rupees and dollars. A year costs ten months (two
months free).

| | Starter | Growth (Recommended) | Unlimited (for high-volume teams) | Enterprise |
|---|---|---|---|---|
| Best for | Up to about 1,000 orders a month | 1,000 to 5,000 orders a month | More than 5,000 orders a month | Groups of brands |
| Monthly | ₹8,999 / $109 | ₹12,999 / $159 | ₹19,999 / $239 | Contract |
| Yearly | ₹89,990 / $1,090 | ₹1,29,990 / $1,590 | ₹1,99,990 / $2,390 | Contract |
| Chats | Unlimited, fair use 25,000 a month | Unlimited, fair use 1,00,000 | Unlimited, fair use 3,00,000 | Contract |
| Team members | 5, then ₹999 / $12 a month each | 10, then ₹799 / $10 | Unlimited, no seat charges | Contract |
| Packing and till staff | ₹199 / $3 a month each | ₹199 / $3 | Included | Contract |
| Stores with POS | 1, then ₹999 / $12 a month each | 3, then ₹999 / $12 | 10, then ₹999 / $12 | Contract |
| WhatsApp numbers | 1, then ₹999 / $12 a month each | 2, then ₹999 / $12 | 5, then ₹999 / $12 | Contract |
| Calling minutes | 1,000, then ₹0.35 / $0.004 | 2,000, then ₹0.25 / $0.003 | 5,000, then ₹0.20 / $0.0024 | Contract |
| AI template drafts | 20 a day | 50 a day | 100 a day | 100 a day |
| Adds | | Packing assistant, team performance and messaging analytics, public API and webhooks | Managers and staff limited to chosen stores, 2,000 API requests a minute, priority support and custom setup | Several brands on one contract |

Every plan has GST invoices, the POS at its included stores, the shared inbox,
broadcasts, automations, Shopify and orders. Instagram DMs are included on
every plan when the app has Instagram switched on. The public API allows 600
requests a minute per key and endpoint, 2,000 on Unlimited and Enterprise.

**Fair use.** Chats (24 hours of WhatsApp with one person) are never charged.
They are still counted: Settings shows the month against the plan's fair-use
level, and a month over it is logged for the team ("Org … had … chats in …,
over …'s fair use"). Above that, the team talks to the brand; nothing is
charged automatically. Unlimited is subject to fair use, to keep the service
fast for everyone: if the use looks like an API farm or replaces a call centre,
we agree a custom plan.

`server/src/billing/pricing.ts` is the only copy of these numbers and features.
The app shows them from `GET /billing/plans`, and usage billing charges from
the same table. The stored plan ids are older than the names: `BASIC` is
Starter, `GROWTH` Growth, `SCALE` Unlimited and `ADVANCE` Enterprise. To change
a price, also create a new Razorpay plan (below): a subscription is charged
what its Razorpay plan says.

Rupee prices and rupee usage bills carry 18% GST; dollar bills carry none, as
they are for customers outside India (confirm the treatment with your
accountant).

## Plan features (gates)

`planFeatures(plan)` in pricing.ts says what each plan has beyond its volumes:

| Feature | Starter | Growth | Unlimited | Enterprise |
|---|---|---|---|---|
| Packing assistant (`packing`) | | ✓ | ✓ | ✓ |
| Messaging and team-performance analytics (`messagingAnalytics`) | | ✓ | ✓ | ✓ |
| Making public API keys and webhooks (`publicApi`) | | ✓ | ✓ | ✓ |
| Managers and staff limited to chosen stores (`storeScoping`) | | | ✓ | ✓ |
| API requests a minute | 600 | 600 | 2,000 | 2,000 |
| AI template drafts a day | 20 | 50 | 100 | 100 |

The gates are enforced only while `BILLING_ENFORCEMENT` is on, so nobody loses
anything before plans are sold:

- Routes marked `@RequirePlanFeature(...)` answer 403 "Available on Growth.
  Book a demo to upgrade." (`code: PLAN_FEATURE_LOCKED`) through the global
  `PlanFeatureGuard`: the packing routes, the messaging analytics routes, and
  making API keys and webhooks (keys and webhooks already made keep working
  and can be revoked).
- The app shows a calm locked state in place of those pages, from the
  `planFeatures` on `GET /organizations/:id` (all open while not enforced).
- Store-limited staff: call `BillingAccessService.allows(orgId, 'storeScoping')`.
- AI drafts a day follow the plan; with enforcement off they stay at 50.
- The API rate follows the plan whether or not enforcement is on (no plan gets
  less than the 600 every key had before).

## What is counted

- **A chat** (the conversation meter) is 24 hours with one person (or WhatsApp
  group), opened by the first WhatsApp message either way while none is open:
  a customer's message, or a message Collabo sends that Meta accepts. It is
  counted in the calendar month (UTC) it opens. Not counted: messages sent from
  the WhatsApp Business app on a coexistence number, imported history, blocked
  contacts, Instagram and Messenger.
- **Calling minutes**: each answered WhatsApp call's talk time, rounded up to
  the minute, in the month the call ended.
- **Team members** (full seats): active owners, admins, managers and agents
  when the bill is made, less the packing and till staff. Viewers, vendors and
  influencers are free, and so are POS PIN staff (paid for through the store).
- **Packing and till staff** (ops seats): active agents with at least one
  grant, every one of them among `section.products`, `inventory.view`,
  `inventory.pack`, `inventory.pick`, `inventory.receive`,
  `inventory.dispatch`, `inventory.labels` and `pos.sell`, and kept to the
  sections those grants name (`server/src/billing/seats.ts`). An agent with no
  section key at all can open every section, so is a full seat. Ops seats use
  any team seats the full members leave free first, then cost the ops price.
- **Stores with POS**: active stock locations of the Store kind, the places
  the till sells at.
- **WhatsApp numbers**: connected, switched-on WhatsApp channels.
- **Instagram accounts**: counted for Settings only; never charged.

Owners and admins see the month so far in **Settings → Billing & plan**, with
the plans and their past usage bills.

## Paying

Plans are sold after a demo: every plan card says "Book a demo", which opens
`BILLING_DEMO_URL` (a booking page) when it is set and otherwise writes to
`BILLING_SALES_EMAIL`. Enterprise says "Talk to us".

- **Once agreed**, the owner (only the owner: admins can look but not choose)
  pays in Settings → Billing under "Already spoken to us? Subscribe": the plan,
  yearly or monthly, then Razorpay Checkout (`POST /billing/subscribe`). The
  workspace moves to the plan once Razorpay says it is paid: its plan,
  interval and currency follow the Razorpay plan its subscription is on.
  Subscribing again asks Razorpay about the subscription it would replace; a
  paid one is recorded, never replaced, and one left unpaid or halted is
  cancelled. A workspace already paying, or on a plan the team set up, is
  asked to talk to us; changing or cancelling a live subscription is done by
  the team for now.
- **At sign-up**, once enforcement is on, the onboarding plan step shows the
  plans with "Start my 14-day free trial" first and "Already spoken to us? Pay
  now". A workspace made without paying starts on a trial of Growth (on
  Starter while enforcement is off); one paid for gets the plan, interval and
  currency paid for. The create request never sets the plan.
- **Enterprise, and any deal paid by invoice**, is set up by the Collabo team
  with the super-admin "Set plan or extend trial" action (Admin → a user →
  their workspace): plan, monthly or yearly, "Invoiced by the Collabo team"
  (billing provider `MANUAL`) and the trial's end. It refuses a manual plan
  while a Razorpay subscription that could still charge the workspace is
  attached, and leaves the plan of a workspace paying through Razorpay to its
  subscription. Each change is logged as `Billing of org … set by super admin
  …` with the values before and after.

**Mandate limit.** Indian card and UPI mandates need the customer's approval
for each recurring charge above ₹15,000. Growth (₹15,338.82 a month with GST)
and Unlimited (₹23,598.82) are above it, so a monthly subscription asks the
customer to approve every charge; Starter (₹10,618.82) is not. The subscribe
step says so next to monthly Growth and Unlimited and recommends paying
yearly, or asking us for a payment link.

## How usage is billed

Every `BILLING_USAGE_POLL_SECONDS` (an hour by default) the server looks for
organizations with an active Razorpay subscription on Starter, Growth or
Unlimited and no bill yet for last month. For each one it:

1. Fetches the subscription from Razorpay. It must be active and on one of the
   plans in `RAZORPAY_PLAN_*`. A subscription on any other plan, such as an
   earlier price, is never charged usage (bill `SKIPPED`).
2. Prices last month's usage and saves it on the bill, so a retry charges the
   same amount. The lines are only: calling minutes over the plan, extra team
   members, packing and till staff, extra stores and extra WhatsApp numbers.
   Under ₹1 or $1 is not charged (`NOTHING_DUE`).
3. Charges it:
   - **Monthly subscription paid by card**: one add-on, "Collabo usage,
     October 2026", on the subscription's next invoice (`ADDED`). Razorpay
     accepts add-ons only on subscriptions paid by card.
   - **UPI or e-mandate, or any yearly subscription** (whose next invoice is
     up to a year away): a Razorpay payment link, which Razorpay emails (and
     texts, with a phone number) to the subscriber with reminders
     (`LINK_SENT`). Razorpay's `payment_link.paid` webhook, or the next hourly
     check, marks it `PAID`.

There is one bill per organization and month. A failed attempt is retried up to
three times; a retry first looks for an add-on or link the earlier attempt may
have made, so a timeout never charges twice. After three failures the bill
stays `FAILED`, and the server log says why ("Usage bill for … failed").
Plans the Collabo team set up (`MANUAL`) show their usage and estimate in
Settings but are not billed here: the team invoices them.

## Trials, grace and read-only

All of this sits behind `BILLING_ENFORCEMENT`, off by default: while it is off
every workspace is active, every plan gate is open, the onboarding plan step
stays hidden and no billing state is read. Deploying changes nothing until it
is switched on.

| Variable | Default | |
|---|---|---|
| `BILLING_ENFORCEMENT` | off | `true` turns on trials, the plan step, plan gates and read-only |
| `BILLING_ENFORCE_FROM` | none | ISO date, required with enforcement: workspaces made before trials get one ending `BILLING_TRIAL_DAYS` after it |
| `BILLING_TRIAL_DAYS` | 14 | |
| `BILLING_GRACE_DAYS` | 7 | |

`billingAccess()` (`server/src/billing/billing-access.ts`) puts each workspace
in one state:

- **active**: an active or authorised subscription, a plan the Collabo team
  set up (`MANUAL`), or enforcement off. A cancelled subscription stays active
  to the end of the period it paid for.
- **trialing**: until `Organization.trialEndsAt` (new workspaces get now + 14
  days; a super admin can move or end it).
- **grace**: for `BILLING_GRACE_DAYS` after the trial's end, after a cancelled
  plan's last paid period, or after a failed payment. A failed payment's
  grace runs from `Organization.paymentFailedAt`, when Razorpay first said the
  subscription was halted, pending (a renewal being retried) or paused, not
  from a period end Razorpay may already have moved on. Everything still
  works.
- **expired**: read-only until a plan is active.

Read-only means:

- Every write is refused with `402` and "This workspace is read-only until a
  plan is active…", by a global guard (`billing-access.guard.ts`). Reads,
  exports included, keep working. Still allowed: sign-in, sign-out and
  switching workspace, the profile and password, billing and subscribing,
  making or deleting a workspace (`@AllowWhenExpired`), every `@Public`
  route (Meta, Shopify and Razorpay webhooks keep being processed, so
  incoming messages and orders are still saved; public pages; the public
  API), and the super-admin area.
- POS sales are writes, so they stop; in grace they carry on.
- Nothing is sent: the outbound sender fails a queued message with "Not
  sent: the workspace is read-only until a plan is active.", broadcasts
  (scheduled or under way) stop with the same reason, and automation runs are
  skipped (`read_only`) before any step. Each logs a line.

The app shows a banner from day 10 of the trial ("Your trial ends in N days.
Choose a plan."), in grace ("Payment needed. The workspace turns read-only on
<date>.") and while read-only ("Read-only until a plan is active."), from the
`billingAccess` on `GET /organizations/:id`.

A checkout from Settings whose webhook went missing is followed up for a week
by the reconciler (every 10 minutes), so a paid workspace does not stay unpaid
and turn read-only.

## Razorpay setup (Collabo's own account)

1. Create 12 plans, monthly and yearly, in rupees and dollars: Starter at
   ₹8,999 a month or ₹89,990 a year, Growth at ₹12,999 or ₹1,29,990, Unlimited
   at ₹19,999 or ₹1,99,990; and $109 / $1,090, $159 / $1,590, $239 / $2,390.
   Razorpay charges exactly the plan amount, so if GST is to be collected on
   the plan itself, create the rupee plans with it added, or set up tax in
   Razorpay. Dollars need Razorpay's international payments switched on.
2. Set each plan id in the server's environment: `RAZORPAY_PLAN_<PLAN>_<CUR>`
   for monthly and `RAZORPAY_PLAN_<PLAN>_<CUR>_YEARLY` for yearly, with
   `<PLAN>` one of `BASIC`, `GROWTH`, `SCALE` and `<CUR>` `INR` or `USD`. Test
   and live mode have different ids. A plan without an id cannot be paid that
   way, and the subscribe step says so. Enterprise has none.
3. Collabo's Razorpay webhook (`/api/v1/webhooks/razorpay`) needs the
   subscription events (`subscription.pending` included), `invoice.paid` and
   `payment_link.paid`.
4. Set `BILLING_DEMO_URL` to the demo booking page "Book a demo" opens
   (https), and `BILLING_SALES_EMAIL` to the address "Talk to us" (and "Book a
   demo", without a demo link) writes to.
5. `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` and `RAZORPAY_WEBHOOK_SECRET` are as
   before. `RAZORPAY_API_BASE` is only for local tests.

## Local testing

`messaging-e2e/localinfra/verify-m21.mjs` runs against `razorpay-mock.mjs`,
which plays both a merchant's Razorpay account and Collabo's (subscriptions,
add-ons and payment links), with the local test keys in `local-m3.env` and
`BILLING_USAGE_POLL_SECONDS=2`. Enforcement stays off there.
