import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Queue } from 'bullmq';
import { MessageDirection, MessageSource, MessageStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MESSAGING_OUTBOUND_QUEUE, ORIGIN_PRIORITY, OutboundJobData, maxSendWaitMs } from './outbound.queue';
import { MessagingSendService } from './messaging-send.service';
import { PlatformSenderService } from './platform-sender.service';

/// Younger than this, a QUEUED row may simply not have reached its worker yet.
const STUCK_AFTER_MS = 2 * 60_000;
const BATCH = 200;

const PRIORITY_BY_SOURCE: Partial<Record<MessageSource, number>> = {
    [MessageSource.AGENT]: ORIGIN_PRIORITY.agent,
    [MessageSource.SYSTEM]: ORIGIN_PRIORITY.system,
    [MessageSource.AUTOMATION]: ORIGIN_PRIORITY.automation,
    [MessageSource.API]: ORIGIN_PRIORITY.api,
    [MessageSource.BROADCAST]: ORIGIN_PRIORITY.broadcast,
};

/** What to do with a QUEUED row whose delivery job is missing or finished. */
export function stuckAction(createdAt: Date, priority: number, now: Date): 'requeue' | 'give-up' {
    return now.getTime() - createdAt.getTime() > maxSendWaitMs(priority) ? 'give-up' : 'requeue';
}

/**
 * Finds messages left QUEUED with no delivery job behind them: the queue add
 * failed after the row was written, Redis lost the job, or BullMQ failed it
 * for stalling without running the processor's own failure path. Each is
 * queued again (one job per message), or failed when it is too old to send
 * without surprising the customer.
 */
@Injectable()
export class OutboundSweeper {
    private readonly logger = new Logger(OutboundSweeper.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly send: MessagingSendService,
        private readonly sender: PlatformSenderService,
        @InjectQueue(MESSAGING_OUTBOUND_QUEUE) private readonly queue: Queue<OutboundJobData>,
    ) { }

    @Cron(CronExpression.EVERY_MINUTE)
    async sweep(now = new Date()): Promise<number> {
        // The status index leads with the organization.
        const orgs = await this.prisma.channel.findMany({ distinct: ['organizationId'], select: { organizationId: true } });
        if (!orgs.length) return 0;
        const where = {
            organizationId: { in: orgs.map((o) => o.organizationId) },
            status: MessageStatus.QUEUED,
            direction: MessageDirection.OUTBOUND,
            externalId: null,
            createdAt: { lt: new Date(now.getTime() - STUCK_AFTER_MS) },
        };
        const select = { id: true, source: true, body: true, createdAt: true } as const;
        // People's replies first, so a broadcast backlog cannot hide them.
        const rows = [
            ...(await this.prisma.message.findMany({
                where: { ...where, source: { in: [MessageSource.AGENT, MessageSource.SYSTEM, MessageSource.AUTOMATION, MessageSource.API] } },
                orderBy: { createdAt: 'asc' },
                take: BATCH,
                select,
            })),
            ...(await this.prisma.message.findMany({
                where: { ...where, source: MessageSource.BROADCAST },
                orderBy: { createdAt: 'asc' },
                take: BATCH,
                select,
            })),
        ];

        let fixed = 0;
        for (const row of rows) {
            try {
                const job = await this.queue.getJob(`deliver-${row.id}`);
                const state = job ? await job.getState() : null;
                if (state && state !== 'completed' && state !== 'failed') continue;
                const priority = (row.source && PRIORITY_BY_SOURCE[row.source]) ?? ORIGIN_PRIORITY.broadcast;
                if (stuckAction(row.createdAt, priority, now) === 'give-up') {
                    await this.sender.giveUp(row.id, 'This message could not be sent in time, so it was not sent. Send it again if it is still needed.');
                } else {
                    await job?.remove();
                    await this.send.enqueue(row.id, (row.body as { humanAgentTag?: boolean } | null)?.humanAgentTag === true, priority);
                }
                fixed++;
            } catch (err) {
                this.logger.warn(`Stuck message ${row.id} not recovered: ${err instanceof Error ? err.message : err}`);
            }
        }
        if (fixed) this.logger.log(`Recovered ${fixed} messages left queued without a delivery job`);
        return fixed;
    }
}
