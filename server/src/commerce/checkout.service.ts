import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CommerceEventsService } from './commerce-events.service';
import { parseCheckout } from './checkout.util';

/** A checkout quiet this long without an order is abandoned: the first cart reminder goes out then. */
export const ABANDONED_AFTER_MS = 30 * 60_000;
/** Older checkouts are history, not something to recover now. */
const RECOVER_WITHIN_MS = 3 * 24 * 3600_000;

/**
 * Shopify checkouts, kept so a cart someone walked away from can be
 * recovered: the abandonment sweep raises one `crm.checkout.abandoned`
 * event per checkout, with Shopify's recovery link.
 */
@Injectable()
export class CheckoutService {
    private readonly logger = new Logger(CheckoutService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly events: CommerceEventsService,
    ) { }

    /** checkouts/create and checkouts/update. */
    async upsertFromWebhook(channel: { id: string; organizationId: string }, body: unknown): Promise<void> {
        const c = parseCheckout(body);
        if (!c) return;
        const data = {
            token: c.token,
            recoveryUrl: c.recoveryUrl,
            phone: c.phone,
            email: c.email,
            firstName: c.firstName,
            customerExternalId: c.customerExternalId,
            currency: c.currency,
            total: c.total,
            items: c.items as unknown as Prisma.InputJsonValue,
            ...(c.completedAt ? { completedAt: c.completedAt } : {}),
        };
        await this.prisma.checkout.upsert({
            where: { channelId_externalId: { channelId: channel.id, externalId: c.externalId } },
            create: { organizationId: channel.organizationId, channelId: channel.id, externalId: c.externalId, ...data },
            update: data,
        });
    }

    async remove(channelId: string, body: unknown): Promise<void> {
        const id = (body as { id?: unknown } | null)?.id;
        if (id === undefined || id === null) return;
        await this.prisma.checkout.deleteMany({ where: { channelId, externalId: String(id) } });
    }

    /**
     * An order arrived for this checkout: nothing to recover. Shopify can
     * deliver the checkout's last update after the order, so an unseen
     * checkout is recorded as completed; later updates never reopen it.
     */
    async markCompleted(channel: { id: string; organizationId: string }, order: { checkout_id?: unknown; checkout_token?: unknown }): Promise<void> {
        const id = order.checkout_id !== undefined && order.checkout_id !== null ? String(order.checkout_id) : null;
        const token = typeof order.checkout_token === 'string' ? order.checkout_token : null;
        if (!id && !token) return;
        const now = new Date();
        const { count } = await this.prisma.checkout.updateMany({
            where: { channelId: channel.id, OR: [...(id ? [{ externalId: id }] : []), ...(token ? [{ token }] : [])] },
            data: { completedAt: now },
        });
        if (count || !id) return;
        await this.prisma.checkout
            .create({ data: { organizationId: channel.organizationId, channelId: channel.id, externalId: id, token, completedAt: now } })
            .catch(() => undefined);
    }

    @Cron(CronExpression.EVERY_10_MINUTES)
    async sweep(now = new Date()): Promise<number> {
        const due = await this.prisma.checkout.findMany({
            where: {
                completedAt: null,
                abandonedAt: null,
                recoveryUrl: { not: null },
                phone: { not: null },
                updatedAt: { lt: new Date(now.getTime() - ABANDONED_AFTER_MS), gt: new Date(now.getTime() - RECOVER_WITHIN_MS) },
            },
            take: 200,
        });
        let raised = 0;
        for (const checkout of due) {
            // Claim it first, so two sweeps never raise it twice.
            const { count } = await this.prisma.checkout.updateMany({ where: { id: checkout.id, abandonedAt: null }, data: { abandonedAt: now } });
            if (!count) continue;
            raised += await this.events.checkoutAbandoned(checkout);
        }
        if (raised) this.logger.log(`Raised ${raised} abandoned-checkout events`);
        return raised;
    }
}
