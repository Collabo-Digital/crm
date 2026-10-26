import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BroadcastStatus, ChannelPlatform, ChannelStatus, MessageTemplate, Prisma, TemplateCategory } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { withRedisLock } from '../../automation/engine/redis-lock';
import { MetaGraphClient } from '../../channel/meta-graph.client';
import { MetaGraphError } from '../../channel/meta-graph.types';
import { WhatsAppAccountService } from '../../channel/whatsapp-account.service';
import { patchChannelMetadataSql } from '../../channel/channel-metadata.util';
import { MessagingMediaStorage } from '../../messaging/media/messaging-media.storage';
import { Priority } from '../../rate-limit/rate-limit.types';
import {
    TemplateDraft,
    TemplateDraftError,
    fromMetaComponents,
    renderTemplate,
    templateParams,
    toMetaComponents,
} from './template-components';
import { templateStarters } from './template-starters';
import { PACK_STOPPED, isButtonInputsRefusal } from './pack/pack-refusal';
import { PackFields, packFieldsFromName } from './pack/pack-fields';
import { LibraryButtonInput, PACK_LANGUAGE } from './pack/template-pack';
import { TemplatePackJobs } from './pack/template-pack-jobs';

const TEMPLATE_FIELDS = 'id,name,language,status,category,components,quality_score,rejected_reason,parameter_format';
/// The pack's own reads also ask which library template each was made from, to adopt it with the right source.
const PACK_TEMPLATE_FIELDS = `${TEMPLATE_FIELDS},library_template_name`;
const DAY = 24 * 3600_000;

/// Meta: approved templates can be edited once in 24 hours and 10 times in 30 days.
const EDIT_WINDOW_DAY = DAY;
const EDIT_WINDOW_MONTH = 30 * DAY;
const EDITS_PER_MONTH = 10;
const EDITABLE = new Set(['APPROVED', 'REJECTED', 'PAUSED']);

/// Outlives the longest pack run (16 creates, each a POST, a read and a pause), so it only expires when its holder died.
const ACCOUNT_LOCK_TTL_MS = 15 * 60_000;

interface MetaTemplate {
    id: string;
    name: string;
    language: string;
    status: string;
    category: string;
    components?: unknown[];
    quality_score?: { score?: string } | string;
    rejected_reason?: string;
    parameter_format?: string;
    library_template_name?: string;
}

/** A template webhook, as the WhatsApp parser reads it. */
export interface TemplateWebhookEvent {
    field: string;
    templateId: string | null;
    name: string | null;
    language: string | null;
    event: string | null;
    value: Record<string, unknown>;
    /** When Meta sent it (the entry's time), so a late event cannot undo a newer one. */
    at?: Date | null;
}

/** How a template is created: by a person in the editor, or by the recommended pack. */
interface SubmitOptions {
    createdById: string | null;
    starterKey: string | null;
    priority: Priority;
    pack?: PackFields;
}

interface CreatedTemplate {
    externalId: string;
    name: string;
    language: string;
    requested: TemplateCategory;
    category?: string;
    status?: string;
    parameterFormat: string;
    components: unknown[];
}

type ChannelRef = { id: string; wabaId: string };

const asCategory = (c: string | undefined): TemplateCategory =>
    c && c.toUpperCase() in TemplateCategory ? (c.toUpperCase() as TemplateCategory) : TemplateCategory.MARKETING;

const qualityOf = (q: MetaTemplate['quality_score']): string | null =>
    typeof q === 'string' ? q : q?.score ?? null;

const reasonOf = (r: string | undefined): string | null => (r && r !== 'NONE' ? r : null);

/** A category Meta reports. The one asked for is kept while Meta files the template under another. */
function categoryChange(t: { category: TemplateCategory; requestedCategory: TemplateCategory | null }, next: TemplateCategory) {
    if (next === t.category) return {};
    const requested = t.requestedCategory ?? t.category;
    return { category: next, requestedCategory: next === requested ? null : requested };
}

