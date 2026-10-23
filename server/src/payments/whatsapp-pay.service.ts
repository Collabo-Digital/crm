import { randomBytes } from 'node:crypto';
import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { ChannelPlatform, DraftOrderStatus, OrderFinancialStatus, PaymentLink, PaymentLinkStatus, PaymentProvider, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MetaGraphClient } from '../channel/meta-graph.client';
import { patchChannelMetadataSql } from '../channel/channel-metadata.util';
import { ChannelAccessService } from '../messaging/channel-access.service';
import { MessagingSendService, SendOutcome } from '../messaging/send/messaging-send.service';
import { Priority } from '../rate-limit/rate-limit.types';
import { CommerceEventsService } from '../commerce/commerce-events.service';
import { formatMoney } from '../commerce/order-vars';
import type { StoreEventKind } from '../commerce/order-vars';
import { PaymentLinksService, PaymentLinkView } from './payment-links.service';
import { MAX_LINK_HOURS, toPaise } from './payment-link.util';
import { BillLine, ORDER_DETAILS_MAX_PAISE, buildOrderDetails, configurationActive, indianAddress } from './whatsapp-pay.util';

/** The number's chosen payment configuration, kept in channel metadata. */
interface PayState {
    configurationName: string;
    provider: string;
    status: string;
    selectedAt: string;
}

export interface PaymentConfiguration {
    name: string;
    provider: string | null;
    status: string;
    active: boolean;
}

export interface RequestOptions {
    conversationId: string;
    contactId: string;
    userId?: string | null;
    automationRunId?: string | null;
    automation?: { automationId: string; runId: string; stepKey: string } | null;
    origin: 'agent' | 'automation';
    text?: string;
    expiresInHours?: number;
    tagOnPaid?: string | null;
}

/** Gateways Meta links in WhatsApp Manager and reports payments for. */
const GATEWAYS = ['razorpay', 'payu', 'billdesk', 'zaakpay'];
const ORDER_PAGE: Partial<Record<StoreEventKind, 'shipped' | 'completed'>> = { fulfilled: 'shipped', delivered: 'completed' };

/**
 * WhatsApp Pay (India): a "Review and Pay" bill in the chat, paid through the
 * gateway the merchant linked to their WhatsApp account in WhatsApp Manager
 * (Razorpay, PayU, BillDesk or Zaakpay). Meta reports the payment by webhook;
 * it is confirmed with Meta's lookup API before the order follows, the same
 * way a paid payment link does. The customer's order page in WhatsApp is kept
 * up to date with order_status messages.
 */
@Injectable()
export class WhatsAppPayService implements OnModuleInit {
    private readonly logger = new Logger(WhatsAppPayService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly access: ChannelAccessService,
        private readonly metaGraph: MetaGraphClient,
        private readonly sender: MessagingSendService,
        private readonly links: PaymentLinksService,
        private readonly events: CommerceEventsService,
    ) { }

    onModuleInit() {
        this.events.onOrder((orderId, kinds) => this.orderChanged(orderId, kinds));
    }

    // ─── Settings ──────────────────────────────────────────────────────

    async view(orgId: string, channelId: string) {
        const channel = await this.channel(orgId, channelId);
        const selected = this.state(channel.metadata);
        let configurations: PaymentConfiguration[] = [];
        let error: string | null = null;
        try {
            configurations = await this.configurations(channelId);
        } catch (err) {
            error = err instanceof Error ? err.message : String(err);
        }
        const current = selected ? configurations.find((c) => c.name === selected.configurationName) : undefined;
        return {
            selected: selected ? { ...selected, ...(current ? { status: current.status, active: current.active } : { active: configurationActive(selected.status) }) } : null,
            configurations,
            error,
        };
    }

