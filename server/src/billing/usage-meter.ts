import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { periodOf } from './pricing';

const CONVERSATION_MS = 24 * 60 * 60 * 1000;

/**
 * Counts WhatsApp conversations for usage billing. A conversation is 24 hours
 * with one person (or group), opened by the first message either way while
 * none is open, and counted in the month it opened.
 */
@Injectable()
export class UsageMeter {
    private readonly logger = new Logger(UsageMeter.name);

    constructor(private readonly prisma: PrismaService) { }

    /** Metering never holds up a message, so a failure is only logged. */
    async noteMessage(organizationId: string, contactId: string, at: Date): Promise<void> {
        try {
            await this.prisma.$transaction(async (tx) => {
                // Two messages at once: the second sees the first's window and opens none.
                const opened = await tx.channelContact.updateMany({
                    where: { id: contactId, OR: [{ usageWindowEndsAt: null }, { usageWindowEndsAt: { lte: at } }] },
                    data: { usageWindowEndsAt: new Date(at.getTime() + CONVERSATION_MS) },
                });
                if (!opened.count) return;
                await tx.$executeRaw(Prisma.sql`
                    INSERT INTO "usage_months" ("organization_id", "period", "conversations", "updated_at")
                    VALUES (${organizationId}, ${periodOf(at)}, 1, now())
                    ON CONFLICT ("organization_id", "period")
                    DO UPDATE SET "conversations" = "usage_months"."conversations" + 1, "updated_at" = now()`);
            });
        } catch (err) {
            this.logger.warn(`Conversation not counted for contact ${contactId}: ${err instanceof Error ? err.message : err}`);
        }
    }
}
