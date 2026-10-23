import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConversationStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { InboxEventsService } from '../messaging/inbox-events.service';

/**
 * Wakes snoozed conversations whose time has come. The inbox list already
 * treats them as open; this makes the stored status agree, so counts and
 * other readers see them too.
 */
@Injectable()
export class InboxMaintenance {
    private readonly logger = new Logger(InboxMaintenance.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly events: InboxEventsService,
    ) { }

    @Cron(CronExpression.EVERY_MINUTE)
    async wakeSnoozed(now = new Date()) {
        const due = await this.prisma.conversation.findMany({
            where: { status: ConversationStatus.SNOOZED, snoozedUntil: { lte: now } },
            select: { id: true, organizationId: true },
            take: 500,
        });
        if (!due.length) return 0;
        await this.prisma.conversation.updateMany({
            where: { id: { in: due.map((c) => c.id) }, status: ConversationStatus.SNOOZED },
            data: { status: ConversationStatus.OPEN, snoozedUntil: null },
        });
        for (const c of due) this.events.publish(c.organizationId, { type: 'conversation.updated', conversationId: c.id });
        this.logger.log(`Woke ${due.length} snoozed conversations`);
        return due.length;
    }
}
