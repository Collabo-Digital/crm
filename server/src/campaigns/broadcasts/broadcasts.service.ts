import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
    Broadcast,
    BroadcastRecipientStatus as R,
    BroadcastStatus,
    ChannelPlatform,
    MessageDirection,
    MessageKind,
    Prisma,
    TemplateCategory,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { contactName } from '../../messaging/contact-name';
import { MessagingSendService } from '../../messaging/send/messaging-send.service';
import { PlatformSenderService } from '../../messaging/send/platform-sender.service';
import { SegmentsService } from '../segments/segments.service';
import { SegmentDefinition } from '../segments/segment-rules';
import { TemplatesService } from '../templates/templates.service';
import { ParameterFormat, renderTemplate, sendComponents, templateParams } from '../templates/template-components';
import {
    BroadcastAudience,
    SKIP_REASON_LABEL,
    SkipReason,
    isEmptyAudience,
    parseAudience,
    rateFor,
    skipReason,
} from './broadcast-audience';
import { BroadcastVariables, RecipientContext, parseVariables, resolveValues } from './broadcast-variables';
import { BROADCAST_QUEUE, BroadcastJobData, startJobId } from './broadcast.queue';

/// Messaging limit tiers: unique people reachable outside a reply window in a moving 24 hours.
const TIER_LIMITS: Record<string, number> = { TIER_250: 250, TIER_2K: 2000, TIER_10K: 10_000, TIER_100K: 100_000 };
/// Share of a number's throughput a broadcast may take, leaving room for the inbox:
/// coexistence numbers are fixed at 20 messages a second, others start at 80.
const RATE_COEXISTENCE = 10;
const RATE_DEFAULT = 40;
/// Failures a retry would only repeat.
const FINAL_ERRORS = new Set(['131050', '131026', '131051', '132000', '132001', '132005', '132007', '132012', '132015', '132016']);
const PAGE = 2000;

export interface SaveBroadcastInput {
    name?: string;
    campaign?: string | null;
    templateId?: string | null;
    variables?: unknown;
    audience?: unknown;
}

interface EvaluatedContact {
    id: string;
    reason: SkipReason | 'missing_value' | null;
    digits: string | null;
}

const contactSelect = {
    id: true,
    externalId: true,
    waId: true,
    phone: true,
    displayName: true,
    addressBookName: true,
    username: true,
    attributes: true,
    blockedAt: true,
    optedOutAt: true,
    optInAt: true,
    customer: { select: { firstName: true, lastName: true, email: true } },
} satisfies Prisma.ChannelContactSelect;

type AudienceContact = Prisma.ChannelContactGetPayload<{ select: typeof contactSelect }>;

const contextOf = (c: AudienceContact): RecipientContext => ({
    name: c.displayName ?? c.addressBookName ?? c.username ?? null,
    phone: c.phone,
    attributes: (c.attributes as Record<string, unknown> | null) ?? null,
    customer: c.customer,
});

/**
 * WhatsApp broadcasts: one approved template to an audience, with values
 * filled per person, sent at a pace the number can carry and tracked to
 * delivery, read, reply and button tap.
 */
@Injectable()
export class BroadcastsService {
    private readonly logger = new Logger(BroadcastsService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly templates: TemplatesService,
        private readonly segments: SegmentsService,
        private readonly sender: MessagingSendService,
        private readonly platform: PlatformSenderService,
        @InjectQueue(BROADCAST_QUEUE) private readonly queue: Queue<BroadcastJobData>,
    ) { }

    // ─── Drafts ────────────────────────────────────────────────────────

