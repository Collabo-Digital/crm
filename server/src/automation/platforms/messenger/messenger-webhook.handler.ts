import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChannelPlatform, ChannelStatus, MessageKind, MessageSource, MessageStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { pickRoutingChannel } from '../../../channel/channel-connection.util';
import { IngestChannel, MessageIngestService } from '../../../messaging/message-ingest.service';
import { messengerContent } from '../../../messaging/message-content';
import { MsEvent, parseMessengerDelivery } from './messenger-webhook.parser';
import { AdsService } from '../../../ads/ads.service';

/**
 * Applies a `page` (Messenger) or `instagram` delivery to the account it
 * names: messages and comments into the inbox, our own sends' echoes and
 * receipts onto the rows we wrote.
 */
@Injectable()
export class MessengerWebhookHandler {
    private readonly logger = new Logger(MessengerWebhookHandler.name);
    private readonly appId: string | undefined;

    constructor(
        private readonly prisma: PrismaService,
        private readonly ingest: MessageIngestService,
        private readonly ads: AdsService,
        config: ConfigService,
    ) {
        this.appId = config.get<string>('meta.appId');
    }

    async handle(payload: unknown): Promise<void> {
        const events = parseMessengerDelivery(payload);
        const channels = new Map<string, IngestChannel | null>();
        for (const event of events) {
            const key = `${event.platform}:${event.accountId}`;
            if (!channels.has(key)) channels.set(key, await this.findChannel(event.platform, event.accountId));
            const channel = channels.get(key);
            if (!channel) {
                this.logger.warn(`${event.platform} webhook for account ${event.accountId}: no connected channel`);
                continue;
            }
            await this.apply(channel, event);
        }
    }

