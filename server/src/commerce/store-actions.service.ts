import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { OrderCancelReason, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { OrderService } from '../order/order.service';
import { DraftOrderService } from '../draft-order/draft-order.service';
import { formatMoney } from './order-vars';

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
    ) { }

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

    async cancelOrder(orgId: string, orderId: string, actor: string, staffNote: string): Promise<void> {
        const order = await this.order(orgId, orderId);
        if (order.cancelledAt) return;
        await this.orders.cancel(orderId, orgId, actor, {
            reason: OrderCancelReason.CUSTOMER,
            refund: false,
            restock: true,
            notifyCustomer: true,
            ...(staffNote ? { staffNote } : {}),
        });
    }

    /** Local only: Shopify customer tags are not pushed. */
    async tagCustomer(orgId: string, customerId: string, tag: string): Promise<{ tags: string[] }> {
        const customer = await this.prisma.customer.findFirst({ where: { id: customerId, organizationId: orgId }, select: { tags: true } });
        if (!customer) throw new NotFoundException('Customer not found');
        if (customer.tags.some((t) => t.toLowerCase() === tag.toLowerCase())) return { tags: customer.tags };
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
        input: { lines: CartLine[]; customerId: string | null; phone: string | null; firstName: string | null; note: string },
    ): Promise<DraftFromCart> {
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
        let checkoutUrl: string | null = null;
        try {
            await this.drafts.mirrorCreateToShopify(draftId, orgId);
        } catch (err) {
            this.logger.warn(`Draft ${draftId} not mirrored to Shopify: ${err instanceof Error ? err.message : err}`);
        }
        const draft = await this.prisma.draftOrder.findUniqueOrThrow({ where: { id: draftId }, select: { name: true, totalPrice: true, currency: true, invoiceUrl: true } });
        checkoutUrl = draft.invoiceUrl;
        return { draftId, name: draft.name, total: formatMoney(draft.totalPrice.toString(), draft.currency), checkoutUrl, missing };
    }

    private async order(orgId: string, orderId: string) {
        const order = await this.prisma.order.findFirst({ where: { id: orderId, organizationId: orgId }, select: { tags: true, note: true, cancelledAt: true } });
        if (!order) throw new NotFoundException('Order not found');
        return order;
    }
}
