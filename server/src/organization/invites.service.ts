import {
    Injectable,
    ForbiddenException,
    NotFoundException,
    ConflictException,
    BadRequestException,
    Logger,
} from '@nestjs/common';
import { OrganizationType, InviteStatus, UserRole, Prisma } from '@prisma/client';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { SendInviteDto } from './dto/send-invite.dto';
import { EmailService } from '../email/email.service';

/** How long an invitation stays claimable. */
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The status a merchant should SEE, which is not always the status stored.
 *
 * Expiry is a moment passing, not an event anything fires, so a PENDING row
 * whose `expiresAt` is behind us is already expired — nothing will have written
 * EXPIRED to it. Deriving it on read keeps that from being a lie, without a cron
 * job whose absence would make the UI wrong.
 */
export type InviteState = 'PENDING' | 'ACCEPTED' | 'EXPIRED' | 'REVOKED';

export function deriveInviteState(
    invite: { status: InviteStatus; expiresAt: Date },
    now: Date = new Date(),
): InviteState {
    if (invite.status === InviteStatus.PENDING && invite.expiresAt.getTime() <= now.getTime()) {
        return 'EXPIRED';
    }
    return invite.status as InviteState;
}

// WHY invites are in OrganizationModule (not AuthModule)?
// Sending, listing, and revoking invites are org management operations.
// Only the ACCEPTANCE of an invite is in AuthModule (because it creates a user + tokens).
@Injectable()
export class InvitesService {
    private readonly logger = new Logger(InvitesService.name);

    constructor(private readonly prisma: PrismaService, private readonly emailService: EmailService) { }

    // ─── SEND INVITE ───
    async send(orgId: string, userId: string, dto: SendInviteDto) {
        // The DTO already lower-cased and trimmed it; re-derive defensively so a
        // future caller that builds the DTO by hand cannot store a stray casing
        // that would then never match at acceptance.
        const email = dto.email.trim().toLowerCase();

        // 1. Check org type — PERSONAL orgs cannot invite
        // WHY? Personal workspaces are solo. User must create a separate ORGANIZATION first.
        const org = await this.prisma.organization.findUnique({ where: { id: orgId } });
        if (!org) throw new NotFoundException('Organization not found');

        if (org.type === OrganizationType.PERSONAL) {
            throw new ForbiddenException(
                'Personal workspaces cannot have team members. Create an organization first.',
            );
        }

        // 2. Cannot invite as OWNER — there can only be one OWNER
        if (dto.role === UserRole.OWNER) {
            throw new BadRequestException('Cannot invite someone as OWNER');
        }

        // 2b. VENDOR invites must be scoped to a real vendor; non-vendors carry no scope.
        let vendorScope: string | null = null;
        if (dto.role === UserRole.VENDOR) {
            const scope = dto.vendorScope?.trim();
            if (!scope) {
                throw new BadRequestException('A vendor must be selected for VENDOR invites.');
            }
            const hasProducts = await this.prisma.product.findFirst({
                where: {
                    organizationId: orgId,
                    deletedAt: null,
                    OR: [{ vendorKey: scope }, { vendor: scope }],
                },
                select: { id: true },
            });
            if (!hasProducts) {
                throw new BadRequestException(`No products found for vendor "${scope}".`);
            }
            vendorScope = scope;
        }

        // 3. Check if already a member
        const existingUser = await this.prisma.user.findUnique({ where: { email } });
        if (existingUser) {
            const existingMember = await this.prisma.organizationMember.findUnique({
                where: { organizationId_userId: { organizationId: orgId, userId: existingUser.id } },
            });
            if (existingMember?.isActive) {
                throw new ConflictException('This person is already a member of the organization.');
            }
        }

        // 4. Check for an existing live invite.
        //
        // An expired PENDING row does not count: it can no longer be accepted,
        // so refusing to invite over it would leave the address permanently
        // un-invitable. It is retired here so the partial unique index (one
        // PENDING per org+email) has room for the new one.
        const existingInvite = await this.prisma.teamInvite.findFirst({
            where: { organizationId: orgId, email, status: InviteStatus.PENDING },
        });
        if (existingInvite) {
            if (deriveInviteState(existingInvite) === 'EXPIRED') {
                await this.prisma.teamInvite.update({
                    where: { id: existingInvite.id },
                    data: { status: InviteStatus.EXPIRED },
                });
            } else {
                throw new ConflictException(
                    'An invitation has already been sent to this email. Resend it instead.',
                );
            }
        }

        // 5. Create the invite
        const invite = await this.createInviteRow({
            organizationId: orgId,
            email,
            name: dto.name ?? null,
            role: dto.role,
            vendorScope,
            invitedBy: userId,
        });

        await this.deliver(invite, org.name, userId);

        return this.toInviteResponse(invite);
    }