    /** A new payment configuration in WhatsApp Manager; a gateway one returns the link where the merchant connects their gateway account. */
    async createConfiguration(orgId: string, channelId: string, input: { name: string; provider: string; redirectUrl?: string }) {
        await this.channel(orgId, channelId);
        const provider = input.provider.toLowerCase();
        if (!GATEWAYS.includes(provider)) throw new BadRequestException('Choose Razorpay, PayU, BillDesk or Zaakpay.');
        const a = await this.access.get(channelId);
        const res = await this.graph<{ oauth_url?: string; expiration?: number; success?: boolean }>(channelId, 'POST', `/${a.wabaId}/payment_configuration`, {
            configuration_name: input.name,
            provider_name: provider,
            ...(input.redirectUrl ? { redirect_url: input.redirectUrl } : {}),
        });
        return { oauthUrl: res.oauth_url ?? null, expiresAt: res.expiration ? new Date(res.expiration * 1000).toISOString() : null };
    }

    /** A fresh link to connect the gateway, when the first one expired. */
    async linkAgain(orgId: string, channelId: string, name: string) {
        await this.channel(orgId, channelId);
        const a = await this.access.get(channelId);
        const res = await this.graph<{ oauth_url?: string; expiration?: number }>(channelId, 'POST', `/${a.wabaId}/generate_payment_configuration_oauth_link`, { configuration_name: name });
        return { oauthUrl: res.oauth_url ?? null, expiresAt: res.expiration ? new Date(res.expiration * 1000).toISOString() : null };
    }

    /** Use this configuration for the number's WhatsApp Pay requests; null turns WhatsApp Pay off. */
    async select(orgId: string, channelId: string, name: string | null) {
        await this.channel(orgId, channelId);
        if (!name) {
            await this.prisma.$executeRaw(Prisma.sql`UPDATE "channels" SET "metadata" = "metadata" - 'whatsappPay', "updated_at" = now() WHERE "id" = ${channelId}`);
            return this.view(orgId, channelId);
        }
        const found = (await this.configurations(channelId)).find((c) => c.name === name);
        if (!found) throw new NotFoundException(`There is no payment configuration “${name}” on this WhatsApp account.`);
        if (!found.active) throw new BadRequestException(`“${name}” is not ready in WhatsApp Manager (${found.status.replace(/_/g, ' ').toLowerCase()}). Connect and test it there first.`);
        if (!found.provider || !GATEWAYS.includes(found.provider)) throw new BadRequestException('Choose a configuration linked to a payment gateway, so payments are reported back.');
        const state: PayState = { configurationName: found.name, provider: found.provider, status: found.status, selectedAt: new Date().toISOString() };
        await this.prisma.$executeRaw(patchChannelMetadataSql(channelId, 'whatsappPay', state as unknown as Record<string, unknown>));
        return this.view(orgId, channelId);
    }

    /** `payment_configuration_update`: keep the chosen configuration's status current. */
    async onConfigurationUpdate(channelId: string, update: { name: string | null; status: string | null }) {
        const channel = await this.prisma.channel.findUnique({ where: { id: channelId }, select: { metadata: true } });
        const state = this.state(channel?.metadata ?? null);
        if (!state || !update.name || state.configurationName !== update.name || !update.status) return;
        await this.prisma.$executeRaw(patchChannelMetadataSql(channelId, 'whatsappPay', { status: update.status }));
    }

    /** Whether this number can send WhatsApp Pay requests now. */
    async available(channelId: string | null): Promise<boolean> {
        if (!channelId) return false;
        const channel = await this.prisma.channel.findUnique({ where: { id: channelId }, select: { platform: true, metadata: true } });
        const state = channel?.platform === ChannelPlatform.WHATSAPP ? this.state(channel.metadata) : null;
        return !!state && configurationActive(state.status);
    }

    // ─── Requests ──────────────────────────────────────────────────────

