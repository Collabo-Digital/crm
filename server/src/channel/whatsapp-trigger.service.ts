import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ChannelPlatform, ChannelStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { normalizePhone } from '../common/phone.util';
import { WHATSAPP_MESSAGING_QUEUE, type WhatsAppMessageJobData } from './whatsapp.queue';

/**
 * Minimal shape of a Shopify Order webhook body we rely on.
 * (The controller passes the raw JSON through; we only read a few fields.)
 */
interface ShopifyOrderPayload {
    id: number | string;
    phone?: string | null;
    customer?: {
        id: number | string;
        phone?: string | null;
        email?: string | null;
        first_name?: string | null;
        last_name?: string | null;
        accepts_marketing?: boolean;
    } | null;
    shipping_address?: { country_code?: string | null } | null;
    billing_address?: { country_code?: string | null } | null;
}

/**
 * Decides whether to send a WhatsApp message for a given incoming order and
 * enqueues the job if so.
 *
 * Separated from both the webhook controller (which should only handle HTTP)
 * and the messaging service (which should only talk to Meta) so the "should we
 * send?" logic has one home.
 */
@Injectable()
export class WhatsAppTriggerService {
    private readonly logger = new Logger(WhatsAppTriggerService.name);

    constructor(
        private readonly prisma: PrismaService,
        @InjectQueue(WHATSAPP_MESSAGING_QUEUE) private readonly queue: Queue,
    ) { }

    /**
     * Fire-once handler for Shopify `orders/create` webhooks.
     * Silent skip on any of: no WA channel, disconnected channel, customer
     * missing phone, customer without marketing consent, phone unparseable.
     */
    async onOrderPlaced(
        organizationId: string,
        shopifyChannelId: string,
        order: ShopifyOrderPayload,
    ): Promise<void> {
        // 1. Does this org have a connected WhatsApp channel?
        // An org can now hold a DISCONNECTED WhatsApp row as history with no
        // active one beside it, so status is part of the query rather than a
        // test applied to "the" row afterwards.
        const waChannel = await this.prisma.channel.findFirst({
            where: {
                organizationId,
                platform: ChannelPlatform.WHATSAPP,
                status: ChannelStatus.CONNECTED,
            },
            orderBy: { createdAt: 'desc' },
        });
        if (!waChannel) {
            return;
        }

        // 2. Consent + phone availability. Fall back to order-level phone if
        //    the customer object doesn't have one (guest checkout cases).
        const customer = order.customer;
        const rawPhone = customer?.phone ?? order.phone ?? null;
        if (!customer || !rawPhone) return;
        if (customer.accepts_marketing !== true) return;

        // 3. Normalize to E.164 using the shipping/billing country as a hint.
        const countryCode =
            order.shipping_address?.country_code ?? order.billing_address?.country_code ?? null;
        const e164 = normalizePhone(rawPhone, countryCode);
        if (!e164) {
            this.logger.warn(
                `Could not normalize phone "${rawPhone}" (country=${countryCode}) for order ${order.id}`,
            );
            return;
        }

        // 4. Look up the CRM rows the upsertOrder call just created so we can
        //    link the message log back to them.
        const crmCustomer = await this.prisma.customer.findFirst({
            where: { channelId: shopifyChannelId, externalId: String(customer.id) },
            select: { id: true },
        });
        const crmOrder = await this.prisma.order.findUnique({
            where: { channelId_externalId: { channelId: shopifyChannelId, externalId: String(order.id) } },
            select: { id: true },
        });

        // 5. Enqueue the send. BullMQ handles retries / rate limits.
        const jobData: WhatsAppMessageJobData = {
            organizationId,
            channelId: waChannel.id,
            customerId: crmCustomer?.id,
            orderId: crmOrder?.id,
            toPhone: e164,
            templateName: 'hello_world', // MVP — swap for approved "order_confirmation" once ready
            templateLanguage: 'en_US',
            triggerType: 'order_placed',
        };
        await this.queue.add('send-template', jobData, {
            attempts: 5,
            backoff: { type: 'exponential', delay: 3000 },
            removeOnComplete: { count: 500 },
            removeOnFail: { count: 200 },
        });

        this.logger.log(
            `Enqueued WhatsApp ${jobData.templateName} for order ${order.id} → ${e164}`,
        );
    }
}
