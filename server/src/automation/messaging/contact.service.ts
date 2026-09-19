import { Injectable } from '@nestjs/common';
import { ChannelPlatform, Prisma } from '@prisma/client';

export interface UpsertContactInput {
    organizationId: string;
    channelId: string;
    platform: ChannelPlatform;
    /** IGSID for DMs, commenter id for comments. Linked later by the outbound step. */
    externalId: string;
    username?: string;
    kind: 'comment' | 'message';
    at: Date;
}

/**
 * The address book: one row per person per connected account. Every inbound
 * item touches it so the window timestamps and counters the send gate reads
 * are always current.
 */
@Injectable()
export class ContactService {
    async upsertFromInbound(tx: Prisma.TransactionClient, input: UpsertContactInput) {
        const touch = input.kind === 'comment' ? { lastCommentAt: input.at } : { lastInboundMessageAt: input.at };

        return tx.channelContact.upsert({
            where: {
                channelId_externalId: { channelId: input.channelId, externalId: input.externalId },
            },
            create: {
                organizationId: input.organizationId,
                channelId: input.channelId,
                platform: input.platform,
                externalId: input.externalId,
                username: input.username ?? null,
                inboundCount: input.kind === 'message' ? 1 : 0,
                metadata: { idSource: input.kind },
                ...touch,
            },
            update: {
                ...(input.username ? { username: input.username } : {}),
                ...(input.kind === 'message' ? { inboundCount: { increment: 1 } } : {}),
                ...touch,
            },
        });
    }
}