import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InboxAvailability, Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { SessionPayload } from '../auth/interfaces/jwt-payload.interface';
import { InboxViewer, canAssignOthers, canManageInbox, canReply, seesAll, seesUnassigned } from './inbox-visibility';
import { SaveTeamDto } from './dto/save-team.dto';

export const ASSIGNABLE_ROLES: UserRole[] = [UserRole.OWNER, UserRole.ADMIN, UserRole.MANAGER, UserRole.AGENT];

/// An open inbox refreshes inboxSeenAt on its 25s heartbeat; two missed beats is gone.
const PRESENCE_TTL_MS = 2 * 60_000;
/// Writing presence on every heartbeat of every tab is wasteful; once a minute is enough.
const PRESENCE_WRITE_EVERY_MS = 60_000;

export type Presence = 'online' | 'away' | 'offline';

export function presenceOf(status: InboxAvailability, seenAt: Date | null, now = new Date()): Presence {
    if (!seenAt || now.getTime() - seenAt.getTime() > PRESENCE_TTL_MS) return 'offline';
    return status === InboxAvailability.AWAY ? 'away' : 'online';
}

const isUniqueViolation = (err: unknown) =>
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

/**
 * Inbox teams, who is available, and who the signed-in member is to the
 * inbox. Routing (M5) reads the same presence the inbox shows.
 */
@Injectable()
export class InboxTeamService {
    private readonly lastPresenceWrite = new Map<string, number>();

    constructor(private readonly prisma: PrismaService) { }

    /** The member as the inbox rules see them, with their teams. */
    async viewer(user: SessionPayload): Promise<InboxViewer> {
        const teams = await this.prisma.inboxTeamMember.findMany({
            where: { userId: user.sub, team: { organizationId: user.orgId! } },
            select: { teamId: true },
        });
        return {
            userId: user.sub,
            role: user.role!,
            grants: user.permissions ?? [],
            teamIds: teams.map((t) => t.teamId),
        };
    }

    async me(orgId: string, viewer: InboxViewer) {
        const member = await this.prisma.organizationMember.findUnique({
            where: { organizationId_userId: { organizationId: orgId, userId: viewer.userId } },
            select: { inboxStatus: true, inboxSeenAt: true },
        });
        const teams = await this.prisma.inboxTeam.findMany({
            where: { id: { in: [...viewer.teamIds] } },
            select: { id: true, name: true },
            orderBy: { name: 'asc' },
        });
        return {
            userId: viewer.userId,
            status: member?.inboxStatus ?? InboxAvailability.ONLINE,
            teams,
            access: {
                seesAll: seesAll(viewer),
                seesUnassigned: seesUnassigned(viewer),
                canReply: canReply(viewer),
                canAssignOthers: canAssignOthers(viewer),
                canManage: canManageInbox(viewer),
            },
        };
    }

    async setStatus(orgId: string, userId: string, status: InboxAvailability) {
        await this.prisma.organizationMember.update({
            where: { organizationId_userId: { organizationId: orgId, userId } },
            data: { inboxStatus: status, inboxSeenAt: new Date() },
        });
        this.lastPresenceWrite.set(`${orgId}:${userId}`, Date.now());
        return { status };
    }

    /** The member has an inbox open. Called from the live stream's heartbeat. */
    async touchPresence(orgId: string, userId: string): Promise<void> {
        const key = `${orgId}:${userId}`;
        const last = this.lastPresenceWrite.get(key) ?? 0;
        if (Date.now() - last < PRESENCE_WRITE_EVERY_MS) return;
        this.lastPresenceWrite.set(key, Date.now());
        await this.prisma.organizationMember.updateMany({
            where: { organizationId: orgId, userId },
            data: { inboxSeenAt: new Date() },
        });
    }

    /** Active members who can be assigned conversations, with presence and teams. */
    async members(orgId: string) {
        const now = new Date();
        const members = await this.prisma.organizationMember.findMany({
            where: { organizationId: orgId, isActive: true, role: { in: ASSIGNABLE_ROLES } },
            select: {
                role: true,
                inboxStatus: true,
                inboxSeenAt: true,
                user: {
                    select: {
                        id: true,
                        firstName: true,
                        lastName: true,
                        avatarUrl: true,
                        inboxTeams: { where: { team: { organizationId: orgId } }, select: { teamId: true } },
                    },
                },
            },
            orderBy: { user: { firstName: 'asc' } },
        });
        return members.map((m) => ({
            id: m.user.id,
            name: `${m.user.firstName} ${m.user.lastName}`.trim(),
            avatarUrl: m.user.avatarUrl,
            role: m.role,
            presence: presenceOf(m.inboxStatus, m.inboxSeenAt, now),
            teamIds: m.user.inboxTeams.map((t) => t.teamId),
        }));
    }

