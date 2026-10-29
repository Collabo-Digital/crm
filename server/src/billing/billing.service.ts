import {
    BadRequestException,
    ForbiddenException,
    Injectable,
    Logger,
    ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
    BillingInterval,
    BillingPlan,
    Prisma,
    SubscriptionStatus,
} from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { BILLING_CURRENCIES, BillingCurrency, GST_PERCENT, PLANS, pricingPlan } from './pricing';
import { RazorpayService } from './razorpay.service';
import { razorpayPlanId } from './razorpay-plans';
import { UsageBillingService } from './usage-billing.service';

/**
 * Razorpay event payload subset we care about. The actual Razorpay payload has
 * many more fields; we only narrow what we read.
 */
interface RazorpayWebhookPayload {
    subscription?: {
        entity?: {
            id: string;
            status: string;
            current_end: number | null;
            customer_id?: string | null;
        };
    };
    /**
     * `invoice.paid` event — fired when a subscription period is paid. This is
     * the most reliable signal that a subscription is ACTIVE for the current
     * period. The invoice entity references both the subscription_id and the
     * customer_id Razorpay assigned during checkout.
     */
    invoice?: {
        entity?: {
            id: string;
            subscription_id?: string | null;
            customer_id?: string | null;
            status: string;
            // Razorpay sets these on subscription invoices:
            line_items?: Array<{
                period_end?: number | null;
            }>;
        };
    };
    payment?: {
        entity?: {
            id: string;
            error_description?: string;
        };
    };
    /** `payment_link.paid`: a usage bill sent as a payment link was paid. */
    payment_link?: {
        entity?: {
            id: string;
            status: string;
        };
    };
}

/** Subscriptions Razorpay will not charge again. */
const ENDED_SUBSCRIPTION: SubscriptionStatus[] = [
    SubscriptionStatus.CANCELLED,
    SubscriptionStatus.COMPLETED,
    SubscriptionStatus.EXPIRED,
];

/**
 * Orchestrates the onboarding payment flow.
 *
 *   1. Client calls POST /billing/onboarding-checkout
 *      → we create a Razorpay Subscription (no pre-created Customer; the
 *        customer is captured automatically when the user pays in the modal)
 *      → store pending state on User
 *      → return { subscriptionId } so the client can mount Checkout.js
 *
 *   2. User completes payment in the modal
 *      → Razorpay webhook fires `subscription.activated`
 *      → handleWebhookEvent flips pendingSubscriptionStatus = ACTIVE and
 *        captures the customer_id Razorpay assigned during checkout
 *
 *   3. Client polls GET /billing/pending-status, sees ACTIVE, advances to
 *      account-type → POST /organizations(/personal)
 *
 *   4. Inside the org-create $transaction, applyPendingSubscriptionToOrg copies
 *      User.pending_* → Organization.* and clears the pending fields. If status
 *      is not ACTIVE/AUTHENTICATED, throws 403.
 */
@Injectable()
export class BillingService {
    private readonly logger = new Logger(BillingService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly razorpay: RazorpayService,
        private readonly config: ConfigService,
        private readonly usageBilling: UsageBillingService,
    ) { }

    /** The price list, and which plans can be bought in which currency. */
    plans() {
        return {
            plans: PLANS,
            gstPercent: GST_PERCENT,
            checkout: Object.fromEntries(
                PLANS.filter((p) => p.selfServe).map((p) => [p.id, BILLING_CURRENCIES.filter((c) => razorpayPlanId(this.config, p.id, c))]),
            ),
            salesEmail: this.config.get<string>('billing.salesEmail') ?? null,
        };
    }

    /**
     * Razorpay errors are plain objects (not Error instances), so without this
     * helper they get logged as `[object Object]`. Pulls the human-readable
     * description out of the SDK error and re-throws as a 400 with the real
     * message, while logging the full payload server-side for debugging.
     */
    private rethrowRazorpay(operation: string, err: unknown): never {
        const detail = this.extractRazorpayError(err);
        this.logger.error(
            `Razorpay ${operation} failed: ${JSON.stringify(err, null, 2)}`,
        );
        throw new BadRequestException(
            detail ?? `Razorpay ${operation} failed. Check server logs.`,
        );
    }

