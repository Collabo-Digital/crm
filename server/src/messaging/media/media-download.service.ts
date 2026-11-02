import { Injectable, Logger } from '@nestjs/common';
import { ChannelPlatform, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MetaGraphClient } from '../../channel/meta-graph.client';
import { Priority } from '../../rate-limit/rate-limit.types';
import { ChannelAccessService } from '../channel-access.service';
import { InboxEventsService } from '../inbox-events.service';
import { MessagingMediaStorage } from './messaging-media.storage';
import { MAX_MEDIA_BYTES } from './media-download.queue';
import type { MediaSpec } from '../message-content';

type StoredMedia = MediaSpec & { storageKey?: string; size?: number; downloadedAt?: string; error?: string };

/**
 * Copies a message's media from Meta into private storage. WhatsApp media is
 * fetched by id with the channel token (ids expire after 7 days, the URL
 * they resolve to after 5 minutes); Messenger and Instagram attachments are
 * CDN links that also expire.
 */
@Injectable()
export class MediaDownloadService {
    private readonly logger = new Logger(MediaDownloadService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly access: ChannelAccessService,
        private readonly metaGraph: MetaGraphClient,
        private readonly storage: MessagingMediaStorage,
        private readonly events: InboxEventsService,
    ) { }

    async download(messageId: string): Promise<'stored' | 'skipped'> {
        const message = await this.prisma.message.findUnique({
            where: { id: messageId },
            select: { id: true, organizationId: true, channelId: true, conversationId: true, media: true, revokedAt: true },
        });
        const media = (message?.media ?? null) as StoredMedia | null;
        if (!message || !media || media.storageKey || media.doNotStore || message.revokedAt) return 'skipped';

        const channel = await this.access.get(message.channelId);
        let url = media.url ?? null;
        let mime = media.mime ?? null;
        // WhatsApp media URLs need the token; Messenger and Instagram CDN links must not get it.
        const authorized = channel.platform === ChannelPlatform.WHATSAPP;

        if (channel.platform === ChannelPlatform.WHATSAPP && media.platformMediaId) {
            const res = await this.metaGraph.request<{ url?: string; mime_type?: string; file_size?: number }>({
                method: 'GET',
                path: `/${media.platformMediaId}`,
                query: { phone_number_id: channel.address },
                accessToken: channel.token,
                scopes: channel.scopes,
                priority: Priority.NORMAL,
                channelId: channel.id,
            });
            url = res.data.url ?? url;
            mime = res.data.mime_type ?? mime;
            if ((res.data.file_size ?? 0) > MAX_MEDIA_BYTES) {
                await this.patch(message.id, media, { error: 'File is larger than 100 MB and was not stored.' });
                return 'skipped';
            }
        }
        if (!url) return 'skipped';

        const res = await fetch(url, {
            headers: authorized ? { Authorization: `Bearer ${channel.token}` } : {},
            signal: AbortSignal.timeout(60_000),
        });
        if (!res.ok) throw new Error(`Media download failed: HTTP ${res.status}`);
        const length = Number(res.headers.get('content-length') ?? 0);
        if (length > MAX_MEDIA_BYTES) {
            await this.patch(message.id, media, { error: 'File is larger than 100 MB and was not stored.' });
            return 'skipped';
        }
        const buffer = Buffer.from(await res.arrayBuffer());
        const contentType = mime ?? res.headers.get('content-type') ?? 'application/octet-stream';
        const saved = await this.storage.save(message.organizationId, buffer, contentType);
        await this.patch(message.id, media, {
            storageKey: saved.storageKey,
            size: saved.size,
            mime: contentType,
            downloadedAt: new Date().toISOString(),
        });
        if (message.conversationId) {
            this.events.publish(message.organizationId, { type: 'message.updated', conversationId: message.conversationId, messageId: message.id });
        }
        return 'stored';
    }

    async markFailed(messageId: string, error: string): Promise<void> {
        const message = await this.prisma.message.findUnique({ where: { id: messageId }, select: { media: true } });
        if (!message?.media) return;
        await this.patch(messageId, message.media as StoredMedia, { error: error.slice(0, 300) });
    }

    private async patch(messageId: string, current: StoredMedia, change: Partial<StoredMedia>) {
        await this.prisma.message.update({
            where: { id: messageId },
            data: { media: { ...current, ...change } as Prisma.InputJsonValue },
        });
    }
}
