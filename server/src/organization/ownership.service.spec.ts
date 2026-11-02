import { BadRequestException, ConflictException, ForbiddenException, ValidationPipe } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { OrganizationController } from './organization.controller';
import { OwnershipService } from './ownership.service';
import { TransferOwnershipDto } from './dto/transfer-ownership.dto';

/**
 * Handing a workspace to an admin: only its owner, only with their password,
 * only to an active admin, both roles swapped together, both cached sessions
 * dropped, and both people told.
 */

const PASSWORD_HASH = bcrypt.hashSync('owner-password', 4);

type Member = {
    id: string;
    userId: string;
    role: UserRole;
    isActive: boolean;
    organization: { name: string; deletedAt: Date | null };
    user: { password: string; email: string; firstName: string; lastName: string; deletedAt: Date | null };
};

const member = (userId: string, role: UserRole, over: Partial<Member> = {}): Member => ({
    id: `m_${userId}`,
    userId,
    role,
    isActive: true,
    organization: { name: 'Acme <Retail>', deletedAt: null },
    user: { password: PASSWORD_HASH, email: `${userId}@test.local`, firstName: userId === 'u_owner' ? 'Asha' : 'Ravi', lastName: 'K', deletedAt: null },
    ...over,
});

function build(members: Member[], counts: { stepDown?: number; stepUp?: number } = {}) {
    const updateMany = jest.fn((args: { where: { role: UserRole } }) =>
        Promise.resolve({ count: args.where.role === UserRole.OWNER ? (counts.stepDown ?? 1) : (counts.stepUp ?? 1) }),
    );
    const prisma = {
        organizationMember: {
            findUnique: jest.fn((args: { where: { organizationId_userId: { userId: string } } }) =>
                Promise.resolve(members.find((m) => m.userId === args.where.organizationId_userId.userId) ?? null),
            ),
        },
        $transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) => fn({ organizationMember: { updateMany } })),
    };
    const redis = { deleteSession: jest.fn(() => Promise.resolve()) };
    const email = { sendOwnershipTransferred: jest.fn(() => Promise.resolve()) };
    const service = new OwnershipService(prisma as never, redis as never, email as never);
    return { service, prisma, updateMany, redis, email };
}

const TO_ADMIN = { newOwnerId: 'u_admin', password: 'owner-password' };