    private extractRazorpayError(err: unknown): string | null {
        if (!err || typeof err !== 'object') return null;
        const e = err as Record<string, unknown>;
        // Shape 1: { statusCode, error: { description, code, ... } }
        if (e.error && typeof e.error === 'object') {
            const inner = e.error as Record<string, unknown>;
            if (typeof inner.description === 'string') return inner.description;
        }
        // Shape 2: { message: '...' } (HttpException already)
        if (typeof e.message === 'string') return e.message;
        return null;
    }

    /**
     * Creates a Razorpay Subscription and persists pending state on the User.
     *
     * Note: we do NOT pre-create a Razorpay Customer. The Razorpay Subscriptions
     * API doesn't accept `customer_id` in the standard checkout flow — the
     * customer is captured automatically when the user pays in the modal. We
     * pass the user's email via `notify_info` to pre-fill the modal.
     *
     * `pendingExternalCustomerId` is populated later from the
     * `subscription.activated` webhook (Razorpay tells us the customer_id once
     * the customer pays).
     */
    async startOnboardingCheckout(
        userId: string,
        plan: BillingPlan,
        interval: BillingInterval,
        currency: BillingCurrency,
    ) {
        const pricing = pricingPlan(plan);
        if (!pricing.selfServe) {
            throw new BadRequestException(`${pricing.name} is set up with the Collabo team. Talk to us to start it.`);
        }
        if (interval !== BillingInterval.MONTHLY) {
            throw new BadRequestException('Plans are billed monthly.');
        }
        const planId = razorpayPlanId(this.config, plan, currency);
        if (!planId) {
            throw new BadRequestException(`The ${pricing.name} plan cannot be bought in ${currency} yet.`);
        }
        const user = await this.prisma.user.findUniqueOrThrow({
            where: { id: userId },
        });
        this.logger.log(
            `Creating subscription: planId=${planId} userEmail=${user.email} currency=${currency}`,
        );

        let subscription: Awaited<
            ReturnType<typeof this.razorpay.createSubscription>
        >;
        try {
            subscription = await this.razorpay.createSubscription({
                planId,
                notifyEmail: user.email,
                notes: { userId, plan, interval, currency },
            });
        } catch (err) {
            this.rethrowRazorpay('subscription creation', err);
        }

        await this.prisma.user.update({
            where: { id: userId },
            data: {
                pendingBillingPlan: plan,
                pendingBillingInterval: interval,
                pendingBillingCurrency: currency,
                pendingExternalSubscriptionId: subscription.id,
                pendingSubscriptionStatus: SubscriptionStatus.CREATED,
                pendingCurrentPeriodEnd: null,
                // pendingExternalCustomerId will be populated from the webhook
                // payload (subscription.activated.entity.customer_id).
            },
        });

        return {
            subscriptionId: subscription.id,
            razorpayKeyId: this.razorpay.getKeyId(),
            currency,
        };
    }

    /** Polled by the client after the Razorpay modal closes. */
    async getPendingStatus(userId: string) {
        const user = await this.prisma.user.findUniqueOrThrow({
            where: { id: userId },
            select: {
                pendingSubscriptionStatus: true,
                pendingBillingPlan: true,
                pendingBillingInterval: true,
                pendingExternalSubscriptionId: true,
            },
        });

        return {
            status: user.pendingSubscriptionStatus,
            plan: user.pendingBillingPlan,
            interval: user.pendingBillingInterval,
            subscriptionId: user.pendingExternalSubscriptionId,
        };
    }