/** Meta's `rejection_info`: why it rejected the template and what it recommends. */
function rejectionInfoOf(v: unknown): { reason?: string; recommendation?: string } | null {
    if (!v || typeof v !== 'object') return null;
    const { reason, recommendation } = v as Record<string, unknown>;
    const info = {
        ...(typeof reason === 'string' && reason ? { reason } : {}),
        ...(typeof recommendation === 'string' && recommendation ? { recommendation } : {}),
    };
    return Object.keys(info).length ? info : null;
}

/**
 * WhatsApp message templates for an organization's connected number: synced
 * from Meta, created and edited here and sent to Meta for review, and kept
 * current by Meta's template webhooks.
 */
@Injectable()
export class TemplatesService {
    private readonly logger = new Logger(TemplatesService.name);
    private readonly appId: string;
    private readonly appUrl: string;

    constructor(
        private readonly prisma: PrismaService,
        private readonly metaGraph: MetaGraphClient,
        private readonly accounts: WhatsAppAccountService,
        private readonly storage: MessagingMediaStorage,
        config: ConfigService,
        private readonly redis: RedisService,
        private readonly packJobs: TemplatePackJobs,
    ) {
        this.appId = config.get<string>('meta.appId') ?? '';
        this.appUrl = config.get<string>('frontendUrl') ?? '';
    }

    /** The organization's connected WhatsApp channel; templates live on its account. */
    async channelFor(orgId: string) {
        const channel = await this.prisma.channel.findFirst({
            where: { organizationId: orgId, platform: ChannelPlatform.WHATSAPP, status: { not: ChannelStatus.DISCONNECTED } },
            select: { id: true, externalStoreId: true, metadata: true, status: true },
        });
        if (!channel?.externalStoreId) throw new BadRequestException('Connect a WhatsApp number in Settings → Channels first.');
        return { id: channel.id, wabaId: channel.externalStoreId, metadata: channel.metadata };
    }

    /** The WhatsApp account connected now, if any; templates of one connected before are not offered. */
    private async currentWabaId(orgId: string): Promise<string | null> {
        const channel = await this.prisma.channel.findFirst({
            where: { organizationId: orgId, platform: ChannelPlatform.WHATSAPP, status: { not: ChannelStatus.DISCONNECTED } },
            select: { externalStoreId: true },
        });
        return channel?.externalStoreId ?? null;
    }

    async list(orgId: string, filter: { status?: string; category?: string; search?: string } = {}) {
        const wabaId = await this.currentWabaId(orgId);
        if (!wabaId) return [];
        const rows = await this.prisma.messageTemplate.findMany({
            where: {
                organizationId: orgId,
                wabaId,
                ...(filter.status ? { status: filter.status } : {}),
                ...(filter.category ? { category: filter.category as TemplateCategory } : {}),
                ...(filter.search?.trim() ? { name: { contains: filter.search.trim().toLowerCase() } } : {}),
            },
            orderBy: [{ updatedAt: 'desc' }],
        });
        return rows.map((t) => this.view(t));
    }

    async get(orgId: string, id: string) {
        return this.view(await this.load(orgId, id));
    }

    starters() {
        return templateStarters(this.appUrl);
    }

    /**
     * Runs `fn` holding the account's template lock, shared by every server:
     * syncs, the pack's creates and its reconciles never interleave. Throws
     * LockTimeoutError when it is still held after `waitMs`.
     */
    withAccountLock<T>(wabaId: string, fn: () => Promise<T>, waitMs = 30_000): Promise<T> {
        return withRedisLock(this.redis, `templates:waba:${wabaId}`, fn, { ttlMs: ACCOUNT_LOCK_TTL_MS, waitMs, pollMs: 250 });
    }

    /** Pull every template on the account; ones deleted at Meta go here too. */
    async sync(orgId: string, opts: { waitMs?: number } = {}) {
        const channel = await this.channelFor(orgId);
        return this.withAccountLock(channel.wabaId, () => this.pull(orgId, channel), opts.waitMs);
    }

