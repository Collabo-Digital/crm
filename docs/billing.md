# Plans and usage billing

Collabo's own subscription: a monthly plan, plus a fee for usage over the
plan's allowances, billed after each month ends. Merchants pay Meta's WhatsApp
message charges to Meta directly; Collabo adds nothing to Meta's prices.

## Plans

| | Basic | Growth (popular) | Enterprise |
|---|---|---|---|
| Price a month | ₹5,000 / $59 | ₹15,000 / $179 | Per contract ("Talk to us") |
| Conversations | 5,000, then ₹0.20 / $0.0024 each | 1,00,000, then ₹0.10 / $0.0012 each | No fee |
| Team members | 5, then ₹1,000 / $12 a month each | 10, then ₹800 / $10 a month each | Unlimited |
| WhatsApp calling | 1,000 minutes, then ₹0.35 / $0.004 a minute | 2,000 minutes, then ₹0.25 / $0.003 a minute | 4,000+ minutes |
| Instagram | ₹799 / $9.99 a month per account | ₹799 / $9.99 a month per account | Included |
| Messenger | Included | Included | Included |

Every plan has every feature. Rupee prices and rupee usage bills carry 18% GST;
dollar bills carry none, as they are for customers outside India (confirm the
treatment with your accountant).

`server/src/billing/pricing.ts` is the only copy of these numbers. The app shows
them from `GET /billing/plans`, and usage billing charges from the same table.
To change a plan's own price, also create a new Razorpay plan (below): a
subscription is charged what its Razorpay plan says. The stored plan ids are
`BASIC`, `GROWTH` and `ADVANCE` (Enterprise).

## What is counted

- **A conversation** is 24 hours with one person (or WhatsApp group), opened by
  the first WhatsApp message either way while none is open: a customer's
  message, or a message Collabo sends that Meta accepts. It is counted in the
  calendar month (UTC) it opens. Not counted: messages sent from the WhatsApp
  Business app on a coexistence number, imported history, blocked contacts,
  Instagram and Messenger.
- **Calling minutes**: each answered WhatsApp call's talk time, rounded up to
  the minute, in the month the call ended.
- **Team members**: active owners, admins, managers and agents when the bill is
  made. Viewers, vendors and influencers are free.
- **Instagram accounts**: the organization's own connected Instagram accounts
  when the bill is made, not those influencers connected.

Owners and admins see the month so far in **Settings → Billing & Plan**, with
the plans in rupees or dollars and their past usage bills.

## How usage is billed

Every `BILLING_USAGE_POLL_SECONDS` (an hour by default) the server looks for
organizations with an active Razorpay subscription on Basic or Growth and no
bill yet for last month. For each one it:

1. Fetches the subscription from Razorpay. It must be active and on one of the
   plans in `RAZORPAY_PLAN_*`. A subscription on any other plan, such as the
   earlier ₹999 / ₹4,999 / ₹9,999 ones, is never charged usage (bill `SKIPPED`).
2. Prices last month's usage and saves it on the bill, so a retry charges the
   same amount. Under ₹1 or $1 is not charged (`NOTHING_DUE`).
3. Charges it:
   - **Card subscription**: one add-on, "Collabo usage, October 2026", on the
     subscription's next invoice (`ADDED`). Razorpay accepts add-ons only on
     subscriptions paid by card.
   - **UPI or e-mandate subscription**: a Razorpay payment link, which Razorpay
     emails (and texts, with a phone number) to the subscriber with reminders
     (`LINK_SENT`). Razorpay's `payment_link.paid` webhook, or the next hourly
     check, marks it `PAID`.

There is one bill per organization and month. A failed attempt is retried up to
three times; a retry first looks for an add-on or link the earlier attempt may
have made, so a timeout never charges twice. After three failures the bill
stays `FAILED`, and the server log says why ("Usage bill for … failed").
Enterprise is invoiced by its contract and gets no usage bill.

## Razorpay setup (Collabo's own account)

1. Create monthly plans: **Basic** at ₹5,000 and **Growth** at ₹15,000. Razorpay
   charges exactly the plan amount, so if GST is to be collected on the plan
   itself, create them at ₹5,900 and ₹17,700, or set up tax in Razorpay. For
   dollars, also create Basic at $59 and Growth at $179; that needs Razorpay's
   international payments switched on.
2. Set each plan id in the server's environment: `RAZORPAY_PLAN_BASIC_INR`,
   `RAZORPAY_PLAN_GROWTH_INR`, `RAZORPAY_PLAN_BASIC_USD`, `RAZORPAY_PLAN_GROWTH_USD`.
   Test and live mode have different ids. A plan without an id cannot be bought
   in that currency, and the plan page says so.
3. Add `payment_link.paid` to the events of Collabo's Razorpay webhook
   (`/api/v1/webhooks/razorpay`), beside the subscription and `invoice.paid`
   events it already has.
4. Set `BILLING_SALES_EMAIL` to the address Enterprise's "Talk to us" writes to.
5. `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` and `RAZORPAY_WEBHOOK_SECRET` are as
   before. `RAZORPAY_API_BASE` is only for local tests.

Indian card and UPI mandates need the customer to approve each recurring charge
above a limit (₹15,000 for most businesses), so a Growth renewal with GST may
need the subscriber's approval each month. Check with Razorpay.

## Still switched off

- **The payment step in onboarding.** New workspaces are created without paying:
  `applyPendingSubscriptionToOrg` in `billing.service.ts` returns early when
  there is no subscription (marked TEMP), and `onboarding-guard.tsx` sends
  `/onboarding/choose-plan` on to account-type. Remove both to require a plan.
  The plan the subscriber paid for is what the workspace gets, whatever the
  create request says.
- **Subscribing from Settings.** A workspace that already exists cannot start a
  subscription there yet.
- **Enterprise** is set by the Collabo team:
  `UPDATE organizations SET billing_plan = 'ADVANCE' WHERE id = '…';`

## Local testing

`messaging-e2e/localinfra/verify-m21.mjs` runs against `razorpay-mock.mjs`,
which plays both a merchant's Razorpay account and Collabo's (subscriptions,
add-ons and payment links), with the local test keys in `local-m3.env` and
`BILLING_USAGE_POLL_SECONDS=2`.