    /**
     * Atomic helper called from inside OrganizationService.create() and
     * createPersonal()'s `$transaction`. Copies User.pending_* → Organization
     * billing fields, clears the pending fields. Throws if no ACTIVE/AUTHENTICATED
     * subscription — this is the server-side hard gate that prevents an org from
     * being created without payment. The plan is the one paid for, whatever
     * the create request said.
     */
    async applyPendingSubscriptionToOrg(
        tx: Prisma.TransactionClient,
        userId: string,
        orgId: string,
    ): Promise<void> {
        const user = await tx.user.findUniqueOrThrow({
            where: { id: userId },
            select: {
                pendingBillingPlan: true,
                pendingBillingInterval: true,
                pendingBillingCurrency: true,
                pendingExternalCustomerId: true,
                pendingExternalSubscriptionId: true,
                pendingSubscriptionStatus: true,
                pendingCurrentPeriodEnd: true,
            },
        });

        const status = user.pendingSubscriptionStatus;

        // TEMP: pricing/billing step is hidden from users during onboarding.
        // Allow orgs to be created without a paid subscription. When billing
        // ships, remove this early-return to restore the payment gate below.
        if (!status) {
            return;
        }

        const isPaid =
            status === SubscriptionStatus.ACTIVE ||
            status === SubscriptionStatus.AUTHENTICATED;

        if (!isPaid) {
            throw new ForbiddenException(
                'Subscription payment required before creating an organization',
            );
        }

        await tx.organization.update({
            where: { id: orgId },
            data: {
                ...(user.pendingBillingPlan ? { billingPlan: user.pendingBillingPlan } : {}),
                ...(user.pendingBillingInterval ? { billingInterval: user.pendingBillingInterval } : {}),
                billingCurrency: user.pendingBillingCurrency,
                externalCustomerId: user.pendingExternalCustomerId,
                externalSubscriptionId: user.pendingExternalSubscriptionId,
                billingProvider: 'RAZORPAY',
                subscriptionStatus: status,
                currentPeriodEnd: user.pendingCurrentPeriodEnd,
            },
        });

        await tx.user.update({
            where: { id: userId },
            data: {
                pendingBillingPlan: null,
                pendingBillingInterval: null,
                pendingBillingCurrency: null,
                pendingExternalCustomerId: null,
                pendingExternalSubscriptionId: null,
                pendingSubscriptionStatus: null,
                pendingCurrentPeriodEnd: null,
            },
        });
    }

    /**
     * End the Razorpay subscription of a workspace that is being deleted, so it
     * is not charged again. Throws when Razorpay cannot be asked, so the
     * deletion stops instead of leaving a deleted workspace on a live
     * subscription; the owner can try again.
     */
    async cancelOrganizationSubscription(orgId: string): Promise<void> {
        const org = await this.prisma.organization.findUnique({
            where: { id: orgId },
            select: { externalSubscriptionId: true, subscriptionStatus: true },
        });
        const subscriptionId = org?.externalSubscriptionId;
        if (!subscriptionId || (org.subscriptionStatus && ENDED_SUBSCRIPTION.includes(org.subscriptionStatus))) return;
        if (!this.razorpay.isConfigured()) {
            this.logger.error(`Org ${orgId} is being deleted with subscription ${subscriptionId}, but Razorpay is not configured to cancel it`);
            return;
        }
        try {
            const sub = await this.razorpay.fetchSubscription(subscriptionId);
            if (!ENDED_SUBSCRIPTION.includes(this.mapRazorpayStatus(sub.status))) {
                await this.razorpay.cancelSubscription(subscriptionId);
            }
        } catch (err) {
            this.logger.error(`Cancelling subscription ${subscriptionId} of org ${orgId} failed: ${this.extractRazorpayError(err) ?? JSON.stringify(err)}`);
            throw new ServiceUnavailableException(
                'Your Collabo subscription could not be cancelled with Razorpay just now, so the workspace was not deleted. Try again in a few minutes.',
            );
        }
        await this.prisma.organization.update({
            where: { id: orgId },
            data: { subscriptionStatus: SubscriptionStatus.CANCELLED },
        });
    }