    /**
     * The sync itself; the caller holds the account lock. A row made after the
     * list was read is never deleted, and pack fields are never cleared. The
     * pack's own sync (`adopt`) adopts each `collabo_<slot>_v<n>` template.
     */
    async pull(orgId: string, channel: ChannelRef, opts: { adopt?: boolean } = {}) {
        const { token, creds } = await this.accounts.load(channel.id);
        const scopes = this.accounts.scopes(channel.wabaId);
        const startedAt = new Date();
        const found: MetaTemplate[] = [];
        let next: { path?: string; url?: string } | null = { path: `/${channel.wabaId}/message_templates` };
        while (next) {
            const res: { data: { data?: MetaTemplate[]; paging?: { next?: string } } } = await this.metaGraph.request({
                method: 'GET',
                ...next,
                ...(next.path ? { query: { fields: opts.adopt ? PACK_TEMPLATE_FIELDS : TEMPLATE_FIELDS, limit: 100 } } : {}),
                accessToken: token,
                scopes,
                priority: Priority.NORMAL,
            });
            found.push(...(res.data.data ?? []));
            next = res.data.paging?.next ? { url: res.data.paging.next } : null;
        }
        const now = new Date();
        // Rows are keyed by account, not organization: ones left by an organization that
        // connected this account before are dropped, so they are not updated across tenants.
        await this.prisma.messageTemplate.deleteMany({ where: { wabaId: channel.wabaId, organizationId: { not: orgId } } });
        const before = new Map(
            (await this.prisma.messageTemplate.findMany({
                where: { organizationId: orgId, wabaId: channel.wabaId },
                select: { name: true, language: true, externalId: true, status: true, category: true, packSlot: true, createdAt: true },
            })).map((r) => [`${r.name}|${r.language}`, r]),
        );
        let packChanged = false;
        for (const t of found) {
            const row = await this.upsertSynced(orgId, channel, t, now, opts.adopt === true);
            const was = before.get(`${t.name}|${t.language}`);
            if (row.packSlot && (!was?.packSlot || was.status !== row.status || was.category !== row.category)) packChanged = true;
        }
        const listed = new Set(found.map((t) => t.id));
        const gone = { organizationId: orgId, wabaId: channel.wabaId, externalId: { notIn: [...listed] }, createdAt: { lt: startedAt } };
        if ([...before.values()].some((r) => r.packSlot && r.externalId && !listed.has(r.externalId) && r.createdAt < startedAt)) packChanged = true;
        const removed = await this.prisma.messageTemplate.deleteMany({ where: gone });
        await this.refreshMarketingMessagesStatus(channel.id, channel.wabaId, token).catch((err) =>
            this.logger.warn(`Marketing Messages API status not read for ${creds.wabaId}: ${err instanceof Error ? err.message : err}`),
        );
        if (packChanged) await this.packChanged(orgId, channel.wabaId);
        return { synced: found.length, removed: removed.count };
    }

    /** One name, every language, re-read from Meta: for a name Meta says is taken. The caller holds the account lock. */
    async pullName(orgId: string, channel: ChannelRef, name: string, priority: Priority): Promise<MessageTemplate[]> {
        const { token } = await this.accounts.load(channel.id);
        const res = await this.metaGraph.request<{ data?: MetaTemplate[] }>({
            method: 'GET',
            path: `/${channel.wabaId}/message_templates`,
            query: { fields: PACK_TEMPLATE_FIELDS, name, limit: 100 },
            accessToken: token,
            scopes: this.accounts.scopes(channel.wabaId),
            priority,
        });
        const now = new Date();
        const rows: MessageTemplate[] = [];
        // Meta's name filter also matches longer names.
        for (const t of (res.data.data ?? []).filter((x) => x.name === name)) rows.push(await this.upsertSynced(orgId, channel, t, now, true));
        return rows;
    }

