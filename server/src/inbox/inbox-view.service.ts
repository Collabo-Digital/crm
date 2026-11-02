import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InboxShareScope, InboxView, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { conversationWhere, parseFilters } from './inbox-filters';
import { InboxViewer, canManageInbox } from './inbox-visibility';
import { InboxTeamService } from './inbox-team.service';
import { SaveInboxViewDto } from './dto/save-inbox-view.dto';

/**
 * Saved inbox filters. Anyone can keep their own; sharing one with a team or
 * everyone is for owners, admins and managers. A shared view never widens
 * what a member sees — the filters run inside each member's own visibility.
 */
@Injectable()
export class InboxViewService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly teams: InboxTeamService,
    ) { }

    async list(orgId: string, viewer: InboxViewer) {
        const rows = await this.prisma.inboxView.findMany({
            where: {
                organizationId: orgId,
                OR: [
                    { scope: InboxShareScope.ORGANIZATION },
                    { scope: InboxShareScope.TEAM, teamId: { in: [...viewer.teamIds] } },
                    { scope: InboxShareScope.PERSONAL, ownerUserId: viewer.userId },
                ],
            },
            orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
            include: { team: { select: { id: true, name: true } } },
        });
        return rows.map((r) => this.view(r, viewer));
    }

    /** How many conversations each of the member's views holds right now. */
    async counts(orgId: string, viewer: InboxViewer, now: Date): Promise<Record<string, number>> {
        const views = await this.list(orgId, viewer);
        const counts = await Promise.all(
            views.map((v) => this.prisma.conversation.count({ where: conversationWhere(orgId, viewer, v.filters, now) })),
        );
        return Object.fromEntries(views.map((v, i) => [v.id, counts[i]]));
    }

    async create(orgId: string, viewer: InboxViewer, dto: SaveInboxViewDto) {
        const target = await this.target(orgId, viewer, dto.scope, dto.teamId);
        const row = await this.prisma.inboxView.create({
            data: {
                organizationId: orgId,
                name: dto.name.trim(),
                filters: parseFilters(dto.filters) as Prisma.InputJsonValue,
                position: dto.position ?? 0,
                ...target,
            },
            include: { team: { select: { id: true, name: true } } },
        });
        return this.view(row, viewer);
    }

    async update(orgId: string, viewer: InboxViewer, id: string, dto: Partial<SaveInboxViewDto>) {
        const existing = await this.load(orgId, viewer, id);
        const target =
            dto.scope !== undefined || dto.teamId !== undefined
                ? await this.target(orgId, viewer, dto.scope ?? existing.scope, dto.teamId ?? existing.teamId ?? undefined)
                : {};
        const row = await this.prisma.inboxView.update({
            where: { id },
            data: {
                ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
                ...(dto.filters !== undefined ? { filters: parseFilters(dto.filters) as Prisma.InputJsonValue } : {}),
                ...(dto.position !== undefined ? { position: dto.position } : {}),
                ...target,
            },
            include: { team: { select: { id: true, name: true } } },
        });
        return this.view(row, viewer);
    }

    async remove(orgId: string, viewer: InboxViewer, id: string) {
        await this.load(orgId, viewer, id);
        await this.prisma.inboxView.delete({ where: { id } });
        return { deleted: true };
    }

    private async load(orgId: string, viewer: InboxViewer, id: string): Promise<InboxView> {
        const row = await this.prisma.inboxView.findFirst({ where: { id, organizationId: orgId } });
        if (!row || (row.scope === InboxShareScope.PERSONAL && row.ownerUserId !== viewer.userId)) {
            throw new NotFoundException('View not found');
        }
        if (row.scope !== InboxShareScope.PERSONAL && !canManageInbox(viewer)) {
            throw new ForbiddenException('Only owners, admins and managers can change shared views.');
        }
        return row;
    }

    private async target(orgId: string, viewer: InboxViewer, scope: InboxShareScope, teamId: string | undefined) {
        if (scope === InboxShareScope.PERSONAL) return { scope, teamId: null, ownerUserId: viewer.userId };
        if (!canManageInbox(viewer)) {
            throw new ForbiddenException('Only owners, admins and managers can share views. Save it for yourself instead.');
        }
        if (scope === InboxShareScope.TEAM) {
            if (!teamId) throw new BadRequestException('Choose the team this view is for.');
            await this.teams.assertTeam(orgId, teamId);
            return { scope, teamId, ownerUserId: null };
        }
        return { scope, teamId: null, ownerUserId: null };
    }

    private view(r: InboxView & { team: { id: string; name: string } | null }, viewer: InboxViewer) {
        return {
            id: r.id,
            name: r.name,
            filters: parseFilters(r.filters),
            scope: r.scope,
            team: r.team,
            position: r.position,
            canEdit: r.scope === InboxShareScope.PERSONAL ? r.ownerUserId === viewer.userId : canManageInbox(viewer),
        };
    }
}