    /** Idempotent webhook event handler. Safe to call with duplicate events. */
    async handleWebhookEvent(
        event: string,
        payload: RazorpayWebhookPayload,
    ): Promise<void> {
        this.logger.log(`Webhook: ${event}`);

        switch (event) {
            case 'subscription.activated':
            case 'subscription.authenticated':
            case 'subscription.charged':
            case 'subscription.halted':
            case 'subscription.cancelled':
            case 'subscription.completed':
            case 'subscription.pending': {
                const sub = payload.subscription?.entity;
                if (!sub) return;
                await this.upsertSubscriptionStatus(
                    sub.id,
                    this.mapRazorpayStatus(sub.status),
                    sub.current_end,
                    sub.customer_id ?? null,
                );
                break;
            }
            // `invoice.paid` is the most reliable "subscription is paid" signal
            // in Razorpay test mode (subscription.* events sometimes don't fire
            // for UPI test payments). The invoice carries subscription_id +
            // customer_id, so we can mark the subscription ACTIVE the same way.
            case 'invoice.paid': {
                const invoice = payload.invoice?.entity;
                const subId = invoice?.subscription_id;
                if (!invoice || !subId) {
                    this.logger.warn(
                        'invoice.paid received without subscription_id — ignoring (one-time invoice)',
                    );
                    return;
                }
                const periodEndUnix =
                    invoice.line_items?.[0]?.period_end ?? null;
                await this.upsertSubscriptionStatus(
                    subId,
                    SubscriptionStatus.ACTIVE,
                    periodEndUnix,
                    invoice.customer_id ?? null,
                );
                break;
            }
            case 'payment_link.paid': {
                const link = payload.payment_link?.entity;
                if (link) await this.usageBilling.onLinkPaid(link.id);
                break;
            }
            case 'payment.failed':
                this.logger.warn(
                    `Payment failed: ${payload.payment?.entity?.id} reason=${payload.payment?.entity?.error_description}`,
                );
                break;
            default:
                this.logger.debug(`Unhandled webhook event: ${event}`);
        }
    }

    private mapRazorpayStatus(raw: string): SubscriptionStatus {
        const map: Record<string, SubscriptionStatus> = {
            created: SubscriptionStatus.CREATED,
            authenticated: SubscriptionStatus.AUTHENTICATED,
            active: SubscriptionStatus.ACTIVE,
            paused: SubscriptionStatus.PAUSED,
            halted: SubscriptionStatus.HALTED,
            cancelled: SubscriptionStatus.CANCELLED,
            completed: SubscriptionStatus.COMPLETED,
            expired: SubscriptionStatus.EXPIRED,
        };
        return map[raw] ?? SubscriptionStatus.CREATED;
    }

    private async upsertSubscriptionStatus(
        razorpaySubId: string,
        status: SubscriptionStatus,
        currentEndUnix: number | null,
        customerId: string | null,
    ): Promise<void> {
        const periodEnd = currentEndUnix ? new Date(currentEndUnix * 1000) : null;

        // Pre-org-creation: subscription is on the User's pending fields.
        // Capture customer_id from Razorpay's payload (we didn't have it at
        // subscription-create time — only after the user pays in the modal).
        const userResult = await this.prisma.user.updateMany({
            where: { pendingExternalSubscriptionId: razorpaySubId },
            data: {
                pendingSubscriptionStatus: status,
                pendingCurrentPeriodEnd: periodEnd,
                ...(customerId ? { pendingExternalCustomerId: customerId } : {}),
            },
        });
        if (userResult.count > 0) {
            this.logger.log(
                `Updated pending sub ${razorpaySubId} on user → ${status}`,
            );
            return;
        }

        // Post-org-creation: subscription is on the Organization (renewals etc.)
        const orgResult = await this.prisma.organization.updateMany({
            where: { externalSubscriptionId: razorpaySubId },
            data: {
                subscriptionStatus: status,
                currentPeriodEnd: periodEnd,
                ...(customerId ? { externalCustomerId: customerId } : {}),
            },
        });
        if (orgResult.count > 0) {
            this.logger.log(`Updated sub ${razorpaySubId} on org → ${status}`);
        } else {
            this.logger.warn(
                `Sub ${razorpaySubId} not found in DB (user or org)`,
            );
        }
    }
}