describe('OwnershipService.transfer', () => {
    it('swaps the two roles in one transaction, each from the role it was read with', async () => {
        const { service, prisma, updateMany } = build([member('u_owner', UserRole.OWNER), member('u_admin', UserRole.ADMIN)]);

        await expect(service.transfer('org_1', 'u_owner', TO_ADMIN)).resolves.toEqual({ ownerId: 'u_admin' });

        expect(prisma.$transaction).toHaveBeenCalledTimes(1);
        expect(updateMany.mock.calls).toEqual([
            [{ where: { id: 'm_u_owner', role: UserRole.OWNER, isActive: true }, data: { role: UserRole.ADMIN } }],
            [{ where: { id: 'm_u_admin', role: UserRole.ADMIN, isActive: true }, data: { role: UserRole.OWNER } }],
        ]);
    });

    it("drops both people's cached sessions, as a role change does", async () => {
        const { service, redis } = build([member('u_owner', UserRole.OWNER), member('u_admin', UserRole.ADMIN)]);

        await service.transfer('org_1', 'u_owner', TO_ADMIN);

        expect((redis.deleteSession.mock.calls as unknown as string[][]).map(([userId]) => userId).sort()).toEqual(['u_admin', 'u_owner']);
    });

    it('emails both of them', async () => {
        const { service, email } = build([member('u_owner', UserRole.OWNER), member('u_admin', UserRole.ADMIN)]);

        await service.transfer('org_1', 'u_owner', TO_ADMIN);

        expect(email.sendOwnershipTransferred).toHaveBeenCalledWith({
            orgName: 'Acme <Retail>',
            previous: { email: 'u_owner@test.local', name: 'Asha K' },
            next: { email: 'u_admin@test.local', name: 'Ravi K' },
        });
    });

    it('refuses a wrong password, and changes nothing', async () => {
        const { service, prisma, redis, email } = build([member('u_owner', UserRole.OWNER), member('u_admin', UserRole.ADMIN)]);

        await expect(service.transfer('org_1', 'u_owner', { ...TO_ADMIN, password: 'guess' })).rejects.toThrow(
            new ForbiddenException('That password is not right.'),
        );
        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(redis.deleteSession).not.toHaveBeenCalled();
        expect(email.sendOwnershipTransferred).not.toHaveBeenCalled();
    });

    it.each([
        ['an agent', member('u_admin', UserRole.AGENT)],
        ['a manager', member('u_admin', UserRole.MANAGER)],
        ['a removed admin', member('u_admin', UserRole.ADMIN, { isActive: false })],
        ['an admin whose account was deleted', member('u_admin', UserRole.ADMIN, { user: { ...member('u_admin', UserRole.ADMIN).user, deletedAt: new Date() } })],
    ])('refuses to hand it to %s', async (_who, target) => {
        const { service, prisma } = build([member('u_owner', UserRole.OWNER), target]);

        await expect(service.transfer('org_1', 'u_owner', TO_ADMIN)).rejects.toBeInstanceOf(BadRequestException);
        expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('refuses someone who is not a member at all', async () => {
        const { service } = build([member('u_owner', UserRole.OWNER)]);

        await expect(service.transfer('org_1', 'u_owner', { ...TO_ADMIN, newOwnerId: 'u_stranger' })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses the owner themselves', async () => {
        const { service } = build([member('u_owner', UserRole.OWNER)]);

        await expect(service.transfer('org_1', 'u_owner', { ...TO_ADMIN, newOwnerId: 'u_owner' })).rejects.toThrow(
            new BadRequestException('You already own this workspace.'),
        );
    });

    it('is for the owner only, password or not', async () => {
        const { service, prisma } = build([member('u_other', UserRole.ADMIN), member('u_admin', UserRole.ADMIN)]);

        await expect(service.transfer('org_1', 'u_other', TO_ADMIN)).rejects.toThrow(
            new ForbiddenException('Only the workspace owner can pass ownership on.'),
        );
        expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('is closed in a deleted workspace', async () => {
        const deleted = { name: 'Acme', deletedAt: new Date() };
        const { service } = build([member('u_owner', UserRole.OWNER, { organization: deleted }), member('u_admin', UserRole.ADMIN)]);

        await expect(service.transfer('org_1', 'u_owner', TO_ADMIN)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it.each([
        ['the owner was changed meanwhile', { stepDown: 0 }],
        ['the admin was changed meanwhile', { stepUp: 0 }],
    ])('rolls back when %s, and leaves the sessions and inboxes alone', async (_case, counts) => {
        const { service, redis, email } = build([member('u_owner', UserRole.OWNER), member('u_admin', UserRole.ADMIN)], counts);

        await expect(service.transfer('org_1', 'u_owner', TO_ADMIN)).rejects.toBeInstanceOf(ConflictException);
        expect(redis.deleteSession).not.toHaveBeenCalled();
        expect(email.sendOwnershipTransferred).not.toHaveBeenCalled();
    });
});

describe('POST /organizations/:orgId/transfer-ownership', () => {
    it('hands the owner and the body to the service', async () => {
        const ownership = { transfer: jest.fn(() => Promise.resolve({ ownerId: 'u_admin' })) };
        const controller = new OrganizationController({} as never, {} as never, ownership as never);

        await controller.transferOwnership('org_1', { sub: 'u_owner', email: 'o@test.local' }, TO_ADMIN);

        expect(ownership.transfer).toHaveBeenCalledWith('org_1', 'u_owner', TO_ADMIN);
    });

    it('allows a few tries a minute, so the password cannot be guessed through it', () => {
        const handler = (OrganizationController.prototype as unknown as Record<string, () => unknown>).transferOwnership;
        expect(Reflect.getMetadata('THROTTLER:LIMITdefault', handler)).toBe(5);
        expect(Reflect.getMetadata('THROTTLER:TTLdefault', handler)).toBe(60_000);
    });

    it('refuses a body without the new owner and the password', async () => {
        const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true });
        const metadata = { type: 'body' as const, metatype: TransferOwnershipDto };

        await expect(pipe.transform({}, metadata)).rejects.toBeInstanceOf(BadRequestException);
        await expect(pipe.transform({ newOwnerId: 'u_admin' }, metadata)).rejects.toBeInstanceOf(BadRequestException);
        await expect(pipe.transform(TO_ADMIN, metadata)).resolves.toBeInstanceOf(TransferOwnershipDto);
    });
});
