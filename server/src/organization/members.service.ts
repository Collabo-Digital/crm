import { BadRequestException, Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { extractGrants, sectionGrants, SECTION_SCOPED_ROLES } from '../auth/permissions';
import { ChannelService } from '../channel/channel.service';
import { InboxEventsService } from '../messaging/inbox-events.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { releaseMemberWork } from './member-release';
import { resolveVendorScope } from './vendor-scope';

/** Roles that look after the team, and see each teammate's email, last sign-in and access. */
const SEES_TEAM_DETAILS: UserRole[] = [UserRole.OWNER, UserRole.ADMIN, UserRole.MANAGER];

@Injectable()
export class MembersService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly redis: RedisService,
        private readonly inboxEvents: InboxEventsService,
        private readonly channels: ChannelService,
    ) { }

    // ─── LIST MEMBERS ───
    // Returns all active members with their user profile info.
    // WHY select specific user fields? We never want to expose passwords or 2FA secrets.
    // Agents and viewers get the roster (names, roles, pictures) and their
    // own row in full: teammates' emails and sign-in times are not theirs to
    // collect.
    async findAll(orgId: string, caller: { userId: string; role: UserRole }) {
        const members = await this.prisma.organizationMember.findMany({
            where: { organizationId: orgId, isActive: true },
            include: {
                user: {
                    select: {
                        id: true,
                        email: true,
                        firstName: true,
                        lastName: true,
                        avatarUrl: true,
                        lastLoginAt: true,
                    },
                },
            },
            orderBy: { joinedAt: 'asc' },
        });

        const seesDetails = SEES_TEAM_DETAILS.includes(caller.role);
        return members.map((m) =>
            seesDetails || m.userId === caller.userId
                ? {
                    id: m.id,
                    role: m.role,
                    permissions: extractGrants(m.permissions),
                    joinedAt: m.joinedAt,
                    user: m.user,
                }
                : {
                    id: m.id,
                    role: m.role,
                    joinedAt: m.joinedAt,
                    user: { id: m.user.id, firstName: m.user.firstName, lastName: m.user.lastName, avatarUrl: m.user.avatarUrl },
                },
        );
    }

    // ─── UPDATE ROLE ───
    // WHY protect OWNER? The org creator (OWNER) can never be demoted.
    // WHY prevent assigning OWNER? There can only be one OWNER per org.
    // A VENDOR needs the vendor it supplies, or every request it makes is
    // refused. INFLUENCER is an outside party that joins through its own
    // invite, never a role a team member is moved into.
    async updateRole(orgId: string, memberId: string, role: UserRole, vendorScope?: string) {
        const member = await this.prisma.organizationMember.findFirst({
            where: { id: memberId, organizationId: orgId, isActive: true },
        });

        if (!member) throw new NotFoundException('Member not found');
        if (member.role === UserRole.OWNER) {
            throw new ForbiddenException('Cannot change the role of the organization owner');
        }
        if (role === UserRole.OWNER) {
            throw new ForbiddenException('Cannot assign OWNER role');
        }
        if (role === UserRole.INFLUENCER) {
            throw new BadRequestException('Influencers can only join through an influencer invitation.');
        }
        const scope = role === UserRole.VENDOR ? await resolveVendorScope(this.prisma, orgId, vendorScope) : null;

        const updated = await this.prisma.organizationMember.update({
            where: { id: memberId },
            data: { role, vendorScope: scope },
        });

        // Invalidate session cache — forces fresh role on next request
        await this.redis.deleteSession(member.userId);

        return updated;
    }

    // ─── UPDATE PERMISSIONS ───
    // Fine-grained inventory/report grants (see auth/permissions.ts). Wholesale
    // replace — the team UI always sends the complete grant list. OWNER needs
    // no grants (implicit full access), so editing the owner is pointless but
    // harmless; we forbid it anyway for symmetry with updateRole.
    async updatePermissions(
        orgId: string,
        memberId: string,
        grants: string[],
        preset?: string,
    ) {
        const member = await this.prisma.organizationMember.findFirst({
            where: { id: memberId, organizationId: orgId, isActive: true },
        });

        if (!member) throw new NotFoundException('Member not found');
        if (member.role === UserRole.OWNER) {
            throw new ForbiddenException('The organization owner already has full access');
        }
        // No section at all would read as "not configured" = full access —
        // never what an admin clearing the last checkbox meant.
        if (SECTION_SCOPED_ROLES.includes(member.role) && sectionGrants(grants).length === 0) {
            throw new BadRequestException('Select at least one section this member can access.');
        }

        const updated = await this.prisma.organizationMember.update({
            where: { id: memberId },
            data: { permissions: { grants, ...(preset ? { preset } : {}) } },
        });

        // Same staleness story as role changes — force a fresh session.
        await this.redis.deleteSession(member.userId);

        return updated;
    }

    // ─── REMOVE MEMBER ───
    // WHY isActive=false instead of DELETE? Soft removal preserves:
    // - Their notes/messages and closed conversations still reference them
    // - They can be re-invited later (the row exists but inactive)
    // - Audit trail of who was in the org
    // Their open conversations and inbox team places are released.
    async remove(orgId: string, memberId: string) {
        const member = await this.prisma.organizationMember.findFirst({
            where: { id: memberId, organizationId: orgId, isActive: true },
        });

        if (!member) throw new NotFoundException('Member not found');
        if (member.role === UserRole.OWNER) {
            throw new ForbiddenException('Cannot remove the organization owner');
        }
        // An influencer's Instagram leaves with them. Done first, so a failure
        // leaves them a member and the removal can simply be tried again.
        if (member.role === UserRole.INFLUENCER) {
            await this.channels.disconnectOwnedBy([orgId], member.userId);
        }

        const { removed, released } = await this.prisma.$transaction(async (tx) => ({
            removed: await tx.organizationMember.update({
                where: { id: memberId },
                data: { isActive: false },
            }),
            released: await releaseMemberWork(tx, [orgId], member.userId),
        }));

        // Invalidate session cache — forces membership refresh on next request
        await this.redis.deleteSession(member.userId);
        for (const c of released) {
            this.inboxEvents.publish(orgId, { type: 'conversation.updated', conversationId: c.id });
        }

        return removed;
    }
}