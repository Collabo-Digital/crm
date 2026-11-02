# Plans, usage billing, trials and read-only

Collabo's own subscription: a plan paid monthly or yearly, plus fees for usage
over the plan's allowances, billed after each month ends. Merchants pay Meta's
WhatsApp message charges to Meta directly: WhatsApp messages at Meta's price,
no markup.

## Plans

Prices are before 18% GST, in rupees and dollars. "Yearly" is the month's price
when a year is paid ahead (20% off, rounded down); the yearly bill is twelve
of them.

| | Starter | Growth (popular) | Pro | Scale | Enterprise |
|---|---|---|---|---|---|
| Monthly | ₹2,499 / $29 | ₹6,999 / $79 | ₹12,499 / $149 | ₹24,999 / $299 | Per contract |
| Yearly, a month | ₹1,999 / $23 | ₹5,599 / $63 | ₹9,999 / $119 | ₹19,999 / $239 | Per contract |
| Chats | 2,000, then ₹0.25 / $0.003 | 15,000, then ₹0.15 / $0.0018 | 1,00,000, then ₹0.10 / $0.0012 | 3,00,000, then ₹0.07 / $0.0008 | Contract |
| Team seats | 3 | 8 | 15 | 30 | Contract |
| Store locations | 1 | 2 | 5 | 10 | Contract |
| WhatsApp numbers | 1 | 2 | 3 | 5 | Contract |
| Calling minutes | 500, then ₹0.35 / $0.004 | 1,500, then ₹0.30 / $0.0035 | 3,000, then ₹0.25 / $0.003 | 6,000, then ₹0.20 / $0.0024 | Contract |
| Bought | Checkout | Checkout | Checkout | After a demo, invoiced | Contract |

Add-ons, on every plan but Enterprise, charged on the next bill and never
blocking anything:

- Extra team seat: ₹699 / $9 a month.
- Packing or till-only seat (an agent whose only grants are packing,
  picking, receiving, dispatch, labels, the till and the Products section):
  ₹199 / $3 a month. These seats use any team seats the full members leave
  free first.
- Extra store location: ₹999 / $12 a month.
- Extra WhatsApp number: ₹999 / $12 a month.
- Instagram: ₹799 / $9.99 a month per account (included on Enterprise).

Scale and Enterprise also get managers and staff limited to chosen stores,
2,000 public API requests a minute per key and endpoint (600 on the other
plans), priority support and payment by invoice: `planFeatures()` in
`server/src/billing/pricing.ts`. Every plan has every selling feature.

`server/src/billing/pricing.ts` is the only copy of these numbers. The app
shows them from `GET /billing/plans`, and usage billing charges from the same
table. The stored plan ids are older than the names: `BASIC` is Starter,
`GROWTH` Growth, `PRO` Pro, `SCALE` Scale and `ADVANCE` Enterprise. To change a
price, also create a new Razorpay plan (below): a subscription is charged
what its Razorpay plan says.

Rupee prices and rupee usage bills carry 18% GST; dollar bills carry none, as
they are for customers outside India (confirm the treatment with your
accountant).

## What is counted

- **A chat** (the conversation meter) is 24 hours with one person (or
  WhatsApp group), opened by the first WhatsApp message either way while none
  is open: a customer's message, or a message Collabo sends that Meta accepts.
  It is counted in the calendar month (UTC) it opens. Not counted: messages
  sent from the WhatsApp Business app on a coexistence number, imported
  history, blocked contacts, Instagram and Messenger.
- **Calling minutes**: each answered WhatsApp call's talk time, rounded up to
  the minute, in the month the call ended.
- **Team seats**: active owners, admins, managers and agents when the bill is
  made, less the packing and till seats. Viewers, vendors and influencers are
  free, and so are POS PIN staff (paid for through the store location).
- **Packing and till seats**: active agents with at least one grant, every
  one of them among `section.products`, `inventory.view`, `inventory.pack`,
  `inventory.pick`, `inventory.receive`, `inventory.dispatch`,
  `inventory.labels` and `pos.sell` (`server/src/billing/seats.ts`). An agent
  with no grants has every section, so takes a full seat.
- **Store locations**: active stock locations of the Store kind, the places
  the till sells at.
- **WhatsApp numbers**: connected, switched-on WhatsApp channels.
- **Instagram accounts**: the organization's own connected Instagram accounts
  when the bill is made, not those influencers connected.

Owners and admins see the month so far in **Settings → Billing & plan**, with
the plans and their past usage bills.

## Paying

- **At sign-up**, once enforcement is on (below), the onboarding plan step
  offers the plans, monthly or yearly, and "Start my 14-day free trial". A
  workspace made without paying starts on a trial of Growth; one paid for
  gets the plan, interval and currency paid for, whatever the create request
  said. Nobody can choose Scale or Enterprise there.
