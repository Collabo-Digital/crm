import { Injectable, Logger } from '@nestjs/common';
import { ChannelPlatform } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { InstagramIngestService } from '../instagram/instagram-ingest.service';
import { InstagramWebhookEntry, parseInstagramEntry } from '../instagram/instagram-webhook.parser';
import { parseMessengerDelivery } from './messenger-webhook.parser';

/**
 * Applies a `page` or `instagram` delivery to the account it names.
 */
@Injectable()
export class MessengerWebhookHandler {
    private readonly logger = new Logger(MessengerWebhookHandler.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly instagramIngest: InstagramIngestService,
    ) { }

    async handle(payload: unknown): Promise<void> {
        const body = payload as { object?: string; entry?: InstagramWebhookEntry[] };
        if (body.object === 'instagram') {
            for (const entry of body.entry ?? []) await this.handleInstagramEntry(entry);
            return;
        }
        const events = parseMessengerDelivery(payload);
        if (events.length) this.logger.log(`Messenger delivery: ${events.length} events received`);
    }

    private async handleInstagramEntry(entry: InstagramWebhookEntry): Promise<void> {
        const channel = await this.prisma.channel.findFirst({
            where: { platform: ChannelPlatform.INSTAGRAM, externalStoreId: entry.id },
            select: { id: true, organizationId: true, externalStoreId: true },
        });
        if (!channel) {
            this.logger.warn(`Instagram webhook entry ${entry.id}: no matching channel`);
            return;
        }
        for (const item of parseInstagramEntry(entry, channel)) {
            await this.instagramIngest.ingestItem(channel, item);
        }
    }
}
