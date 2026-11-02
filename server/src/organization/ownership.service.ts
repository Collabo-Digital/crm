import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { EmailService } from '../email/email.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { TransferOwnershipDto } from './dto/transfer-ownership.dto';

const fullName = (user: { firstName: string; lastName: string }) => `${user.firstName} ${user.lastName}`.trim();

@Injectable()
export class OwnershipService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly redis: RedisService,
        private readonly email: EmailService,
    ) { }

    /**
     * Hand the workspace to one of its active admins; the owner stays on as an
     * admin. Only the owner may, and a signed-in session is not enough: they
     * type their password, as on sign-in, because the owner alone changes the
     * plan and can delete the workspace.
     *
     * Both roles change in one transaction, each only from the role it was
     * read with, so two transfers at once cannot leave two owners or none.
     * Both cached sessions are then dropped, as a role change does, and both
     * people are told by email.
     */
    async transfer(orgId: string, ownerId: string, dto: TransferOwnershipDto) {
        const owner = await this.prisma.organizationMember.findUnique({
            where: { organizationId_userId: { organizationId: orgId, userId: ownerId } },
            include: {
                organization: { select: { name: true, deletedAt: true } },
                user: { select: { password: true, email: true, firstName: true, lastName: true } },
            },
        });
        if (!owner || !owner.isActive || owner.organization.deletedAt) {
            throw new ForbiddenException('You are not a member of this organization');
        }
        if (owner.role !== UserRole.OWNER) {
            throw new ForbiddenException('Only the workspace owner can pass ownership on.');
        }
        if (!(await bcrypt.compare(dto.password, owner.user.password))) {
            throw new ForbiddenException('That password is not right.');
        }
        if (dto.newOwnerId === ownerId) {
            throw new BadRequestException('You already own this workspace.');
        }

        const next = await this.prisma.organizationMember.findUnique({
            where: { organizationId_userId: { organizationId: orgId, userId: dto.newOwnerId } },
            include: { user: { select: { email: true, firstName: true, lastName: true, deletedAt: true } } },
        });
        if (!next || !next.isActive || next.role !== UserRole.ADMIN || next.user.deletedAt) {
            throw new BadRequestException('Ownership can only go to an active admin of this workspace. Make them an admin first.');
        }

        await this.prisma.$transaction(async (tx) => {
            const stepDown = await tx.organizationMember.updateMany({
                where: { id: owner.id, role: UserRole.OWNER, isActive: true },
                data: { role: UserRole.ADMIN },
            });
            const stepUp = await tx.organizationMember.updateMany({
                where: { id: next.id, role: UserRole.ADMIN, isActive: true },
                data: { role: UserRole.OWNER },
            });
            if (stepDown.count !== 1 || stepUp.count !== 1) {
                throw new ConflictException('The team changed while this was being saved. Reload and try again.');
            }
        });

        // Invalidate both session caches — forces the fresh roles on the next request.
        await Promise.all([this.redis.deleteSession(ownerId), this.redis.deleteSession(dto.newOwnerId)]);

        await this.email.sendOwnershipTransferred({
            orgName: owner.organization.name,
            previous: { email: owner.user.email, name: fullName(owner.user) },
            next: { email: next.user.email, name: fullName(next.user) },
        });

        return { ownerId: dto.newOwnerId };
    }
}