    /**
     * Send a "Review and Pay" bill for an unpaid order or an open draft, in
     * the chat. Only inside the 24-hour window. A newer request for the same
     * order replaces an older unpaid one; a payment on the older one still
     * counts.
     */
    async request(orgId: string, target: { orderId?: string; draftOrderId?: string }, opts: RequestOptions): Promise<{ link: PaymentLinkView; outcome: SendOutcome }> {
        const conversation = await this.prisma.conversation.findFirst({
            where: { id: opts.conversationId, organizationId: orgId },
            select: { channelId: true, channel: { select: { platform: true, metadata: true } } },
        });
        if (!conversation || conversation.channel.platform !== ChannelPlatform.WHATSAPP) throw new BadRequestException('WhatsApp Pay requests go on WhatsApp only.');
        const state = this.state(conversation.channel.metadata);
        if (!state || !configurationActive(state.status)) {
            throw new BadRequestException('Turn on WhatsApp Pay for this number in Campaigns → Catalog first.');
        }
        if (opts.automationRunId) {
            const sent = await this.prisma.paymentLink.findFirst({ where: { automationRunId: opts.automationRunId, provider: PaymentProvider.WHATSAPP_PAY, ...target } });
            if (sent) return { link: this.links.toView(sent), outcome: { ok: true, messageId: '', duplicate: true } };
        }

        const bill = target.orderId ? await this.orderBill(orgId, target.orderId) : target.draftOrderId ? await this.draftBill(orgId, target.draftOrderId) : null;
        if (!bill) throw new BadRequestException('Choose the order or draft order to collect payment for.');
        if (bill.currency !== 'INR') throw new BadRequestException(`WhatsApp Pay is in rupees; this is in ${bill.currency}.`);
        const totalPaise = toPaise(bill.total);
        if (totalPaise > ORDER_DETAILS_MAX_PAISE) throw new BadRequestException('WhatsApp Pay requests are capped at ₹5,00,000 by UPI. Send a payment link instead.');
        const beneficiary = indianAddress(bill.address, bill.buyerName);
        if (!beneficiary) {
            throw new BadRequestException('WhatsApp Pay needs a delivery address in India with a 6-digit PIN code. Add it to the order or draft order first; a payment link does not need one.');
        }

        const catalogId = ((conversation.channel.metadata as { catalog?: { catalogId?: string } } | null)?.catalog?.catalogId) ?? null;
        const synced = catalogId
            ? new Set((await this.prisma.catalogItem.findMany({
                where: { channelId: conversation.channelId, status: 'SYNCED', variantId: { in: bill.lines.map((l) => l.variantId).filter((v): v is string => !!v) } },
                select: { variantId: true },
            })).map((c) => c.variantId))
            : new Set<string>();
        const lines: BillLine[] = bill.lines.map((l) => ({ name: l.name, unitPaise: toPaise(l.price), quantity: l.quantity, retailerId: l.variantId && synced.has(l.variantId) ? l.variantId : null }));
        const importer = lines.every((l) => l.retailerId) ? null : await this.importer(orgId);

        const hours = Math.min(Math.max(Math.round(opts.expiresInHours ?? 24), 1), MAX_LINK_HOURS);
        const expiresAt = new Date(Date.now() + hours * 3_600_000);
        const referenceId = `cw_${randomBytes(12).toString('base64url')}`;
        let parameters: Record<string, unknown>;
        try {
            parameters = buildOrderDetails({
                referenceId,
                lines,
                totalPaise,
                taxPaise: toPaise(bill.tax),
                shippingPaise: toPaise(bill.shipping),
                discountPaise: toPaise(bill.discount),
                catalogId,
                importer,
                beneficiary,
                configuration: { name: state.configurationName, provider: state.provider },
                receipt: bill.description,
                expiresAt,
            });
        } catch (err) {
            throw new BadRequestException(err instanceof Error ? err.message : String(err));
        }

        const row = await this.prisma.paymentLink.create({
            data: {
                organizationId: orgId,
                provider: PaymentProvider.WHATSAPP_PAY,
                channelId: conversation.channelId,
                paymentConfiguration: state.configurationName,
                externalId: referenceId,
                shortUrl: '',
                referenceId,
                amount: bill.total,
                currency: 'INR',
                description: bill.description,
                orderId: target.orderId ?? null,
                draftOrderId: target.draftOrderId ?? null,
                customerId: bill.customerId,
                contactId: opts.contactId,
                conversationId: opts.conversationId,
                automationRunId: opts.automationRunId ?? null,
                createdById: opts.userId ?? null,
                tagOnPaid: opts.tagOnPaid?.trim() || null,
                expiresAt,
            },
        });
        const amount = formatMoney(bill.total.toString(), 'INR');
        const outcome = await this.sender.send({
            organizationId: orgId,
            conversationId: opts.conversationId,
            payload: {
                type: 'order_details',
                text: (opts.text?.trim() || `${bill.description}: ${amount}. Tap below to review and pay in WhatsApp.`).slice(0, 1024),
                parameters,
                summary: `WhatsApp Pay request: ${bill.description}, ${amount}`,
            },
            origin: opts.origin,
            actorUserId: opts.userId ?? null,
            automation: opts.automation ?? null,
            idempotencyKey: opts.automation ? `auto:${opts.automation.runId}:${opts.automation.stepKey}` : `wapay:${row.id}`,
        });
        if (!outcome.ok) {
            // It never reached the customer, so there is nothing to track.
            await this.prisma.paymentLink.delete({ where: { id: row.id } });
            throw new BadRequestException(outcome.message);
        }
        // The older unpaid request is replaced; its payment, if it still comes, is still recorded.
        await this.prisma.paymentLink.updateMany({
            where: { organizationId: orgId, provider: PaymentProvider.WHATSAPP_PAY, status: PaymentLinkStatus.CREATED, id: { not: row.id }, ...target },
            data: { status: PaymentLinkStatus.CANCELLED },
        });
        return { link: this.links.toView(row), outcome };
    }