    async list(orgId: string, q: { status?: BroadcastStatus; search?: string; page?: number; limit?: number }) {
        const page = q.page ?? 1;
        const limit = q.limit ?? 25;
        const where: Prisma.BroadcastWhereInput = {
            organizationId: orgId,
            ...(q.status ? { status: q.status } : {}),
            ...(q.search?.trim()
                ? { OR: [{ name: { contains: q.search.trim(), mode: 'insensitive' } }, { campaign: { contains: q.search.trim(), mode: 'insensitive' } }] }
                : {}),
        };
        const [rows, total] = await Promise.all([
            this.prisma.broadcast.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
            this.prisma.broadcast.count({ where }),
        ]);
        const stats = await this.stats(rows.map((r) => r.id));
        return {
            data: rows.map((b) => ({ ...this.view(b), stats: stats.get(b.id) ?? emptyStats() })),
            meta: { total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) },
        };
    }

    async get(orgId: string, id: string) {
        const b = await this.load(orgId, id);
        const [stats, template] = await Promise.all([
            this.stats([b.id]),
            b.templateId ? this.prisma.messageTemplate.findUnique({ where: { id: b.templateId } }) : null,
        ]);
        return {
            ...this.view(b),
            stats: stats.get(b.id) ?? emptyStats(),
            template: template ? this.templates.view(template) : null,
        };
    }

    async create(orgId: string, userId: string, input: SaveBroadcastInput) {
        const channel = await this.templates.channelFor(orgId);
        const row = await this.prisma.broadcast.create({
            data: {
                organizationId: orgId,
                channelId: channel.id,
                name: input.name?.trim() || 'Untitled broadcast',
                campaign: input.campaign?.trim() || null,
                createdById: userId,
            },
        });
        if (input.templateId || input.variables || input.audience) return this.update(orgId, row.id, input);
        return this.get(orgId, row.id);
    }

    async update(orgId: string, id: string, input: SaveBroadcastInput) {
        const b = await this.load(orgId, id);
        if (b.status !== BroadcastStatus.DRAFT) throw new BadRequestException('Only a draft can be changed. Cancel the schedule first.');
        if (input.templateId) await this.templates.load(orgId, input.templateId);
        await this.prisma.broadcast.update({
            where: { id: b.id },
            data: {
                ...(input.name !== undefined ? { name: input.name.trim() || 'Untitled broadcast' } : {}),
                ...(input.campaign !== undefined ? { campaign: input.campaign?.trim() || null } : {}),
                ...(input.templateId !== undefined ? { templateId: input.templateId } : {}),
                ...(input.variables !== undefined ? { variables: parseVariables(input.variables) as Prisma.InputJsonValue } : {}),
                ...(input.audience !== undefined ? { audience: parseAudience(input.audience) as Prisma.InputJsonValue } : {}),
            },
        });
        return this.get(orgId, b.id);
    }

    async remove(orgId: string, id: string) {
        const b = await this.load(orgId, id);
        if (b.status !== BroadcastStatus.DRAFT) throw new BadRequestException('Only drafts can be deleted; sent broadcasts stay for reporting.');
        await this.prisma.broadcast.delete({ where: { id: b.id } });
        return { deleted: true };
    }

    async duplicate(orgId: string, userId: string, id: string) {
        const b = await this.load(orgId, id);
        const copy = await this.prisma.broadcast.create({
            data: {
                organizationId: orgId,
                channelId: b.channelId,
                name: `${b.name} (copy)`,
                campaign: b.campaign,
                templateId: b.templateId,
                variables: (b.variables ?? undefined) as Prisma.InputJsonValue | undefined,
                audience: (b.audience ?? undefined) as Prisma.InputJsonValue | undefined,
                createdById: userId,
            },
        });
        return this.get(orgId, copy.id);
    }

    async recipients(orgId: string, id: string, q: { status?: R; page?: number; limit?: number }) {
        const b = await this.load(orgId, id);
        const page = q.page ?? 1;
        const limit = q.limit ?? 25;
        const where: Prisma.BroadcastRecipientWhereInput = { broadcastId: b.id, ...(q.status ? { status: q.status } : {}) };
        const [rows, total] = await Promise.all([
            this.prisma.broadcastRecipient.findMany({
                where,
                orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
                skip: (page - 1) * limit,
                take: limit,
                include: {
                    contact: { select: { id: true, displayName: true, addressBookName: true, username: true, phone: true, externalId: true, conversations: { select: { id: true }, take: 1 } } },
                },
            }),
            this.prisma.broadcastRecipient.count({ where }),
        ]);
        return {
            data: rows.map((r) => ({
                id: r.id,
                status: r.status,
                skipReason: r.skipReason,
                skipLabel: r.skipReason ? (SKIP_REASON_LABEL[r.skipReason as SkipReason] ?? r.skipReason) : null,
                errorCode: r.errorCode,
                errorMessage: r.errorMessage,
                sentAt: r.sentAt,
                deliveredAt: r.deliveredAt,
                readAt: r.readAt,
                repliedAt: r.repliedAt,
                clickedAt: r.clickedAt,
                failedAt: r.failedAt,
                contact: { id: r.contact.id, name: contactName(r.contact), phone: r.contact.phone, conversationId: r.contact.conversations[0]?.id ?? null },
            })),
            meta: { total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) },
        };
    }

    // ─── Review ────────────────────────────────────────────────────────

    /**
     * Everything to check before sending: who is in, who is left out and
     * why, what it will look like, the estimated Meta cost, and warnings
     * about the template, number quality and messaging limit.
     */
    async preview(orgId: string, id: string) {
        const b = await this.load(orgId, id);
        const template = b.templateId ? await this.prisma.messageTemplate.findUnique({ where: { id: b.templateId } }) : null;
        const audience = parseAudience(b.audience);
        const vars = parseVariables(b.variables);
        const warnings: string[] = [];
        const blockers: string[] = [];

        if (!template) blockers.push('Choose a template.');
        else if (template.status !== 'APPROVED') blockers.push(`The template is ${template.status.toLowerCase()}; only approved templates can be sent.`);
        if (template?.qualityScore === 'RED') warnings.push('This template’s quality is low. Meta may pause it if more people block or report it.');
        if (isEmptyAudience(audience)) blockers.push('Choose who receives it.');

        const params = template ? templateParams(template.components as Record<string, unknown>[], formatOf(template.parameterFormat)) : [];
        const unmapped = params.filter((p) => p.component !== 'header' && !vars.values[p.key]).map((p) => p.key);
        if (unmapped.length) blockers.push(`Fill in every template value (${unmapped.join(', ')}).`);
        const mediaHeader = params.find((p) => p.component === 'header' && p.kind !== 'text' && p.kind !== 'location');
        if (mediaHeader && !vars.headerMedia) blockers.push('Upload the header image, video or document.');

        const evaluated = isEmptyAudience(audience) || !template ? [] : await this.evaluate(orgId, b, audience, template.category, params, vars, 'review');
        const sendable = evaluated.filter((e) => !e.reason);
        const skipped: Record<string, number> = {};
        for (const e of evaluated) if (e.reason) skipped[e.reason] = (skipped[e.reason] ?? 0) + 1;

        const channel = await this.prisma.channel.findUnique({ where: { id: b.channelId }, select: { metadata: true } });
        const health = ((channel?.metadata as Record<string, any> | null)?.health?.number ?? {}) as Record<string, any>;
        if (health.quality_rating === 'RED' || health.quality_rating === 'YELLOW') {
            warnings.push(`The number’s quality rating is ${String(health.quality_rating).toLowerCase()}. Sending to people who do not expect it can lower it further.`);
        }
        const tier = health.whatsapp_business_manager_messaging_limit as string | undefined;
        const limit = tier ? TIER_LIMITS[tier] : undefined;
        let usedToday: number | null = null;
        if (limit) {
            usedToday = await this.reachedOutsideWindow(b.channelId);
            if (usedToday + sendable.length > limit) {
                warnings.push(
                    `Your messaging limit is ${limit.toLocaleString('en-IN')} people a day and about ${usedToday.toLocaleString('en-IN')} were messaged in the last 24 hours. Meta will not deliver to people past the limit.`,
                );
            }
        }
        const plusOne = template?.category === TemplateCategory.MARKETING ? sendable.filter((e) => e.digits?.startsWith('1')).length : 0;
        if (plusOne) warnings.push(`${plusOne} recipients have +1 numbers. WhatsApp does not deliver marketing templates to US numbers.`);

        const cost = await this.estimate(orgId, sendable, template?.category ?? null);
        const sample = template ? await this.samples(sendable.slice(0, 3), template, vars) : [];
        return {
            ready: blockers.length === 0 && sendable.length > 0,
            blockers: sendable.length === 0 && blockers.length === 0 && evaluated.length > 0 ? ['Everyone in the audience is left out.'] : blockers,
            warnings,
            audience: { total: evaluated.length, sending: sendable.length, skipped, skippedLabels: SKIP_REASON_LABEL },
            limit: limit ? { tier, limit, usedToday } : null,
            cost,
            sample,
        };
    }

    /** Send the template to one number first, to see it as a customer will. */
    async testSend(orgId: string, id: string, rawPhone: string) {
        const b = await this.load(orgId, id);
        const digits = rawPhone.replace(/[^\d]/g, '');
        if (digits.length < 8 || digits.length > 15) throw new BadRequestException('Enter the full number with country code.');
        const template = b.templateId ? await this.templates.load(orgId, b.templateId) : null;
        if (!template || template.status !== 'APPROVED') throw new BadRequestException('Choose an approved template first.');
        const vars = parseVariables(b.variables);

        const contact =
            (await this.prisma.channelContact.findFirst({ where: { channelId: b.channelId, OR: [{ waId: digits }, { externalId: digits }] }, select: contactSelect })) ??
            (await this.prisma.channelContact.create({
                data: { organizationId: orgId, channelId: b.channelId, platform: ChannelPlatform.WHATSAPP, externalId: digits, waId: digits, phone: `+${digits}` },
                select: contactSelect,
            }));
        const params = templateParams(template.components as Record<string, unknown>[], formatOf(template.parameterFormat));
        // Missing values get the template's own example, so a test always goes out.
        const { values, missing } = resolveValues(params, vars, contextOf(contact), vars.headerMedia ? 'pending-upload' : null);
        for (const key of missing) {
            const example = params.find((p) => p.key === key)?.example;
            if (example) values[key] = example;
        }
        let components: unknown[];
        try {
            components = sendComponents(template.components as Record<string, unknown>[], formatOf(template.parameterFormat), values);
        } catch (err) {
            throw new BadRequestException(err instanceof Error ? err.message : 'Template values are incomplete.');
        }
        const conversationId = await this.sender.conversationFor(contact.id);
        return this.sender.send({
            organizationId: orgId,
            conversationId,
            origin: 'broadcast',
            payload: {
                type: 'template',
                name: template.name,
                language: template.language,
                category: template.category,
                components,
                ...(vars.headerMedia ? { headerMedia: vars.headerMedia } : {}),
            },
        });
    }

    /** Send now, or at `scheduledAt`. */
    async schedule(orgId: string, id: string, scheduledAt?: string | null) {
        const b = await this.load(orgId, id);
        if (b.status !== BroadcastStatus.DRAFT) throw new BadRequestException('This broadcast has already been scheduled or sent.');
        const review = await this.preview(orgId, id);
        if (!review.ready) throw new BadRequestException(review.blockers[0] ?? 'Nobody in the audience can receive this broadcast.');
        const at = scheduledAt ? new Date(scheduledAt) : null;
        if (at && (Number.isNaN(at.getTime()) || at.getTime() < Date.now() + 60_000)) {
            throw new BadRequestException('Schedule it at least a minute from now.');
        }
        await this.prisma.broadcast.update({
            where: { id: b.id },
            data: { status: BroadcastStatus.SCHEDULED, scheduledAt: at ?? new Date() },
        });
        await this.queue.add(
            'start',
            { kind: 'start', broadcastId: b.id },
            { jobId: startJobId(b.id), delay: at ? at.getTime() - Date.now() : 0, attempts: 3, backoff: { type: 'exponential', delay: 30_000 }, removeOnComplete: true, removeOnFail: { count: 100 } },
        );
        return this.get(orgId, b.id);
    }

    /**
     * A scheduled broadcast goes back to being a draft. One that is sending
     * stops: people not yet handed to WhatsApp are left out; messages already
     * on their way still arrive.
     */
    async cancel(orgId: string, id: string) {
        const b = await this.load(orgId, id);
        if (b.status === BroadcastStatus.SCHEDULED) {
            await this.queue.remove(startJobId(b.id)).catch(() => undefined);
            await this.prisma.broadcast.update({ where: { id: b.id }, data: { status: BroadcastStatus.DRAFT, scheduledAt: null } });
        } else if (b.status === BroadcastStatus.SENDING) {
            await this.prisma.broadcast.update({ where: { id: b.id }, data: { status: BroadcastStatus.CANCELLED, cancelledAt: new Date() } });
            await this.prisma.broadcastRecipient.updateMany({
                where: { broadcastId: b.id, status: R.PENDING },
                data: { status: R.SKIPPED, skipReason: 'cancelled' },
            });
        } else {
            throw new BadRequestException('Only scheduled or sending broadcasts can be cancelled.');
        }
        return this.get(orgId, b.id);
    }

    /** Send again to people whose message failed for a reason a retry could fix. */
    async retryFailed(orgId: string, id: string) {
        const b = await this.load(orgId, id);
        if (b.status !== BroadcastStatus.COMPLETED && b.status !== BroadcastStatus.CANCELLED) {
            throw new BadRequestException('Retry once the broadcast has finished sending.');
        }
        const failed = await this.prisma.broadcastRecipient.findMany({
            where: { broadcastId: b.id, status: R.FAILED },
            select: { id: true, errorCode: true },
        });
        const retryable = failed.filter((f) => !f.errorCode || !FINAL_ERRORS.has(f.errorCode)).map((f) => f.id);
        if (!retryable.length) throw new BadRequestException('No failed messages can be retried; the rest failed for reasons a retry would repeat.');
        await this.prisma.broadcastRecipient.updateMany({
            where: { id: { in: retryable } },
            data: { status: R.PENDING, attempts: { increment: 1 }, messageId: null, errorCode: null, errorMessage: null, failedAt: null },
        });
        await this.prisma.broadcast.update({ where: { id: b.id }, data: { status: BroadcastStatus.SENDING, completedAt: null } });
        await this.enqueueBatches(b, retryable);
        return { retrying: retryable.length, notRetryable: failed.length - retryable.length };
    }

    // ─── Sending (queue steps) ─────────────────────────────────────────

    /** Resolve the audience into recipients and queue them at the number's pace. */
    async start(broadcastId: string) {
        const b = await this.prisma.broadcast.findUnique({ where: { id: broadcastId } });
        if (!b || (b.status !== BroadcastStatus.SCHEDULED && b.status !== BroadcastStatus.SENDING)) return;
        const template = b.templateId ? await this.prisma.messageTemplate.findUnique({ where: { id: b.templateId } }) : null;
        if (!template || template.status !== 'APPROVED') {
            await this.fail(b.id, template ? `The template was ${template.status.toLowerCase()} when sending started.` : 'The template was deleted.');
            return;
        }
        const audience = parseAudience(b.audience);
        const vars = parseVariables(b.variables);
        const params = templateParams(template.components as Record<string, unknown>[], formatOf(template.parameterFormat));

        // The header file goes up once; every message reuses its media id.
        let mediaId = (b.variables as { headerMediaId?: string } | null)?.headerMediaId ?? null;
        if (vars.headerMedia && !mediaId) {
            mediaId = await this.platform.uploadForWhatsApp(b.channelId, vars.headerMedia);
            await this.prisma.broadcast.update({
                where: { id: b.id },
                data: { variables: { ...vars, headerMediaId: mediaId } as Prisma.InputJsonValue },
            });
        }
        await this.prisma.broadcast.update({
            where: { id: b.id },
            data: {
                status: BroadcastStatus.SENDING,
                startedAt: b.startedAt ?? new Date(),
                templateName: template.name,
                templateLanguage: template.language,
                templateCategory: template.category,
            },
        });

        if (!(await this.prisma.broadcastRecipient.count({ where: { broadcastId: b.id } }))) {
            const evaluated = await this.evaluate(b.organizationId, b, audience, template.category, params, vars, 'send', mediaId);
            for (let i = 0; i < evaluated.length; i += 1000) {
                await this.prisma.broadcastRecipient.createMany({
                    data: evaluated.slice(i, i + 1000).map((e) => ({
                        organizationId: b.organizationId,
                        broadcastId: b.id,
                        contactId: e.id,
                        status: e.reason ? R.SKIPPED : R.PENDING,
                        skipReason: e.reason,
                    })),
                    skipDuplicates: true,
                });
            }
        }
        const pending = await this.prisma.broadcastRecipient.findMany({
            where: { broadcastId: b.id, status: R.PENDING },
            select: { id: true },
            orderBy: { createdAt: 'asc' },
        });
        await this.enqueueBatches(b, pending.map((p) => p.id));
        this.logger.log(`Broadcast ${b.id}: ${pending.length} messages queued`);
    }

    /** Hand one batch of recipients to the send pipeline. */
    async sendBatch(broadcastId: string, recipientIds: string[]) {
        const b = await this.prisma.broadcast.findUnique({ where: { id: broadcastId } });
        if (!b || b.status !== BroadcastStatus.SENDING || !b.templateId) return;
        const template = await this.prisma.messageTemplate.findUnique({ where: { id: b.templateId } });
        if (!template) return;
        const vars = parseVariables(b.variables);
        const mediaId = (b.variables as { headerMediaId?: string } | null)?.headerMediaId ?? null;
        const format = formatOf(template.parameterFormat);
        const components = template.components as Record<string, unknown>[];
        const params = templateParams(components, format);
        const recipients = await this.prisma.broadcastRecipient.findMany({
            where: { id: { in: recipientIds }, status: R.PENDING },
            include: { contact: { select: contactSelect } },
        });
        for (const r of recipients) {
            const { values, missing } = resolveValues(params, vars, contextOf(r.contact), mediaId);
            if (missing.length) {
                await this.prisma.broadcastRecipient.update({ where: { id: r.id }, data: { status: R.SKIPPED, skipReason: 'missing_value' } });
                continue;
            }
            try {
                const conversationId = await this.sender.conversationFor(r.contactId);
                const outcome = await this.sender.send({
                    organizationId: b.organizationId,
                    conversationId,
                    origin: 'broadcast',
                    idempotencyKey: `broadcast:${r.id}:${r.attempts}`,
                    payload: {
                        type: 'template',
                        name: template.name,
                        language: template.language,
                        category: template.category,
                        components: sendComponents(components, format, values),
                        previewText: renderTemplate(components, values).body,
                    },
                });
                await this.prisma.broadcastRecipient.update({
                    where: { id: r.id },
                    data: outcome.ok
                        ? { status: R.QUEUED, messageId: outcome.messageId, queuedAt: new Date() }
                        : outcome.code === 'opted_out' || outcome.code === 'contact_blocked'
                            ? { status: R.SKIPPED, skipReason: outcome.code === 'opted_out' ? 'opted_out' : 'blocked' }
                            : { status: R.FAILED, failedAt: new Date(), errorMessage: outcome.message },
                });
            } catch (err) {
                await this.prisma.broadcastRecipient.update({
                    where: { id: r.id },
                    data: { status: R.FAILED, failedAt: new Date(), errorMessage: err instanceof Error ? err.message : String(err) },
                });
            }
        }
    }

    /** Done once nobody is waiting to be handed over; delivery keeps updating the numbers after. */
    async finishIfDone(broadcastId: string, attempt: number) {
        const b = await this.prisma.broadcast.findUnique({ where: { id: broadcastId }, select: { id: true, status: true } });
        if (!b || b.status !== BroadcastStatus.SENDING) return;
        const pending = await this.prisma.broadcastRecipient.count({ where: { broadcastId, status: R.PENDING } });
        if (pending === 0) {
            await this.prisma.broadcast.update({ where: { id: broadcastId }, data: { status: BroadcastStatus.COMPLETED, completedAt: new Date() } });
            return;
        }
        if (attempt < 60) {
            await this.queue.add('finish', { kind: 'finish', broadcastId, attempt: attempt + 1 }, { delay: 30_000, removeOnComplete: true });
        }
    }

    async fail(broadcastId: string, reason: string) {
        await this.prisma.broadcast.update({
            where: { id: broadcastId },
            data: { status: BroadcastStatus.FAILED, failureReason: reason, completedAt: new Date() },
        });
        await this.prisma.broadcastRecipient.updateMany({
            where: { broadcastId, status: R.PENDING },
            data: { status: R.SKIPPED, skipReason: 'cancelled' },
        });
    }

    // ─── Helpers ───────────────────────────────────────────────────────

    async load(orgId: string, id: string): Promise<Broadcast> {
        const row = await this.prisma.broadcast.findFirst({ where: { id, organizationId: orgId } });
        if (!row) throw new NotFoundException('Broadcast not found');
        return row;
    }

    /**
     * Every contact the audience includes on the broadcast's number, with the
     * reason each is left out, if any. `send` mode also checks the template
     * values against each person.
     */
    private async evaluate(
        orgId: string,
        b: Broadcast,
        audience: BroadcastAudience,
        category: TemplateCategory,
        params: ReturnType<typeof templateParams>,
        vars: BroadcastVariables,
        mode: 'review' | 'send',
        mediaId: string | null = null,
    ): Promise<EvaluatedContact[]> {
        const segmentWhere = async (ids: string[]) =>
            Promise.all(
                ids.map(async (sid) => {
                    const s = await this.segments.load(orgId, sid);
                    return this.segments.where(orgId, s.definition as SegmentDefinition);
                }),
            );
        const include: Prisma.ChannelContactWhereInput = audience.everyone
            ? {}
            : { OR: [...(await segmentWhere(audience.segmentIds)), ...audience.tags.map((t) => ({ tags: { has: t } }))] };
        const base: Prisma.ChannelContactWhereInput = { AND: [{ organizationId: orgId, channelId: b.channelId, isGroup: false }, include] };
        const ex = audience.exclude;
        const excludeParts = [...(await segmentWhere(ex.segmentIds)), ...ex.tags.map((t) => ({ tags: { has: t } }))];

        const excluded = new Set<string>();
        if (excludeParts.length) {
            const rows = await this.prisma.channelContact.findMany({ where: { AND: [base, { OR: excludeParts }] }, select: { id: true } });
            rows.forEach((r) => excluded.add(r.id));
        }
        const already = new Set<string>();
        if (ex.broadcastIds.length) {
            const rows = await this.prisma.broadcastRecipient.findMany({
                where: { broadcastId: { in: ex.broadcastIds }, organizationId: orgId, sentAt: { not: null } },
                select: { contactId: true },
            });
            rows.forEach((r) => already.add(r.contactId));
        }
        const recent = new Set<string>();
        if (ex.messagedWithinHours) {
            const rows = await this.prisma.broadcastRecipient.findMany({
                where: { organizationId: orgId, broadcastId: { not: b.id }, sentAt: { gte: new Date(Date.now() - ex.messagedWithinHours * 3600_000) } },
                select: { contactId: true },
            });
            rows.forEach((r) => recent.add(r.contactId));
        }

        const out: EvaluatedContact[] = [];
        const marketing = category === TemplateCategory.MARKETING;
        // Under review the header file is not uploaded yet; only whether there is one matters.
        const headerStandIn = mode === 'send' ? mediaId : vars.headerMedia ? 'not-uploaded-yet' : null;
        let cursor: string | undefined;
        for (; ;) {
            const page: AudienceContact[] = await this.prisma.channelContact.findMany({
                where: base,
                select: contactSelect,
                orderBy: { id: 'asc' },
                take: PAGE,
                ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
            });
            for (const c of page) {
                let reason: EvaluatedContact['reason'] = skipReason(
                    {
                        ...c,
                        excluded: excluded.has(c.id),
                        alreadyReceived: already.has(c.id),
                        recentlyMessaged: recent.has(c.id),
                    },
                    { marketing, requireOptIn: audience.requireOptIn },
                );
                if (!reason && resolveValues(params, vars, contextOf(c), headerStandIn).missing.length) reason = 'missing_value';
                out.push({ id: c.id, reason, digits: c.waId });
            }
            if (page.length < PAGE) break;
            cursor = page[page.length - 1].id;
        }
        return out;
    }

    /** Unique people messaged with a template in the last 24 hours on this number: what counts toward the limit. */
    private async reachedOutsideWindow(channelId: string): Promise<number> {
        const rows = await this.prisma.message.findMany({
            where: {
                channelId,
                direction: MessageDirection.OUTBOUND,
                kind: MessageKind.TEMPLATE,
                createdAt: { gte: new Date(Date.now() - 24 * 3600_000) },
                status: { not: 'FAILED' },
            },
            distinct: ['contactId'],
            select: { contactId: true },
        });
        return rows.length;
    }

    /** The cost estimate from the rates the business entered from its Meta rate card. */
    private async estimate(orgId: string, sendable: EvaluatedContact[], category: TemplateCategory | null) {
        const rates = await this.prisma.messageRate.findMany({ where: { organizationId: orgId } });
        const field = category === TemplateCategory.UTILITY ? 'utility' : category === TemplateCategory.AUTHENTICATION ? 'authentication' : 'marketing';
        const totals = new Map<string, { currency: string; amount: number; count: number }>();
        let unpriced = 0;
        for (const e of sendable) {
            const rate = rateFor(e.digits, rates);
            const value = rate?.[field];
            if (!rate || value === null || value === undefined) {
                unpriced++;
                continue;
            }
            const key = rate.currency;
            const t = totals.get(key) ?? { currency: key, amount: 0, count: 0 };
            t.amount += Number(value);
            t.count++;
            totals.set(key, t);
        }
        return {
            category,
            totals: [...totals.values()].map((t) => ({ ...t, amount: Math.round(t.amount * 100) / 100 })),
            unpriced,
            ratesConfigured: rates.length > 0,
        };
    }

    private async samples(sendable: EvaluatedContact[], template: { components: Prisma.JsonValue; parameterFormat: string }, vars: BroadcastVariables) {
        const contacts = await this.prisma.channelContact.findMany({ where: { id: { in: sendable.map((s) => s.id) } }, select: contactSelect });
        const components = template.components as Record<string, unknown>[];
        const params = templateParams(components, formatOf(template.parameterFormat));
        return contacts.map((c) => ({
            contact: contactName(c),
            preview: renderTemplate(components, resolveValues(params, vars, contextOf(c), vars.headerMedia ? 'preview' : null).values),
        }));
    }

    private async enqueueBatches(b: Pick<Broadcast, 'id' | 'channelId'>, ids: string[]) {
        const channel = await this.prisma.channel.findUnique({ where: { id: b.channelId }, select: { credentials: true } });
        const coexistence = (channel?.credentials as { isOnBizApp?: boolean } | null)?.isOnBizApp === true;
        const rate = coexistence ? RATE_COEXISTENCE : RATE_DEFAULT;
        const batches: string[][] = [];
        for (let i = 0; i < ids.length; i += rate) batches.push(ids.slice(i, i + rate));
        await this.queue.addBulk(
            batches.map((recipientIds, i) => ({
                name: 'send',
                data: { kind: 'send' as const, broadcastId: b.id, recipientIds },
                opts: { delay: i * 1000, attempts: 3, backoff: { type: 'exponential', delay: 10_000 }, removeOnComplete: true, removeOnFail: { count: 200 } },
            })),
        );
        await this.queue.add('finish', { kind: 'finish', broadcastId: b.id, attempt: 0 }, { delay: batches.length * 1000 + 15_000, removeOnComplete: true });
    }

    private async stats(ids: string[]) {
        const map = new Map<string, ReturnType<typeof emptyStats>>();
        if (!ids.length) return map;
        const [byStatus, replied, clicked] = await Promise.all([
            this.prisma.broadcastRecipient.groupBy({ by: ['broadcastId', 'status'], where: { broadcastId: { in: ids } }, _count: { _all: true } }),
            this.prisma.broadcastRecipient.groupBy({ by: ['broadcastId'], where: { broadcastId: { in: ids }, repliedAt: { not: null } }, _count: { _all: true } }),
            this.prisma.broadcastRecipient.groupBy({ by: ['broadcastId'], where: { broadcastId: { in: ids }, clickedAt: { not: null } }, _count: { _all: true } }),
        ]);
        for (const row of byStatus) {
            const s = map.get(row.broadcastId) ?? emptyStats();
            s.total += row._count._all;
            s.byStatus[row.status] = row._count._all;
            map.set(row.broadcastId, s);
        }
        for (const s of map.values()) {
            const n = s.byStatus;
            s.sent = (n.SENT ?? 0) + (n.DELIVERED ?? 0) + (n.READ ?? 0);
            s.delivered = (n.DELIVERED ?? 0) + (n.READ ?? 0);
            s.read = n.READ ?? 0;
            s.failed = n.FAILED ?? 0;
            s.skipped = n.SKIPPED ?? 0;
            s.pending = (n.PENDING ?? 0) + (n.QUEUED ?? 0);
        }
        for (const row of replied) (map.get(row.broadcastId) ?? emptyStats()).replied = row._count._all;
        for (const row of clicked) (map.get(row.broadcastId) ?? emptyStats()).clicked = row._count._all;
        return map;
    }

    private view(b: Broadcast) {
        return {
            id: b.id,
            name: b.name,
            campaign: b.campaign,
            status: b.status,
            channelId: b.channelId,
            templateId: b.templateId,
            templateName: b.templateName,
            templateCategory: b.templateCategory,
            variables: parseVariables(b.variables),
            audience: parseAudience(b.audience),
            scheduledAt: b.scheduledAt,
            startedAt: b.startedAt,
            completedAt: b.completedAt,
            cancelledAt: b.cancelledAt,
            failureReason: b.failureReason,
            createdAt: b.createdAt,
            updatedAt: b.updatedAt,
        };
    }
}

function emptyStats() {
    return {
        total: 0,
        pending: 0,
        sent: 0,
        delivered: 0,
        read: 0,
        replied: 0,
        clicked: 0,
        failed: 0,
        skipped: 0,
        byStatus: {} as Partial<Record<R, number>>,
    };
}

const formatOf = (f: string): ParameterFormat => (f === 'NAMED' ? 'NAMED' : 'POSITIONAL');
