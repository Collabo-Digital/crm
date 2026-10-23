import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ChannelPlatform, ChannelStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WhatsAppAccountService } from './whatsapp-account.service';

/**
 * Re-reads quality rating, messaging limit and name status for every
 * connected number once a day. Webhooks report changes as they happen; this
 * catches anything missed while the app was unsubscribed or down.
 */
@Injectable()
export class WhatsAppHealthScheduler {
    private readonly logger = new Logger(WhatsAppHealthScheduler.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly account: WhatsAppAccountService,
    ) { }

    @Cron(CronExpression.EVERY_DAY_AT_5AM)
    async refreshAll() {
        const rows = await this.prisma.channel.findMany({
            where: { platform: ChannelPlatform.WHATSAPP, status: { not: ChannelStatus.DISCONNECTED } },
            select: { id: true },
        });
        let failed = 0;
        for (const row of rows) {
            try {
                await this.account.refreshHealth(row.id);
            } catch (err) {
                failed++;
                this.logger.warn(`WhatsApp health refresh failed for ${row.id}: ${err instanceof Error ? err.message : err}`);
            }
        }
        if (rows.length) this.logger.log(`WhatsApp health refreshed for ${rows.length - failed}/${rows.length} numbers`);
    }
}
