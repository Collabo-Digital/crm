import { BadGatewayException, BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ChannelPlatform, ChannelStatus, Prisma, UserRole } from "@prisma/client";
import type { AutomationViewer } from "../../automation.service";
import { PrismaService } from "../../../prisma/prisma.service";
import { deletionCutoff, IG_MEDIA_FIELDS, IgMediaPage, isMediaSyncStale, mapIgMedia, MappedMedia, MEDIA_PAGE_SIZE, MEDIA_SYNC_LIMIT, mediaSyncedAt } from "./instagram-media.util";
import { isRateLimitedError, Priority } from "../../../rate-limit/rate-limit.types";
import { MetaGraphError, metaScope, type MetaResponse } from "../../../channel/meta-graph.types";
import { InstagramOAuthService } from "../../../channel/instagram-oauth.service";
import { MetaGraphClient } from "../../../channel/meta-graph.client";
import { ConfigService } from "@nestjs/config";

const IG_GRAPH_HOST = 'https://graph.instagram.com';
const MEDIA_FETCH_TIMEOUT_MS = 30_000;
const LABEL_CAPTION_MAX = 140;

export interface MediaListQuery {
    search?: string;
    limit?: number;
    refresh?: boolean;
}

const LIST_SELECT = {
    id: true,
    externalId: true,
    mediaType: true,
    permalink: true,
    thumbnailUrl: true,
    caption: true,
    postedAt: true,
    likeCount: true,
    commentCount: true,
} satisfies Prisma.ChannelMediaSelect;

type ChannelRow = {
    id: string;
    organizationId: string;
    platform: ChannelPlatform;
    status: ChannelStatus;
    ownerUserId: string | null;
    metadata: Prisma.JsonValue;
};

function describeError(err: unknown): string {
    if (err instanceof MetaGraphError) return `${err.httpStatus ?? 'network'} ${err.code}: ${err.message}`;
    return err instanceof Error ? err.message : String(err);
}



/**
 * The post cache behind the trigger's "Post or reel" picker.
 *
 * Reads come from channel_media; a read refreshes the cache inline when it is
 * older than MEDIA_STALE_MS. Nothing else writes channel_media, so the run
 * engine can match incoming comments against it with one indexed lookup.
 */
@Injectable()
export class InstagramMediaService {
    private readonly logger = new Logger(InstagramMediaService.name)
    private readonly graphVersion: string;

    constructor(
        private readonly prisma: PrismaService,
        private readonly config: ConfigService,
        private readonly metaGraph: MetaGraphClient,
        private readonly instagramOAuth: InstagramOAuthService,
    ) {
        this.graphVersion = this.config.get<string>('instagram.graphVersion') ?? 'v21.0';
    }

    /** GET /automations/media — cached posts, refreshed first when stale or asked. */
    async list(channelId: string, orgId: string, viewer: AutomationViewer, query: MediaListQuery) {
        const channel = await this.getChannel(channelId, orgId, viewer)
        const now = new Date();
        let syncError: string | null = null

        const shouldSync = channel.status === ChannelStatus.CONNECTED && (query.refresh || isMediaSyncStale(channel.metadata, now))
        if (shouldSync) {
            try {
                await this.sync(channel, Priority.INTERACTIVE)
            } catch (error) {
                // A rate limit becomes a 503 + Retry-After via the HTTP filter.
                // Anything else must not empty the picker: serve the cache.
                if (isRateLimitedError(error)) throw error;
                syncError = describeError(error);
                this.logger.warn(`Instagram media refresh for channel ${channel.id} failed: ${syncError}`);
            }
        }

        const cachedPosts = await this.prisma.channelMedia.findMany({
            where: { channelId: channel.id, deletedAt: null, ...(query.search ? { caption: { contains: query.search, mode: 'insensitive' } } : ({})) },
            orderBy: [{ postedAt: 'desc' }, { createdAt: 'desc' }],
            take: query.limit ?? MEDIA_SYNC_LIMIT,
            select: LIST_SELECT
        })

        const channelAfterSync = await this.prisma.channel.findUnique({
            where: { id: channel.id },
            select: { metadata: true }
        })

        return {
            data: cachedPosts.map((r) => ({
                ...r,
                caption: r.caption && r.caption.length > LABEL_CAPTION_MAX
                    ? `${r.caption.slice(0, LABEL_CAPTION_MAX - 1)}…`
                    : r.caption,
            })),
            syncedAt: mediaSyncedAt(channelAfterSync?.metadata),
            stale: isMediaSyncStale(channelAfterSync?.metadata, now),
            syncError,
        };
    }


    /** POST /automations/media/sync — explicit refresh; errors surface. */
    async refresh(channelId: string, orgId: string, viewer: AutomationViewer) {
        const channel = await this.getChannel(channelId, orgId, viewer)
        if (channel.status !== ChannelStatus.CONNECTED) {
            throw new BadRequestException('Instagram account is not connected');
        }

        try {
            return await this.sync(channel, Priority.INTERACTIVE)
        } catch (error) {
            if (isRateLimitedError(error)) throw error
            if (error instanceof BadRequestException) throw error; // token upkeep already explained itself
            if (error instanceof MetaGraphError && error.code === 'AUTH_FAILED') {
                throw new BadRequestException('Instagram access failed. Reconnect the account.');
            }
            this.logger.error(`Instagram media sync for channel ${channel.id} failed: ${describeError(error)}`);
            throw new BadGatewayException('Instagram could not be reached. Please try again.');

        }
    }