    private async upsertSynced(orgId: string, channel: ChannelRef, t: MetaTemplate, now: Date, adopting: boolean): Promise<MessageTemplate> {
        const data = {
            externalId: t.id,
            status: t.status,
            category: asCategory(t.category),
            qualityScore: qualityOf(t.quality_score),
            statusReason: reasonOf(t.rejected_reason),
            parameterFormat: (t.parameter_format ?? 'POSITIONAL').toUpperCase(),
            components: (t.components ?? []) as Prisma.InputJsonValue,
            syncedAt: now,
        };
        const adopt = adopting ? packFieldsFromName(t) : null;
        const row = await this.prisma.messageTemplate.upsert({
            where: { wabaId_name_language: { wabaId: channel.wabaId, name: t.name, language: t.language } },
            create: { organizationId: orgId, channelId: channel.id, wabaId: channel.wabaId, name: t.name, language: t.language, ...data, ...(adopt ?? {}) },
            update: { channelId: channel.id, ...data },
        });
        return adopt && !row.packSlot ? this.prisma.messageTemplate.update({ where: { id: row.id }, data: adopt }) : row;
    }

    /** Submit a new template for Meta's review. */
    async create(orgId: string, userId: string, draft: TemplateDraft, starterKey?: string) {
        const channel = await this.channelFor(orgId);
        const exists = await this.prisma.messageTemplate.findUnique({
            where: { wabaId_name_language: { wabaId: channel.wabaId, name: draft.name, language: draft.language } },
            select: { id: true },
        });
        if (exists) throw new ConflictException(`A template called ${draft.name} already exists in this language.`);
        try {
            return this.view(await this.submit(orgId, channel, draft, { createdById: userId, starterKey: starterKey ?? null, priority: Priority.INTERACTIVE }));
        } catch (err) {
            throw this.refusal(err);
        }
    }

    /**
     * The create path the editor and the pack share: the components (a media
     * header's sample uploaded first), the POST and the row. Meta's refusals
     * come back as they are. The pack's POSTs are never repeated blindly: one
     * Meta took without answering comes back as "already exists", and the
     * pack adopts it.
     */
    async submit(orgId: string, channel: ChannelRef, draft: TemplateDraft, opts: SubmitOptions): Promise<MessageTemplate> {
        const { token } = await this.accounts.load(channel.id);
        const components = await this.componentsFor(orgId, draft, token, opts.priority);
        const sentAt = new Date();
        const res = await this.metaGraph.request<{ id?: string; status?: string; category?: string }>({
            method: 'POST',
            path: `/${channel.wabaId}/message_templates`,
            accessToken: token,
            body: {
                name: draft.name,
                language: draft.language,
                category: draft.category,
                parameter_format: draft.parameterFormat.toLowerCase(),
                components,
            },
            scopes: this.accounts.scopes(channel.wabaId),
            priority: opts.priority,
            ...(opts.pack ? { idempotent: false } : {}),
        });
        if (!res.data.id) throw new BadRequestException('Meta did not accept the template.');
        return this.saveCreated(orgId, channel, {
            externalId: res.data.id,
            name: draft.name,
            language: draft.language,
            requested: draft.category as TemplateCategory,
            category: res.data.category,
            status: res.data.status,
            parameterFormat: draft.parameterFormat,
            components,
        }, opts, sentAt);
    }

