import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BillingInterval, BillingPlan, BillingProvider, Prisma, SubscriptionStatus, UsageBill, UsageBillStatus, UserRole } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { RazorpayService } from './razorpay.service';
import { planOfRazorpayId } from './razorpay-plans';
import { BillingCurrency, ChargeKey, Charges, GST_PERCENT, NO_USAGE, periodRange, previousPeriod, pricingPlan, Usage, usageCharges } from './pricing';
import { UsageService } from './usage.service';

/** ₹1 or $1, in the smallest unit: less is not charged. */
const MIN_CHARGE = 100;
const MAX_ATTEMPTS = 3;
/** A bill a stopped server left mid-way is taken up again after this. */
const STUCK_MS = 30 * 60 * 1000;
/** The plans with Razorpay plans. Enterprise is invoiced by the Collabo team. */
const USAGE_PRICED: BillingPlan[] = [BillingPlan.BASIC, BillingPlan.GROWTH, BillingPlan.SCALE];

const LINE_TEXT: Record<ChargeKey, (n: string, one: boolean) => string> = {
    callingMinutes: (n, one) => `${n} calling minute${one ? '' : 's'} over the plan`,
    members: (n, one) => `${n} extra team seat${one ? '' : 's'}`,
    opsSeats: (n, one) => `${n} packing or till seat${one ? '' : 's'}`,
    storeLocations: (n, one) => `${n} extra store location${one ? '' : 's'}`,
    whatsappNumbers: (n, one) => `${n} extra WhatsApp number${one ? '' : 's'}`,
};

/**
 * Usage billing: once a month is over, each organization with an active
 * Razorpay subscription on a usage-priced plan is charged for what it used
 * over the plan's allowances. Razorpay takes add-ons only on subscriptions
 * paid by card, and puts them on the next invoice, so a monthly card
 * subscription gets one on its next renewal; one paid by UPI or e-mandate,
 * and a yearly one (whose next invoice is up to a year away), is sent a
 * payment link by email instead. Plans the Collabo team set up by hand
 * (billing provider MANUAL) are invoiced by the team, not here.
 *
 * One bill per organization and month (unique). A retry first looks for the
 * add-on or link an earlier attempt may have made, so a timeout never charges twice.
 */
