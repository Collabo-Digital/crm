import { Injectable, Logger } from '@nestjs/common';
import { ChannelPlatform, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MetaGraphClient } from '../channel/meta-graph.client';
import { MetaGraphError } from '../channel/meta-graph.types';
import { Priority } from '../rate-limit/rate-limit.types';
import { ChannelAccessService } from './channel-access.service';
import { InboxEventsService } from './inbox-events.service';

/**
 * Names and photos for Messenger and Instagram contacts, which webhooks
 * identify only by a scoped id. Read once when the contact first writes.
 * Messenger needs Meta's "Business Asset User Profile Access" feature; without
 * it the lookup fails and the contact keeps showing its id.
 */
@Injectable()
export class ContactProfileService {
    private readonly logger = new Logger(ContactProfileService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly access: ChannelAccessService,
        private readonly metaGraph: MetaGraphClient,
        private readonly events: InboxEventsService,
    ) { }

    async fetch(contactId: string): Promise<'updated' | 'skipped' | 'unavailable'> {
        const contact = await this.prisma.channelContact.findUnique({
            where: { id: contactId },
            select: { id: true, channelId: true, platform: true, externalId: true, displayName: true, metadata: true, organizationId: true },
        });
        if (!contact || contact.platform === ChannelPlatform.WHATSAPP || contact.displayName) return 'skipped';

        const channel = await this.access.get(contact.channelId);
        const fields =
            contact.platform === ChannelPlatform.FACEBOOK ? 'first_name,last_name,profile_pic' : 'name,username,profile_pic';
        try {
            const res = await this.metaGraph.request<{
                first_name?: string;
                last_name?: string;
                name?: string;
                username?: string;
                profile_pic?: string;
            }>({
                method: 'GET',
                ...(channel.baseUrl ? { url: `${channel.baseUrl}/${contact.externalId}` } : { path: `/${contact.externalId}` }),
                query: { fields },
                accessToken: channel.token,
                scopes: channel.scopes,
                pageId: channel.pageId ?? undefined,
                priority: Priority.BULK,
                channelId: channel.id,
            });
            const p = res.data;
            const name = p.name ?? ([p.first_name, p.last_name].filter(Boolean).join(' ') || null);
            await this.prisma.channelContact.update({
                where: { id: contact.id },
                data: {
                    ...(name ? { displayName: name } : {}),
                    ...(p.username ? { username: p.username } : {}),
                    ...(p.profile_pic ? { profilePicUrl: p.profile_pic } : {}),
                },
            });
            const conversations = await this.prisma.conversation.findMany({ where: { contactId: contact.id }, select: { id: true } });
            for (const c of conversations) this.events.publish(contact.organizationId, { type: 'conversation.updated', conversationId: c.id });
            return 'updated';
        } catch (err) {
            if (!(err instanceof MetaGraphError)) throw err;
            await this.prisma.channelContact.update({
                where: { id: contact.id },
                data: {
                    metadata: {
                        ...((contact.metadata as Record<string, unknown>) ?? {}),
                        profileLookup: { failedAt: new Date().toISOString(), error: err.message.slice(0, 200) },
                    } as Prisma.InputJsonValue,
                },
            });
            this.logger.debug(`Profile for contact ${contact.id} unavailable: ${err.message}`);
            return 'unavailable';
        }
    }
}