    // ─── Teams ────────────────────────────────────────────────────────

    async listTeams(orgId: string) {
        const now = new Date();
        const teams = await this.prisma.inboxTeam.findMany({
            where: { organizationId: orgId },
            orderBy: { name: 'asc' },
            include: {
                members: {
                    select: { userId: true, user: { select: { firstName: true, lastName: true } } },
                },
                _count: { select: { conversations: { where: { status: { not: 'CLOSED' } } } } },
            },
        });
        const presence = await this.presenceByUser(orgId, now);
        return teams.map((t) => ({
            id: t.id,
            name: t.name,
            openConversations: t._count.conversations,
            members: t.members.map((m) => ({
                id: m.userId,
                name: `${m.user.firstName} ${m.user.lastName}`.trim(),
                presence: presence.get(m.userId) ?? 'offline',
            })),
        }));
    }

    async createTeam(orgId: string, viewer: InboxViewer, dto: SaveTeamDto) {
        this.assertManager(viewer);
        const memberIds = await this.validMemberIds(orgId, dto.memberIds ?? []);
        try {
            const team = await this.prisma.inboxTeam.create({
                data: {
                    organizationId: orgId,
                    name: dto.name.trim(),
                    members: { create: memberIds.map((userId) => ({ userId })) },
                },
                select: { id: true },
            });
            return this.getTeam(orgId, team.id);
        } catch (err) {
            if (isUniqueViolation(err)) throw new ConflictException('A team with this name already exists.');
            throw err;
        }
    }

    async updateTeam(orgId: string, viewer: InboxViewer, id: string, dto: Partial<SaveTeamDto>) {
        this.assertManager(viewer);
        const team = await this.prisma.inboxTeam.findFirst({ where: { id, organizationId: orgId }, select: { id: true } });
        if (!team) throw new NotFoundException('Team not found');
        const memberIds = dto.memberIds ? await this.validMemberIds(orgId, dto.memberIds) : null;
        try {
            await this.prisma.$transaction(async (tx) => {
                if (dto.name !== undefined) await tx.inboxTeam.update({ where: { id }, data: { name: dto.name.trim() } });
                if (memberIds) {
                    await tx.inboxTeamMember.deleteMany({ where: { teamId: id, userId: { notIn: memberIds } } });
                    await tx.inboxTeamMember.createMany({
                        data: memberIds.map((userId) => ({ teamId: id, userId })),
                        skipDuplicates: true,
                    });
                }
            });
        } catch (err) {
            if (isUniqueViolation(err)) throw new ConflictException('A team with this name already exists.');
            throw err;
        }
        return this.getTeam(orgId, id);
    }

    /** Conversations and contacts keep going; they just lose the team. */
    async deleteTeam(orgId: string, viewer: InboxViewer, id: string) {
        this.assertManager(viewer);
        const { count } = await this.prisma.inboxTeam.deleteMany({ where: { id, organizationId: orgId } });
        if (!count) throw new NotFoundException('Team not found');
        return { deleted: true };
    }

    async assertTeam(orgId: string, teamId: string) {
        const team = await this.prisma.inboxTeam.findFirst({ where: { id: teamId, organizationId: orgId }, select: { id: true } });
        if (!team) throw new BadRequestException('That team does not exist.');
    }

    private async getTeam(orgId: string, id: string) {
        const teams = await this.listTeams(orgId);
        return teams.find((t) => t.id === id)!;
    }

    private async validMemberIds(orgId: string, ids: string[]): Promise<string[]> {
        const unique = [...new Set(ids)];
        if (!unique.length) return [];
        const found = await this.prisma.organizationMember.findMany({
            where: { organizationId: orgId, userId: { in: unique }, isActive: true, role: { in: ASSIGNABLE_ROLES } },
            select: { userId: true },
        });
        if (found.length !== unique.length) {
            throw new BadRequestException('Teams can only include active members who can reply to chats.');
        }
        return unique;
    }

    private async presenceByUser(orgId: string, now: Date): Promise<Map<string, Presence>> {
        const rows = await this.prisma.organizationMember.findMany({
            where: { organizationId: orgId, isActive: true },
            select: { userId: true, inboxStatus: true, inboxSeenAt: true },
        });
        return new Map(rows.map((r) => [r.userId, presenceOf(r.inboxStatus, r.inboxSeenAt, now)]));
    }

    private assertManager(viewer: InboxViewer) {
        if (!canManageInbox(viewer)) throw new ForbiddenException('Only owners, admins and managers can change teams.');
    }
}
