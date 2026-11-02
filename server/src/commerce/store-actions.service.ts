import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ChannelPlatform, InvoiceStatus, OrderCancelReason, OrderFinancialStatus, OrderFulfillmentStatus, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ShopifyGraphqlClient } from '../channel/shopify-graphql.client';
import { ShopifyOAuthService } from '../channel/shopify-oauth.service';
import { CUSTOMER_TAGS_ADD_MUTATION, type CustomerTagsAddResponse, type CustomerTagsAddVariables } from '../channel/shopify-graphql.types';
import { OrderService } from '../order/order.service';
import { DraftOrderService } from '../draft-order/draft-order.service';
import { formatMoney, invoiceVars } from './order-vars';
import { InvoiceService } from '../invoice/invoice.service';
import { MessagingMediaStorage } from '../messaging/media/messaging-media.storage';

/** Money the customer has paid or authorised, which a cancel without a refund would keep. */
const PAID_STATUSES: OrderFinancialStatus[] = [
    OrderFinancialStatus.AUTHORIZED,
    OrderFinancialStatus.PARTIALLY_PAID,
    OrderFinancialStatus.PAID,
    OrderFinancialStatus.PARTIALLY_REFUNDED,
];

export interface CartLine {
    retailerId: string;
    quantity: number;
}

export interface DraftFromCart {
    draftId: string;
    name: string | null;
    total: string;
    /** Shopify's checkout link; null when no Shopify store is connected or the mirror failed. */
    checkoutUrl: string | null;
    /** Cart items that are not products of this store any more. */
    missing: string[];
    /** The cart had a draft order already; this is that one. */
    existing: boolean;
}

/**
 * What automations (and the inbox) can do to the store: tag, note or cancel
 * an order, tag a customer, and turn a WhatsApp cart into a draft order with
 * a checkout link. Order changes go through OrderService, so a Shopify order
 * is updated in Shopify too.
 */
@Injectable()
export class StoreActionsService {
    private readonly logger = new Logger(StoreActionsService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly orders: OrderService,
        private readonly drafts: DraftOrderService,
        private readonly graphql: ShopifyGraphqlClient,
        private readonly shopifyOAuth: ShopifyOAuthService,
        private readonly invoices: InvoiceService,
        private readonly media: MessagingMediaStorage,
    ) { }

    /**
     * The order's live GST invoice as a PDF in chat-media storage, ready to go
     * as a template's document header, with its {{invoice.*}} values. Null
     * when the order has no invoice (not paid yet, or invoiced by hand later).
     */
    async invoiceDocument(orgId: string, orderId: string): Promise<{ invoiceId: string; storageKey: string; filename: string; vars: Record<string, string> } | null> {
        const invoice = await this.prisma.invoice.findFirst({
            where: { orderId, organizationId: orgId, status: { notIn: [InvoiceStatus.CANCELLED, InvoiceStatus.CREDIT_NOTE] } },
            select: { id: true, invoiceNumber: true, invoiceDate: true, grandTotal: true, currency: true },
        });
        if (!invoice) return null;
        const { buffer, filename } = await this.invoices.pdf(invoice.id, orgId);
        const { storageKey } = await this.media.save(orgId, buffer, 'application/pdf');
        return { invoiceId: invoice.id, storageKey, filename, vars: invoiceVars({ ...invoice, grandTotal: invoice.grandTotal.toString() }) };
    }

    /**
     * The person a change is recorded against: the automation's creator, else
     * the organization's owner. Order timelines and draft orders need one.
     */
    async actorFor(orgId: string, preferred: string | null): Promise<string> {
        if (preferred) {
            const member = await this.prisma.organizationMember.findFirst({ where: { organizationId: orgId, userId: preferred, isActive: true }, select: { userId: true } });
            if (member) return member.userId;
        }
        const owner = await this.prisma.organizationMember.findFirst({
            where: { organizationId: orgId, role: UserRole.OWNER, isActive: true },
            orderBy: { createdAt: 'asc' },
            select: { userId: true },
        });
        if (!owner) throw new BadRequestException('This organization has no owner to record the change against.');
        return owner.userId;
    }

    async tagOrder(orgId: string, orderId: string, tag: string, actor: string): Promise<{ tags: string[] }> {
        const order = await this.order(orgId, orderId);
        if (order.tags.some((t) => t.toLowerCase() === tag.toLowerCase())) return { tags: order.tags };
        const tags = [...order.tags, tag];
        await this.orders.update(orderId, orgId, actor, { tags });
        return { tags };
    }

    async noteOrder(orgId: string, orderId: string, text: string, actor: string): Promise<void> {
        const order = await this.order(orgId, orderId);
        await this.orders.update(orderId, orgId, actor, { note: order.note ? `${order.note}\n${text}` : text });
    }