    /**
     * A template from Meta's Template Library: Meta's own wording, approved
     * the moment it is made; only the name and the link buttons' addresses
     * are ours. The answer has no components, so the template is read back.
     */
    async createFromLibrary(
        orgId: string,
        channel: ChannelRef,
        t: { name: string; libraryTemplateName: string; buttonInputs?: LibraryButtonInput[] },
        pack: PackFields,
        priority: Priority,
    ): Promise<MessageTemplate> {
        const { token } = await this.accounts.load(channel.id);
        const scopes = this.accounts.scopes(channel.wabaId);
        const post = (buttonInputs?: unknown) =>
            this.metaGraph.request<{ id?: string; status?: string; category?: string }>({
                method: 'POST',
                path: `/${channel.wabaId}/message_templates`,
                accessToken: token,
                body: {
                    name: t.name,
                    category: 'UTILITY',
                    language: PACK_LANGUAGE,
                    library_template_name: t.libraryTemplateName,
                    ...(buttonInputs !== undefined ? { library_template_button_inputs: buttonInputs } : {}),
                },
                scopes,
                priority,
                idempotent: false,
            });
        const sentAt = new Date();
        let res: Awaited<ReturnType<typeof post>>;
        if (!t.buttonInputs?.length) {
            res = await post();
        } else {
            // Meta's reference types the inputs as an array, its guide shows a JSON string.
            try {
                res = await post(t.buttonInputs);
                this.logger.log(`Library template ${t.libraryTemplateName} created with its button inputs as an array.`);
            } catch (err) {
                if (!isButtonInputsRefusal(err)) throw err;
                res = await post(JSON.stringify(t.buttonInputs));
                this.logger.log(`Library template ${t.libraryTemplateName} created with its button inputs as a JSON string; Meta refused them as an array.`);
            }
        }
        if (!res.data.id) throw new BadRequestException('Meta did not accept the template.');
        const read = await this.metaGraph.request<Partial<MetaTemplate>>({
            method: 'GET',
            path: `/${res.data.id}`,
            query: { fields: 'name,language,status,category,components,parameter_format,library_template_name' },
            accessToken: token,
            scopes,
            priority,
        });
        return this.saveCreated(orgId, channel, {
            externalId: res.data.id,
            name: t.name,
            language: PACK_LANGUAGE,
            requested: TemplateCategory.UTILITY,
            category: read.data.category ?? res.data.category,
            status: read.data.status ?? res.data.status,
            parameterFormat: (read.data.parameter_format ?? 'POSITIONAL').toUpperCase(),
            components: read.data.components ?? [],
        }, { createdById: null, starterKey: null, priority, pack }, sentAt);
    }

    /**
     * Upserted, not inserted: a template Meta approves at once can have its
     * status webhook processed, and the account synced, before this save.
     * That row keeps the status Meta gave it and gains what only we know.
     */
    private async saveCreated(orgId: string, channel: ChannelRef, t: CreatedTemplate, opts: SubmitOptions, sentAt: Date): Promise<MessageTemplate> {
        const category = asCategory(t.category ?? t.requested);
        const ours = {
            organizationId: orgId,
            channelId: channel.id,
            externalId: t.externalId,
            starterKey: opts.starterKey,
            submittedAt: sentAt,
            createdById: opts.createdById,
            ...(opts.pack ?? {}),
        };
        const row = await this.prisma.messageTemplate.upsert({
            where: { wabaId_name_language: { wabaId: channel.wabaId, name: t.name, language: t.language } },
            create: {
                ...ours,
                wabaId: channel.wabaId,
                name: t.name,
                language: t.language,
                category,
                // Meta files a utility template it reads as marketing under marketing.
                requestedCategory: category !== t.requested ? t.requested : null,
                status: t.status ?? 'PENDING',
                parameterFormat: t.parameterFormat,
                components: t.components as Prisma.InputJsonValue,
            },
            update: ours,
        });
        return row.category !== t.requested && !row.requestedCategory
            ? this.prisma.messageTemplate.update({ where: { id: row.id }, data: { requestedCategory: t.requested } })
            : row;
    }

    /** A template's status, read from Meta: for one in review whose webhook may never come. */
    async refreshStatus(channel: ChannelRef, t: MessageTemplate, priority: Priority): Promise<MessageTemplate> {
        const { token } = await this.accounts.load(channel.id);
        const res = await this.metaGraph.request<Partial<MetaTemplate>>({
            method: 'GET',
            path: `/${t.externalId}`,
            query: { fields: 'status,category,quality_score,rejected_reason' },
            accessToken: token,
            scopes: this.accounts.scopes(channel.wabaId),
            priority,
        });
        const data: Prisma.MessageTemplateUpdateInput = {};
        if (res.data.status && res.data.status !== t.status) {
            data.status = res.data.status;
            data.statusReason = reasonOf(res.data.rejected_reason);
        }
        if (res.data.category) Object.assign(data, categoryChange(t, asCategory(res.data.category)));
        const quality = qualityOf(res.data.quality_score);
        if (quality && quality !== t.qualityScore) data.qualityScore = quality;
        return Object.keys(data).length ? this.prisma.messageTemplate.update({ where: { id: t.id }, data }) : t;
    }

