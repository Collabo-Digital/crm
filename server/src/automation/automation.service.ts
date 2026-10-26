import {
    BadRequestException,
    ConflictException,
    Injectable,
    NotFoundException,
    UnprocessableEntityException,
} from '@nestjs/common';
import { UserRole, Prisma, AutomationStatus, ChannelPlatform } from "@prisma/client";
import { PrismaService } from '../prisma/prisma.service';
import { QueryAutomationsDto } from "./dto/query-automations.dto";
import { CreateAutomationDto } from "./dto/create-automation.dto";
import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { collectIssues, defaultTriggerStep, keywordsFor, parseDefinition, reidSteps, triggerConfigFor, triggerPostFor, triggerTypeFor, type Issue, type IssueContext, type StepDef } from './blocks/definition.schema';
import { Flow } from './engine/flow';
import { templateParams } from '../campaigns/templates/template-components';
import { UpdateAutomationDto } from './dto/update-automation.dto';
import { SaveDefinitionDto } from './dto/save-definition.dto';
import { DuplicateAutomationDto } from './dto/duplicate-automation.dto';
import { WhatsAppPayService } from '../payments/whatsapp-pay.service';


/** Who is asking. Same shape ChannelService uses for its visibility scope. */
export interface AutomationViewer {
    userId: string;
    role?: UserRole;
    /** May edit automations. Everyone else reads them without the webhook URL's secret. */
    canManage?: boolean;
}

/** The webhook URL is a credential: blank its token for people who only read the automation. */
function withoutWebhookToken<T extends { definition: Prisma.JsonValue; triggers: Array<{ triggerType: string; subjectId: string | null }> }>(row: T): T {
    const definition = row.definition as { steps?: Array<{ config?: Record<string, unknown> }> } | null;
    const [first, ...rest] = definition?.steps ?? [];
    return {
        ...row,
        definition: first?.config?.token ? { ...definition, steps: [{ ...first, config: { ...first.config, token: '' } }, ...rest] } : row.definition,
        triggers: row.triggers.map((t) => (t.triggerType === 'crm.webhook' ? { ...t, subjectId: null } : t)),
    } as T;
}

const DEFAULT_SETTINGS = { oncePerContact: 'ever' } as const;

const LIST_SELECT = {
    id: true,
    name: true,
    description: true,
    status: true,
    platform: true,
    version: true,
    publishedAt: true,
    triggeredCount: true,
    lastTriggeredAt: true,
    lastError: true,
    packKey: true,
    createdAt: true,
    updatedAt: true,
    channel: { select: { id: true, name: true, platform: true } },
    ownerUser: { select: { id: true, firstName: true, lastName: true, email: true } },
} satisfies Prisma.AutomationSelect;
export type AutomationListRow = Prisma.AutomationGetPayload<{ select: typeof LIST_SELECT }>;

const DETAIL_INCLUDE = {
    channel: { select: { id: true, name: true, platform: true, externalStoreId: true } },
    ownerUser: { select: { id: true, firstName: true, lastName: true, email: true } },
    publishedVersion: { select: { id: true, version: true, publishedAt: true, definition: true, settings: true } },
    triggers: {
        orderBy: { position: 'asc' },
        select: {
            id: true, position: true, triggerType: true, subjectId: true,
            mediaId: true, keywords: true, config: true, isActive: true,
        },
    },
} satisfies Prisma.AutomationInclude;
type DetailRow = Prisma.AutomationGetPayload<{ include: typeof DETAIL_INCLUDE }>;

