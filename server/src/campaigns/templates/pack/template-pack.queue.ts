import type { JobsOptions, Queue } from 'bullmq';
import { ChannelPlatform, ChannelStatus, Prisma } from '@prisma/client';
import type { PrismaService } from '../../../prisma/prisma.service';
import { Priority } from '../../../rate-limit/rate-limit.types';

/**
 * The recommended template pack's queue. Its one processor lives in
 * CampaignsModule, beside TemplatesService; the modules that start a pack
 * (WhatsApp and Shopify connect in ChannelModule, Razorpay connect in
 * PaymentsModule) register the queue by name and use the plain functions
 * here, so none of them imports CampaignsModule.
 */
export const TEMPLATE_PACK_QUEUE = 'template-pack';

export type PackEnsureReason = 'connect' | 'shopify' | 'razorpay' | 'backfill' | 'manual';

/** `ensure`: create whatever the pack is missing on the account. */
export interface PackEnsureJob {
    organizationId: string;
    wabaId: string;
    reason: PackEnsureReason;
}

/** `reconcile`: re-read pack templates in review, and act on rejections and recategorisation. */
export interface PackReconcileJob {
    organizationId: string;
    wabaId: string;
}

/** `sync`: a full template sync, after a webhook named a template not saved yet. */
export interface TemplateSyncJob {
    organizationId: string;
}

export type TemplatePackJobData = PackEnsureJob | PackReconcileJob | TemplateSyncJob;

/** Hyphens only: BullMQ refuses ids with ':' and ids that are bare numbers. */
export const packJobId = {
    ensure: (orgId: string) => `pack-ensure-${orgId}`,
    reconcile: (orgId: string) => `pack-reconcile-${orgId}`,
    sync: (orgId: string) => `template-sync-${orgId}`,
};

export const PACK_JOB_OPTS = {
    attempts: 5,
    backoff: { type: 'exponential' as const, delay: 60_000 },
    removeOnComplete: { age: 7 * 24 * 3600 },
    removeOnFail: { age: 30 * 24 * 3600 },
};

/** The start-up backfill works through every account at bulk priority; a merchant's own action goes first. */
export const packPriority = (reason: PackEnsureReason): Priority => (reason === 'backfill' ? Priority.BULK : Priority.NORMAL);

type JobQueue = Pick<Queue, 'getJob' | 'add'>;

/**
 * Adds a job under a stable id. BullMQ keeps finished jobs and silently
 * ignores an add with an id it still holds, so a finished one is removed
 * first; a waiting or delayed one is left alone and its state returned.
 */
export async function addReplacingFinished(queue: JobQueue, name: string, data: unknown, opts: JobsOptions & { jobId: string }): Promise<string> {
    const existing = await queue.getJob(opts.jobId);
    if (existing) {
        const state = await existing.getState();
        if (state !== 'completed' && state !== 'failed' && state !== 'unknown') return state;
        // Another server may have replaced it a moment ago; its add then stands.
        await existing.remove().catch(() => undefined);
    }
    await queue.add(name, data, opts);
    return 'added';
}

/**
 * As addReplacingFinished, plus one `-next` follow-up behind a job that is
 * already running: that job may have read the account before this change.
 */
export async function addWithFollowUp(queue: JobQueue, name: string, data: unknown, opts: JobsOptions & { jobId: string }): Promise<string> {
    const outcome = await addReplacingFinished(queue, name, data, opts);
    if (outcome !== 'active') return outcome;
    return addReplacingFinished(queue, name, data, { ...opts, jobId: `${opts.jobId}-next` });
}

/**
 * Queues an ensure for the organization. `followUp: false` leaves a running
 * one to finish alone (the start-up backfill only needs the account covered).
 */
export function queuePackEnsure(queue: JobQueue, job: PackEnsureJob, opts: { delayMs?: number; followUp?: boolean } = {}): Promise<string> {
    const add = opts.followUp === false ? addReplacingFinished : addWithFollowUp;
    return add(queue, 'ensure', job, {
        ...PACK_JOB_OPTS,
        jobId: packJobId.ensure(job.organizationId),
        priority: packPriority(job.reason),
        delay: opts.delayMs ?? 0,
    });
}

type PackDb = Pick<PrismaService, 'templatePack' | 'channel'>;

/**
 * Makes sure the account has its pack row. A new row takes `autoActivate`
 * and `origin` from the caller; an existing one keeps its own (an account
 * connected before the pack shipped stays off when it reconnects), unless
 * it was left by another organization that had this WhatsApp account
 * before, in which case it starts again for this one.
 */
export async function claimPackRow(
    prisma: Pick<PrismaService, 'templatePack'>,
    row: { organizationId: string; channelId: string; wabaId: string; autoActivate: boolean; origin: 'connect' | 'backfill' | 'manual' },
): Promise<void> {
    const existing = await prisma.templatePack.findUnique({ where: { wabaId: row.wabaId } });
    if (!existing) {
        try {
            await prisma.templatePack.create({ data: row });
        } catch (err) {
            // Made by a concurrent start a moment ago: that row stands.
            if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
        }
        return;
    }
    if (existing.organizationId !== row.organizationId) {
        await prisma.templatePack.update({
            where: { id: existing.id },
            data: { ...row, version: 0, status: 'pending', stoppedReason: null, lastRunAt: null, settings: Prisma.DbNull },
        });
    } else if (existing.channelId !== row.channelId) {
        await prisma.templatePack.update({ where: { id: existing.id }, data: { channelId: row.channelId } });
    }
}

/**
 * WhatsApp connect. A pack made for a brand-new channel row goes live by
 * itself once Meta approves its templates; one made when an existing row is
 * reconnected (an account that existed before) waits for the merchant.
 */
export async function startPackOnConnect(
    prisma: PackDb,
    queue: JobQueue,
    account: { organizationId: string; channelId: string; wabaId: string; newChannel: boolean },
): Promise<void> {
    const { newChannel, ...row } = account;
    await claimPackRow(prisma, { ...row, autoActivate: newChannel, origin: 'connect' });
    await queuePackEnsure(queue, { organizationId: account.organizationId, wabaId: account.wabaId, reason: 'connect' });
}

/**
 * Shopify or Razorpay connect: their templates are added to a pack the
 * organization already has. One without a pack row is left alone, so
 * connecting a store never creates templates on an account that has not
 * opted into the pack (or been backfilled).
 */
export async function queuePackEnsureIfPresent(prisma: PackDb, queue: JobQueue, organizationId: string, reason: 'shopify' | 'razorpay'): Promise<boolean> {
    const channel = await prisma.channel.findFirst({
        where: { organizationId, platform: ChannelPlatform.WHATSAPP, status: { not: ChannelStatus.DISCONNECTED } },
        select: { externalStoreId: true },
    });
    if (!channel?.externalStoreId) return false;
    const pack = await prisma.templatePack.findUnique({ where: { wabaId: channel.externalStoreId }, select: { organizationId: true } });
    if (pack?.organizationId !== organizationId) return false;
    await queuePackEnsure(queue, { organizationId, wabaId: channel.externalStoreId, reason });
    return true;
}