    /**
     * Edit content. Meta allows it for approved, rejected and paused
     * templates; approved ones at most once a day and ten times a month, and
     * never their category. The edit goes back into review.
     */
    async update(orgId: string, id: string, draft: TemplateDraft) {
        const template = await this.load(orgId, id);
        if (!template.externalId || !EDITABLE.has(template.status)) {
            throw new BadRequestException(`A ${template.status.toLowerCase()} template cannot be edited.`);
        }
        const now = Date.now();
        if (template.status === 'APPROVED') {
            const recent = template.editedAt.filter((d) => now - d.getTime() < EDIT_WINDOW_MONTH);
            if (recent.some((d) => now - d.getTime() < EDIT_WINDOW_DAY)) {
                throw new BadRequestException('Approved templates can be edited once every 24 hours. Try again tomorrow.');
            }
            if (recent.length >= EDITS_PER_MONTH) {
                throw new BadRequestException('This template has had 10 edits in 30 days, Meta’s limit.');
            }
        }
        const channel = await this.channelFor(orgId);
        const { token } = await this.accounts.load(channel.id);
        const components = await this.componentsFor(orgId, { ...draft, name: template.name, language: template.language, category: template.category }, token, Priority.INTERACTIVE);
        try {
            await this.metaGraph.request({
                method: 'POST',
                path: `/${template.externalId}`,
                accessToken: token,
                body: { components },
                scopes: this.accounts.scopes(channel.wabaId),
                priority: Priority.INTERACTIVE,
            });
        } catch (err) {
            throw this.refusal(err);
        }
        const row = await this.prisma.messageTemplate.update({
            where: { id: template.id },
            data: {
                components: components as Prisma.InputJsonValue,
                status: 'PENDING',
                statusReason: null,
                editedAt: template.status === 'APPROVED' ? [...template.editedAt, new Date(now)] : template.editedAt,
            },
        });
        return this.view(row);
    }

    /** Delete this language of the template at Meta and here. */
    async remove(orgId: string, id: string) {
        const template = await this.load(orgId, id);
        const sending = await this.prisma.broadcast.findFirst({
            where: { templateId: template.id, status: { in: [BroadcastStatus.SCHEDULED, BroadcastStatus.SENDING] } },
            select: { name: true, status: true },
        });
        if (sending) {
            throw new BadRequestException(
                sending.status === BroadcastStatus.SENDING
                    ? `The broadcast “${sending.name}” is sending this template. You can delete the template once it has finished or been stopped.`
                    : `The broadcast “${sending.name}” is scheduled to send this template. You can delete the template once it has been sent or its schedule cancelled.`,
            );
        }
        const channel = await this.channelFor(orgId);
        const { token } = await this.accounts.load(channel.id);
        if (template.externalId) {
            try {
                await this.metaGraph.request({
                    method: 'DELETE',
                    path: `/${channel.wabaId}/message_templates`,
                    query: { hsm_id: template.externalId, name: template.name },
                    accessToken: token,
                    scopes: this.accounts.scopes(channel.wabaId),
                    priority: Priority.INTERACTIVE,
                });
            } catch (err) {
                throw this.refusal(err);
            }
        }
        await this.prisma.messageTemplate.delete({ where: { id: template.id } });
        return { deleted: true };
    }

