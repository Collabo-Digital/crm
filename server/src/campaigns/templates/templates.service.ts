import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BroadcastStatus, ChannelPlatform, ChannelStatus, MessageTemplate, Prisma, TemplateCategory } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
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

const TEMPLATE_FIELDS = 'id,name,language,status,category,components,quality_score,rejected_reason,parameter_format';
const DAY = 24 * 3600_000;

/// Meta: approved templates can be edited once in 24 hours and 10 times in 30 days.
const EDIT_WINDOW_DAY = DAY;
const EDIT_WINDOW_MONTH = 30 * DAY;
const EDITS_PER_MONTH = 10;
const EDITABLE = new Set(['APPROVED', 'REJECTED', 'PAUSED']);

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
}

/** A template webhook, as the WhatsApp parser reads it. */
export interface TemplateWebhookEvent {
    field: string;
    templateId: string | null;
    name: string | null;
    language: string | null;
    event: string | null;
    value: Record<string, unknown>;
}

const asCategory = (c: string | undefined): TemplateCategory =>
    c && c.toUpperCase() in TemplateCategory ? (c.toUpperCase() as TemplateCategory) : TemplateCategory.MARKETING;

const qualityOf = (q: MetaTemplate['quality_score']): string | null =>
    typeof q === 'string' ? q : q?.score ?? null;

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

    /** Pull every template on the account; ones deleted at Meta go here too. */
    async sync(orgId: string) {
        const channel = await this.channelFor(orgId);
        const { token, creds } = await this.accounts.load(channel.id);
        const scopes = this.accounts.scopes(channel.wabaId);
        const found: MetaTemplate[] = [];
        let next: { path?: string; url?: string } | null = { path: `/${channel.wabaId}/message_templates` };
        while (next) {
            const res: { data: { data?: MetaTemplate[]; paging?: { next?: string } } } = await this.metaGraph.request({
                method: 'GET',
                ...next,
                ...(next.path ? { query: { fields: TEMPLATE_FIELDS, limit: 100 } } : {}),
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
        for (const t of found) {
            const data = {
                externalId: t.id,
                status: t.status,
                category: asCategory(t.category),
                qualityScore: qualityOf(t.quality_score),
                statusReason: t.rejected_reason && t.rejected_reason !== 'NONE' ? t.rejected_reason : null,
                parameterFormat: (t.parameter_format ?? 'POSITIONAL').toUpperCase(),
                components: (t.components ?? []) as Prisma.InputJsonValue,
                syncedAt: now,
            };
            await this.prisma.messageTemplate.upsert({
                where: { wabaId_name_language: { wabaId: channel.wabaId, name: t.name, language: t.language } },
                create: { organizationId: orgId, channelId: channel.id, wabaId: channel.wabaId, name: t.name, language: t.language, ...data },
                update: { channelId: channel.id, ...data },
            });
        }
        const removed = await this.prisma.messageTemplate.deleteMany({
            where: { organizationId: orgId, wabaId: channel.wabaId, externalId: { notIn: found.map((t) => t.id) } },
        });
        await this.refreshMarketingMessagesStatus(channel.id, channel.wabaId, token).catch((err) =>
            this.logger.warn(`Marketing Messages API status not read for ${creds.wabaId}: ${err instanceof Error ? err.message : err}`),
        );
        return { synced: found.length, removed: removed.count };
    }

    /** Submit a new template for Meta's review. */
    async create(orgId: string, userId: string, draft: TemplateDraft, starterKey?: string) {
        const channel = await this.channelFor(orgId);
        const exists = await this.prisma.messageTemplate.findUnique({
            where: { wabaId_name_language: { wabaId: channel.wabaId, name: draft.name, language: draft.language } },
            select: { id: true },
        });
        if (exists) throw new ConflictException(`A template called ${draft.name} already exists in this language.`);
        const { token } = await this.accounts.load(channel.id);
        const components = await this.componentsFor(orgId, draft, token);

        let res: { data: { id?: string; status?: string; category?: string } };
        try {
            res = await this.metaGraph.request({
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
                priority: Priority.INTERACTIVE,
            });
        } catch (err) {
            throw this.refusal(err);
        }
        if (!res.data.id) throw new BadRequestException('Meta did not accept the template.');
        const category = asCategory(res.data.category ?? draft.category);
        const row = await this.prisma.messageTemplate.create({
            data: {
                organizationId: orgId,
                channelId: channel.id,
                wabaId: channel.wabaId,
                externalId: res.data.id,
                name: draft.name,
                language: draft.language,
                category,
                // Meta files a utility template it reads as marketing under marketing.
                requestedCategory: category !== draft.category ? (draft.category as TemplateCategory) : null,
                status: res.data.status ?? 'PENDING',
                parameterFormat: draft.parameterFormat,
                components: components as Prisma.InputJsonValue,
                starterKey: starterKey ?? null,
                submittedAt: new Date(),
                createdById: userId,
            },
        });
        return this.view(row);
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
        const components = await this.componentsFor(orgId, { ...draft, name: template.name, language: template.language, category: template.category }, token);
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
     * Manager that we have never seen is fetched with the next sync.
     */
    async applyWebhook(channel: { id: string; organizationId: string; externalStoreId: string | null }, e: TemplateWebhookEvent) {
        const where: Prisma.MessageTemplateWhereInput = e.templateId
            ? { externalId: e.templateId }
            : { wabaId: channel.externalStoreId ?? '', name: e.name ?? '', language: e.language ?? '' };
        const template = await this.prisma.messageTemplate.findFirst({ where: { organizationId: channel.organizationId, ...where } });
        if (!template) {
            await this.sync(channel.organizationId).catch((err) =>
                this.logger.warn(`Template sync after a webhook for an unknown template failed: ${err instanceof Error ? err.message : err}`),
            );
            return;
        }
        const v = e.value;
        const data: Prisma.MessageTemplateUpdateInput = {};
        if (e.field === 'message_template_status_update' && e.event) {
            // Events, not statuses: Meta's API reads a reinstated template as APPROVED, and a
            // flagged one stays approved and sendable (its quality webhook carries the warning).
            if (e.event === 'REINSTATED') {
                data.status = 'APPROVED';
                data.statusReason = null;
            } else if (e.event !== 'FLAGGED') {
                data.status = e.event;
                const reason = (v.reason as string | undefined) ?? (v.other_info as { title?: string } | undefined)?.title;
                data.statusReason = reason && reason !== 'NONE' ? reason : null;
            }
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
            await this.sync(channel.organizationId).catch(() => undefined);
            return;
        }
        if (Object.keys(data).length) await this.prisma.messageTemplate.update({ where: { id: template.id }, data });
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
            submittedAt: t.submittedAt,
            syncedAt: t.syncedAt,
            updatedAt: t.updatedAt,
        };
    }

    /** Components for Meta, uploading a media header first when there is one. */
    private async componentsFor(orgId: string, draft: TemplateDraft, token: string) {
        const header = draft.header;
        let handle: string | null = null;
        if (header && header.format !== 'TEXT' && header.format !== 'LOCATION') {
            if (!header.storageKey || !header.mime) throw new BadRequestException('Upload the header image, video or document first.');
            // Uploads are stored under the organization's id.
            if (!header.storageKey.startsWith(`${orgId}/`)) throw new BadRequestException('Upload the header file again.');
            handle = await this.uploadHeaderSample(header.storageKey, header.mime, header.filename ?? 'header', token);
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
    private async uploadHeaderSample(storageKey: string, mime: string, filename: string, token: string): Promise<string> {
        if (!this.appId) throw new BadRequestException('META_APP_ID is not configured.');
        const file = await this.storage.read(storageKey);
        const scopes = this.metaGraph.baseScopes();
        const session = await this.metaGraph.request<{ id?: string }>({
            method: 'POST',
            path: `/${this.appId}/uploads`,
            query: { file_name: filename, file_length: file.length, file_type: mime },
            accessToken: token,
            scopes,
            priority: Priority.INTERACTIVE,
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
            priority: Priority.INTERACTIVE,
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
