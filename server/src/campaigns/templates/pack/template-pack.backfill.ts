import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../../../prisma/prisma.service';
import { TEMPLATE_PACK_VERSION } from './template-pack';
import { TEMPLATE_PACK_QUEUE, TemplatePackJobData, claimPackRow, queuePackEnsure } from './template-pack.queue';

/**
 * Brings every connected WhatsApp account up to the current pack, from
 * application start-up (TEMPLATE_PACK_AUTO_ENABLE, on by default). An account
 * connected before the pack shipped gets its row here, with its automations
 * left for the merchant to turn on; a pack made for an older pack version is
 * ensured again. Each account is one `ensure` job under the organization's
 * job id, so several servers starting together queue it once, and the
 * queue's bulk priority keeps a merchant's own connect ahead of the backfill.
 */
@Injectable()
export class TemplatePackBackfill implements OnApplicationBootstrap {
    private readonly logger = new Logger(TemplatePackBackfill.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly config: ConfigService,
        @InjectQueue(TEMPLATE_PACK_QUEUE) private readonly queue: Queue<TemplatePackJobData>,
    ) { }

    onApplicationBootstrap(): void {
        if (this.config.get<boolean>('templatePack.autoEnable') === false) return;
        // Not awaited: start-up must not wait on, or fail with, the queue.
        void this.enqueueAll().catch((err) =>
            this.logger.error(`Could not queue the recommended templates; the next start tries again: ${err instanceof Error ? err.message : err}`),
        );
    }

    /** Queues an ensure for every connected account without the current pack. Returns how many were queued. */
    async enqueueAll(): Promise<number> {
        const accounts = await this.prisma.$queryRaw<Array<{ channelId: string; organizationId: string; wabaId: string; packOrg: string | null; version: number | null }>>`
            SELECT c."id" AS "channelId", c."organization_id" AS "organizationId", c."external_store_id" AS "wabaId",
                   p."organization_id" AS "packOrg", p."version"
            FROM "channels" c
            JOIN "organizations" o ON o."id" = c."organization_id" AND o."deleted_at" IS NULL
            LEFT JOIN "template_packs" p ON p."waba_id" = c."external_store_id"
            WHERE c."platform" = 'WHATSAPP' AND c."status" = 'CONNECTED' AND c."external_store_id" IS NOT NULL
              AND (p."id" IS NULL OR p."organization_id" <> c."organization_id" OR p."version" < ${TEMPLATE_PACK_VERSION})
            ORDER BY c."connected_at" NULLS LAST
        `;
        let queued = 0;
        for (const a of accounts) {
            if (a.packOrg !== a.organizationId) {
                await claimPackRow(this.prisma, { organizationId: a.organizationId, channelId: a.channelId, wabaId: a.wabaId, autoActivate: false, origin: 'backfill' });
            }
            if ((await queuePackEnsure(this.queue, { organizationId: a.organizationId, wabaId: a.wabaId, reason: 'backfill' }, { followUp: false })) === 'added') queued++;
        }
        if (queued > 0) this.logger.log(`Queued the recommended WhatsApp templates for ${queued} account(s).`);
        return queued;
    }
}