    /** Tenant + visibility in the WHERE; 404 for "missing" and "not yours" alike. */
    private async getChannel(channelId: string, orgId: string, viewer: AutomationViewer): Promise<ChannelRow> {
        const channel = await this.prisma.channel.findFirst({
            where: { id: channelId, organizationId: orgId },
            select: { id: true, organizationId: true, platform: true, status: true, ownerUserId: true, metadata: true },
        });
        if (!channel) throw new NotFoundException('Channel not found');
        if (viewer.role === UserRole.INFLUENCER && channel.ownerUserId !== viewer.userId) {
            throw new NotFoundException('Channel not found');
        }
        if (channel.platform !== ChannelPlatform.INSTAGRAM) {
            throw new BadRequestException('Post picker is only available for Instagram accounts');
        }
        return channel;
    }

    /** Pull the newest MEDIA_SYNC_LIMIT posts and reconcile channel_media. */
    private async sync(channel: ChannelRow, priority: Priority) {
        const now = new Date();
        try {
            const nodes = await this.fetchRecent(channel.id, priority);

            // First occurrence wins if Meta repeats an id across pages.
            const seenExternalIds = new Set<string>();
            const posts: MappedMedia[] = [];

            for (const rawPost of nodes) {
                const post = mapIgMedia(rawPost);
                if (!post) continue;
                if (seenExternalIds.has(post.externalId)) continue;
                seenExternalIds.add(post.externalId);
                posts.push(post);
            }
            const postIds = posts.map((post) => post.externalId)
            const cutoff = deletionCutoff(posts);

            const deleted = await this.prisma.$transaction(async (tx) => {
                for (const post of posts) {
                    await tx.channelMedia.upsert({
                        where: { channelId_externalId: { channelId: channel.id, externalId: post.externalId } },
                        create: { organizationId: channel.organizationId, channelId: channel.id, ...post },
                        update: { ...post, deletedAt: null }
                    })
                }

                let removed = 0
                if (cutoff && postIds.length > 0) {
                    const res = await tx.channelMedia.updateMany({
                        where: { channelId: channel.id, deletedAt: null, externalId: { notIn: postIds }, postedAt: { gte: cutoff } },
                        data: { deletedAt: now }
                    })
                    removed = res.count
                }

                // Triggers published before this post was cached carry only the
                // external id; link them now so runs and the detail page resolve.
                if (postIds.length > 0) {
                    const cachedPosts = await tx.channelMedia.findMany({
                        where: { channelId: channel.id, externalId: { in: postIds } },
                        select: { id: true, externalId: true },
                    });

                    const mediaIdByPostId = new Map(cachedPosts.map((post) => [post.externalId, post.id]));
                    const triggersMissingMedia = await tx.automationTrigger.findMany({
                        where: { channelId: channel.id, mediaId: null, subjectId: { in: postIds } },
                        select: { id: true, subjectId: true },
                    });

                    for (const trigger of triggersMissingMedia) {
                        const mediaId = trigger.subjectId ? mediaIdByPostId.get(trigger.subjectId) : undefined;
                        if (mediaId) {
                            await tx.automationTrigger.update({ where: { id: trigger.id }, data: { mediaId } });
                        }
                    }
                }

                return removed
            })

            await this.writeSyncState(channel.id, { at: now.toISOString(), count: posts.length, deleted, error: null })
            this.logger.log(`Instagram media sync for channel ${channel.id}: ${posts.length} synced, ${deleted} deleted`);
            return { synced: posts.length, deleted, syncedAt: now };
        } catch (error) {
            console.log(error)
            await this.writeSyncState(channel.id, { error: describeError(error) }).catch(() => undefined)
            throw error
        }
    }

    /** GET /me/media, following paging.next until the cap. */
    private async fetchRecent(channelId: string, priority: Priority) {
        const { token, igUserId } = await this.instagramOAuth.getAccessToken(channelId)
        const scopes = [...this.metaGraph.baseScopes(), metaScope.igUser(igUserId)];

        const nodes: IgMediaPage['data'] = []
        let url: string | undefined = `${IG_GRAPH_HOST}/${this.graphVersion}/me/media`;
        let query: Record<string, string | number> | undefined = { fields: IG_MEDIA_FIELDS, limit: MEDIA_PAGE_SIZE };

        while (url && nodes.length < MEDIA_SYNC_LIMIT) {
            const res: MetaResponse<IgMediaPage> = await this.metaGraph.request<IgMediaPage>({
                method: 'GET',
                url,
                query,
                accessToken: token,
                scopes,
                priority,
                channelId,
                timeoutMs: MEDIA_FETCH_TIMEOUT_MS,
            })

            nodes.push(...(res.data.data ?? []))
            // paging.next is a complete URL carrying fields, limit and cursor.
            url = res.data.paging?.next;
            query = undefined;
        }
        return nodes.slice(0, MEDIA_SYNC_LIMIT);
    }

    /** Merge mediaSync into Channel.metadata; never replace the whole object. */
    private async writeSyncState(channelId: string, patch: Record<string, unknown>) {
        const channel = await this.prisma.channel.findUnique({
            where: { id: channelId },
            select: { metadata: true }
        })
        const channelMetaData = (channel?.metadata && typeof channel.metadata === 'object' && !Array.isArray(channel.metadata) ? channel.metadata : {}) as Record<string, unknown>
        const previousSyncState = (channelMetaData.mediaSync && typeof channelMetaData.mediaSync === 'object' ? channelMetaData.mediaSync : {}) as Record<string, unknown>
        await this.prisma.channel.update({
            where: { id: channelId },
            data: { metadata: { ...channelMetaData, mediaSync: { ...previousSyncState, ...patch } } as unknown as Prisma.InputJsonValue }
        })
    }

}