    /** A payment status from the webhook: confirmed with Meta's lookup before anything follows. */
    async onPayment(channelId: string, payment: { referenceId: string; status: string }) {
        const link = await this.prisma.paymentLink.findFirst({ where: { provider: PaymentProvider.WHATSAPP_PAY, channelId, referenceId: payment.referenceId } });
        if (!link) {
            this.logger.log(`WhatsApp Pay status for unknown reference ${payment.referenceId} on channel ${channelId}`);
            return;
        }
        await this.confirm(link);
    }

    /** "Check status" on a WhatsApp Pay request. */
    async refresh(orgId: string, id: string): Promise<PaymentLinkView> {
        const link = await this.links.get(orgId, id);
        if (link.provider !== PaymentProvider.WHATSAPP_PAY) throw new BadRequestException('This is not a WhatsApp Pay request.');
        await this.confirm(link);
        await this.links.idle();
        return this.links.toView(await this.links.get(orgId, id));
    }

    /** Requests whose webhook never came, and ones past their expiry. */
    async sweep(limit = 25): Promise<number> {
        const now = Date.now();
        const due = await this.prisma.paymentLink.findMany({
            where: { provider: PaymentProvider.WHATSAPP_PAY, status: PaymentLinkStatus.CREATED, createdAt: { gt: new Date(now - 7 * 86_400_000) }, updatedAt: { lt: new Date(now - 10 * 60_000) } },
            orderBy: { updatedAt: 'asc' },
            take: limit,
        });
        for (const link of due) {
            try {
                const paid = await this.confirm(link);
                if (!paid && link.expiresAt.getTime() < now) {
                    await this.prisma.paymentLink.updateMany({ where: { id: link.id, status: PaymentLinkStatus.CREATED }, data: { status: PaymentLinkStatus.EXPIRED } });
                }
            } catch (err) {
                this.logger.warn(`WhatsApp Pay request ${link.id} not checked: ${err instanceof Error ? err.message : err}`);
            }
            await this.prisma.paymentLink.updateMany({ where: { id: link.id, status: PaymentLinkStatus.CREATED }, data: { updatedAt: new Date() } });
        }
        return due.length;
    }

    // ─── Internals ─────────────────────────────────────────────────────