    /**
     * Cancels an unpaid order that has not shipped, as the order is now.
     * Returns why it was left alone otherwise: cancelling here never refunds,
     * and would cancel shipments and restock goods that are on their way.
     */
    async cancelOrder(orgId: string, orderId: string, actor: string, staffNote: string): Promise<string | null> {
        const order = await this.prisma.order.findFirst({
            where: { id: orderId, organizationId: orgId },
            select: {
                cancelledAt: true,
                financialStatus: true,
                fulfillmentStatus: true,
                fulfillments: { where: { status: { not: 'cancelled' } }, select: { id: true }, take: 1 },
            },
        });
        if (!order) throw new NotFoundException('Order not found');
        if (order.cancelledAt) return null;
        if (PAID_STATUSES.includes(order.financialStatus)) {
            return 'The order was not cancelled because it has been paid, and cancelling here does not refund the customer. Cancel and refund it from the order page.';
        }
        if (order.fulfillments.length || order.fulfillmentStatus === OrderFulfillmentStatus.FULFILLED || order.fulfillmentStatus === OrderFulfillmentStatus.PARTIAL) {
            return 'The order was not cancelled because it has already been shipped. Cancel it from the order page if the shipment can still be stopped.';
        }
        await this.orders.cancel(orderId, orgId, actor, {
            reason: OrderCancelReason.CUSTOMER,
            refund: false,
            restock: true,
            notifyCustomer: true,
            ...(staffNote ? { staffNote } : {}),
        });
        return null;
    }

    /** Local only: Shopify customer tags are not pushed. */
    /** A Shopify customer is tagged in Shopify first, so the next customers/update webhook keeps the tag. */
    async tagCustomer(orgId: string, customerId: string, tag: string): Promise<{ tags: string[] }> {
        const customer = await this.prisma.customer.findFirst({
            where: { id: customerId, organizationId: orgId },
            select: { tags: true, externalId: true, channel: { select: { id: true, platform: true } } },
        });
        if (!customer) throw new NotFoundException('Customer not found');
        if (customer.tags.some((t) => t.toLowerCase() === tag.toLowerCase())) return { tags: customer.tags };
        if (customer.channel.platform === ChannelPlatform.SHOPIFY) {
            const { token, shopDomain } = await this.shopifyOAuth.getAccessToken(customer.channel.id);
            const result = await this.graphql.request<CustomerTagsAddResponse, CustomerTagsAddVariables>(
                { shopDomain, accessToken: token },
                CUSTOMER_TAGS_ADD_MUTATION,
                { id: ShopifyGraphqlClient.toGid('Customer', customer.externalId), tags: [tag] },
            );
            ShopifyGraphqlClient.throwIfUserErrors(result.tagsAdd.userErrors, 'tagsAdd');
        }
        const tags = [...customer.tags, tag];
        await this.prisma.customer.update({ where: { id: customerId }, data: { tags } });
        return { tags };
    }

    /**
     * A draft order from a WhatsApp cart. Catalog item ids are variant ids
     * (see CatalogService). The draft is mirrored to Shopify right away when a
     * store is connected, which is what produces the checkout link.
     */
    async draftFromCart(
        orgId: string,
        actor: string,
        input: { lines: CartLine[]; customerId: string | null; phone: string | null; firstName: string | null; note: string; sourceMessageId: string | null },
    ): Promise<DraftFromCart> {
        // One draft per cart: a second tap, another agent or the automation get the draft already made.
        if (input.sourceMessageId) {
            const made = await this.prisma.draftOrder.findFirst({
                where: { organizationId: orgId, deletedAt: null, metadata: { path: ['sourceMessageId'], equals: input.sourceMessageId } },
                select: { id: true, name: true, totalPrice: true, currency: true, invoiceUrl: true },
            });
            if (made) {
                return { draftId: made.id, name: made.name, total: formatMoney(made.totalPrice.toString(), made.currency), checkoutUrl: made.invoiceUrl, missing: [], existing: true };
            }
        }
        const quantities = new Map<string, number>();
        for (const l of input.lines) quantities.set(l.retailerId, (quantities.get(l.retailerId) ?? 0) + Math.max(1, Math.floor(l.quantity)));
        const variants = await this.prisma.productVariant.findMany({
            where: { id: { in: [...quantities.keys()] }, product: { organizationId: orgId } },
            select: { id: true },
        });
        const known = new Set(variants.map((v) => v.id));
        const missing = [...quantities.keys()].filter((id) => !known.has(id));
        if (!known.size) throw new BadRequestException('None of the cart’s items are products of this store.');

        const created = await this.drafts.create(orgId, actor, {
            customer: input.customerId ? { customerId: input.customerId } : { ...(input.phone ? { phone: input.phone } : {}), ...(input.firstName ? { firstName: input.firstName } : {}) },
            lineItems: [...known].map((id) => ({ productVariantId: id, quantity: quantities.get(id)! })),
            note: input.note,
        });
        const draftId = (created as { id: string }).id;
        if (input.sourceMessageId) {
            await this.prisma.$executeRaw`
                UPDATE "draft_orders" SET "metadata" = coalesce("metadata", '{}'::jsonb) || jsonb_build_object('sourceMessageId', ${input.sourceMessageId}::text)
                WHERE "id" = ${draftId}
            `;
        }
        let checkoutUrl: string | null = null;
        try {
            await this.drafts.mirrorCreateToShopify(draftId, orgId);
        } catch (err) {
            this.logger.warn(`Draft ${draftId} not mirrored to Shopify: ${err instanceof Error ? err.message : err}`);
        }
        const draft = await this.prisma.draftOrder.findUniqueOrThrow({ where: { id: draftId }, select: { name: true, totalPrice: true, currency: true, invoiceUrl: true } });
        checkoutUrl = draft.invoiceUrl;
        return { draftId, name: draft.name, total: formatMoney(draft.totalPrice.toString(), draft.currency), checkoutUrl, missing, existing: false };
    }

    private async order(orgId: string, orderId: string) {
        const order = await this.prisma.order.findFirst({ where: { id: orderId, organizationId: orgId }, select: { tags: true, note: true, cancelledAt: true } });
        if (!order) throw new NotFoundException('Order not found');
        return order;
    }
}
