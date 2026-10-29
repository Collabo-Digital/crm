import { Injectable } from '@nestjs/common';
import { BroadcastRecipientStatus as R, MessageKind, MessageStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/// A message from someone within this long of a broadcast counts as a reply to it.
export const BROADCAST_REPLY_WINDOW_MS = 72 * 3600_000;

/** Recipient statuses a message status may move on from. Forward only, like the messages themselves. */
const FROM: Partial<Record<MessageStatus, R[]>> = {
    [MessageStatus.SENT]: [R.PENDING, R.QUEUED],
    [MessageStatus.DELIVERED]: [R.PENDING, R.QUEUED, R.SENT],
    [MessageStatus.READ]: [R.PENDING, R.QUEUED, R.SENT, R.DELIVERED],
    [MessageStatus.FAILED]: [R.PENDING, R.QUEUED, R.SENT],
};

/**
 * Keeps broadcast recipients in step with their messages — sent, delivered,
 * read, failed — and credits a broadcast with the replies and button taps
 * that follow it. Lives with messaging so the writers of message state call
 * it directly.
 */
@Injectable()
export class BroadcastTracker {
    constructor(private readonly prisma: PrismaService) { }

    async onStatus(messageId: string, messageStatus: MessageStatus, at: Date, error?: { code: string | null; message: string | null } | null) {
        // A recipient's statuses stop at read; a played voice note is one.
        const status = messageStatus === MessageStatus.PLAYED ? MessageStatus.READ : messageStatus;
        const from = FROM[status];
        if (!from) return;
        await this.prisma.broadcastRecipient.updateMany({
            where: { messageId, status: { in: from } },
            data:
                status === MessageStatus.SENT
                    ? { status: R.SENT, sentAt: at }
                    : status === MessageStatus.DELIVERED
                        ? { status: R.DELIVERED, deliveredAt: at }
                        : status === MessageStatus.READ
                            ? { status: R.READ, readAt: at }
                            : { status: R.FAILED, failedAt: at, errorCode: error?.code ?? null, errorMessage: error?.message ?? null },
        });
        // A message reported delivered or read was also sent, even if that webhook never came.
        if (status === MessageStatus.DELIVERED || status === MessageStatus.READ) {
            await this.prisma.broadcastRecipient.updateMany({ where: { messageId, sentAt: null }, data: { sentAt: at } });
        }
        if (status === MessageStatus.READ) {
            await this.prisma.broadcastRecipient.updateMany({ where: { messageId, deliveredAt: null }, data: { deliveredAt: at } });
        }
    }

    /**
     * Someone wrote in. A reply to the broadcast message itself — a template
     * button tap carries it as context — is a click as well as a reply;
     * otherwise their most recent broadcast in the last three days gets the reply.
     */
    async onInbound(input: { contactId: string; at: Date; replyToExternalId: string | null; kind: MessageKind }) {
        if (input.replyToExternalId) {
            const quoted = await this.prisma.message.findFirst({
                where: { contactId: input.contactId, externalId: input.replyToExternalId },
                select: { id: true },
            });
            const recipient = quoted
                ? await this.prisma.broadcastRecipient.findUnique({ where: { messageId: quoted.id }, select: { id: true, repliedAt: true, clickedAt: true } })
                : null;
            if (recipient) {
                const click = input.kind === MessageKind.INTERACTIVE && !recipient.clickedAt;
                if (!recipient.repliedAt || click) {
                    await this.prisma.broadcastRecipient.update({
                        where: { id: recipient.id },
                        data: { ...(recipient.repliedAt ? {} : { repliedAt: input.at }), ...(click ? { clickedAt: input.at } : {}) },
                    });
                }
                return;
            }
        }
        // Only the latest broadcast is credited; once it has its reply, later messages credit nothing.
        const recent = await this.prisma.broadcastRecipient.findFirst({
            where: {
                contactId: input.contactId,
                sentAt: { gte: new Date(input.at.getTime() - BROADCAST_REPLY_WINDOW_MS), lte: input.at },
            },
            orderBy: { sentAt: 'desc' },
            select: { id: true, repliedAt: true },
        });
        if (recent && !recent.repliedAt) await this.prisma.broadcastRecipient.update({ where: { id: recent.id }, data: { repliedAt: input.at } });
    }
}