    /** GET /{phone_number_id}/payments/{configuration}/{reference_id}; settles a captured payment. True when it is paid. */
    private async confirm(link: PaymentLink): Promise<boolean> {
        if (!link.channelId || !link.paymentConfiguration) return false;
        const a = await this.access.get(link.channelId);
        const res = await this.graph<{
            payments?: Array<{ status?: string; currency?: string; amount?: { value?: number; offset?: number }; transactions?: Array<{ id?: string; status?: string; method?: { type?: string } }> }>;
        }>(link.channelId, 'GET', `/${a.address}/payments/${encodeURIComponent(link.paymentConfiguration)}/${encodeURIComponent(link.referenceId)}`);
        const p = res.payments?.[0];
        if (p?.status !== 'captured') return false;
        const txn = p.transactions?.find((t) => t.status === 'success') ?? p.transactions?.[0];
        const offset = p.amount?.offset ?? 100;
        const claimed = await this.links.settle(link, {
            status: PaymentLinkStatus.PAID,
            amountPaidPaise: Math.round(((p.amount?.value ?? 0) * 100) / offset),
            currency: p.currency ?? '',
            paymentId: txn?.id ?? null,
            method: txn?.method?.type ?? null,
            source: 'WhatsApp Pay',
        });
        if (claimed) await this.orderStatus(link, 'processing', 'Payment received. We are preparing your order.');
        return true;
    }

    /** Shipped and delivered orders that were paid by WhatsApp Pay update the order page; an unpaid request on a cancelled order is closed. */
    private async orderChanged(orderId: string, kinds: StoreEventKind[]) {
        const requests = await this.prisma.paymentLink.findMany({
            where: { provider: PaymentProvider.WHATSAPP_PAY, OR: [{ orderId }, { draftOrder: { completedOrderId: orderId } }] },
        });
        for (const link of requests) {
            if (link.status === PaymentLinkStatus.PAID) {
                for (const kind of kinds) {
                    const status = ORDER_PAGE[kind];
                    if (status) await this.orderStatus(link, status, status === 'shipped' ? 'Your order is on its way.' : 'Your order was delivered.');
                }
            } else if (link.status === PaymentLinkStatus.CREATED && kinds.includes('cancelled')) {
                // A paid order cannot be marked cancelled on the order page (Meta error 2047); an unpaid one can.
                await this.orderStatus(link, 'canceled', 'This order was cancelled.');
                await this.prisma.paymentLink.updateMany({ where: { id: link.id, status: PaymentLinkStatus.CREATED }, data: { status: PaymentLinkStatus.CANCELLED } });
            }
        }
    }

    /** One order_status message per request and status; outside the 24-hour window WhatsApp refuses it and that is logged. */
    private async orderStatus(link: PaymentLink, status: 'processing' | 'shipped' | 'completed' | 'canceled', text: string) {
        if (!link.conversationId) return;
        const outcome = await this.sender.send({
            organizationId: link.organizationId,
            conversationId: link.conversationId,
            payload: { type: 'order_status', text, referenceId: link.referenceId, status },
            origin: 'system',
            idempotencyKey: `wapay:${link.id}:${status}`,
        });
        if (!outcome.ok) this.logger.log(`WhatsApp Pay order page for ${link.id} not updated to ${status}: ${outcome.message}`);
    }

    private async orderBill(orgId: string, orderId: string) {
        const order = await this.prisma.order.findFirst({
            where: { id: orderId, organizationId: orgId, deletedAt: null },
            include: { lineItems: true, customer: { select: { firstName: true, lastName: true, defaultAddress: true } } },
        });
        if (!order) throw new NotFoundException('Order not found');
        if (order.cancelledAt) throw new BadRequestException(`Order ${order.name} is cancelled.`);
        if (order.financialStatus !== OrderFinancialStatus.PENDING && order.financialStatus !== OrderFinancialStatus.AUTHORIZED) {
            throw new BadRequestException(`Order ${order.name} is not waiting for payment.`);
        }
        return {
            description: `Order ${order.name}`,
            currency: order.currency,
            total: order.totalPrice,
            tax: order.totalTax,
            shipping: order.totalShippingPrice,
            discount: order.totalDiscounts,
            customerId: order.customerId,
            buyerName: [order.customer?.firstName, order.customer?.lastName].filter(Boolean).join(' ') || null,
            address: order.shippingAddress ?? order.billingAddress ?? order.customer?.defaultAddress ?? null,
            lines: order.lineItems.map((l) => ({ name: [l.title, l.variantTitle].filter((x) => x && x !== 'Default Title').join(' – '), price: l.price, quantity: l.quantity, variantId: l.variantId })),
        };
    }