    private async apply(channel: IngestChannel, e: MsEvent): Promise<void> {
        const platformKey = e.platform === ChannelPlatform.INSTAGRAM ? 'instagram' : 'facebook';
        switch (e.kind) {
            case 'message': {
                if (e.message.isDeleted) {
                    await this.ingest.applyRevoke(channel, e.message.mid, e.timestamp);
                    return;
                }
                const recorded = await this.ingest.recordInbound({
                    channel,
                    contact: { platform: e.platform, scopedId: e.senderId },
                    externalId: e.message.mid,
                    occurredAt: e.timestamp,
                    content: messengerContent(e.message),
                    body: e.message.raw,
                    replyToExternalId: e.message.replyToMid,
                    standby: e.standby,
                    consentPayload: e.message.quickReplyPayload,
                    event: {
                        // A story mention reaches us as a DM with a story_mention attachment.
                        type: e.platform === ChannelPlatform.INSTAGRAM
                            ? (e.message.attachments[0]?.type === 'story_mention' ? 'instagram.mention' : 'instagram.message')
                            : 'facebook.message',
                        extraPayload: {
                            quickReplyPayload: e.message.quickReplyPayload,
                            storyReply: e.message.replyToStory,
                            referral: e.message.referral,
                        },
                    },
                });
                // A chat from a click-to-Messenger or click-to-Instagram ad.
                if (recorded && e.message.referral) {
                    await this.ads.captureReferral(channel, { conversationId: recorded.conversationId, messageId: recorded.messageId, referral: e.message.referral, at: e.timestamp });
                }
                return;
            }
            case 'echo': {
                // Our own sends come back as echoes; the sender already wrote them.
                if (e.appId && this.appId && e.appId === this.appId) return;
                await this.ingest.recordBusinessMessage({
                    channel,
                    contact: { platform: e.platform, scopedId: e.recipientId },
                    externalId: e.message.mid,
                    occurredAt: e.timestamp,
                    content: messengerContent(e.message),
                    body: { ...e.message.raw, app_id: e.appId },
                    replyToExternalId: e.message.replyToMid,
                    source: MessageSource.OTHER_APP,
                });
                return;
            }
            case 'postback': {
                const recorded = await this.ingest.recordInbound({
                    channel,
                    contact: { platform: e.platform, scopedId: e.senderId },
                    externalId: e.mid ?? `postback:${e.senderId}:${e.timestamp.getTime()}`,
                    occurredAt: e.timestamp,
                    content: { kind: MessageKind.INTERACTIVE, text: e.title, media: null },
                    body: { postback: { title: e.title, payload: e.payload, referral: e.referral } },
                    standby: e.standby,
                    consentPayload: e.payload,
                    event: {
                        type: e.platform === ChannelPlatform.INSTAGRAM ? 'instagram.postback' : 'facebook.postback',
                        extraPayload: { postbackPayload: e.payload },
                    },
                });
                // A new thread from an ad can open with Get Started, carrying the referral.
                if (recorded && e.referral) {
                    await this.ads.captureReferral(channel, { conversationId: recorded.conversationId, messageId: recorded.messageId, referral: e.referral, at: e.timestamp });
                }
                return;
            }
            case 'referral':
                // Someone with a thread already open tapped an ad: no message, just the referral.
                await this.ads.captureForSender(channel, e.senderId, e.referral, e.timestamp);
                return;
            case 'delivery':
                for (const mid of e.mids) {
                    await this.ingest.applyStatus(channel, mid, { status: MessageStatus.DELIVERED, at: e.timestamp });
                }
                if (e.watermark) {
                    await this.ingest.applyWatermark(channel, { platform: e.platform, scopedId: e.senderId }, MessageStatus.DELIVERED, e.watermark);
                }
                return;
            case 'read':
                if (e.mid) await this.ingest.applyStatus(channel, e.mid, { status: MessageStatus.READ, at: e.timestamp });
                if (e.watermark) {
                    await this.ingest.applyWatermark(channel, { platform: e.platform, scopedId: e.senderId }, MessageStatus.READ, e.watermark);
                }
                return;
            case 'reaction':
                await this.ingest.applyReaction(channel, e.mid, e.action === 'unreact' ? null : e.emoji, 'customer');
                return;
            case 'edit':
                await this.ingest.applyEdit(channel, e.mid, e.text, e.timestamp);
                return;
            case 'comment': {
                // The business's own comments and replies are not inbox items.
                if (!e.fromId || e.fromId === e.accountId) return;
                if (e.verb === 'remove') {
                    await this.ingest.applyRevoke(channel, e.commentId, e.timestamp);
                    return;
                }
                if (e.verb === 'edited') {
                    await this.ingest.applyEdit(channel, e.commentId, e.text, e.timestamp);
                    return;
                }
                if (e.verb !== 'add') return;
                await this.ingest.recordInbound({
                    channel,
                    contact: {
                        platform: e.platform,
                        scopedId: e.fromId,
                        ...(e.platform === ChannelPlatform.INSTAGRAM ? { username: e.fromName } : { profileName: e.fromName }),
                    },
                    externalId: e.commentId,
                    occurredAt: e.timestamp,
                    content: { kind: MessageKind.COMMENT, text: e.text, media: null },
                    body: { comment: e.raw, postId: e.postId, parentId: e.parentId, mediaProductType: e.mediaProductType },
                    event: {
                        type: e.platform === ChannelPlatform.INSTAGRAM ? 'instagram.comment' : 'facebook.comment',
                        mediaExternalId: e.platform === ChannelPlatform.INSTAGRAM ? e.postId : null,
                        extraPayload: { postId: e.postId, parentId: e.parentId },
                    },
                });
                return;
            }
            case 'mention':
                this.logger.log(`Instagram mention on media ${e.mediaId ?? 'unknown'} for channel ${channel.id}`);
                return;
            case 'handover':
                this.logger.log(`${platformKey} thread control for ${e.senderId}: ${e.type}`);
                return;
            default:
                this.logger.debug(`${platformKey} event not stored: ${e.type}`);
        }
    }

    private async findChannel(platform: ChannelPlatform, accountId: string): Promise<IngestChannel | null> {
        const claims = await this.prisma.channel.findMany({
            where: { platform, externalStoreId: accountId, status: { not: ChannelStatus.DISCONNECTED } },
            select: { id: true, organizationId: true, platform: true, status: true, connectedAt: true },
        });
        const row = pickRoutingChannel(claims);
        if (row && claims.length > 1) {
            this.logger.warn(`${platform} webhook for account ${accountId}: ${claims.length} channels claim it; routed to ${row.id} (org ${row.organizationId})`);
        }
        return row ? { id: row.id, organizationId: row.organizationId, platform: row.platform, address: accountId } : null;
    }
}