- **From Settings → Billing**, the owner (only the owner: admins can look but
  not choose) picks a plan and pays in Razorpay Checkout
  (`POST /billing/subscribe`). The workspace moves to the plan once Razorpay
  says it is paid: its plan, interval and currency follow the Razorpay plan
  its subscription is on. Starting again replaces a subscription left unpaid
  or halted, cancelling it. A workspace already paying, or on a plan the
  Collabo team set up, is asked to talk to us to change it; changing or
  cancelling a live subscription is done by the team for now.
- **Scale and Enterprise** are set up by the Collabo team with the super-admin
  "Set plan or extend trial" action (Admin → a user → their workspace):
  plan, monthly or yearly, "Invoiced by the Collabo team" (billing provider
  `MANUAL`) and the trial's end. Each change is logged as `Billing of org …
  set by super admin …` with the values before and after. A workspace paying
  through Razorpay keeps its subscription's plan; only its trial can change
  there.

Indian card and UPI mandates need the customer's approval for any recurring
charge above ₹15,000, so Pro is the largest plan that renews monthly without
it (₹14,749 with GST). Scale is sold yearly by invoice and bank transfer, or
monthly by card with the customer approving each charge.

## How usage is billed

Every `BILLING_USAGE_POLL_SECONDS` (an hour by default) the server looks for
organizations with an active Razorpay subscription on Starter, Growth or Pro
and no bill yet for last month. For each one it:

1. Fetches the subscription from Razorpay. It must be active and on one of the
   plans in `RAZORPAY_PLAN_*`. A subscription on any other plan, such as an
   earlier price, is never charged usage (bill `SKIPPED`).
2. Prices last month's usage and saves it on the bill, so a retry charges the
   same amount. Under ₹1 or $1 is not charged (`NOTHING_DUE`).
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
Settings but are not billed here: the team invoices them. Enterprise is
invoiced by its contract.

## Trials, grace and read-only

All of this sits behind `BILLING_ENFORCEMENT`, off by default: while it is off
every workspace is active, the onboarding plan step stays hidden and no
billing state is read. Deploying changes nothing until it is switched on.

| Variable | Default | |
|---|---|---|
| `BILLING_ENFORCEMENT` | off | `true` turns on trials, the plan step and read-only |
| `BILLING_ENFORCE_FROM` | none | ISO date, required with enforcement: workspaces made before trials get one ending `BILLING_TRIAL_DAYS` after it |
| `BILLING_TRIAL_DAYS` | 14 | |
| `BILLING_GRACE_DAYS` | 7 | |

`billingAccess()` (`server/src/billing/billing-access.ts`) puts each workspace
in one state:

- **active**: an active or authorised subscription, a plan the Collabo team
  set up (`MANUAL`), or enforcement off. A stopped subscription (cancelled,
  or a payment that failed) stays active to the end of the period it paid
  for.
- **trialing**: until `Organization.trialEndsAt` (new workspaces get now + 14
  days; a super admin can move it).
- **grace**: for `BILLING_GRACE_DAYS` after the later of the trial's end and
  the last paid period's end. Everything still works.
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

## Razorpay setup (Collabo's own account)

1. Create the plans, monthly and yearly, in rupees and dollars: Starter at
   ₹2,499 a month or ₹23,988 a year, Growth at ₹6,999 or ₹67,188, Pro at
   ₹12,499 or ₹1,19,988; and $29 / $276, $79 / $756, $149 / $1,428. Razorpay
   charges exactly the plan amount, so if GST is to be collected on the plan
   itself, create the rupee plans with it added, or set up tax in Razorpay.
   Dollars need Razorpay's international payments switched on.
2. Set each plan id in the server's environment, 12 in all:
   `RAZORPAY_PLAN_<PLAN>_<CUR>` for monthly and `RAZORPAY_PLAN_<PLAN>_<CUR>_YEARLY`
   for yearly, with `<PLAN>` one of `BASIC`, `GROWTH`, `PRO` and `<CUR>` `INR`
   or `USD`. Test and live mode have different ids. A plan without an id
   cannot be bought that way, and the plan cards say so. Scale and Enterprise
   have none.
3. Collabo's Razorpay webhook (`/api/v1/webhooks/razorpay`) needs the
   subscription events, `invoice.paid` and `payment_link.paid`.
4. Set `BILLING_SALES_EMAIL` to the address Scale's "Book a demo" and
   Enterprise's "Talk to us" write to.
5. `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` and `RAZORPAY_WEBHOOK_SECRET` are as
   before. `RAZORPAY_API_BASE` is only for local tests.

## Local testing

`messaging-e2e/localinfra/verify-m21.mjs` runs against `razorpay-mock.mjs`,
which plays both a merchant's Razorpay account and Collabo's (subscriptions,
add-ons and payment links), with the local test keys in `local-m3.env` and
`BILLING_USAGE_POLL_SECONDS=2`. Enforcement stays off there.
