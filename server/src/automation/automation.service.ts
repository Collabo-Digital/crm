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
import { collectIssues, defaultTriggerStep, keywordsFor, parseDefinition, reidSteps, triggerMatchFor, triggerPostFor, triggerTypeFor, type Issue } from './blocks/definition.schema';
import { UpdateAutomationDto } from './dto/update-automation.dto';
import { SaveDefinitionDto } from './dto/save-definition.dto';
import { DuplicateAutomationDto } from './dto/duplicate-automation.dto';


/** Who is asking. Same shape ChannelService uses for its visibility scope. */
export interface AutomationViewer {
    userId: string;
    role?: UserRole;
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
    createdAt: true,
    updatedAt: true,
    channel: { select: { id: true, name: true, platform: true } },
    ownerUser: { select: { id: true, firstName: true, lastName: true, email: true } },
} satisfies Prisma.AutomationSelect;

const DETAIL_INCLUDE = {
    channel: { select: { id: true, name: true, platform: true, externalStoreId: true } },
    ownerUser: { select: { id: true, firstName: true, lastName: true, email: true } },
    publishedVersion: { select: { id: true, version: true, publishedAt: true } },
    triggers: {
        orderBy: { position: 'asc' },
        select: {
            id: true, position: true, triggerType: true, subjectId: true,
            mediaId: true, keywords: true, config: true, isActive: true,
        },
    },
} satisfies Prisma.AutomationInclude;

@Injectable()
export class AutomationService {
    constructor(private readonly prisma: PrismaService) { }

    // ─── Scoping ────────────────────────────────────────────────────────────

    /**
     * Influencers see only rows they created; everyone else sees the org.
     * Mirrors ChannelService.visibilityScope so the two sections agree.
     */
    private scope(viewer: AutomationViewer): Prisma.AutomationWhereInput {
        return viewer.role === UserRole.INFLUENCER ? { ownerUserId: viewer.userId } : {};
    }

    /** By-id read with tenant + visibility in the WHERE. 404 for both "missing" and "not yours". */
    private async getVisible(id: string, orgId: string, viewer: AutomationViewer) {
        const row = await this.prisma.automation.findFirst({
            where: { id, organizationId: orgId, ...this.scope(viewer) },
            include: DETAIL_INCLUDE,
        });
        if (!row) throw new NotFoundException('Automation not found');
        return row;
    }

    private async withIssues<T extends { definition: Prisma.JsonValue; platform: ChannelPlatform | null; channelId: string | null }>(row: T) {
        let issues: Issue[] = [];
        try {
            const steps = parseDefinition(row.definition);
            issues = collectIssues(steps, await this.issueContext(row));
        } catch {
            // A stored draft that no longer parses (schema tightened later) is
            // reported as one issue rather than a 500 on every detail read.
            issues = [{ stepId: '', code: 'invalid_definition', title: 'Definition needs attention', body: 'Re-save this automation in the editor.' }];
        }
        return { ...row, issues };
    }

    private async issueContext(row: { platform: ChannelPlatform | null; channelId: string | null }) {
        let knownMediaIds: Set<string> | null = null;
        if (row.channelId) {
            const media = await this.prisma.channelMedia.findMany({
                where: { channelId: row.channelId, deletedAt: null },
                select: { externalId: true },
            });
            if (media.length > 0) knownMediaIds = new Set(media.map((m) => m.externalId));
        }
        return { platform: row.platform, knownMediaIds };
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

    async findOne(id: string, orgId: string, viewer: AutomationViewer) {
        return this.withIssues(await this.getVisible(id, orgId, viewer));
    }

    async issues(id: string, orgId: string, viewer: AutomationViewer): Promise<Issue[]> {
        const row = await this.getVisible(id, orgId, viewer);
        const steps = parseDefinition(row.definition);
        return collectIssues(steps, await this.issueContext(row));
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

        const updated = await this.prisma.automation.update({
            where: { id: row.id },
            data: {
                definition: { steps } as unknown as Prisma.InputJsonValue,
                settings: settings as Prisma.InputJsonValue,
            },
            include: DETAIL_INCLUDE,
        });
        return this.withIssues(updated);
    }

    // ─── Lifecycle ──────────────────────────────────────────────────────────

    /**
     * Freeze a version and arm the trigger. 422 with the issues list if the
     * draft is not publishable; nothing is written in that case.
     */
    async publish(id: string, orgId: string, viewer: AutomationViewer) {
        const row = await this.getVisible(id, orgId, viewer);
        this.assertNotArchived(row.status);

        const steps = parseDefinition(row.definition);
        const issues = collectIssues(steps, await this.issueContext(row));
        if (issues.length > 0) {
            throw new UnprocessableEntityException({
                message: `Automation has ${issues.length} issue${issues.length === 1 ? '' : 's'}`,
                issues,
            });
        }

        const trigger = steps[0];
        const post = triggerPostFor(trigger);
        const media = post && row.channelId
            ? await this.prisma.channelMedia.findUnique({
                where: { channelId_externalId: { channelId: row.channelId, externalId: post } },
                select: { id: true },
            })
            : null;

        const nextVersion = row.version + 1;

        await this.prisma.$transaction(async (tx) => {
            const version = await tx.automationVersion.create({
                data: {
                    organizationId: orgId,
                    automationId: row.id,
                    version: nextVersion,
                    definition: { steps } as unknown as Prisma.InputJsonValue,
                    settings: (row.settings ?? DEFAULT_SETTINGS) as Prisma.InputJsonValue,
                    publishedByUserId: viewer.userId,
                },
            });

            await tx.automation.update({
                where: { id: row.id },
                data: {
                    version: nextVersion,
                    publishedVersionId: version.id,
                    publishedAt: new Date(),
                    status: AutomationStatus.ACTIVE,
                    lastError: null,
                    lastErrorAt: null,
                },
            });

            // One trigger row per automation in this build (position 0). The id
            // equals the trigger step's id so run.triggerId and step keys agree.
            await tx.automationTrigger.deleteMany({
                where: { automationId: row.id, NOT: { id: trigger.id } },
            });
            await tx.automationTrigger.upsert({
                where: { automationId_position: { automationId: row.id, position: 0 } },
                create: {
                    id: trigger.id,
                    organizationId: orgId,
                    automationId: row.id,
                    position: 0,
                    channelId: row.channelId,
                    triggerType: triggerTypeFor(trigger),
                    mediaId: media?.id ?? null,
                    subjectId: post,
                    keywords: keywordsFor(trigger),
                    config: { match: triggerMatchFor(trigger) } as Prisma.InputJsonValue,
                    isActive: true,
                },
                update: {
                    channelId: row.channelId,
                    triggerType: triggerTypeFor(trigger),
                    mediaId: media?.id ?? null,
                    subjectId: post,
                    keywords: keywordsFor(trigger),
                    config: { match: triggerMatchFor(trigger) } as Prisma.InputJsonValue,
                    isActive: true,
                },
            });
        });

        return this.findOne(row.id, orgId, viewer);
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