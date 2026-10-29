import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AutomationStatus, ChannelPlatform, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AutomationJobs } from '../messaging/automation-jobs';
import { countryCodeOf, normalizePhone } from '../common/phone.util';
import { StoreEventKind, checkoutVars, invoiceVars, isCashOnDelivery, orderVars, refundVars } from './order-vars';
import { storeLinkKey, storeLinkToken } from './store-links';

const isUniqueViolation = (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
const phoneOf = (address: unknown): string | null => {
    const a = address as { phone?: unknown } | null;
    return typeof a?.phone === 'string' && a.phone.trim() ? a.phone : null;
};

/**
 * Store events for automations: an order was placed, paid, shipped, out for
 * delivery, delivered, cancelled or refunded, a checkout was abandoned, an
 * invoice was issued or a payment link was paid. Raised only when an
 * active automation listens, once per order and kind, for the buyer's
 * contact on each listening channel — on WhatsApp the contact is created
 * from the order's phone number if new. Never throws: a store write must
 * not fail because messaging could not follow.
 *
 * Writes automation events directly rather than through the messaging
 * module, so the channel and order modules can use it without a cycle.
 */
@Injectable()
export class CommerceEventsService {
    private readonly logger = new Logger(CommerceEventsService.name);
    private readonly orderListeners: Array<(orderId: string, kinds: StoreEventKind[]) => Promise<StoreEventKind[] | void>> = [];
    private readonly paymentListeners: Array<(linkId: string) => Promise<void>> = [];
    /** Signs {{order.track_path}} and {{checkout.cart_path}}, as the bill links are signed. */
    private readonly linkKey: Buffer;

    constructor(
        private readonly prisma: PrismaService,
        private readonly jobs: AutomationJobs,
        config: ConfigService,
    ) {
        this.linkKey = storeLinkKey(config.get<string>('encryptionKey') || config.get<string>('jwt.accessSecret')!);
    }

    /**
     * Also told of every order event, whether or not an automation listens:
     * WhatsApp Pay keeps the customer's order page up to date this way. Lets
     * a module that depends on this one react without this one depending on it.
     * A listener returns the events it told the customer of itself, so the
     * automations set to skip those (skipWhatsAppPay) do not say them twice.
     */
    onOrder(listener: (orderId: string, kinds: StoreEventKind[]) => Promise<StoreEventKind[] | void>): void {
        this.orderListeners.push(listener);
    }

    /** Also told of every paid payment link or WhatsApp Pay bill: the Conversions API reports it this way. */
    onPayment(listener: (linkId: string) => Promise<void>): void {
        this.paymentListeners.push(listener);
    }

    async order(orderId: string, kinds: StoreEventKind[]): Promise<void> {
        const unique = [...new Set(kinds)];
        // What WhatsApp Pay put on the customer's order page itself, as it went out: not what it might have sent.
        const told = new Set<StoreEventKind>();
        for (const listener of this.orderListeners) {
            if (!unique.length) break;
            const said = await listener(orderId, unique).catch((err) => {
                this.logger.warn(`Order listener for ${orderId} failed: ${err instanceof Error ? err.message : err}`);
                return undefined;
            });
            for (const kind of said ?? []) told.add(kind);
        }
        try {
            if (!unique.length) return;
            const buyer = await this.buyerOf(orderId);
            if (!buyer) return;
            const { order, e164, vars } = buyer;
            for (const kind of unique) {
                await this.raise({
                    organizationId: order.organizationId,
                    eventType: `crm.order.${kind}`,
                    externalId: `${order.id}:${kind}`,
                    e164,
                    customerId: order.customerId,
                    orderId: order.id,
                    vars,
                    extra: { isCod: isCashOnDelivery(order.paymentGateways), ...(told.has(kind) ? { whatsAppPayNotice: true } : {}) },
                });
            }
        } catch (err) {
            this.logger.warn(`Order events for ${orderId} not raised: ${err instanceof Error ? err.message : err}`);
        }
    }

    /**
     * A GST invoice was issued — on payment, by hand, in bulk or with an
     * offline sale — so automations can send it to the buyer. Carries the
     * order's variables and {{invoice.*}}.
     */
    async invoiceIssued(invoiceId: string): Promise<void> {
        try {
            const invoice = await this.prisma.invoice.findUnique({
                where: { id: invoiceId },
                select: { id: true, orderId: true, invoiceNumber: true, invoiceDate: true, grandTotal: true, currency: true },
            });
            if (!invoice) return;
            const buyer = await this.buyerOf(invoice.orderId);
            if (!buyer) return;
            await this.raise({
                organizationId: buyer.order.organizationId,
                eventType: 'crm.invoice.issued',
                externalId: `${invoice.id}:issued`,
                e164: buyer.e164,
                customerId: buyer.order.customerId,
                orderId: buyer.order.id,
                vars: { ...buyer.vars, ...invoiceVars({ ...invoice, grandTotal: invoice.grandTotal.toString() }) },
                extra: { invoiceId: invoice.id },
            });
        } catch (err) {
            this.logger.warn(`Invoice event for ${invoiceId} not raised: ${err instanceof Error ? err.message : err}`);
        }
    }

    /**
     * Money was refunded on an order. One event per refund (an order can be
     * refunded in parts), carrying the order's variables and {{refund.amount}}.
     */
    async refunded(orderId: string, refund: { id: string; amount: number | string; currency: string }): Promise<void> {
        try {
            const buyer = await this.buyerOf(orderId);
            if (!buyer) return;
            await this.raise({
                organizationId: buyer.order.organizationId,
                eventType: 'crm.order.refunded',
                externalId: `${refund.id}:refunded`,
                e164: buyer.e164,
                customerId: buyer.order.customerId,
                orderId: buyer.order.id,
                vars: { ...buyer.vars, ...refundVars(refund) },
                extra: { refundId: refund.id },
            });
        } catch (err) {
            this.logger.warn(`Refund event for ${refund.id} not raised: ${err instanceof Error ? err.message : err}`);
        }
    }

    /**
     * A payment link was paid. Reaches the contact the link was sent to when
     * there is one, else the order's buyer. Carries {{payment.*}}, and
     * {{order.*}} when the link was for an order.
     */
    async paymentReceived(input: {
        organizationId: string;
        linkId: string;
        orderId: string | null;
        customerId: string | null;
        contactId: string | null;
        vars: Record<string, string>;
    }): Promise<void> {
        for (const listener of this.paymentListeners) {
            await listener(input.linkId).catch((err) => this.logger.warn(`Payment listener for ${input.linkId} failed: ${err instanceof Error ? err.message : err}`));
        }
        try {
            const buyer = input.orderId ? await this.buyerOf(input.orderId) : null;
            const contact = input.contactId
                ? await this.prisma.channelContact.findFirst({ where: { id: input.contactId, organizationId: input.organizationId }, select: { id: true, channelId: true, externalId: true, phone: true } })
                : null;
            const customer = !buyer && !contact && input.customerId
                ? await this.prisma.customer.findUnique({ where: { id: input.customerId }, select: { phone: true } })
                : null;
            await this.raise({
                organizationId: input.organizationId,
                eventType: 'crm.payment.received',
                externalId: `${input.linkId}:paid`,
                e164: buyer?.e164 ?? normalizePhone(contact?.phone ?? customer?.phone ?? null),
                customerId: buyer?.order.customerId ?? input.customerId,
                orderId: input.orderId,
                vars: { ...(buyer?.vars ?? {}), ...input.vars },
                extra: { paymentLinkId: input.linkId },
                contact,
            });
        } catch (err) {
            this.logger.warn(`Payment event for ${input.linkId} not raised: ${err instanceof Error ? err.message : err}`);
        }
    }

    /** The order, the buyer's number from its addresses (or the customer), and its {{order.*}} values. */
    private async buyerOf(orderId: string) {
        const order = await this.prisma.order.findUnique({
            where: { id: orderId },
            include: {
                customer: { select: { id: true, phone: true } },
                lineItems: { select: { title: true, quantity: true } },
                fulfillments: { select: { trackingNumber: true, trackingUrl: true, trackingCompany: true }, orderBy: { createdAt: 'desc' } },
            },
        });
        if (!order) return null;
        const country = countryCodeOf(order.shippingAddress) ?? countryCodeOf(order.billingAddress);
        const e164 = normalizePhone(phoneOf(order.shippingAddress) ?? phoneOf(order.billingAddress) ?? order.customer?.phone, country);
        const vars = {
            ...orderVars({ ...order, totalPrice: order.totalPrice.toString() }),
            // The order's page at `<app>/t/`: its courier's tracking, or its status until there is some.
            'order.track_path': storeLinkToken(this.linkKey, 'order', order.id),
        };
        return { order, e164, vars };
    }

    async checkoutAbandoned(checkout: {
        id: string;
        organizationId: string;
        phone: string | null;
        recoveryUrl: string | null;
        total: Prisma.Decimal | null;
        currency: string | null;
        items: Prisma.JsonValue;
        firstName: string | null;
        customerExternalId: string | null;
        channelId: string;
        updatedAt: Date;
    }): Promise<number> {
        try {
            const customer = checkout.customerExternalId
                ? await this.prisma.customer.findFirst({ where: { channelId: checkout.channelId, externalId: checkout.customerExternalId }, select: { id: true } })
                : null;
            const items = (Array.isArray(checkout.items) ? checkout.items : []) as Array<{ title: string; quantity: number }>;
            return await this.raise({
                organizationId: checkout.organizationId,
                eventType: 'crm.checkout.abandoned',
                externalId: checkout.id,
                e164: normalizePhone(checkout.phone),
                customerId: customer?.id ?? null,
                orderId: null,
                vars: {
                    ...checkoutVars({ recoveryUrl: checkout.recoveryUrl, total: checkout.total?.toString() ?? null, currency: checkout.currency, items, firstName: checkout.firstName }),
                    // `<app>/c/` sends the shopper on to the checkout, wherever the store's domain is now.
                    'checkout.cart_path': storeLinkToken(this.linkKey, 'cart', checkout.id),
                },
                // A run stops when this checkout is completed, or the shopper ordered since it went quiet (stopWhen.orderPlaced).
                extra: { checkoutId: checkout.id, quietSince: checkout.updatedAt.toISOString() },
            });
        } catch (err) {
            this.logger.warn(`Abandoned checkout ${checkout.id} not raised: ${err instanceof Error ? err.message : err}`);
            return 0;
        }
    }

    /** One event per listening channel that can reach the buyer. Returns how many were raised. */
    private async raise(input: {
        organizationId: string;
        eventType: string;
        externalId: string;
        e164: string | null;
        customerId: string | null;
        orderId: string | null;
        vars: Record<string, string>;
        extra?: Record<string, unknown>;
        /** The contact to use on its own channel, instead of finding one by number. */
        contact?: { id: string; channelId: string; externalId: string } | null;
    }): Promise<number> {
        const listening = await this.prisma.automationTrigger.findMany({
            where: {
                organizationId: input.organizationId,
                triggerType: input.eventType,
                isActive: true,
                channelId: { not: null },
                automation: { status: AutomationStatus.ACTIVE },
            },
            select: { channel: { select: { id: true, platform: true } } },
        });
        const channels = [...new Map(listening.filter((t) => t.channel).map((t) => [t.channel!.id, t.channel!])).values()];
        let raised = 0;
        for (const channel of channels) {
            const contact = input.contact?.channelId === channel.id
                ? input.contact
                : await this.contactOn(channel, input.organizationId, input.e164, input.customerId);
            if (!contact) continue;
            try {
                const event = await this.prisma.automationEvent.create({
                    data: {
                        organizationId: input.organizationId,
                        channelId: channel.id,
                        eventType: input.eventType,
                        // One event per store event and channel, however often Shopify redelivers.
                        externalId: channels.length > 1 ? `${input.externalId}:${channel.id}` : input.externalId,
                        occurredAt: new Date(),
                        contactId: contact.id,
                        customerId: input.customerId,
                        orderId: input.orderId,
                        actorExternalId: contact.externalId,
                        payload: { raw: { vars: input.vars, ...(input.extra ?? {}) } } as Prisma.InputJsonValue,
                    },
                    select: { id: true },
                });
                await this.jobs.event(event.id);
                raised++;
            } catch (err) {
                if (!isUniqueViolation(err)) throw err;
            }
        }
        return raised;
    }

    /**
     * The buyer on this channel. WhatsApp can message any number, so a new
     * one becomes a contact; Instagram and Messenger only reach people who
     * already wrote, linked to this customer.
     */
    private async contactOn(channel: { id: string; platform: ChannelPlatform }, organizationId: string, e164: string | null, customerId: string | null) {
        if (channel.platform !== ChannelPlatform.WHATSAPP) {
            if (!customerId) return null;
            return this.prisma.channelContact.findFirst({ where: { channelId: channel.id, customerId }, select: { id: true, externalId: true } });
        }
        if (!e164) return null;
        const digits = e164.replace(/\D/g, '');
        const existing = await this.prisma.channelContact.findFirst({
            where: { channelId: channel.id, OR: [{ waId: digits }, { externalId: digits }, { phone: e164 }] },
            select: { id: true, externalId: true, customerId: true },
        });
        if (existing) {
            if (!existing.customerId && customerId) {
                // The chats follow, as when a customer is linked by hand or by phone, so the inbox sees their orders.
                await this.prisma.$transaction([
                    this.prisma.channelContact.update({ where: { id: existing.id }, data: { customerId } }),
                    this.prisma.conversation.updateMany({ where: { contactId: existing.id, customerId: null }, data: { customerId } }),
                ]);
            }
            return existing;
        }
        try {
            return await this.prisma.channelContact.create({
                data: { organizationId, channelId: channel.id, platform: ChannelPlatform.WHATSAPP, externalId: digits, waId: digits, phone: e164, customerId },
                select: { id: true, externalId: true },
            });
        } catch (err) {
            if (!isUniqueViolation(err)) throw err;
            return this.prisma.channelContact.findUnique({
                where: { channelId_externalId: { channelId: channel.id, externalId: digits } },
                select: { id: true, externalId: true },
            });
        }
    }
}
