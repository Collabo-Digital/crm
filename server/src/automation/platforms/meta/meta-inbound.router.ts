import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { WhatsAppWebhookHandler } from '../whatsapp/whatsapp-webhook.handler';
import { parseWhatsAppDelivery } from '../whatsapp/whatsapp-webhook.parser';
import { MessengerWebhookHandler } from '../messenger/messenger-webhook.handler';

/**
 * Processes one stored delivery: parse by object, hand to the platform
 * handler, stamp the row. A throw leaves `processedAt` empty and records the
 * error, and the queue retries; handlers are idempotent on Meta's ids, so a
 * delivery that half-succeeded can run again safely.
 */
@Injectable()
export class MetaInboundRouter {
    private readonly logger = new Logger(MetaInboundRouter.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly whatsapp: WhatsAppWebhookHandler,
        private readonly messenger: MessengerWebhookHandler,
    ) { }

    async process(deliveryId: string): Promise<'processed' | 'skipped'> {
        const delivery = await this.prisma.metaWebhookDelivery.findUnique({
            where: { id: deliveryId },
            select: { id: true, object: true, payload: true, processedAt: true },
        });
        if (!delivery || delivery.processedAt) return 'skipped';

        await this.prisma.metaWebhookDelivery.update({
            where: { id: delivery.id },
            data: { attempts: { increment: 1 } },
        });

        try {
            switch (delivery.object) {
                case 'whatsapp_business_account':
                    await this.whatsapp.handle(parseWhatsAppDelivery(delivery.payload));
                    break;
                case 'page':
                case 'instagram':
                    await this.messenger.handle(delivery.payload);
                    break;
                default:
                    this.logger.warn(`Meta delivery ${delivery.id}: unknown object ${delivery.object}`);
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            await this.prisma.metaWebhookDelivery
                .update({ where: { id: delivery.id }, data: { error: message.slice(0, 2000) } })
                .catch(() => undefined);
            throw err;
        }

        await this.prisma.metaWebhookDelivery.update({
            where: { id: delivery.id },
            data: { processedAt: new Date(), error: null },
        });
        return 'processed';
    }
}
