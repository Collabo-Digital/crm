import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChannelPlatform, ChannelStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EncryptionService } from '../channel/encryption.service';
import { InstagramOAuthService } from '../channel/instagram-oauth.service';
import { INSTAGRAM_LOGIN_FLOW } from '../channel/instagram-login.util';
import { MetaGraphClient } from '../channel/meta-graph.client';
import { metaScope } from '../channel/meta-graph.types';
import type { RateLimitScope } from '../rate-limit/rate-limit.types';

/** Everything needed to send through, or download from, one messaging channel. */
export interface ChannelAccess {
    id: string;
    organizationId: string;
    platform: ChannelPlatform;
    status: ChannelStatus;
    isEnabled: boolean;
    /** Coexistence number offboarded or partner link gone. */
    sendsPaused: boolean;
    /** Our address on the platform: phone number id, Page id, Instagram account id. */
    address: string;
    token: string;
    /** Where sends go: `/{phone_number_id}/messages`, `/{page_id}/messages`, or Instagram Login's `/{ig_id}/messages`. */
    sendPath: string;
    /** Absolute base for Instagram Login rows, which live on graph.instagram.com. */
    baseUrl: string | null;
    scopes: RateLimitScope[];
    pageId: string | null;
    wabaId: string | null;
}

type Obj = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' && v ? v : null);

/**
 * Resolves a messaging channel to its token and addresses. One place that
 * knows the three credential shapes: WhatsApp (business token + phone number
 * id), Facebook Pages and Page-linked Instagram (Page token), and Instagram
 * Login (Instagram user token on graph.instagram.com).
 */
@Injectable()
export class ChannelAccessService {
    private readonly graphVersion: string;

    constructor(
        private readonly prisma: PrismaService,
        private readonly encryption: EncryptionService,
        private readonly instagramOAuth: InstagramOAuthService,
        private readonly metaGraph: MetaGraphClient,
        config: ConfigService,
    ) {
        this.graphVersion = config.get<string>('meta.graphVersion') ?? 'v21.0';
    }

    async get(channelId: string): Promise<ChannelAccess> {
        const channel = await this.prisma.channel.findUnique({
            where: { id: channelId },
            select: { id: true, organizationId: true, platform: true, status: true, isEnabled: true, credentials: true, metadata: true },
        });
        if (!channel?.credentials) throw new NotFoundException('Channel not found or not connected');
        const creds = channel.credentials as Obj;
        const meta = (channel.metadata ?? {}) as Obj;
        const coexistence = (meta.coexistence ?? {}) as Obj;
        const base = {
            id: channel.id,
            organizationId: channel.organizationId,
            platform: channel.platform,
            status: channel.status,
            isEnabled: channel.isEnabled,
            sendsPaused: coexistence.sendsPaused === true,
        };
        const app = this.metaGraph.baseScopes();

        switch (channel.platform) {
            case ChannelPlatform.WHATSAPP: {
                const phoneNumberId = str(creds.phoneNumberId);
                const wabaId = str(creds.wabaId);
                const token = this.decrypt(creds.accessToken);
                if (!phoneNumberId || !wabaId || !token) throw new BadRequestException('WhatsApp channel is missing credentials. Reconnect it.');
                return {
                    ...base,
                    address: phoneNumberId,
                    token,
                    sendPath: `/${phoneNumberId}/messages`,
                    baseUrl: null,
                    scopes: [...app, metaScope.buc(wabaId), metaScope.phone(phoneNumberId)],
                    pageId: null,
                    wabaId,
                };
            }
            case ChannelPlatform.FACEBOOK:
            case ChannelPlatform.INSTAGRAM: {
                if (channel.platform === ChannelPlatform.INSTAGRAM && creds.authFlow === INSTAGRAM_LOGIN_FLOW) {
                    const { token, igUserId } = await this.instagramOAuth.getAccessToken(channel.id);
                    return {
                        ...base,
                        address: igUserId,
                        token,
                        sendPath: `/${igUserId}/messages`,
                        baseUrl: `https://graph.instagram.com/${this.graphVersion}`,
                        scopes: [...app, metaScope.igUser(igUserId)],
                        pageId: null,
                        wabaId: null,
                    };
                }
                const pageId = str(creds.pageId);
                const token = this.decrypt(creds.pageAccessToken);
                if (!pageId || !token) throw new BadRequestException('This account is missing its Page access. Reconnect it.');
                const address =
                    channel.platform === ChannelPlatform.INSTAGRAM ? (str(creds.instagramUserId) ?? pageId) : pageId;
                return {
                    ...base,
                    address,
                    token,
                    sendPath: `/${pageId}/messages`,
                    baseUrl: null,
                    scopes: [...app, metaScope.page(pageId)],
                    pageId,
                    wabaId: null,
                };
            }
            default:
                throw new BadRequestException(`${channel.platform} is not a messaging channel`);
        }
    }

    private decrypt(cipher: unknown): string | null {
        if (typeof cipher !== 'string' || !cipher) return null;
        try {
            return this.encryption.decrypt(cipher) || null;
        } catch {
            return null;
        }
    }
}
