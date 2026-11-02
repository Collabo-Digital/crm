import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import {
    META_INBOUND_JOB_OPTS,
    META_INBOUND_QUEUE,
    MetaInboundJobData,
    MetaWebhookObject,
} from './meta-inbound.queue';
import { SigningSecret, bodyHash, matchMetaSignature, summariseDelivery } from './meta-webhook.signature';

export type IntakeOutcome = 'stored' | 'redelivery' | 'bad_signature' | 'bad_body' | 'wrong_object';

/**
 * The first stop for every Meta webhook: check the signature, write the raw
 * body to meta_webhook_deliveries, queue it, acknowledge. Nothing here reads
 * the payload beyond what routing needs, so a slow or failing handler can
 * never turn a delivery into a non-200 — Messenger unsubscribes an app whose
 * deliveries keep failing for an hour.
 */
@Injectable()
export class MetaWebhookIntakeService {
    private readonly logger = new Logger(MetaWebhookIntakeService.name);
    private readonly appSecrets: SigningSecret[];
    private readonly instagramSecrets: SigningSecret[];

    constructor(
        private readonly prisma: PrismaService,
        config: ConfigService,
        @InjectQueue(META_INBOUND_QUEUE) private readonly queue: Queue<MetaInboundJobData>,
    ) {
        const app = config.get<string>('meta.appSecret');
        const igLogin = config.get<string>('instagram.loginAppSecret');
        this.appSecrets = app ? [{ label: 'META_APP_SECRET', secret: app }] : [];
        // Accounts connected through Instagram Login are signed with the
        // Instagram app secret rather than the Meta app secret.
        this.instagramSecrets = [
            ...(igLogin ? [{ label: 'INSTAGRAM_APP_SECRET', secret: igLogin }] : []),
            ...this.appSecrets,
        ];
    }

    async accept(
        expected: MetaWebhookObject,
        rawBody: Buffer | undefined,
        signature: string | undefined,
    ): Promise<IntakeOutcome> {
        if (!rawBody) return 'bad_body';
        const secrets = expected === 'instagram' ? this.instagramSecrets : this.appSecrets;
        if (!matchMetaSignature(rawBody, signature, secrets)) {
            this.logger.warn(`Meta ${expected} webhook rejected: signature does not match any configured app secret`);
            return 'bad_signature';
        }

        let body: { object?: unknown; entry?: unknown };
        try {
            body = JSON.parse(rawBody.toString('utf8')) as typeof body;
        } catch {
            this.logger.warn(`Meta ${expected} webhook body is not JSON`);
            return 'bad_body';
        }
        if (body.object !== expected) {
            this.logger.warn(`Meta webhook on the ${expected} endpoint carried object "${String(body.object)}"`);
            return 'wrong_object';
        }

        const hash = bodyHash(rawBody);
        const { entryIds, fields } = summariseDelivery(body);
        let deliveryId: string;
        let outcome: IntakeOutcome = 'stored';
        try {
            const row = await this.prisma.metaWebhookDelivery.create({
                data: {
                    object: expected,
                    entryIds,
                    fields,
                    payload: body as Prisma.InputJsonValue,
                    bodyHash: hash,
                },
                select: { id: true },
            });
            deliveryId = row.id;
        } catch (err) {
            if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
            const existing = await this.prisma.metaWebhookDelivery.findUnique({
                where: { bodyHash: hash },
                select: { id: true, processedAt: true },
            });
            if (!existing || existing.processedAt) return 'redelivery';
            // Stored before but never processed (the queue add failed, or the
            // job ran out of attempts): queue it again.
            deliveryId = existing.id;
            outcome = 'redelivery';
        }

        try {
            await this.enqueue(deliveryId);
        } catch (err) {
            // The row is safe; MetaWebhookMaintenance re-queues unprocessed rows.
            this.logger.error(`Could not queue Meta delivery ${deliveryId}: ${err instanceof Error ? err.message : String(err)}`);
        }
        return outcome;
    }

    /** Queue (or re-queue) one stored delivery. The job id keeps it single while live. */
    async enqueue(deliveryId: string): Promise<void> {
        const existing = await this.queue.getJob(deliveryId);
        if (existing) {
            const state = await existing.getState();
            if (state !== 'completed' && state !== 'failed') return;
            await existing.remove();
        }
        await this.queue.add('delivery', { deliveryId }, { ...META_INBOUND_JOB_OPTS, jobId: deliveryId });
    }
}
