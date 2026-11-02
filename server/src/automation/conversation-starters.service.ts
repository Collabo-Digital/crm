import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ChannelPlatform, Prisma, UserRole } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { MetaGraphClient } from '../channel/meta-graph.client';
import { patchChannelMetadataSql } from '../channel/channel-metadata.util';
import { Priority } from '../rate-limit/rate-limit.types';
import { ChannelAccessService } from '../messaging/channel-access.service';
import type { AutomationViewer } from './automation.service';

export const StartersSchema = z.object({
    /** Messenger only: the button a person taps to open a new chat. Required for a menu. */
    getStarted: z.object({ enabled: z.boolean().default(false), payload: z.string().min(1).max(1000).default('GET_STARTED') }).default({ enabled: false, payload: 'GET_STARTED' }),
    /** Questions shown when someone opens a chat for the first time. Meta allows four. */
    iceBreakers: z.array(z.object({ question: z.string().trim().min(1).max(80), payload: z.string().trim().min(1).max(1000) })).max(4).default([]),
    persistentMenu: z
        .array(
            z.object({
                title: z.string().trim().min(1).max(30),
                type: z.enum(['postback', 'web_url']),
                payload: z.string().max(1000).default(''),
                url: z.string().max(1000).default(''),
            }),
        )
        .max(20)
        .default([]),
});
export type Starters = z.infer<typeof StartersSchema>;

const EMPTY: Starters = StartersSchema.parse({});

/**
 * Ice breakers, the Get Started button and the persistent menu of a Facebook
 * Page or Instagram account, through Meta's Messenger Profile API. A tap
 * arrives as a postback, which a postback trigger can answer. Saved on the
 * channel so the editor shows what was last pushed.
 */
@Injectable()
export class ConversationStartersService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly access: ChannelAccessService,
        private readonly metaGraph: MetaGraphClient,
    ) { }

    async get(orgId: string, viewer: AutomationViewer, channelId: string) {
        const channel = await this.channel(orgId, viewer, channelId);
        const saved = (channel.metadata as { starters?: unknown } | null)?.starters;
        const parsed = StartersSchema.safeParse(saved ?? {});
        return { platform: channel.platform, ...(parsed.success ? parsed.data : EMPTY), pushedAt: (saved as { pushedAt?: string } | undefined)?.pushedAt ?? null };
    }

    async save(orgId: string, viewer: AutomationViewer, channelId: string, raw: unknown) {
        const channel = await this.channel(orgId, viewer, channelId);
        const parsed = StartersSchema.safeParse(raw);
        if (!parsed.success) {
            const issue = parsed.error.issues[0];
            throw new BadRequestException(`${issue.path.join('.') || 'starters'}: ${issue.message}`);
        }
        const s = parsed.data;
        const facebook = channel.platform === ChannelPlatform.FACEBOOK;
        if (!facebook) s.getStarted.enabled = false;
        for (const item of s.persistentMenu) {
            if (item.type === 'web_url' && !/^https:\/\//i.test(item.url)) throw new BadRequestException(`Menu item "${item.title}" needs an https:// link.`);
            if (item.type === 'postback' && !item.payload.trim()) throw new BadRequestException(`Menu item "${item.title}" needs a payload.`);
        }
        if (facebook && s.persistentMenu.length && !s.getStarted.enabled) {
            throw new BadRequestException('Turn on the Get Started button first: Messenger shows a menu only with it.');
        }

        const set: Record<string, unknown> = {};
        const clear: string[] = [];
        if (facebook) {
            if (s.getStarted.enabled) set.get_started = { payload: s.getStarted.payload };
            else clear.push('get_started');
        }
        if (s.iceBreakers.length) {
            set.ice_breakers = [{ locale: 'default', call_to_actions: s.iceBreakers.map((b) => ({ question: b.question, payload: b.payload })) }];
        } else clear.push('ice_breakers');
        if (s.persistentMenu.length) {
            set.persistent_menu = [
                {
                    locale: 'default',
                    composer_input_disabled: false,
                    call_to_actions: s.persistentMenu.map((m) =>
                        m.type === 'web_url' ? { type: 'web_url', title: m.title, url: m.url } : { type: 'postback', title: m.title, payload: m.payload },
                    ),
                },
            ];
        } else clear.push('persistent_menu');

        const access = await this.access.get(channel.id);
        // Page-linked Instagram goes through the Page with platform=instagram;
        // Instagram Login accounts call graph.instagram.com directly.
        const target = access.baseUrl ? { url: `${access.baseUrl}/me/messenger_profile` } : { path: '/me/messenger_profile' };
        const query = channel.platform === ChannelPlatform.INSTAGRAM && !access.baseUrl ? { platform: 'instagram' } : undefined;
        const common = { ...target, query, accessToken: access.token, scopes: access.scopes, pageId: access.pageId ?? undefined, priority: Priority.INTERACTIVE, channelId: channel.id };
        if (Object.keys(set).length) await this.metaGraph.request({ method: 'POST', ...common, body: set });
        if (clear.length) await this.metaGraph.request({ method: 'DELETE', ...common, body: { fields: clear } });

        const pushedAt = new Date().toISOString();
        await this.prisma.$executeRaw(patchChannelMetadataSql(channel.id, 'starters', { ...s, pushedAt }));
        return { platform: channel.platform, ...s, pushedAt };
    }

    private async channel(orgId: string, viewer: AutomationViewer, channelId: string) {
        const channel = await this.prisma.channel.findFirst({
            where: {
                id: channelId,
                organizationId: orgId,
                platform: { in: [ChannelPlatform.FACEBOOK, ChannelPlatform.INSTAGRAM] },
                ...(viewer.role === UserRole.INFLUENCER ? { ownerUserId: viewer.userId } : {}),
            },
            select: { id: true, platform: true, metadata: true },
        });
        if (!channel) throw new NotFoundException('Facebook Page or Instagram account not found');
        return channel as { id: string; platform: ChannelPlatform; metadata: Prisma.JsonValue };
    }
}
