import { Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { randomInt } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { ACTIVE_MEMBERSHIP } from '../auth/active-membership';
import { normalizeEmail } from '../common/utils/email.util';
import { releaseMemberWork } from '../organization/member-release';

@Injectable()
export class UserService {
  constructor(private readonly prisma: PrismaService) { }

  async create(data: { email: string; password: string; firstName: string; lastName: string; avatarUrl?: string }) {
    const email = normalizeEmail(data.email);
    if (await this.findIdByEmail(email)) throw new ConflictException('Email already registered');

    const passwordHash = await bcrypt.hash(data.password, 12);
    const emailVerifyCode = randomInt(100000, 1000000).toString();
    const emailVerifyExpires = new Date(Date.now() + 10 * 60 * 1000);

    return this.prisma.user.create({
      data: {
        email,
        password: passwordHash,
        firstName: data.firstName,
        lastName: data.lastName,
        avatarUrl: data.avatarUrl,
        emailVerifyCode,
        emailVerifyExpires,
      },
    });
  }

  /**
   * The account for an address, whatever its case. New accounts are stored
   * lower-cased, but older ones kept the casing typed at signup and the
   * unique index on `email` is case-sensitive. Plain SQL rather than Prisma's
   * `mode: 'insensitive'`, which compares with ILIKE and would read `_` and
   * `%` in an address as wildcards.
   */
  async findIdByEmail(email: string): Promise<string | null> {
    const normalized = normalizeEmail(email);
    const exact = await this.prisma.user.findUnique({ where: { email: normalized }, select: { id: true } });
    if (exact) return exact.id;
    const [row] = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM users WHERE lower(email) = ${normalized} ORDER BY created_at ASC LIMIT 1`;
    return row?.id ?? null;
  }

  async findByEmail(email: string) {
    const id = await this.findIdByEmail(email);
    return id ? this.findById(id) : null;
  }

  async findById(id: string) {
    return this.prisma.user.findUnique({ where: { id } });
  }

  async findByIdWithMemberships(id: string) {
    return this.prisma.user.findUnique({
      where: { id },
      include: { memberships: { where: ACTIVE_MEMBERSHIP, orderBy: { createdAt: 'asc' }, include: { organization: true } } },
    });
  }

  async update(id: string, data: { firstName?: string; lastName?: string; avatarUrl?: string }) {
    return this.prisma.user.update({ where: { id }, data });
  }

  async verifyEmail(userId: string, code: string) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, emailVerifyCode: code, emailVerifyExpires: { gt: new Date() }, emailVerified: false },
    });
    if (!user) throw new NotFoundException('Invalid or expired verification token');

    return this.prisma.user.update({
      where: { id: user.id },
      data: { emailVerified: true, emailVerifiedAt: new Date(), emailVerifyCode: null, emailVerifyExpires: null },
    });
  }

  async regenerateVerifyCode(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.emailVerified) return null;

    const emailVerifyCode = randomInt(100000, 1000000).toString();
    const emailVerifyExpires = new Date(Date.now() + 10 * 60 * 1000);

    return this.prisma.user.update({
      where: { id: user.id },
      data: { emailVerifyCode, emailVerifyExpires },
    });
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    const isValid = await bcrypt.compare(currentPassword, user.password);
    if (!isValid) throw new ConflictException('Current password is incorrect');

    return this.prisma.user.update({
      where: { id: userId },
      data: { password: await bcrypt.hash(newPassword, 12) },
    });
  }

  /**
   * Close an account. Refused while it owns a live workspace: there is no
   * ownership transfer, so the workspace would be left running with nobody
   * able to manage or delete it. Its memberships end (releasing their
   * conversations), and the address is freed so it can sign up again.
   */
  async softDelete(id: string) {
    const owned = await this.prisma.organizationMember.findFirst({
      where: { userId: id, role: UserRole.OWNER, ...ACTIVE_MEMBERSHIP },
      select: { organization: { select: { name: true } } },
    });
    if (owned) {
      throw new ConflictException(
        `You own the workspace "${owned.organization.name}". Delete that workspace in Settings first, then delete your account.`,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const memberships = await tx.organizationMember.findMany({
        where: { userId: id, isActive: true },
        select: { organizationId: true },
      });
      await tx.organizationMember.updateMany({ where: { userId: id, isActive: true }, data: { isActive: false } });
      await releaseMemberWork(tx, memberships.map((m) => m.organizationId), id);
      return tx.user.update({
        where: { id },
        data: { deletedAt: new Date(), email: `deleted+${id}@deleted.invalid` },
      });
    });
  }
}