    /**
     * Status, quality and category webhooks. A template made in WhatsApp
     * Manager that we have never seen is fetched by a sync job, one per
     * account at a time: a pack's templates approved the moment they are made
     * each name a template not saved yet.
     */
    async applyWebhook(channel: { id: string; organizationId: string; externalStoreId: string | null }, e: TemplateWebhookEvent) {
        if (e.field === 'message_template_status_update' && e.event === 'LIMIT_EXCEEDED' && channel.externalStoreId) {
            await this.prisma.templatePack.updateMany({
                where: { wabaId: channel.externalStoreId, organizationId: channel.organizationId },
                data: { status: 'stopped', stoppedReason: PACK_STOPPED.templateLimit },
            });
        }
        const where: Prisma.MessageTemplateWhereInput = e.templateId
            ? { externalId: e.templateId }
            : { wabaId: channel.externalStoreId ?? '', name: e.name ?? '', language: e.language ?? '' };
        const template = await this.prisma.messageTemplate.findFirst({ where: { organizationId: channel.organizationId, ...where } });
        if (!template) {
            await this.packJobs.sync(channel.organizationId);
            return;
        }
        const v = e.value;
        const data: Prisma.MessageTemplateUpdateInput = {};
        if (e.field === 'message_template_status_update' && e.event) {
            // Meta can deliver one template's events out of order; an older one changes nothing.
            if (e.at && template.statusUpdatedAt && e.at < template.statusUpdatedAt) return;
            if (e.at) data.statusUpdatedAt = e.at;
            // Events, not statuses: Meta's API reads a reinstated template as APPROVED, and a
            // flagged one stays approved and sendable (its quality webhook carries the warning).
            if (e.event === 'REINSTATED') {
                data.status = 'APPROVED';
                data.statusReason = null;
            } else if (e.event !== 'FLAGGED') {
                data.status = e.event;
                const reason = (v.reason as string | undefined) ?? (v.other_info as { title?: string } | undefined)?.title;
                data.statusReason = reason && reason !== 'NONE' ? reason : null;
                const rejection = rejectionInfoOf(v.rejection_info);
                if (rejection) data.rejectionInfo = rejection;
                else if (e.event === 'APPROVED' && template.rejectionInfo) data.rejectionInfo = Prisma.DbNull;
            }
            const category = v.message_template_category as string | undefined;
            if (category) Object.assign(data, categoryChange(template, asCategory(category)));
        } else if (e.field === 'message_template_quality_update') {
            data.qualityScore = (v.new_quality_score as string | undefined) ?? null;
        } else if (e.field === 'template_category_update') {
            const next = v.new_category as string | undefined;
            if (next) {
                data.category = asCategory(next);
                data.requestedCategory = asCategory((v.previous_category as string | undefined) ?? template.category);
            }
        } else if (e.field === 'message_template_components_update') {
            // The content changed at Meta; the next sync carries it.
            await this.packJobs.sync(channel.organizationId);
            return;
        }
        if (Object.keys(data).length) await this.prisma.messageTemplate.update({ where: { id: template.id }, data });
        const changed = 'status' in data || 'category' in data;
        if (template.packSlot && changed) await this.packChanged(channel.organizationId, template.wabaId);
    }

    /** A pack template's status or category changed: act on it, and let its automations follow. */
    private async packChanged(orgId: string, wabaId: string) {
        await this.packJobs.reconcile(orgId, wabaId);
        await this.packJobs.managedSync(orgId);
    }

    /** Approved templates, for the inbox's template picker. */
    async approved(orgId: string) {
        const wabaId = await this.currentWabaId(orgId);
        if (!wabaId) return [];
        const rows = await this.prisma.messageTemplate.findMany({
            where: { organizationId: orgId, wabaId, status: 'APPROVED' },
            orderBy: { name: 'asc' },
        });
        return rows.map((t) => this.view(t));
    }

    async load(orgId: string, id: string): Promise<MessageTemplate> {
        const row = await this.prisma.messageTemplate.findFirst({ where: { id, organizationId: orgId } });
        if (!row) throw new NotFoundException('Template not found');
        return row;
    }