    private async draftBill(orgId: string, draftId: string) {
        const draft = await this.prisma.draftOrder.findFirst({
            where: { id: draftId, organizationId: orgId, deletedAt: null },
            include: { lineItems: true, customer: { select: { firstName: true, lastName: true, defaultAddress: true } } },
        });
        if (!draft) throw new NotFoundException('Draft order not found');
        if (draft.status !== DraftOrderStatus.OPEN && draft.status !== DraftOrderStatus.INVOICE_SENT) throw new BadRequestException('This draft order is already completed.');
        return {
            description: draft.name ? `Order ${draft.name}` : 'Your order',
            currency: draft.currency,
            total: draft.totalPrice,
            tax: draft.totalTax,
            shipping: draft.totalShippingPrice,
            discount: draft.totalDiscounts,
            customerId: draft.customerId,
            buyerName: [draft.customer?.firstName, draft.customer?.lastName].filter(Boolean).join(' ') || null,
            address: draft.shippingAddress ?? draft.billingAddress ?? draft.customer?.defaultAddress ?? null,
            lines: draft.lineItems.map((l) => ({ name: [l.title, l.variantTitle].filter((x) => x && x !== 'Default Title').join(' – '), price: l.price, quantity: l.quantity, variantId: l.variantId })),
        };
    }

    /** Items outside the catalog name their importer: the organization's default GST registration. */
    private async importer(orgId: string) {
        const gstin = await this.prisma.organizationGstin.findFirst({ where: { organizationId: orgId, isActive: true }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }] });
        const address = gstin ? indianAddress({ ...(gstin.address as Record<string, unknown> | null), province: (gstin.address as { province?: string } | null)?.province ?? gstin.stateName }, gstin.legalName) : null;
        if (!gstin || !address) {
            throw new BadRequestException('Some items are not in this number’s WhatsApp catalog, so WhatsApp Pay needs the importer’s name and address: add your GSTIN with its address under Tax & GST, or sync the catalog.');
        }
        return { name: gstin.legalName, address };
    }

    private async configurations(channelId: string): Promise<PaymentConfiguration[]> {
        const a = await this.access.get(channelId);
        const res = await this.graph<{ data?: Array<{ payment_configurations?: Array<{ configuration_name?: string; provider_name?: string; status?: string }> }> }>(
            channelId, 'GET', `/${a.wabaId}/payment_configurations`,
        );
        return (res.data ?? []).flatMap((d) => d.payment_configurations ?? []).filter((c) => c.configuration_name).map((c) => ({
            name: c.configuration_name!,
            provider: c.provider_name?.toLowerCase() ?? null,
            status: c.status ?? 'Unknown',
            active: configurationActive(c.status),
        }));
    }

    private async graph<T>(channelId: string, method: 'GET' | 'POST', path: string, body?: Record<string, unknown>): Promise<T> {
        const a = await this.access.get(channelId);
        try {
            return (await this.metaGraph.request<T>({ method, path, ...(body ? { body } : {}), accessToken: a.token, scopes: a.scopes, priority: Priority.INTERACTIVE, channelId })).data;
        } catch (err) {
            throw new BadRequestException(`Meta refused: ${err instanceof Error ? err.message : err}`);
        }
    }

    private async channel(orgId: string, channelId: string) {
        const channel = await this.prisma.channel.findFirst({ where: { id: channelId, organizationId: orgId, platform: ChannelPlatform.WHATSAPP }, select: { id: true, metadata: true } });
        if (!channel) throw new NotFoundException('WhatsApp number not found');
        return channel;
    }

    private state(metadata: Prisma.JsonValue | null): PayState | null {
        const s = (metadata as { whatsappPay?: PayState } | null)?.whatsappPay;
        return s?.configurationName ? s : null;
    }
}