    /**
     * Insert the row, translating the partial unique index into the same
     * conflict the application-level check raises.
     *
     * The check above and this constraint answer the same question; the index is
     * what makes the answer true under a double-submit, where both requests read
     * "no pending invite" before either writes.
     */
    private async createInviteRow(data: {
        organizationId: string;
        email: string;
        name: string | null;
        role: UserRole;
        vendorScope: string | null;
        invitedBy: string;
    }) {
        try {
            return await this.prisma.teamInvite.create({
                data: {
                    ...data,
                    token: randomBytes(32).toString('hex'),
                    expiresAt: new Date(Date.now() + INVITE_TTL_MS),
                },
            });
        } catch (error) {
            if (
                error instanceof Prisma.PrismaClientKnownRequestError &&
                error.code === 'P2002'
            ) {
                throw new ConflictException(
                    'An invitation has already been sent to this email. Resend it instead.',
                );
            }
            throw error;
        }
    }

    /** Send the right email for the invite's role. Never throws. */
    private async deliver(
        invite: { email: string; name: string | null; role: UserRole; token: string; expiresAt: Date },
        orgName: string,
        invitedBy: string,
    ) {
        if (invite.role === UserRole.INFLUENCER) {
            const inviter = await this.prisma.user.findUnique({
                where: { id: invitedBy },
                select: { firstName: true, lastName: true },
            });
            await this.emailService.sendInfluencerInvite({
                email: invite.email,
                inviteeName: invite.name,
                orgName,
                inviterName: inviter ? `${inviter.firstName} ${inviter.lastName}`.trim() : null,
                token: invite.token,
                expiresAt: invite.expiresAt,
            });
            return;
        }
        await this.emailService.sendTeamInvite(invite.email, orgName, invite.token);
    }

    private toInviteResponse(invite: {
        id: string;
        email: string;
        name: string | null;
        role: UserRole;
        vendorScope: string | null;
        status: InviteStatus;
        expiresAt: Date;
        createdAt: Date;
    }) {
        return {
            id: invite.id,
            email: invite.email,
            name: invite.name,
            role: invite.role,
            vendorScope: invite.vendorScope,
            status: deriveInviteState(invite),
            expiresAt: invite.expiresAt,
            createdAt: invite.createdAt,
        };
    }

    // ─── LIST PENDING INVITES ───
    async findAllPending(orgId: string) {
        const invites = await this.prisma.teamInvite.findMany({
            where: { organizationId: orgId, status: InviteStatus.PENDING },
            orderBy: { createdAt: 'desc' },
            select: {
                id: true, email: true, name: true, role: true, vendorScope: true,
                status: true, invitedBy: true, expiresAt: true, createdAt: true,
            },
        });
        // Deliberately still returns rows that have lapsed, carrying status
        // 'EXPIRED' — the team UI must be able to show and re-send them.
        return invites.map((invite) => ({
            ...this.toInviteResponse(invite),
            invitedBy: invite.invitedBy,
        }));
    }

    // ─── RESEND ───
    /**
     * Re-issue a pending invitation: a NEW token, a fresh expiry, another email.
     *
     * Rotating the token is the point — the old link stops working the moment a
     * new one is sent, so a forwarded or leaked link cannot outlive the resend.
     * The row is reused, so this never creates a second membership or a second
     * live invitation.
     */
    async resend(orgId: string, inviteId: string, userId: string) {
        const invite = await this.prisma.teamInvite.findFirst({
            where: { id: inviteId, organizationId: orgId },
            include: { organization: { select: { name: true } } },
        });
        if (!invite) throw new NotFoundException('Invitation not found');
        if (invite.status === InviteStatus.ACCEPTED) {
            throw new ConflictException('This invitation has already been accepted.');
        }

        const updated = await this.prisma.teamInvite.update({
            where: { id: invite.id },
            data: {
                token: randomBytes(32).toString('hex'),
                expiresAt: new Date(Date.now() + INVITE_TTL_MS),
                // A cancelled or lapsed invitation becomes live again rather than
                // forcing the admin to delete and retype it.
                status: InviteStatus.PENDING,
                revokedAt: null,
            },
        });

        await this.deliver(updated, invite.organization.name, userId);
        return this.toInviteResponse(updated);
    }

