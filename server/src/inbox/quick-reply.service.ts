import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InboxShareScope, Prisma, QuickReply } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { InboxViewer, canManageInbox, canReply } from './inbox-visibility';
import { InboxTeamService } from './inbox-team.service';
import { SaveQuickReplyDto } from './dto/save-quick-reply.dto';

/** What a member sees: everyone's, their teams', and their own. */
export function quickRepliesFor(orgId: string, viewer: InboxViewer): Prisma.QuickReplyWhereInput {
    return {
        organizationId: orgId,
        OR: [
            { scope: InboxShareScope.ORGANIZATION },
            { scope: InboxShareScope.TEAM, teamId: { in: [...viewer.teamIds] } },
            { scope: InboxShareScope.PERSONAL, ownerUserId: viewer.userId },
        ],
    };
}

/**
 * Saved answers for the composer. Personal ones belong to their author;
 * shared ones (everyone, or one team) are run by owners, admins and managers.
 */
@Injectable()
export class QuickReplyService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly teams: InboxTeamService,
    ) { }

    /**
     * The composer's list. `manage` adds every team's replies, for the
     * settings page, to members who run them.
     */
    async list(orgId: string, viewer: InboxViewer, manage = false) {
        const where: Prisma.QuickReplyWhereInput =
            manage && canManageInbox(viewer)
                ? {
                    organizationId: orgId,
                    OR: [{ scope: { not: InboxShareScope.PERSONAL } }, { ownerUserId: viewer.userId }],
                }
                : quickRepliesFor(orgId, viewer);
        const rows = await this.prisma.quickReply.findMany({
            where,
            orderBy: { shortcut: 'asc' },
            include: { team: { select: { id: true, name: true } } },
        });
        return rows.map((r) => this.view(r, viewer));
    }

    async create(orgId: string, viewer: InboxViewer, dto: SaveQuickReplyDto) {
        const target = await this.target(orgId, viewer, dto.scope, dto.teamId);
        const shortcut = dto.shortcut.toLowerCase();
        await this.assertShortcutFree(orgId, target, shortcut, null);
        const row = await this.prisma.quickReply.create({
            data: {
                organizationId: orgId,
                shortcut,
                body: dto.body,
                keywords: this.keywords(dto.keywords),
                attachment: this.attachment(orgId, dto.attachment) ?? Prisma.DbNull,
                ...target,
                createdById: viewer.userId,
            },
            include: { team: { select: { id: true, name: true } } },
        });
        return this.view(row, viewer);
    }

    async update(orgId: string, viewer: InboxViewer, id: string, dto: Partial<SaveQuickReplyDto>) {
        const existing = await this.load(orgId, viewer, id);
        const target =
            dto.scope !== undefined || dto.teamId !== undefined
                ? await this.target(orgId, viewer, dto.scope ?? existing.scope, dto.teamId ?? existing.teamId ?? undefined)
                : { scope: existing.scope, teamId: existing.teamId, ownerUserId: existing.ownerUserId };
        const shortcut = dto.shortcut?.toLowerCase() ?? existing.shortcut;
        await this.assertShortcutFree(orgId, target, shortcut, id);
        const row = await this.prisma.quickReply.update({
            where: { id },
            data: {
                shortcut,
                ...(dto.body !== undefined ? { body: dto.body } : {}),
                ...(dto.keywords !== undefined ? { keywords: this.keywords(dto.keywords) } : {}),
                ...(dto.attachment !== undefined ? { attachment: this.attachment(orgId, dto.attachment) ?? Prisma.DbNull } : {}),
                ...target,
            },
            include: { team: { select: { id: true, name: true } } },
        });
        return this.view(row, viewer);
    }

    async remove(orgId: string, viewer: InboxViewer, id: string) {
        await this.load(orgId, viewer, id);
        await this.prisma.quickReply.delete({ where: { id } });
        return { deleted: true };
    }

    /** Loads a reply the member may change. */
    private async load(orgId: string, viewer: InboxViewer, id: string): Promise<QuickReply> {
        const row = await this.prisma.quickReply.findFirst({ where: { id, organizationId: orgId } });
        if (!row || (row.scope === InboxShareScope.PERSONAL && row.ownerUserId !== viewer.userId)) {
            throw new NotFoundException('Quick reply not found');
        }
        if (row.scope !== InboxShareScope.PERSONAL && !canManageInbox(viewer)) {
            throw new ForbiddenException('Only owners, admins and managers can change shared quick replies.');
        }
        return row;
    }

    private async target(orgId: string, viewer: InboxViewer, scope: InboxShareScope, teamId: string | undefined) {
        if (!canReply(viewer)) throw new ForbiddenException('Viewers cannot save quick replies.');
        if (scope === InboxShareScope.PERSONAL) return { scope, teamId: null, ownerUserId: viewer.userId };
        if (!canManageInbox(viewer)) {
            throw new ForbiddenException('Only owners, admins and managers can share quick replies. Save it for yourself instead.');
        }
        if (scope === InboxShareScope.TEAM) {
            if (!teamId) throw new BadRequestException('Choose the team this quick reply is for.');
            await this.teams.assertTeam(orgId, teamId);
            return { scope, teamId, ownerUserId: null };
        }
        return { scope, teamId: null, ownerUserId: null };
    }

    /** One shortcut per audience: an agent's own "/hi" may shadow the shared one, two shared ones may not clash. */
    private async assertShortcutFree(
        orgId: string,
        target: { scope: InboxShareScope; teamId: string | null; ownerUserId: string | null },
        shortcut: string,
        exceptId: string | null,
    ) {
        const clash = await this.prisma.quickReply.findFirst({
            where: {
                organizationId: orgId,
                shortcut,
                scope: target.scope,
                teamId: target.teamId,
                ownerUserId: target.ownerUserId,
                ...(exceptId ? { id: { not: exceptId } } : {}),
            },
            select: { id: true },
        });
        if (clash) throw new ConflictException(`/${shortcut} is already used. Pick another shortcut.`);
    }

    private keywords(raw: string[] | undefined): string[] {
        return [...new Set((raw ?? []).map((k) => k.trim().toLowerCase()).filter(Boolean))];
    }

    private attachment(orgId: string, a: SaveQuickReplyDto['attachment']): Prisma.InputJsonValue | null {
        if (!a) return null;
        if (!a.storageKey.startsWith(`${orgId}/`)) throw new BadRequestException('Upload the file again before saving it.');
        return { storageKey: a.storageKey, mime: a.mime, filename: a.filename ?? null, mediaKind: a.mediaKind };
    }

    private view(r: QuickReply & { team: { id: string; name: string } | null }, viewer: InboxViewer) {
        return {
            id: r.id,
            shortcut: r.shortcut,
            body: r.body,
            keywords: r.keywords,
            attachment: r.attachment as { storageKey: string; mime: string; filename: string | null; mediaKind: string } | null,
            scope: r.scope,
            team: r.team,
            canEdit: r.scope === InboxShareScope.PERSONAL ? r.ownerUserId === viewer.userId : canManageInbox(viewer),
            updatedAt: r.updatedAt,
        };
    }
}