    view(t: MessageTemplate) {
        const components = t.components as Record<string, unknown>[];
        const format = t.parameterFormat === 'NAMED' ? 'NAMED' : 'POSITIONAL';
        return {
            id: t.id,
            externalId: t.externalId,
            name: t.name,
            language: t.language,
            category: t.category,
            requestedCategory: t.requestedCategory,
            status: t.status,
            statusReason: t.statusReason,
            qualityScore: t.qualityScore,
            parameterFormat: format,
            components,
            params: templateParams(components, format),
            preview: renderTemplate(components),
            draft: fromMetaComponents({ name: t.name, language: t.language, category: t.category, parameterFormat: format }, components),
            editable: !!t.externalId && EDITABLE.has(t.status),
            starterKey: t.starterKey,
            packSlot: t.packSlot,
            packVersion: t.packVersion,
            packSource: t.packSource,
            libraryTemplateName: t.libraryTemplateName,
            rejectionInfo: t.rejectionInfo as { reason?: string; recommendation?: string } | null,
            statusUpdatedAt: t.statusUpdatedAt,
            submittedAt: t.submittedAt,
            syncedAt: t.syncedAt,
            updatedAt: t.updatedAt,
        };
    }

    /** Components for Meta, uploading a media header first when there is one. */
    private async componentsFor(orgId: string, draft: TemplateDraft, token: string, priority: Priority) {
        const header = draft.header;
        let handle: string | null = null;
        if (header && header.format !== 'TEXT' && header.format !== 'LOCATION') {
            if (!header.storageKey || !header.mime) throw new BadRequestException('Upload the header image, video or document first.');
            // Uploads are stored under the organization's id.
            if (!header.storageKey.startsWith(`${orgId}/`)) throw new BadRequestException('Upload the header file again.');
            handle = await this.uploadHeaderSample(header.storageKey, header.mime, header.filename ?? 'header', token, priority);
        }
        try {
            return toMetaComponents(draft, handle);
        } catch (err) {
            if (err instanceof TemplateDraftError) throw new BadRequestException(err.message);
            throw err;
        }
    }

    /**
     * A media header's sample goes through the Resumable Upload API: open a
     * session on the app, send the bytes, and the returned handle `h` is the
     * template's `header_handle`.
     */
    private async uploadHeaderSample(storageKey: string, mime: string, filename: string, token: string, priority: Priority): Promise<string> {
        if (!this.appId) throw new BadRequestException('META_APP_ID is not configured.');
        const file = await this.storage.read(storageKey);
        const scopes = this.metaGraph.baseScopes();
        const session = await this.metaGraph.request<{ id?: string }>({
            method: 'POST',
            path: `/${this.appId}/uploads`,
            query: { file_name: filename, file_length: file.length, file_type: mime },
            accessToken: token,
            scopes,
            priority,
        });
        if (!session.data.id) throw new BadRequestException('Meta did not open an upload session.');
        const uploaded = await this.metaGraph.request<{ h?: string }>({
            method: 'POST',
            path: `/${session.data.id}`,
            binary: new Uint8Array(file),
            headers: { file_offset: '0' },
            authScheme: 'OAuth',
            accessToken: token,
            scopes,
            priority,
            timeoutMs: 60_000,
        });
        if (!uploaded.data.h) throw new BadRequestException('Meta did not return a handle for the header file.');
        return uploaded.data.h;
    }

    /**
     * Whether the account accepted the Marketing Messages API terms; the
     * sender routes marketing templates through that API once it has.
     */
    private async refreshMarketingMessagesStatus(channelId: string, wabaId: string, token: string) {
        const res = await this.metaGraph.request<{ marketing_messages_onboarding_status?: string }>({
            method: 'GET',
            path: `/${wabaId}`,
            query: { fields: 'marketing_messages_onboarding_status' },
            accessToken: token,
            scopes: this.accounts.scopes(wabaId),
            priority: Priority.NORMAL,
        });
        const status = res.data.marketing_messages_onboarding_status ?? null;
        await this.prisma.$executeRaw(
            patchChannelMetadataSql(channelId, 'marketingMessages', { status, checkedAt: new Date().toISOString() }),
        );
    }

    /** Meta's own words for a refused template, as a 400. */
    private refusal(err: unknown): Error {
        if (err instanceof MetaGraphError && err.code === 'API_ERROR') {
            const details = err.details as { error_user_msg?: string } | undefined;
            return new BadRequestException(details?.error_user_msg ?? err.message);
        }
        return err as Error;
    }
}
