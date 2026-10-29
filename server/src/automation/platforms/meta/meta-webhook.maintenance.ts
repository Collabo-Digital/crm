import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../../prisma/prisma.service';
import { MetaWebhookIntakeService } from './meta-webhook-intake.service';
import { META_INBOUND_JOB_OPTS } from './meta-inbound.queue';

const RETENTION_DAYS = 14;
/// Older than this and still unprocessed means the queue add was lost.
const STUCK_AFTER_MS = 2 * 60_000;
const REQUEUE_BATCH = 200;

/**
 * Housekeeping for meta_webhook_deliveries: re-queue rows whose queue job was
 * lost (Redis down at intake time), and prune rows past the retention window.
 */
@Injectable()
export class MetaWebhookMaintenance {
    private readonly logger = new Logger(MetaWebhookMaintenance.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly intake: MetaWebhookIntakeService,
    ) { }

    @Cron(CronExpression.EVERY_5_MINUTES)
    async requeueStuck(now = new Date()) {
        const rows = await this.prisma.metaWebhookDelivery.findMany({
            where: {
                processedAt: null,
                receivedAt: { lt: new Date(now.getTime() - STUCK_AFTER_MS) },
                // Past its retries, a row waits for a person: its error says why.
                attempts: { lt: META_INBOUND_JOB_OPTS.attempts },
            },
            orderBy: { receivedAt: 'asc' },
            take: REQUEUE_BATCH,
            select: { id: true },
        });
        for (const row of rows) {
            await this.intake.enqueue(row.id).catch((err) =>
                this.logger.error(`Could not re-queue Meta delivery ${row.id}: ${err}`),
            );
        }
        if (rows.length) this.logger.log(`Re-queued ${rows.length} unprocessed Meta deliveries`);
        return rows.length;
    }

    @Cron(CronExpression.EVERY_DAY_AT_4AM)
    async prune(now = new Date()) {
        const { count } = await this.prisma.metaWebhookDelivery.deleteMany({
            where: { receivedAt: { lt: new Date(now.getTime() - RETENTION_DAYS * 24 * 3600_000) } },
        });
        if (count) this.logger.log(`Pruned ${count} Meta deliveries older than ${RETENTION_DAYS} days`);
        return count;
    }
}
