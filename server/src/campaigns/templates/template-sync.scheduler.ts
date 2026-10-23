import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ChannelPlatform, ChannelStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { TemplatesService } from './templates.service';

/**
 * Templates follow Meta by webhook; this catches anything a webhook missed
 * (and templates made in WhatsApp Manager) every six hours.
 */
@Injectable()
export class TemplateSyncScheduler {
    private readonly logger = new Logger(TemplateSyncScheduler.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly templates: TemplatesService,
    ) { }

    @Cron('15 */6 * * *')
    async syncAll() {
        const channels = await this.prisma.channel.findMany({
            where: { platform: ChannelPlatform.WHATSAPP, status: ChannelStatus.CONNECTED },
            select: { organizationId: true },
        });
        for (const { organizationId } of channels) {
            try {
                await this.templates.sync(organizationId);
            } catch (err) {
                this.logger.warn(`Template sync for ${organizationId} failed: ${err instanceof Error ? err.message : err}`);
            }
        }
    }
}
