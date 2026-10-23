import { Injectable } from '@nestjs/common';
import { BroadcastRecipientStatus as R, ChannelPlatform, ChannelStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/** The Campaigns landing page: the last 30 days of broadcasts, template health and the number's limits. */
@Injectable()
export class CampaignsOverviewService {
    constructor(private readonly prisma: PrismaService) { }

    async overview(orgId: string) {
        const since = new Date(Date.now() - 30 * 24 * 3600_000);
        const recipients = { organizationId: orgId, broadcast: { startedAt: { gte: since } } };
        const [byStatus, replied, clicked, broadcasts, templates, channel, recent] = await Promise.all([
            this.prisma.broadcastRecipient.groupBy({ by: ['status'], where: recipients, _count: { _all: true } }),
            this.prisma.broadcastRecipient.count({ where: { ...recipients, repliedAt: { not: null } } }),
            this.prisma.broadcastRecipient.count({ where: { ...recipients, clickedAt: { not: null } } }),
            this.prisma.broadcast.count({ where: { organizationId: orgId, startedAt: { gte: since } } }),
            this.prisma.messageTemplate.groupBy({ by: ['status'], where: { organizationId: orgId }, _count: { _all: true } }),
            this.prisma.channel.findFirst({
                where: { organizationId: orgId, platform: ChannelPlatform.WHATSAPP, status: { not: ChannelStatus.DISCONNECTED } },
                select: { id: true, name: true, status: true, metadata: true },
            }),
            this.prisma.broadcast.findMany({
                where: { organizationId: orgId },
                orderBy: { createdAt: 'desc' },
                take: 5,
                select: { id: true, name: true, status: true, templateName: true, startedAt: true, scheduledAt: true, createdAt: true },
            }),
        ]);
        const n = Object.fromEntries(byStatus.map((s) => [s.status, s._count._all])) as Partial<Record<R, number>>;
        const health = ((channel?.metadata as Record<string, any> | null)?.health?.number ?? {}) as Record<string, any>;
        return {
            last30Days: {
                broadcasts,
                sent: (n.SENT ?? 0) + (n.DELIVERED ?? 0) + (n.READ ?? 0),
                delivered: (n.DELIVERED ?? 0) + (n.READ ?? 0),
                read: n.READ ?? 0,
                replied,
                clicked,
                failed: n.FAILED ?? 0,
            },
            templates: Object.fromEntries(templates.map((t) => [t.status, t._count._all])),
            number: channel
                ? {
                    channelId: channel.id,
                    name: channel.name,
                    status: channel.status,
                    quality: health.quality_rating ?? null,
                    messagingLimit: health.whatsapp_business_manager_messaging_limit ?? null,
                    marketingMessagesApi: ((channel.metadata as Record<string, any> | null)?.marketingMessages?.status as string | undefined) ?? null,
                }
                : null,
            recent,
        };
    }
}