    // ─── REVOKE INVITE ───
    // Changes status from PENDING to REVOKED. The token becomes invalid.
    async revoke(orgId: string, inviteId: string) {
        const invite = await this.prisma.teamInvite.findFirst({
            where: { id: inviteId, organizationId: orgId, status: InviteStatus.PENDING },
        });
        if (!invite) throw new NotFoundException('Invitation not found');

        const updated = await this.prisma.teamInvite.update({
            where: { id: inviteId },
            data: { status: InviteStatus.REVOKED, revokedAt: new Date() },
        });
        return this.toInviteResponse(updated);
    }

    // ─── INFLUENCERS ───

    /**
     * One list of everyone invited as an influencer, joined or not.
     *
     * Two sources, because an influencer is one of two things: an accepted
     * invitation that became a membership, or an invitation still in flight.
     * The UI shows them in a single table, so the join happens here rather than
     * leaving the client to stitch two endpoints together and guess at ordering.
     *
     * The Instagram column comes from the CHANNEL system — `Channel.ownerUserId`
     * — not from a second copy of the connection kept for display.
     */
    async listInfluencers(orgId: string) {
        const [members, invites] = await Promise.all([
            this.prisma.organizationMember.findMany({
                where: { organizationId: orgId, role: UserRole.INFLUENCER, isActive: true },
                orderBy: { joinedAt: 'desc' },
                select: {
                    id: true,
                    joinedAt: true,
                    permissions: true,
                    user: {
                        select: { id: true, email: true, firstName: true, lastName: true, avatarUrl: true },
                    },
                },
            }),
            this.prisma.teamInvite.findMany({
                where: { organizationId: orgId, role: UserRole.INFLUENCER },
                orderBy: { createdAt: 'desc' },
                select: {
                    id: true, email: true, name: true, role: true, vendorScope: true,
                    status: true, expiresAt: true, createdAt: true, acceptedUserId: true,
                },
            }),
        ]);

        const memberUserIds = members.map((m) => m.user.id);
        const channels = memberUserIds.length
            ? await this.prisma.channel.findMany({
                where: {
                    organizationId: orgId,
                    ownerUserId: { in: memberUserIds },
                },
                select: {
                    id: true, platform: true, name: true, status: true,
                    externalStoreId: true, externalStoreUrl: true,
                    connectedAt: true, ownerUserId: true, credentials: true, metadata: true,
                },
            })
            : [];

        const joined = members.map((member) => {
            const owned = channels.filter((c) => c.ownerUserId === member.user.id);
            // The invitation that produced this membership, for "invited on".
            const source = invites.find(
                (i) => i.acceptedUserId === member.user.id || i.email === member.user.email,
            );
            return {
                kind: 'MEMBER' as const,
                memberId: member.id,
                inviteId: source?.id ?? null,
                userId: member.user.id,
                email: member.user.email,
                name: `${member.user.firstName} ${member.user.lastName}`.trim(),
                avatarUrl: member.user.avatarUrl,
                status: 'ACTIVE' as const,
                invitedAt: source?.createdAt ?? member.joinedAt,
                joinedAt: member.joinedAt,
                channels: owned.map((c) => ({
                    id: c.id,
                    platform: c.platform,
                    name: c.name,
                    status: c.status,
                    externalStoreId: c.externalStoreId,
                    externalStoreUrl: c.externalStoreUrl,
                    connectedAt: c.connectedAt,
                })),
            };
        });

        const claimedEmails = new Set(members.map((m) => m.user.email));
        const outstanding = invites
            .filter((i) => i.status !== InviteStatus.ACCEPTED && !claimedEmails.has(i.email))
            .map((invite) => ({
                kind: 'INVITE' as const,
                memberId: null,
                inviteId: invite.id,
                userId: null,
                email: invite.email,
                name: invite.name,
                avatarUrl: null,
                status: deriveInviteState(invite),
                invitedAt: invite.createdAt,
                joinedAt: null,
                expiresAt: invite.expiresAt,
                channels: [] as never[],
            }));

        // Newest first across both kinds, so the row an admin just created is at
        // the top whichever kind it is.
        return [...joined, ...outstanding].sort(
            (a, b) => new Date(b.invitedAt).getTime() - new Date(a.invitedAt).getTime(),
        );
    }
}
