import { randomBytes } from 'node:crypto';
import { BadRequestException, Injectable, Logger, NotFoundException, OnApplicationShutdown, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { DraftOrderStatus, OrderFinancialStatus, PaymentLink, PaymentLinkStatus, PaymentProvider, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { OrderService } from '../order/order.service';
import { DraftOrderService } from '../draft-order/draft-order.service';
import { StoreActionsService } from '../commerce/store-actions.service';
import { CommerceEventsService } from '../commerce/commerce-events.service';
import { formatMoney } from '../commerce/order-vars';
import { countryCodeOf, normalizePhone } from '../common/phone.util';
import { PaymentAccountsService } from './payment-accounts.service';
import { RazorpayApiError, RazorpayMerchantClient, RazorpayPaymentLink } from './razorpay-merchant.client';
import { MAX_LINK_HOURS, MIN_PAISE, fromPaise, paymentVars, razorpayContact, razorpaySignatureValid, statusFromRazorpay, toPaise } from './payment-link.util';

export interface LinkOptions {
    /** Who sent it: a teammate in the inbox, or none for an automation. */
    userId?: string | null;
    contactId?: string | null;
    conversationId?: string | null;
    automationRunId?: string | null;
    expiresInHours?: number;
    /** Added to the order once it is paid, e.g. "cod-to-prepaid". */
    tagOnPaid?: string | null;
}

export interface PaymentLinkView {
    id: string;
    provider: PaymentProvider;
    shortUrl: string;
    amount: string;
    currency: string;
    description: string;
    status: PaymentLinkStatus;
    orderId: string | null;
    draftOrderId: string | null;
    expiresAt: Date;
    paidAt: Date | null;
    paymentMethod: string | null;
    followUpError: string | null;
    createdAt: Date;
    /** True when an open link for the same order or draft was reused instead of making another. */
    existing?: boolean;
}

const OPEN: PaymentLinkStatus[] = [PaymentLinkStatus.CREATED, PaymentLinkStatus.PARTIALLY_PAID];
/** Why the other links and bills for an order or draft are being closed. */
export type CloseReason = 'replaced' | 'paid';
type LinkTarget = Pick<PaymentLink, 'id' | 'organizationId' | 'orderId' | 'draftOrderId'>;
const phoneOf = (address: unknown): string | null => {
    const a = address as { phone?: unknown } | null;
    return typeof a?.phone === 'string' && a.phone.trim() ? a.phone : null;
};
/** A draft completed in the CRM records how it was paid. */
const draftPaymentMethod = (method: string | null): 'UPI' | 'CARD' | 'OTHER' => (method === 'upi' ? 'UPI' : method === 'card' ? 'CARD' : 'OTHER');

/**
 * Payment links from the merchant's own Razorpay account, sent in chat: for
 * an unpaid order (cash on delivery turned prepaid), for a draft order made
 * from a WhatsApp cart, or for an amount typed in the inbox. A paid link
 * marks the order paid (in Shopify too) or completes the draft into an
 * order, and raises the "payment received" trigger.
 *
 * Razorpay tells us by webhook; links whose webhook never came are checked
 * by the sweep and by "Check status". The webhook is answered as soon as the
 * payment is recorded; the order or draft follows after, since completing a
 * Shopify draft waits for Shopify's order. A follow-up that never finished
 * (a restart) is run again by the sweep.
 */
@Injectable()
export class PaymentLinksService implements OnModuleInit, OnApplicationShutdown {
    private readonly logger = new Logger(PaymentLinksService.name);
    private readonly running = new Set<Promise<void>>();
    private readonly closeListeners: Array<(keep: LinkTarget, reason: CloseReason) => Promise<void>> = [];

    constructor(
        private readonly prisma: PrismaService,
        private readonly accounts: PaymentAccountsService,
        private readonly razorpay: RazorpayMerchantClient,
        private readonly orders: OrderService,
        private readonly drafts: DraftOrderService,
        private readonly store: StoreActionsService,
        private readonly events: CommerceEventsService,
    ) { }

    onModuleInit() {
        this.events.onOrder(async (orderId, kinds) => {
            if (kinds.includes('cancelled')) await this.orderCancelled(orderId);
        });
    }

    /**
     * Told when the other ways to pay an order or draft are closed: WhatsApp
     * Pay closes its bills this way, since it depends on this service.
     */
    onClose(listener: (keep: LinkTarget, reason: CloseReason) => Promise<void>): void {
        this.closeListeners.push(listener);
    }

    /**
     * One payable link or bill per order or draft. A newer one replaces the
     * rest, and a paid one closes them; otherwise a customer holding two could
     * pay both, and nothing would say so.
     */
    async closeOthers(keep: LinkTarget, reason: CloseReason): Promise<void> {
        if (!keep.orderId && !keep.draftOrderId) return;
        const open = await this.prisma.paymentLink.findMany({
            where: {
                organizationId: keep.organizationId,
                provider: PaymentProvider.RAZORPAY,
                status: PaymentLinkStatus.CREATED,
                id: { not: keep.id },
                ...(keep.orderId ? { orderId: keep.orderId } : { draftOrderId: keep.draftOrderId }),
            },
        });
        for (const link of open) await this.cancelAtRazorpay(link);
        for (const listener of this.closeListeners) {
            await listener(keep, reason).catch((err) => this.logger.warn(`Closing other payment requests for ${keep.id} failed: ${err instanceof Error ? err.message : err}`));
        }
    }

    async forOrder(orgId: string, orderId: string, opts: LinkOptions = {}): Promise<PaymentLinkView> {
        const order = await this.prisma.order.findFirst({
            where: { id: orderId, organizationId: orgId, deletedAt: null },
            include: { customer: { select: { firstName: true, lastName: true, email: true, phone: true } } },
        });
        if (!order) throw new NotFoundException('Order not found');
        if (order.cancelledAt) throw new BadRequestException(`Order ${order.name} is cancelled.`);
        if (order.financialStatus === OrderFinancialStatus.PAID || order.financialStatus === OrderFinancialStatus.REFUNDED || order.financialStatus === OrderFinancialStatus.PARTIALLY_REFUNDED) {
            throw new BadRequestException(`Order ${order.name} is already paid.`);
        }
        if (order.financialStatus === OrderFinancialStatus.PARTIALLY_PAID) {
            throw new BadRequestException(`Order ${order.name} is partly paid; collect the rest from the order page.`);
        }
        const reused = await this.reuse(orgId, { orderId }, order.totalPrice);
        if (reused) return reused;
        const country = countryCodeOf(order.shippingAddress) ?? countryCodeOf(order.billingAddress);
        return this.create(orgId, {
            amount: order.totalPrice,
            currency: order.currency,
            description: `Order ${order.name}`,
            orderId: order.id,
            customerId: order.customerId,
            customer: {
                name: [order.customer?.firstName, order.customer?.lastName].filter(Boolean).join(' ') || undefined,
                email: order.customer?.email ?? undefined,
                contact: razorpayContact(normalizePhone(phoneOf(order.shippingAddress) ?? phoneOf(order.billingAddress) ?? order.customer?.phone, country)),
            },
            notes: { order: order.name },
        }, opts);
    }

    async forDraft(orgId: string, draftId: string, opts: LinkOptions = {}): Promise<PaymentLinkView> {
        const draft = await this.prisma.draftOrder.findFirst({
            where: { id: draftId, organizationId: orgId, deletedAt: null },
            include: { customer: { select: { firstName: true, lastName: true, email: true, phone: true } } },
        });
        if (!draft) throw new NotFoundException('Draft order not found');
        if (draft.status !== DraftOrderStatus.OPEN && draft.status !== DraftOrderStatus.INVOICE_SENT) {
            throw new BadRequestException('This draft order is already completed.');
        }
        const reused = await this.reuse(orgId, { draftOrderId: draftId }, draft.totalPrice);
        if (reused) return reused;
        return this.create(orgId, {
            amount: draft.totalPrice,
            currency: draft.currency,
            description: draft.name ? `Order ${draft.name}` : 'Your order',
            draftOrderId: draft.id,
            customerId: draft.customerId,
            customer: {
                name: [draft.customer?.firstName, draft.customer?.lastName].filter(Boolean).join(' ') || undefined,
                email: draft.customer?.email ?? draft.customerEmail ?? undefined,
                contact: razorpayContact(normalizePhone(draft.customer?.phone)),
            },
            notes: draft.name ? { draft: draft.name } : {},
        }, opts);
    }

    /** An amount typed in the inbox, not tied to an order. */
    async forAmount(orgId: string, input: { amount: number; description: string; customerId: string | null; phone: string | null; name: string | null }, opts: LinkOptions = {}): Promise<PaymentLinkView> {
        const org = await this.prisma.organization.findUnique({ where: { id: orgId }, select: { currency: true } });
        return this.create(orgId, {
            amount: new Prisma.Decimal(input.amount),
            currency: org?.currency ?? 'INR',
            description: input.description,
            customerId: input.customerId,
            customer: { name: input.name ?? undefined, contact: razorpayContact(normalizePhone(input.phone)) },
            notes: {},
        }, opts);
    }

    async list(orgId: string, where: { conversationId?: string; orderId?: string }): Promise<PaymentLinkView[]> {
        const rows = await this.prisma.paymentLink.findMany({ where: { organizationId: orgId, ...where }, orderBy: { createdAt: 'desc' }, take: 20 });
        return rows.map((r) => this.toView(r));
    }

    async get(orgId: string, id: string): Promise<PaymentLink> {
        const link = await this.prisma.paymentLink.findFirst({ where: { id, organizationId: orgId } });
        if (!link) throw new NotFoundException('Payment link not found');
        return link;
    }

    /** Ask Razorpay, for when its webhook has not arrived. WhatsApp Pay requests are checked by WhatsAppPayService. */
    async refresh(orgId: string, id: string): Promise<PaymentLinkView> {
        const link = await this.get(orgId, id);
        if (link.provider !== PaymentProvider.RAZORPAY || !link.accountId) throw new BadRequestException('This is not a Razorpay link.');
        const account = await this.prisma.paymentAccount.findUniqueOrThrow({ where: { id: link.accountId } });
        if (!account.credentials || account.disconnectedAt) throw new BadRequestException('Reconnect Razorpay in Settings → Orders → Payments to check this link.');
        const entity = await this.razorpay.fetch(this.accounts.keys(account), link.externalId);
        const payment = entity.payments?.find((p) => p.status === 'captured') ?? entity.payments?.[0];
        await this.apply(link, entity, payment ? { id: payment.payment_id, method: payment.method } : null);
        await this.idle();
        return this.toView(await this.get(orgId, id));
    }

    async cancel(orgId: string, id: string): Promise<PaymentLinkView> {
        const link = await this.get(orgId, id);
        if (link.provider !== PaymentProvider.RAZORPAY) throw new BadRequestException('A WhatsApp Pay request cannot be cancelled; it expires by itself.');
        if (!OPEN.includes(link.status)) throw new BadRequestException('Only an unpaid link can be cancelled.');
        const account = await this.accounts.require(orgId);
        const entity = await this.razorpay.cancel(this.accounts.keys(account), link.externalId);
        await this.apply(link, entity, null);
        return this.toView(await this.get(orgId, id));
    }

    /**
     * POST /webhooks/razorpay/merchant/:token. The token picks the account,
     * the account's webhook secret checks the signature, and only that
     * account's links can be touched.
     */
    async webhook(token: string, rawBody: Buffer | undefined, signature: string | undefined): Promise<{ received: boolean }> {
        const account = await this.prisma.paymentAccount.findUnique({ where: { webhookToken: token } });
        if (!account) throw new NotFoundException();
        const secret = this.accounts.webhookSecret(account);
        if (!secret || !rawBody || !signature || !razorpaySignatureValid(rawBody, signature, secret)) {
            throw new UnauthorizedException('Signature does not match this account’s webhook secret.');
        }
        await this.prisma.paymentAccount.update({ where: { id: account.id }, data: { lastWebhookAt: new Date() } });
        const body = JSON.parse(rawBody.toString()) as {
            event?: string;
            payload?: { payment_link?: { entity?: RazorpayPaymentLink }; payment?: { entity?: { id?: string; method?: string } } };
        };
        const entity = body.payload?.payment_link?.entity;
        if (!entity?.id) return { received: true };
        const link = await this.prisma.paymentLink.findUnique({ where: { accountId_externalId: { accountId: account.id, externalId: entity.id } } });
        // A link made outside Collabo, in the same Razorpay account.
        if (!link) return { received: true };
        const payment = body.payload?.payment?.entity;
        await this.apply(link, entity, payment?.id ? { id: payment.id, method: payment.method ?? null } : null);
        return { received: true };
    }

    /** Follow-ups still running; awaited on shutdown so a paid order is not left behind. */
    async idle(): Promise<void> {
        await Promise.all([...this.running]);
    }

    onApplicationShutdown(): Promise<void> {
        return this.idle();
    }

    /** Links whose webhook never came: ask Razorpay, oldest-checked first. Then paid links whose follow-up never finished. */
    async sweep(limit = 25): Promise<number> {
        const now = Date.now();
        const unfinished = await this.prisma.paymentLink.findMany({
            where: { status: PaymentLinkStatus.PAID, followedUpAt: null, paidAt: { lt: new Date(now - 5 * 60_000) } },
            take: limit,
        });
        for (const link of unfinished) await this.followUp(link);
        const due = await this.prisma.paymentLink.findMany({
            where: { provider: PaymentProvider.RAZORPAY, status: { in: OPEN }, createdAt: { gt: new Date(now - 7 * 86_400_000) }, updatedAt: { lt: new Date(now - 10 * 60_000) } },
            orderBy: { updatedAt: 'asc' },
            take: limit,
        });
        for (const link of due) {
            try {
                await this.refresh(link.organizationId, link.id);
            } catch (err) {
                this.logger.warn(`Payment link ${link.id} not checked: ${err instanceof Error ? err.message : err}`);
            }
            // Checked, changed or not: wait another round before asking again.
            await this.prisma.paymentLink.updateMany({ where: { id: link.id, status: { in: OPEN } }, data: { updatedAt: new Date() } });
        }
        return due.length + unfinished.length;
    }

    // ─── Internals ─────────────────────────────────────────────────────

    /** An open link for the same order or draft and amount, so a second click does not make another. */
    private async reuse(orgId: string, target: { orderId?: string; draftOrderId?: string }, amount: Prisma.Decimal): Promise<PaymentLinkView | null> {
        const open = await this.prisma.paymentLink.findFirst({
            where: { organizationId: orgId, ...target, status: PaymentLinkStatus.CREATED, expiresAt: { gt: new Date(Date.now() + 3_600_000) } },
            orderBy: { createdAt: 'desc' },
        });
        return open && open.amount.equals(amount) ? { ...this.toView(open), existing: true } : null;
    }

    private async create(
        orgId: string,
        input: {
            amount: Prisma.Decimal;
            currency: string;
            description: string;
            orderId?: string;
            draftOrderId?: string;
            customerId: string | null;
            customer: { name?: string; email?: string; contact?: string };
            notes: Record<string, string>;
        },
        opts: LinkOptions,
    ): Promise<PaymentLinkView> {
        if (input.currency !== 'INR') throw new BadRequestException(`Payment links are in rupees; this is in ${input.currency}.`);
        const paise = toPaise(input.amount);
        if (paise < MIN_PAISE) throw new BadRequestException('A payment link is for at least ₹1.');
        const account = await this.accounts.require(orgId);
        const hours = Math.min(Math.max(Math.round(opts.expiresInHours ?? 48), 1), MAX_LINK_HOURS);
        const expiresAt = new Date(Date.now() + hours * 3_600_000);
        const referenceId = `cl_${randomBytes(12).toString('base64url')}`;
        const keys = this.accounts.keys(account);
        let entity: RazorpayPaymentLink;
        try {
            entity = await this.razorpay.create(keys, {
                amount: paise,
                currency: 'INR',
                reference_id: referenceId,
                description: input.description.slice(0, 2048),
                customer: Object.fromEntries(Object.entries(input.customer).filter(([, v]) => v)) as typeof input.customer,
                expire_by: Math.floor(expiresAt.getTime() / 1000),
                notes: Object.fromEntries(Object.entries({ ...input.notes, collabo_reference: referenceId }).map(([k, v]) => [k, v.slice(0, 255)])),
            });
        } catch (err) {
            if (err instanceof RazorpayApiError) throw new BadRequestException(`Razorpay refused the link: ${err.message}`);
            throw err;
        }
        let row: PaymentLink;
        try {
            row = await this.prisma.paymentLink.create({
                data: {
                    organizationId: orgId,
                    accountId: account.id,
                    provider: PaymentProvider.RAZORPAY,
                    externalId: entity.id,
                    shortUrl: entity.short_url,
                    referenceId,
                    amount: fromPaise(paise),
                    currency: 'INR',
                    description: input.description,
                    orderId: input.orderId ?? null,
                    draftOrderId: input.draftOrderId ?? null,
                    customerId: input.customerId,
                    contactId: opts.contactId ?? null,
                    conversationId: opts.conversationId ?? null,
                    automationRunId: opts.automationRunId ?? null,
                    createdById: opts.userId ?? null,
                    tagOnPaid: opts.tagOnPaid?.trim() || null,
                    expiresAt,
                },
            });
        } catch (err) {
            // A payable link we cannot track would take money we never record.
            await this.razorpay.cancel(keys, entity.id).catch(() => undefined);
            throw err;
        }
        await this.closeOthers(row, 'replaced').catch((err) => this.logger.warn(`Older payment links for ${row.id} not closed: ${err instanceof Error ? err.message : err}`));
        return this.toView(row);
    }

    /** Cancelled orders take no payment: their open Razorpay links are cancelled too. */
    private async orderCancelled(orderId: string): Promise<void> {
        const open = await this.prisma.paymentLink.findMany({
            where: { provider: PaymentProvider.RAZORPAY, status: PaymentLinkStatus.CREATED, OR: [{ orderId }, { draftOrder: { completedOrderId: orderId } }] },
        });
        for (const link of open) await this.cancelAtRazorpay(link);
    }

    /** Best effort: a link that cannot be cancelled and is then paid is caught by `refundNeeded`. */
    private async cancelAtRazorpay(link: PaymentLink): Promise<void> {
        try {
            const account = link.accountId ? await this.prisma.paymentAccount.findUnique({ where: { id: link.accountId } }) : null;
            if (!account?.credentials || account.disconnectedAt) throw new Error('Razorpay is not connected');
            await this.apply(link, await this.razorpay.cancel(this.accounts.keys(account), link.externalId), null);
        } catch (err) {
            this.logger.warn(`Payment link ${link.id} was left open: ${err instanceof Error ? err.message : err}`);
        }
    }

    /**
     * Take Razorpay's state of a link. Paid is claimed once (whoever gets
     * there first, webhook or sweep, does the follow-up), and a paid link
     * never goes back.
     */
    private async apply(link: PaymentLink, entity: RazorpayPaymentLink, payment: { id: string; method: string | null } | null): Promise<void> {
        const status = statusFromRazorpay(entity.status);
        if (!status) return;
        await this.settle(link, { status, amountPaidPaise: entity.amount_paid ?? 0, currency: entity.currency, paymentId: payment?.id ?? null, method: payment?.method ?? null, source: 'Razorpay' });
    }

    /**
     * Take the gateway's state of a link or WhatsApp Pay request. Paid is
     * claimed once (whoever gets there first does the follow-up), only for the
     * full amount, and a paid link never goes back. True when this call
     * claimed the payment.
     */
    async settle(
        link: PaymentLink,
        outcome: { status: PaymentLinkStatus; amountPaidPaise: number; currency: string; paymentId: string | null; method: string | null; source: string },
    ): Promise<boolean> {
        const { status } = outcome;
        if (status === link.status || link.status === PaymentLinkStatus.PAID) return false;
        if (status !== PaymentLinkStatus.PAID) {
            await this.prisma.paymentLink.updateMany({
                where: { id: link.id, status: { not: PaymentLinkStatus.PAID } },
                data: { status, amountPaid: fromPaise(outcome.amountPaidPaise) },
            });
            return false;
        }
        if (outcome.amountPaidPaise !== toPaise(link.amount) || outcome.currency !== link.currency) {
            await this.prisma.paymentLink.update({
                where: { id: link.id },
                data: { followUpError: `${outcome.source} reported ${outcome.amountPaidPaise / 100} ${outcome.currency} paid on a link for ${link.amount} ${link.currency}; the order was not marked paid.` },
            });
            return false;
        }
        const claimed = await this.prisma.paymentLink.updateMany({
            where: { id: link.id, status: { not: PaymentLinkStatus.PAID } },
            data: { status: PaymentLinkStatus.PAID, paidAt: new Date(), amountPaid: link.amount, paymentId: outcome.paymentId, paymentMethod: outcome.method },
        });
        if (claimed.count) void this.followUp({ ...link, paymentId: outcome.paymentId, paymentMethod: outcome.method });
        return claimed.count > 0;
    }

    /** Runs the follow-up once per call, tracked so shutdown and "Check status" can wait for it. */
    private followUp(link: PaymentLink): Promise<void> {
        const task = this.afterPaid(link)
            .catch((err) => this.logger.error(`Payment link ${link.id} follow-up crashed: ${err instanceof Error ? err.message : err}`))
            .finally(() => this.running.delete(task));
        this.running.add(task);
        return task;
    }

    /** The order or draft follows the payment. A failure is kept on the link; the payment stands. */
    private async afterPaid(link: PaymentLink): Promise<void> {
        // A second payment, or one for a cancelled order, has to go back to the
        // customer. Nothing about the order follows it, and no "payment
        // received" message goes out.
        const refund = await this.refundNeeded(link);
        if (refund) {
            this.logger.warn(`Payment link ${link.id} paid, refund needed: ${refund.message}`);
            await this.prisma.paymentLink.update({ where: { id: link.id }, data: { followedUpAt: new Date(), followUpError: refund.message } });
            if (refund.orderId) {
                await this.prisma.orderTimelineEvent
                    .create({ data: { orderId: refund.orderId, action: 'payment_refund_needed', message: refund.message, metadata: { paymentLinkId: link.id, paymentId: link.paymentId } } })
                    .catch((err) => this.logger.warn(`Refund note for payment link ${link.id} not added to the order: ${err instanceof Error ? err.message : err}`));
            }
            return;
        }
        const problems: string[] = [];
        let orderId = link.orderId;
        try {
            const actor = await this.store.actorFor(link.organizationId, link.createdById);
            const via = `Paid online with ${link.provider === PaymentProvider.WHATSAPP_PAY ? 'WhatsApp Pay' : 'a Razorpay payment link'}${link.paymentId ? ` (${link.paymentId})` : ''}`;
            if (link.orderId) {
                const order = await this.prisma.order.findUnique({ where: { id: link.orderId }, select: { financialStatus: true } });
                if (order && order.financialStatus !== OrderFinancialStatus.PAID) await this.orders.markPaid(link.orderId, link.organizationId, actor, via);
                if (link.tagOnPaid) await this.store.tagOrder(link.organizationId, link.orderId, link.tagOnPaid, actor);
            } else if (link.draftOrderId) {
                const done = await this.drafts.complete(link.draftOrderId, link.organizationId, actor, {
                    paymentPending: false,
                    paymentMethod: draftPaymentMethod(link.paymentMethod),
                    generateInvoice: true,
                });
                orderId = (done as { order?: { id?: string } | null }).order?.id ?? null;
            }
        } catch (err) {
            problems.push(err instanceof Error ? err.message : String(err));
        }
        if (problems.length) this.logger.warn(`Payment link ${link.id} paid, follow-up failed: ${problems.join('; ')}`);
        await this.closeOthers(link, 'paid').catch((err) => this.logger.warn(`Other payment links for ${link.id} not closed: ${err instanceof Error ? err.message : err}`));
        await this.prisma.paymentLink.update({
            where: { id: link.id },
            data: {
                followedUpAt: new Date(),
                ...(problems.length ? { followUpError: problems.join('; ').slice(0, 1000) } : {}),
                ...(orderId && orderId !== link.orderId ? { orderId } : {}),
            },
        });
        await this.events.paymentReceived({
            organizationId: link.organizationId,
            linkId: link.id,
            orderId,
            customerId: link.customerId,
            contactId: link.contactId,
            vars: {
                ...paymentVars(link),
                'payment.method': link.paymentMethod ?? '',
                'payment.id': link.paymentId ?? '',
                'payment.description': link.description,
            },
        });
    }

    /**
     * Why this payment has to be refunded: another link or bill for the same
     * order or draft was paid first, or the order was cancelled. Null when it
     * is the payment that counts.
     */
    private async refundNeeded(link: PaymentLink): Promise<{ message: string; orderId: string | null } | null> {
        if (!link.orderId && !link.draftOrderId) return null;
        const amount = formatMoney(link.amount.toString(), link.currency);
        const from = link.provider === PaymentProvider.WHATSAPP_PAY ? 'the payment gateway linked to WhatsApp Pay' : 'your Razorpay dashboard';
        const self = await this.prisma.paymentLink.findUnique({ where: { id: link.id }, select: { paidAt: true } });
        const paidAt = self?.paidAt ?? new Date();
        const earlier = await this.prisma.paymentLink.findFirst({
            where: {
                organizationId: link.organizationId,
                status: PaymentLinkStatus.PAID,
                id: { not: link.id },
                ...(link.orderId ? { orderId: link.orderId } : { draftOrderId: link.draftOrderId }),
                // The first payment counts; a tie on the instant goes to the lower id.
                OR: [{ paidAt: { lt: paidAt } }, { paidAt, id: { lt: link.id } }],
            },
            orderBy: { paidAt: 'asc' },
        });
        if (earlier) {
            const what = earlier.provider === PaymentProvider.WHATSAPP_PAY ? 'a WhatsApp Pay bill' : 'another payment link';
            const draft = link.draftOrderId && !link.orderId
                ? await this.prisma.draftOrder.findUnique({ where: { id: link.draftOrderId }, select: { completedOrderId: true } })
                : null;
            return {
                message: `This is a second payment: ${what} for this ${link.orderId ? 'order' : 'draft order'} was already paid${earlier.paymentId ? ` (${earlier.paymentId})` : ''}. Refund ${amount} to the customer from ${from}.`,
                orderId: link.orderId ?? draft?.completedOrderId ?? earlier.orderId ?? null,
            };
        }
        if (link.orderId) {
            const order = await this.prisma.order.findUnique({ where: { id: link.orderId }, select: { name: true, cancelledAt: true } });
            if (order?.cancelledAt) {
                return { message: `Order ${order.name} was cancelled before this payment came in. Refund ${amount} to the customer from ${from}.`, orderId: link.orderId };
            }
        }
        return null;
    }

    toView(r: PaymentLink): PaymentLinkView {
        return {
            id: r.id,
            provider: r.provider,
            shortUrl: r.shortUrl,
            amount: r.amount.toString(),
            currency: r.currency,
            description: r.description,
            status: r.status,
            orderId: r.orderId,
            draftOrderId: r.draftOrderId,
            expiresAt: r.expiresAt,
            paidAt: r.paidAt,
            paymentMethod: r.paymentMethod,
            followUpError: r.followUpError,
            createdAt: r.createdAt,
        };
    }
}