@Injectable()
export class UsageBillingService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(UsageBillingService.name);
    private timer: NodeJS.Timeout | null = null;
    private running = false;

    constructor(
        private readonly prisma: PrismaService,
        private readonly razorpay: RazorpayService,
        private readonly usage: UsageService,
        private readonly config: ConfigService,
    ) { }

    onModuleInit() {
        const seconds = this.config.get<number>('billing.usagePollSeconds') ?? 3600;
        this.timer = setInterval(() => void this.tick(), seconds * 1000);
    }

    onModuleDestroy() {
        if (this.timer) clearInterval(this.timer);
    }

    async tick(now = new Date()): Promise<void> {
        if (this.running || !this.razorpay.isConfigured()) return;
        this.running = true;
        try {
            await this.billMonth(previousPeriod(now), now);
            await this.checkLinks();
        } catch (err) {
            this.logger.error(`Usage billing run failed: ${err instanceof Error ? err.message : err}`);
        } finally {
            this.running = false;
        }
    }

    async billMonth(period: string, now: Date): Promise<void> {
        const orgs = await this.prisma.organization.findMany({
            where: {
                deletedAt: null,
                billingProvider: BillingProvider.RAZORPAY,
                externalSubscriptionId: { not: null },
                subscriptionStatus: SubscriptionStatus.ACTIVE,
                billingPlan: { in: USAGE_PRICED },
                createdAt: { lt: periodRange(period).end },
                // Not yet billed, or a bill that may be taken up again.
                usageBills: {
                    none: {
                        period,
                        OR: [
                            { status: { notIn: [UsageBillStatus.PROCESSING, UsageBillStatus.FAILED] } },
                            { status: UsageBillStatus.FAILED, attempts: { gte: MAX_ATTEMPTS } },
                        ],
                    },
                },
            },
            select: { id: true },
            take: 100,
        });
        for (const org of orgs) await this.bill(org.id, period, now);
    }

    /** Razorpay's payment_link.paid webhook, and the check for a missed one. */
    async onLinkPaid(linkId: string): Promise<void> {
        await this.prisma.usageBill.updateMany({
            where: { externalId: linkId, status: UsageBillStatus.LINK_SENT },
            data: { status: UsageBillStatus.PAID },
        });
    }

    async checkLinks(): Promise<void> {
        const open = await this.prisma.usageBill.findMany({
            where: { status: UsageBillStatus.LINK_SENT },
            select: { externalId: true },
            take: 200,
        });
        for (const bill of open) {
            try {
                const link = await this.razorpay.paymentLink(bill.externalId!);
                if (link.status === 'paid') await this.onLinkPaid(link.id);
            } catch (err) {
                this.logger.warn(`Payment link ${bill.externalId} could not be checked: ${err instanceof Error ? err.message : err}`);
            }
        }
    }

    private async bill(organizationId: string, period: string, now: Date): Promise<void> {
        const bill = await this.claim(organizationId, period, now);
        if (!bill) return;
        try {
            await this.prisma.usageBill.update({ where: { id: bill.id }, data: await this.charge(bill) });
        } catch (err) {
            const note = (err instanceof Error ? err.message : String(err)).slice(0, 300);
            this.logger.error(`Usage bill for ${organizationId}, ${period} failed (attempt ${bill.attempts}): ${note}`);
            await this.prisma.usageBill.update({ where: { id: bill.id }, data: { status: UsageBillStatus.FAILED, note } });
        }
    }

    /** Takes the month's bill: a new one, a failed one with attempts left, or one left mid-way. */
    private async claim(organizationId: string, period: string, now: Date): Promise<UsageBill | null> {
        try {
            return await this.prisma.usageBill.create({ data: { organizationId, period, attempts: 1 } });
        } catch (err) {
            if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
        }
        const taken = await this.prisma.usageBill.updateMany({
            where: {
                organizationId,
                period,
                OR: [
                    { status: UsageBillStatus.FAILED, attempts: { lt: MAX_ATTEMPTS } },
                    { status: UsageBillStatus.PROCESSING, updatedAt: { lt: new Date(now.getTime() - STUCK_MS) } },
                ],
            },
            data: { status: UsageBillStatus.PROCESSING, attempts: { increment: 1 } },
        });
        return taken.count ? this.prisma.usageBill.findUnique({ where: { organizationId_period: { organizationId, period } } }) : null;
    }

    private async charge(bill: UsageBill): Promise<Prisma.UsageBillUpdateInput> {
        const org = await this.prisma.organization.findUniqueOrThrow({
            where: { id: bill.organizationId },
            select: {
                name: true,
                externalSubscriptionId: true,
                members: { where: { role: UserRole.OWNER }, select: { user: { select: { email: true } } }, take: 1 },
            },
        });
        const sub = await this.razorpay.fetchSubscription(org.externalSubscriptionId!);
        if (sub.status !== 'active') return { status: UsageBillStatus.SKIPPED, note: `The subscription is ${sub.status}.` };
        const onPlan = planOfRazorpayId(this.config, sub.plan_id);
        if (!onPlan) return { status: UsageBillStatus.SKIPPED, note: 'The subscription is on a plan without usage prices.' };

        // The month's usage is fixed on the first attempt, so a retry charges the same.
        const usage: Usage = bill.usage ? { ...NO_USAGE, ...(bill.usage as Partial<Usage>) } : await this.usage.usage(bill.organizationId, bill.period);
        const pricing = pricingPlan(onPlan.plan);
        // Chats are never charged: over the fair use, the team talks to the brand.
        if (pricing.fairUseChats !== null && usage.conversations > pricing.fairUseChats) {
            this.logger.warn(`Org ${bill.organizationId} had ${usage.conversations} chats in ${bill.period}, over ${pricing.name}'s fair use of ${pricing.fairUseChats}`);
        }
        const charges = usageCharges(pricing, onPlan.currency, usage);
        const priced = {
            plan: onPlan.plan,
            currency: onPlan.currency,
            usage: usage as unknown as Prisma.InputJsonValue,
            lines: charges.lines as unknown as Prisma.InputJsonValue,
            subtotal: charges.subtotal,
            tax: charges.tax,
            total: charges.total,
        };
        if (charges.total < MIN_CHARGE) return { ...priced, status: UsageBillStatus.NOTHING_DUE, note: null };
        await this.prisma.usageBill.update({ where: { id: bill.id }, data: priced });

        const reference = `collabo-usage-${bill.id}`;
        const title = `Collabo usage, ${monthName(bill.period)}`;
        const details = describe(charges, onPlan.currency);
        const retry = bill.attempts > 1;
        if (sub.payment_method === 'card' && onPlan.interval === BillingInterval.MONTHLY) {
            const since = Math.floor(bill.createdAt.getTime() / 1000) - 60;
            const earlier = retry
                ? (await this.razorpay.addonsSince(since)).find((a) => a.subscription_id === sub.id && a.item.description?.includes(reference))
                : undefined;
            const addon = earlier ?? (await this.razorpay.addAddon(sub.id, {
                name: title,
                amount: charges.total,
                currency: onPlan.currency,
                description: `${details} Ref ${reference}`,
            }));
            return { status: UsageBillStatus.ADDED, externalId: addon.id, note: null };
        }
        const link = (retry ? await this.razorpay.paymentLinkByReference(reference) : null)
            ?? (await this.razorpay.createPaymentLink({
                amount: charges.total,
                currency: onPlan.currency,
                description: `${title}: ${details}`,
                reference_id: reference,
                customer: {
                    name: org.name,
                    email: sub.customer_email ?? org.members[0]?.user.email,
                    ...(sub.customer_contact ? { contact: sub.customer_contact } : {}),
                },
                notes: { organization_id: bill.organizationId, usage_bill_id: bill.id, period: bill.period },
            }));
        return {
            status: link.status === 'paid' ? UsageBillStatus.PAID : UsageBillStatus.LINK_SENT,
            externalId: link.id,
            paymentUrl: link.short_url,
            note: null,
        };
    }
}

function monthName(period: string): string {
    const { start } = periodRange(period);
    return start.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function describe(charges: Charges, currency: BillingCurrency): string {
    const locale = currency === 'INR' ? 'en-IN' : 'en-US';
    const parts = charges.lines.map((l) => LINE_TEXT[l.key](l.quantity.toLocaleString(locale), l.quantity === 1));
    if (charges.tax) parts.push(`GST ${GST_PERCENT}%`);
    return `${parts.join(', ')}.`;
}