const isUniqueViolation = (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

@Injectable()
export class AutomationService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly whatsAppPay: WhatsAppPayService,
    ) { }

    // ─── Scoping ────────────────────────────────────────────────────────────

    /**
     * Influencers see only rows they created; everyone else sees the org.
     * Mirrors ChannelService.visibilityScope so the two sections agree.
     */
    private scope(viewer: AutomationViewer): Prisma.AutomationWhereInput {
        return viewer.role === UserRole.INFLUENCER ? { ownerUserId: viewer.userId } : {};
    }

    /** By-id read with tenant + visibility in the WHERE. 404 for both "missing" and "not yours". */
    async getVisible(id: string, orgId: string, viewer: AutomationViewer) {
        const row = await this.prisma.automation.findFirst({
            where: { id, organizationId: orgId, ...this.scope(viewer) },
            include: DETAIL_INCLUDE,
        });
        if (!row) throw new NotFoundException('Automation not found');
        return row;
    }

    private async withIssues<
        T extends {
            organizationId: string;
            definition: Prisma.JsonValue;
            settings: Prisma.JsonValue;
            platform: ChannelPlatform | null;
            channelId: string | null;
            publishedVersion: { definition: Prisma.JsonValue; settings: Prisma.JsonValue; id: string; version: number; publishedAt: Date } | null;
        },
    >(row: T) {
        let issues: Issue[] = [];
        try {
            const steps = parseDefinition(row.definition);
            issues = collectIssues(steps, await this.issueContext(row, steps));
        } catch {
            // A stored draft that no longer parses (schema tightened later) is
            // reported as one issue rather than a 500 on every detail read.
            issues = [{ stepId: '', code: 'invalid_definition', title: 'Definition needs attention', body: 'Re-save this automation in the editor.' }];
        }
        // The draft differs from what runs: edited since the last publish.
        const published = row.publishedVersion;
        const unpublishedChanges =
            !!published &&
            (JSON.stringify(published.definition) !== JSON.stringify(row.definition) ||
                JSON.stringify(published.settings ?? DEFAULT_SETTINGS) !== JSON.stringify(row.settings ?? DEFAULT_SETTINGS));
        const publishedVersion = published ? { id: published.id, version: published.version, publishedAt: published.publishedAt } : null;
        return { ...row, publishedVersion, unpublishedChanges, issues };
    }

    private async issueContext(row: { organizationId: string; platform: ChannelPlatform | null; channelId: string | null }, steps: StepDef[]): Promise<IssueContext> {
        let knownMediaIds: Set<string> | null = null;
        if (row.channelId) {
            const media = await this.prisma.channelMedia.findMany({
                where: { channelId: row.channelId, deletedAt: null },
                select: { externalId: true },
            });
            if (media.length > 0) knownMediaIds = new Set(media.map((m) => m.externalId));
        }
        const templateIds = [...new Set(new Flow(steps).all().map(({ step }) => step.config.templateId).filter((v): v is string => typeof v === 'string' && !!v))];
        const rows = templateIds.length
            ? await this.prisma.messageTemplate.findMany({
                where: { id: { in: templateIds }, organizationId: row.organizationId },
                select: { id: true, name: true, components: true, parameterFormat: true },
            })
            : [];
        const templates = new Map(rows.map((r) => [r.id, {
            name: r.name,
            params: templateParams(r.components as Record<string, unknown>[], r.parameterFormat === 'NAMED' ? 'NAMED' : 'POSITIONAL')
                .map((p) => ({ key: p.key, name: p.name, kind: p.kind })),
        }]));
        const paySteps = new Flow(steps).all().filter(({ step }) => step.type === 'send_payment_link');
        const paymentsConnected = paySteps.some(({ step }) => step.config.method !== 'whatsapp_pay')
            ? !!(await this.prisma.paymentAccount.findFirst({ where: { organizationId: row.organizationId, disconnectedAt: null, credentials: { not: null } }, select: { id: true } }))
            : undefined;
        const whatsAppPayReady = paySteps.some(({ step }) => step.config.method === 'whatsapp_pay') ? await this.whatsAppPay.available(row.channelId) : undefined;
        const usesSheets = new Flow(steps).all().some(({ step }) => step.type === 'sheet_add_row' || (step.type === 'trigger' && step.config.event === 'sheet_row'));
        const sheets = usesSheets
            ? new Set((await this.prisma.googleSheet.findMany({ where: { organizationId: row.organizationId }, select: { id: true } })).map((s) => s.id))
            : undefined;
        return { platform: row.platform, knownMediaIds, templates, paymentsConnected, whatsAppPayReady, sheets };
    }


    // ─── List / read ────────────────────────────────────────────────────────

    async list(orgId: string, viewer: AutomationViewer, query: QueryAutomationsDto) {
        const page = query.page ?? 1;
        const limit = query.limit ?? 20;

        const where: Prisma.AutomationWhereInput = {
            organizationId: orgId,
            ...this.scope(viewer),
            // Archived rows are hidden unless asked for explicitly.
            status: query.status ?? { not: AutomationStatus.ARCHIVED },
            ...(query.platform ? { platform: query.platform } : {}),
            ...(query.search ? { name: { contains: query.search, mode: 'insensitive' } } : {}),
        };

        const [data, total] = await Promise.all([
            this.prisma.automation.findMany({
                where,
                skip: (page - 1) * limit,
                take: limit,
                orderBy: { [query.sortBy ?? 'updatedAt']: query.sortOrder ?? 'desc' },
                select: LIST_SELECT,
            }),
            this.prisma.automation.count({ where }),
        ]);

        return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
    }

    /** The organization's recommended-pack automations, as list rows; archived ones are gone for good. */
    packList(orgId: string): Promise<AutomationListRow[]> {
        return this.prisma.automation.findMany({
            where: { organizationId: orgId, packKey: { not: null }, status: { not: AutomationStatus.ARCHIVED } },
            select: LIST_SELECT,
        });
    }

    async findOne(id: string, orgId: string, viewer: AutomationViewer) {
        const row = await this.withIssues(await this.getVisible(id, orgId, viewer));
        return viewer.canManage ? row : withoutWebhookToken(row);
    }

    async issues(id: string, orgId: string, viewer: AutomationViewer): Promise<Issue[]> {
        const row = await this.getVisible(id, orgId, viewer);
        const steps = parseDefinition(row.definition);
        return collectIssues(steps, await this.issueContext(row, steps));
    }


    // ─── Create / update ────────────────────────────────────────────────────

    async create(orgId: string, viewer: AutomationViewer, dto: CreateAutomationDto) {
        const channel = await this.prisma.channel.findFirst({
            where: { id: dto.channelId, organizationId: orgId },
            select: { id: true, platform: true, ownerUserId: true },
        });
        if (!channel) throw new NotFoundException('Channel not found');
        if (channel.platform !== dto.platform) {
            throw new BadRequestException(`Channel is a ${channel.platform} account, not ${dto.platform}`);
        }
        // An influencer may only automate the account they connected themselves.
        if (viewer.role === UserRole.INFLUENCER && channel.ownerUserId !== viewer.userId) {
            throw new NotFoundException('Channel not found');
        }

        const definition = { steps: [defaultTriggerStep(dto.platform)] };

        const created = await this.prisma.automation.create({
            data: {
                organizationId: orgId,
                platform: dto.platform,
                channelId: channel.id,
                ownerUserId: viewer.userId,
                name: dto.name.trim(),
                description: dto.description?.trim() || null,
                status: AutomationStatus.DRAFT,
                definition: definition as unknown as Prisma.InputJsonValue,
                settings: DEFAULT_SETTINGS as Prisma.InputJsonValue,
            },
            include: DETAIL_INCLUDE,
        });
        return this.withIssues(created);
    }

    async update(id: string, orgId: string, viewer: AutomationViewer, dto: UpdateAutomationDto) {
        const row = await this.getVisible(id, orgId, viewer);
        this.assertNotArchived(row.status);

        const updated = await this.prisma.automation.update({
            where: { id: row.id },
            data: {
                ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
                ...(dto.description !== undefined ? { description: dto.description.trim() || null } : {}),
            },
            include: DETAIL_INCLUDE,
        });
        return this.withIssues(updated);
    }

    /** Save draft: replaces the whole step list. Never touches the published version. */
    async saveDefinition(id: string, orgId: string, viewer: AutomationViewer, dto: SaveDefinitionDto) {
        const row = await this.getVisible(id, orgId, viewer);
        this.assertNotArchived(row.status);

        const steps = parseDefinition(dto.definition);
        const settings = { ...DEFAULT_SETTINGS, ...(row.settings as object ?? {}), ...(dto.settings ?? {}) };

        const updated = await this.prisma.$transaction(async (tx) => {
            // Only publish issues the webhook URL's token. One sent by the client is ignored, so nobody can pick a
            // guessable token or another automation's. It is read under the row lock publish also takes, so a save
            // that races the first publish keeps the URL that publish issued.
            const [current] = await tx.$queryRaw<Array<{ token: string | null }>>`
                SELECT "definition" #>> '{steps,0,config,token}' AS "token" FROM "automations" WHERE "id" = ${row.id} FOR UPDATE
            `;
            steps[0].config = { ...steps[0].config, token: current?.token ?? '' };
            return tx.automation.update({
                where: { id: row.id },
                data: {
                    definition: { steps } as unknown as Prisma.InputJsonValue,
                    settings: settings as Prisma.InputJsonValue,
                },
                include: DETAIL_INCLUDE,
            });
        });
        return this.withIssues(updated);
    }

    // ─── System paths: Collabo's recommended pack ───────────────────────────

    /**
     * An automation Collabo makes for the organization: no creator, a draft
     * until it is published, its definition checked like a saved draft's.
     * Null when it exists already (another sync made it first).
     */
    async createSystem(
        orgId: string,
        input: { packKey: string; name: string; description: string; channelId: string; steps: StepDef[]; activateWhenReady: boolean },
    ): Promise<{ id: string } | null> {
        const steps = parseDefinition({ steps: input.steps });
        try {
            return await this.prisma.automation.create({
                data: {
                    organizationId: orgId,
                    platform: ChannelPlatform.WHATSAPP,
                    channelId: input.channelId,
                    ownerUserId: null,
                    name: input.name,
                    description: input.description,
                    status: AutomationStatus.DRAFT,
                    definition: { steps } as unknown as Prisma.InputJsonValue,
                    settings: DEFAULT_SETTINGS as Prisma.InputJsonValue,
                    packKey: input.packKey,
                    activateWhenReady: input.activateWhenReady,
                },
                select: { id: true },
            });
        } catch (err) {
            if (isUniqueViolation(err)) return null;
            throw err;
        }
    }

    /**
     * Replace a system automation's draft, if it is still the one the caller
     * read: a merchant's edit saved meanwhile is kept. A live one keeps running
     * its published version until it is published again. Returns the draft
     * saved, or null.
     */
    async saveSystemDefinition(id: string, orgId: string, input: StepDef[], current: Prisma.JsonValue): Promise<{ steps: StepDef[] } | null> {
        const definition = { steps: parseDefinition({ steps: input }) };
        const { count } = await this.prisma.automation.updateMany({
            where: { id, organizationId: orgId, status: { not: AutomationStatus.ARCHIVED }, definition: { equals: current as Prisma.InputJsonValue } },
            data: { definition: definition as unknown as Prisma.InputJsonValue },
        });
        return count ? definition : null;
    }

    /**
     * Publish with nobody behind it: the draft the caller decided on, and only
     * that (a merchant's edit saved meanwhile stays a draft, and null comes
     * back). Returns the issues that kept it from going live; none when it did.
     */
    async publishSystem(id: string, orgId: string, draft: unknown): Promise<Issue[] | null> {
        const row = await this.prisma.automation.findFirst({ where: { id, organizationId: orgId }, include: DETAIL_INCLUDE });
        if (!row) throw new NotFoundException('Automation not found');
        // As stored: JSON drops undefined keys, and Postgres reorders the others.
        if (!isDeepStrictEqual(row.definition, JSON.parse(JSON.stringify(draft)))) return null;
        return this.publishRow(row, null);
    }

    // ─── Lifecycle ──────────────────────────────────────────────────────────

    /**
     * Freeze a version and arm the trigger. 422 with the issues list if the
     * draft is not publishable; nothing is written in that case.
     */
    async publish(id: string, orgId: string, viewer: AutomationViewer) {
        const row = await this.getVisible(id, orgId, viewer);
        const issues = await this.publishRow(row, viewer.userId);
        if (issues.length > 0) {
            throw new UnprocessableEntityException({
                message: `Automation has ${issues.length} issue${issues.length === 1 ? '' : 's'}`,
                issues,
            });
        }
        return this.findOne(row.id, orgId, viewer);
    }

    /** Publish unless the draft has issues; then nothing is written and they are returned. */
    private async publishRow(row: DetailRow, publishedByUserId: string | null): Promise<Issue[]> {
        const orgId = row.organizationId;
        this.assertNotArchived(row.status);

        const steps = parseDefinition(row.definition);
        const issues = collectIssues(steps, await this.issueContext(row, steps));
        if (issues.length > 0) return issues;

        const trigger = steps[0];
        // A webhook trigger gets its secret URL on first publish and keeps it: a draft that lost its
        // token takes back the one already live rather than changing a URL other systems call.
        const issueToken = trigger.config.event === 'webhook' && !trigger.config.token;
        if (issueToken) {
            const live = row.triggers.find((t) => t.triggerType === 'crm.webhook')?.subjectId;
            trigger.config = { ...trigger.config, token: live || randomBytes(18).toString('base64url') };
        }
        const post = triggerPostFor(trigger);
        const media = post && row.channelId
            ? await this.prisma.channelMedia.findUnique({
                where: { channelId_externalId: { channelId: row.channelId, externalId: post } },
                select: { id: true },
            })
            : null;

        const nextVersion = row.version + 1;

        await this.prisma.$transaction(async (tx) => {
            if (trigger.config.event === 'sheet_row' && post) await this.watchSheetFromNow(tx, orgId, post);
            const version = await tx.automationVersion.create({
                data: {
                    organizationId: orgId,
                    automationId: row.id,
                    version: nextVersion,
                    definition: { steps } as unknown as Prisma.InputJsonValue,
                    settings: (row.settings ?? DEFAULT_SETTINGS) as Prisma.InputJsonValue,
                    publishedByUserId,
                },
            });

            // Only the token goes into the draft, so an edit saved since this publish read it is kept.
            if (issueToken) {
                await tx.$executeRaw`
                    UPDATE "automations" SET "definition" = jsonb_set("definition", '{steps,0,config,token}', to_jsonb(${String(trigger.config.token)}::text))
                    WHERE "id" = ${row.id}
                `;
            }
            await tx.automation.update({
                where: { id: row.id },
                data: {
                    version: nextVersion,
                    publishedVersionId: version.id,
                    publishedAt: new Date(),
                    status: AutomationStatus.ACTIVE,
                    lastError: null,
                    lastErrorAt: null,
                    // Live now, by whoever published it: nothing left to wait for.
                    activateWhenReady: false,
                },
            });

            // One trigger row per automation in this build (position 0). Step ids
            // are only unique within an automation, so the row has its own id.
            await tx.automationTrigger.deleteMany({
                where: { automationId: row.id, NOT: { position: 0 } },
            });
            await tx.automationTrigger.upsert({
                where: { automationId_position: { automationId: row.id, position: 0 } },
                create: {
                    organizationId: orgId,
                    automationId: row.id,
                    position: 0,
                    channelId: row.channelId,
                    triggerType: triggerTypeFor(trigger),
                    mediaId: media?.id ?? null,
                    subjectId: post,
                    keywords: keywordsFor(trigger),
                    config: triggerConfigFor(trigger) as Prisma.InputJsonValue,
                    isActive: true,
                },
                update: {
                    channelId: row.channelId,
                    triggerType: triggerTypeFor(trigger),
                    mediaId: media?.id ?? null,
                    subjectId: post,
                    keywords: keywordsFor(trigger),
                    config: triggerConfigFor(trigger) as Prisma.InputJsonValue,
                    isActive: true,
                },
            });
        });
        return [];
    }

    async pause(id: string, orgId: string, viewer: AutomationViewer) {
        const row = await this.getVisible(id, orgId, viewer);
        if (row.status !== AutomationStatus.ACTIVE) {
            throw new ConflictException('Only an active automation can be paused');
        }
        await this.setActive(row.id, false, AutomationStatus.PAUSED);
        return this.findOne(row.id, orgId, viewer);
    }

    async resume(id: string, orgId: string, viewer: AutomationViewer) {
        const row = await this.getVisible(id, orgId, viewer);
        if (row.status !== AutomationStatus.PAUSED || !row.publishedVersionId) {
            throw new ConflictException('Only a paused, published automation can be resumed');
        }
        const sheetId = row.triggers.find((t) => t.triggerType === 'crm.sheet.row')?.subjectId;
        if (sheetId) await this.watchSheetFromNow(this.prisma, orgId, sheetId);
        await this.setActive(row.id, true, AutomationStatus.ACTIVE);
        return this.findOne(row.id, orgId, viewer);
    }

    async duplicate(id: string, orgId: string, viewer: AutomationViewer, dto: DuplicateAutomationDto) {
        const row = await this.getVisible(id, orgId, viewer);
        const steps = reidSteps(parseDefinition(row.definition));

        const created = await this.prisma.automation.create({
            data: {
                organizationId: orgId,
                platform: row.platform,
                channelId: row.channelId,
                ownerUserId: viewer.userId,
                name: (dto.name ?? `Copy of ${row.name}`).slice(0, 120),
                description: row.description,
                status: AutomationStatus.DRAFT,
                definition: { steps } as unknown as Prisma.InputJsonValue,
                settings: (row.settings ?? DEFAULT_SETTINGS) as Prisma.InputJsonValue,
            },
            include: DETAIL_INCLUDE,
        });
        return this.withIssues(created);
    }

    /** Archive, never delete: runs, versions and messages point at this row. */
    async archive(id: string, orgId: string, viewer: AutomationViewer) {
        const row = await this.getVisible(id, orgId, viewer);
        if (row.status === AutomationStatus.ARCHIVED) return { id: row.id, status: row.status };

        await this.prisma.$transaction([
            this.prisma.automation.update({
                where: { id: row.id },
                data: { status: AutomationStatus.ARCHIVED, archivedAt: new Date() },
            }),
            this.prisma.automationTrigger.updateMany({
                where: { automationId: row.id },
                data: { isActive: false },
            }),
        ]);
        return { id: row.id, status: AutomationStatus.ARCHIVED };
    }

    // ─── Helpers ────────────────────────────────────────────────────────────

    /**
     * Called before a sheet trigger goes live. A sheet no live automation
     * watches kept filling unread; its read position is cleared so the next
     * read starts from its end and those rows never start anything. A sheet
     * still being watched is read up to date already, and keeps its place.
     */
    private async watchSheetFromNow(db: Prisma.TransactionClient, orgId: string, sheetId: string) {
        const watched = await db.automationTrigger.count({
            where: { organizationId: orgId, triggerType: 'crm.sheet.row', subjectId: sheetId, isActive: true, automation: { status: AutomationStatus.ACTIVE } },
        });
        if (!watched) await db.googleSheet.updateMany({ where: { id: sheetId, organizationId: orgId }, data: { seenRows: null } });
    }

    /** Status and trigger.isActive always move together so the matcher never joins. */
    private setActive(automationId: string, isActive: boolean, status: AutomationStatus) {
        return this.prisma.$transaction([
            this.prisma.automation.update({ where: { id: automationId }, data: { status } }),
            this.prisma.automationTrigger.updateMany({ where: { automationId }, data: { isActive } }),
        ]);
    }


    private assertNotArchived(status: AutomationStatus) {
        if (status === AutomationStatus.ARCHIVED) {
            throw new ConflictException('This automation is archived. Duplicate it to keep working on it.');
        }
    }
}