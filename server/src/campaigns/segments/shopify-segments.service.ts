import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ChannelPlatform, ChannelStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ShopifyGraphqlClient } from '../../channel/shopify-graphql.client';
import { ShopifyOAuthService } from '../../channel/shopify-oauth.service';

const SEGMENTS_QUERY = /* GraphQL */ `
  query ShopifySegments($after: String) {
    segments(first: 100, after: $after) {
      nodes { id name query }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const MEMBERS_QUERY = /* GraphQL */ `
  query ShopifySegmentMembers($segmentId: ID!, $after: String) {
    customerSegmentMembers(segmentId: $segmentId, first: 1000, after: $after) {
      totalCount
      edges { node { id } }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

interface SegmentsResponse {
    segments: { nodes: Array<{ id: string; name: string; query: string | null }>; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
}
interface MembersResponse {
    customerSegmentMembers: { totalCount: number; edges: Array<{ node: { id: string } }>; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
}

/** Members read per sync; a bigger segment is synced up to this many and says so. */
const MAX_MEMBERS = 100_000;

/** The numeric customer id at the end of a member id, whether Shopify writes it as a Customer or a CustomerSegmentMember gid. */
export function customerNumber(gid: string): string | null {
    return /\/(\d+)$/.exec(gid)?.[1] ?? null;
}

/**
 * Customer segments built in the Shopify admin, as audiences: a merchant
 * links one, Collabo reads its members (read_customers, up to 1,000 a page)
 * and matches them to the store customers it has, and a Collabo segment rule
 * "Shopify segment is …" picks their contacts. Linked segments re-sync daily.
 */
@Injectable()
export class ShopifySegmentsService {
    private readonly logger = new Logger(ShopifySegmentsService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly graphql: ShopifyGraphqlClient,
        private readonly shopifyOAuth: ShopifyOAuthService,
    ) { }

    /** The store's segments, with the linked ones' counts. */
    async list(orgId: string) {
        const linked = await this.prisma.shopifySegment.findMany({ where: { organizationId: orgId }, orderBy: { name: 'asc' } });
        const channel = await this.store(orgId, false);
        let available: Array<{ id: string; name: string; query: string | null }> = [];
        let error: string | null = null;
        if (channel) {
            try {
                available = await this.remoteSegments(channel.id);
            } catch (err) {
                error = err instanceof Error ? err.message : String(err);
            }
        }
        return {
            connected: !!channel,
            error,
            linked: linked.map((s) => this.view(s)),
            available: available.filter((a) => !linked.some((l) => l.externalId === a.id)).map((a) => ({ externalId: a.id, name: a.name, query: a.query })),
        };
    }

    async link(orgId: string, externalId: string) {
        const channel = await this.store(orgId, true);
        const remote = (await this.remoteSegments(channel!.id)).find((s) => s.id === externalId);
        if (!remote) throw new NotFoundException('That segment is not in your Shopify store.');
        const row = await this.prisma.shopifySegment.upsert({
            where: { channelId_externalId: { channelId: channel!.id, externalId } },
            create: { organizationId: orgId, channelId: channel!.id, externalId, name: remote.name, query: remote.query },
            update: { name: remote.name, query: remote.query },
        });
        return this.sync(orgId, row.id);
    }

    async unlink(orgId: string, id: string) {
        const done = await this.prisma.shopifySegment.deleteMany({ where: { id, organizationId: orgId } });
        if (!done.count) throw new NotFoundException('Shopify segment not found');
    }

    /** Re-read the members; ones no longer in the segment leave it. */
    async sync(orgId: string, id: string) {
        const segment = await this.prisma.shopifySegment.findFirst({ where: { id, organizationId: orgId } });
        if (!segment) throw new NotFoundException('Shopify segment not found');
        const started = new Date();
        try {
            const { token, shopDomain } = await this.shopifyOAuth.getAccessToken(segment.channelId);
            const numbers = new Set<string>();
            let total = 0;
            let after: string | null = null;
            do {
                const res: MembersResponse = await this.graphql.request<MembersResponse, { segmentId: string; after: string | null }>(
                    { shopDomain, accessToken: token }, MEMBERS_QUERY, { segmentId: segment.externalId, after },
                );
                total = res.customerSegmentMembers.totalCount;
                for (const e of res.customerSegmentMembers.edges) {
                    const n = customerNumber(e.node.id);
                    if (n) numbers.add(n);
                }
                after = res.customerSegmentMembers.pageInfo.hasNextPage ? res.customerSegmentMembers.pageInfo.endCursor : null;
            } while (after && numbers.size < MAX_MEMBERS);

            const ids = [...numbers];
            const customers: Array<{ id: string }> = [];
            for (let i = 0; i < ids.length; i += 5000) {
                customers.push(...(await this.prisma.customer.findMany({ where: { channelId: segment.channelId, externalId: { in: ids.slice(i, i + 5000) } }, select: { id: true } })));
            }
            for (let i = 0; i < customers.length; i += 1000) {
                const chunk = customers.slice(i, i + 1000).map((c) => ({ segmentId: segment.id, customerId: c.id, syncedAt: started }));
                await this.prisma.$transaction([
                    this.prisma.shopifySegmentMember.deleteMany({ where: { segmentId: segment.id, customerId: { in: chunk.map((c) => c.customerId) } } }),
                    this.prisma.shopifySegmentMember.createMany({ data: chunk }),
                ]);
            }
            await this.prisma.shopifySegmentMember.deleteMany({ where: { segmentId: segment.id, syncedAt: { lt: started } } });
            const truncated = total > numbers.size && numbers.size >= MAX_MEMBERS;
            const updated = await this.prisma.shopifySegment.update({
                where: { id: segment.id },
                data: { memberCount: total, matchedCount: customers.length, syncedAt: new Date(), lastError: truncated ? `Only the first ${MAX_MEMBERS.toLocaleString('en-IN')} members were read.` : null },
            });
            return this.view(updated);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            await this.prisma.shopifySegment.update({ where: { id: segment.id }, data: { lastError: message.slice(0, 500) } });
            throw new BadRequestException(`Shopify did not return the segment’s members: ${message}`);
        }
    }

    @Cron(CronExpression.EVERY_DAY_AT_4AM)
    async syncAll(): Promise<void> {
        const all = await this.prisma.shopifySegment.findMany({ select: { id: true, organizationId: true } });
        for (const s of all) {
            await this.sync(s.organizationId, s.id).catch((err) => this.logger.warn(`Shopify segment ${s.id} not synced: ${err instanceof Error ? err.message : err}`));
        }
    }

    private async remoteSegments(channelId: string) {
        const { token, shopDomain } = await this.shopifyOAuth.getAccessToken(channelId);
        const out: Array<{ id: string; name: string; query: string | null }> = [];
        let after: string | null = null;
        for (let page = 0; page < 10; page++) {
            const res: SegmentsResponse = await this.graphql.request<SegmentsResponse, { after: string | null }>({ shopDomain, accessToken: token }, SEGMENTS_QUERY, { after });
            out.push(...res.segments.nodes);
            after = res.segments.pageInfo.hasNextPage ? res.segments.pageInfo.endCursor : null;
            if (!after) break;
        }
        return out;
    }

    private async store(orgId: string, required: boolean) {
        const channel = await this.prisma.channel.findFirst({ where: { organizationId: orgId, platform: ChannelPlatform.SHOPIFY, status: ChannelStatus.CONNECTED }, select: { id: true } });
        if (!channel && required) throw new BadRequestException('Connect your Shopify store first.');
        return channel;
    }

    private view(s: { id: string; externalId: string; name: string; query: string | null; memberCount: number | null; matchedCount: number | null; syncedAt: Date | null; lastError: string | null }) {
        return { id: s.id, externalId: s.externalId, name: s.name, query: s.query, memberCount: s.memberCount, matchedCount: s.matchedCount, syncedAt: s.syncedAt, lastError: s.lastError };
    }
}
