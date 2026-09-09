import {
  Injectable,
  UnauthorizedException,
  ForbiddenException,
  NotFoundException,
  BadRequestException,
  Logger,
  HttpException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import { InviteStatus } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { UserService } from '../user/user.service';
import { JwtPayload, TokenPair } from './interfaces/jwt-payload.interface';
import { defaultGrantsForRole } from './permissions';
import { SignupDto } from './dto/signup.dto';
import { LoginDto } from './dto/login.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { AcceptInviteDto } from './dto/accept-invite.dto';
import { EmailService } from '../email/email.service';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly refreshExpires: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly userService: UserService,
    private readonly emailService: EmailService,
    private readonly redis: RedisService,
  ) {
    this.refreshExpires = this.config.get<string>('jwt.refreshExpires') || '7d';
  }

  // ─── AUTH FLOWS ───

  async signup(dto: SignupDto) {
    const user = await this.userService.create({
      email: dto.email,
      password: dto.password,
      firstName: dto.firstName,
      lastName: dto.lastName,
      avatarUrl: dto.avatarUrl,
    });

    // TODO: Send verification email via Resend
    await this.emailService.sendVerificationCode(user.email, user.emailVerifyCode as string);

    return {
      userId: user.id,
      email: user.email,
      verifyCode: user.emailVerifyCode as string,
      message: 'Verification code sent to your email.',
      nextStep: 'verify-email',
    };
  }

  async verifyEmail(userId: string, code: string) {
    const user = await this.userService.verifyEmail(userId, code);

    // Pull a typed row so the super-admin flag has the right type without any casts.
    const fullUser = await this.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { id: true, email: true, isSuperAdmin: true },
    });
    await this.syncSuperAdminFlag(fullUser);
    const isSuperAdmin = fullUser.isSuperAdmin;

    const userWithMemberships = await this.userService.findByIdWithMemberships(user.id);
    const membership = userWithMemberships?.memberships[0];

    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      orgId: membership?.organizationId,
      role: membership?.role,
      isSuperAdmin,
    };

    const tokens = await this.generateTokenPair(payload);

    const hasOrgs = (userWithMemberships?.memberships.length ?? 0) > 0;

    return {
      ...tokens,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        avatarUrl: user.avatarUrl,
        emailVerified: true,
        isSuperAdmin,
      },
      organizations: (userWithMemberships?.memberships ?? []).map((m) => ({
        id: m.organization.id,
        name: m.organization.name,
        slug: m.organization.slug,
        type: m.organization.type,
        role: m.role,
        vendorScope: m.vendorScope ?? undefined,
      })),
      nextStep: hasOrgs ? null : 'choose-plan',
      message: 'Email verified successfully.',
    };
  }

  async resendVerification(userId: string) {
    const user = await this.userService.regenerateVerifyCode(userId);
    if (user) {
      await this.emailService.sendVerificationCode(user.email, user.emailVerifyCode as string);
    }
    return {
      message: 'Verification code sent.|',
      nextStep: 'verify-email',
      code: user?.emailVerifyCode,
    };
  }

  async login(dto: LoginDto, userAgent?: string, ipAddress?: string) {
    // Rate limit check — block after 5 failed attempts per email
    const attempts = await this.redis.getLoginAttempts(dto.email);
    if (this.redis.isLoginBlocked(attempts)) {
      throw new UnauthorizedException('Too many failed login attempts. Please try again in 15 minutes.');
    }

    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
      include: {
        memberships: { where: { isActive: true }, include: { organization: true } },
      },
    });

    if (!user || user.deletedAt) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const isValid = await bcrypt.compare(dto.password, user.password);
    if (!isValid) {
      await this.redis.incrementLoginAttempts(dto.email);
      throw new UnauthorizedException('Invalid email or password');
    }

    // CHANGED: include userId in error so frontend can redirect to OTP page
    if (!user.emailVerified) {
      // Resend OTP automatically 
      const updatedUser = await this.userService.regenerateVerifyCode(user.id);
      if (updatedUser) {
        await this.emailService.sendVerificationCode(user.email, updatedUser.emailVerifyCode!);
      }

      throw new HttpException(
        {
          statusCode: 403,
          message: 'Please verify your email before logging in',
          userId: user.id,
          nextStep: 'verify-email',
        },
        403,
      );
    }

    if (user.twoFactorEnabled) {
      if (!dto.totpCode) {
        throw new ForbiddenException('Two-factor authentication code required');
      }
      // TODO: Validate TOTP
    }

    // Reset rate limit on successful login
    await this.redis.resetLoginAttempts(dto.email);

    // Sync the Collabo-team super-admin flag against the env allowlist before issuing a token.
    await this.syncSuperAdminFlag(user);

    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

    const membership = user.memberships[0];
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      orgId: membership?.organizationId,
      role: membership?.role,
      isSuperAdmin: user.isSuperAdmin,
    };

    const tokens = await this.generateTokenPair(payload);

    // Cache session in Redis
    await this.redis.setSession(user.id, {
      sub: user.id, email: user.email,
      orgId: membership?.organizationId, role: membership?.role,
      vendorScope: membership?.vendorScope ?? undefined,
      emailVerified: user.emailVerified,
      memberships: user.memberships.map((m) => ({ orgId: m.organizationId, role: m.role, vendorScope: m.vendorScope ?? undefined })),
      isSuperAdmin: user.isSuperAdmin,
    });

    return {
      ...tokens,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        avatarUrl: user.avatarUrl,
        emailVerified: user.emailVerified,
        twoFactorEnabled: user.twoFactorEnabled,
        isSuperAdmin: user.isSuperAdmin,
      },
      organizations: user.memberships.map((m) => ({
        id: m.organization.id,
        name: m.organization.name,
        slug: m.organization.slug,
        type: m.organization.type,
        role: m.role,
        vendorScope: m.vendorScope ?? undefined,
      })),
      nextStep: user.memberships.length === 0 ? 'choose-plan' : null,
    };
  }

  async switchOrg(userId: string, orgId: string) {
    // Verify user is an active member of this org
    const membership = await this.prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId: orgId, userId } },
      include: { organization: true },
    });

    if (!membership || !membership.isActive) {
      throw new ForbiddenException('You are not a member of this organization');
    }

    if (membership.organization.deletedAt) {
      throw new ForbiddenException('This organization has been deleted');
    }

    // Get user info + all memberships
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { memberships: { where: { isActive: true }, include: { organization: true } } },
    });

    if (!user) throw new NotFoundException('User not found');

    // Generate new JWT scoped to the selected org
    const payload: JwtPayload = {
      sub: userId,
      email: user.email,
      orgId: membership.organizationId,
      role: membership.role,
      isSuperAdmin: user.isSuperAdmin,
    };

    const tokens = await this.generateTokenPair(payload);

    // Update session cache with new orgId
    await this.redis.setSession(userId, {
      sub: userId, email: user.email,
      orgId: membership.organizationId, role: membership.role,
      vendorScope: membership.vendorScope ?? undefined,
      emailVerified: user.emailVerified,
      memberships: user.memberships.map((m) => ({ orgId: m.organizationId, role: m.role, vendorScope: m.vendorScope ?? undefined })),
      isSuperAdmin: user.isSuperAdmin,
    });

    return {
      ...tokens,
      currentOrganization: {
        id: membership.organization.id,
        name: membership.organization.name,
        slug: membership.organization.slug,
        type: membership.organization.type,
        role: membership.role,
      },
      organizations: user.memberships.map((m) => ({
        id: m.organization.id,
        name: m.organization.name,
        slug: m.organization.slug,
        type: m.organization.type,
        role: m.role,
        vendorScope: m.vendorScope ?? undefined,
      })),
    };
  }

  async refresh(refreshToken: string, userAgent?: string, ipAddress?: string) {
    return this.rotateRefreshToken(refreshToken, userAgent, ipAddress);
  }

  async logout(refreshToken: string) {
    await this.revokeRefreshToken(refreshToken);
    return { message: 'Logged out successfully' };
  }

  async forgotPassword(email: string) {
    const user = await this.userService.findByEmail(email);
    if (user && !user.deletedAt) {
      const token = randomBytes(32).toString('hex');
      await this.prisma.passwordResetToken.create({
        data: { userId: user.id, token, expiresAt: new Date(Date.now() + 3600000) },
      });
      console.log('token', token);
      await this.emailService.sendPasswordResetLink(email, token);
    }
    return { message: 'If an account exists with this email, a reset link has been sent to your email.' };
  }

  async resetPassword(dto: ResetPasswordDto) {
    const resetToken = await this.prisma.passwordResetToken.findFirst({
      where: { token: dto.token, usedAt: null, expiresAt: { gt: new Date() } },
    });
    if (!resetToken) throw new NotFoundException('Invalid or expired reset token');

    const hash = await bcrypt.hash(dto.newPassword, 12);
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: resetToken.userId }, data: { password: hash } }),
      this.prisma.passwordResetToken.update({ where: { id: resetToken.id }, data: { usedAt: new Date() } }),
    ]);
    await this.revokeAllUserTokens(resetToken.userId);
    return { message: 'Password reset successfully. Please log in with your new password.' };
  }

  // ─── INVITE ACCEPTANCE ───

  async getInviteByToken(token: string) {
    const invite = await this.prisma.teamInvite.findUnique({
      where: { token },
      include: { organization: { select: { id: true, name: true, slug: true, logo: true } } },
    });
    if (!invite) throw new NotFoundException('Invitation not found');
    if (invite.status !== InviteStatus.PENDING) {
      throw new BadRequestException(
        invite.status === InviteStatus.ACCEPTED
          ? 'This invitation has already been used.'
          : `This invitation has been ${invite.status.toLowerCase()}.`,
      );
    }
    if (invite.expiresAt < new Date()) throw new BadRequestException('This invitation has expired.');

    const userExists = !!(await this.userService.findByEmail(invite.email));
    return {
      email: invite.email,
      name: invite.name,
      role: invite.role,
      vendorScope: invite.vendorScope,
      organization: invite.organization,
      userExists,
      expiresAt: invite.expiresAt,
    };
  }

  /**
   * Claim an invitation.
   *
   * `callerUserId` is the authenticated user, when there is one — this endpoint
   * is `@Public()` because a brand-new person must be able to reach it, so the
   * caller is resolved from the header rather than by a guard.
   *
   * It is also what closes a real hole: previously, ANY holder of the token
   * could accept an invitation addressed to an existing account, which silently
   * joined that person's account to an organization they had never heard of. A
   * forwarded invitation email was enough. Now an invitation to an address that
   * already has an account can only be claimed while signed in as that account.
   */
  async acceptInvite(dto: AcceptInviteDto, callerUserId?: string) {
    const invite = await this.prisma.teamInvite.findUnique({
      where: { token: dto.token },
      include: { organization: true },
    });
    if (!invite) throw new NotFoundException('Invitation not found');
    if (invite.status !== InviteStatus.PENDING) {
      throw new BadRequestException(
        invite.status === InviteStatus.ACCEPTED
          ? 'This invitation has already been used.'
          : `This invitation has been ${invite.status.toLowerCase()}.`,
      );
    }
    if (invite.expiresAt < new Date()) throw new BadRequestException('This invitation has expired.');

    let user = await this.userService.findByEmail(invite.email);

    // Whoever is signed in must be the person the invitation names. Being
    // signed in as someone else is the confusing case, so it is named plainly
    // rather than silently creating a second account or joining the wrong one.
    if (callerUserId) {
      const caller = await this.prisma.user.findUnique({
        where: { id: callerUserId },
        select: { id: true, email: true },
      });
      if (caller && caller.email !== invite.email) {
        throw new ForbiddenException(
          `This invitation was sent to ${invite.email}. You are signed in as ${caller.email}. Sign out and open the invitation link again.`,
        );
      }
    } else if (user) {
      // The address already has an account, and nobody is signed in. Proving
      // ownership of that account is the price of joining it to an org.
      throw new UnauthorizedException(
        `An account already exists for ${invite.email}. Sign in to accept this invitation.`,
      );
    }

    if (!user) {
      if (!dto.password || !dto.firstName || !dto.lastName) {
        throw new BadRequestException('firstName, lastName, and password are required for new users');
      }
      user = await this.userService.create({
        email: invite.email, password: dto.password, firstName: dto.firstName, lastName: dto.lastName,
      });
      // Holding the emailed token IS proof of address ownership, so there is
      // nothing left for a verification code to establish.
      await this.prisma.user.update({
        where: { id: user.id },
        data: { emailVerified: true, emailVerifiedAt: new Date(), emailVerifyCode: null, emailVerifyExpires: null },
      });
    }

    // Upsert, not create: removal from an organization is a soft `isActive:
    // false`, so a returning member already has a row and `create` threw P2002
    // — which made re-inviting anyone who had ever been removed impossible.
    // Re-joining also re-seeds the role's default grants, so a returning
    // influencer is not left with a stale permission set.
    await this.prisma.organizationMember.upsert({
      where: {
        organizationId_userId: { organizationId: invite.organizationId, userId: user.id },
      },
      create: {
        organizationId: invite.organizationId,
        userId: user.id,
        role: invite.role,
        vendorScope: invite.vendorScope,
        permissions: { grants: defaultGrantsForRole(invite.role) },
      },
      update: {
        role: invite.role,
        vendorScope: invite.vendorScope,
        isActive: true,
        permissions: { grants: defaultGrantsForRole(invite.role) },
      },
    });

    await this.prisma.teamInvite.update({
      where: { id: invite.id },
      // acceptedUserId is what ties the invitation to the account that claimed
      // it — the influencer list joins on it, and the invited address alone
      // could not answer "who actually joined".
      data: {
        status: InviteStatus.ACCEPTED,
        acceptedAt: new Date(),
        acceptedUserId: user.id,
      },
    });

    // Invalidate session cache — stale orgId/memberships need to refresh
    await this.redis.deleteSession(user.id);

    const payload: JwtPayload = { sub: user.id, email: user.email, orgId: invite.organizationId, role: invite.role };
    const tokens = await this.generateTokenPair(payload);

    return {
      ...tokens,
      user: { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName },
      // The role travels with the response so the client can put the correct
      // one in its store; it used to assume AGENT and get every later role
      // check wrong until the next full reload.
      role: invite.role,
      organization: { id: invite.organization.id, name: invite.organization.name, slug: invite.organization.slug },
    };
  }

  /**
   * The user id inside a Bearer token, or undefined.
   *
   * Used only by the public invite-accept route, which must behave differently
   * for a signed-in caller but cannot use a guard to find one. An invalid or
   * expired token is treated as "not signed in" rather than an error: the
   * request is still a legitimate attempt to accept an invitation.
   */
  verifyAccessTokenSubject(authorization?: string): string | undefined {
    const raw = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : null;
    if (!raw) return undefined;
    try {
      return this.jwt.verify<JwtPayload>(raw).sub;
    } catch {
      return undefined;
    }
  }

  // ─── TOKEN MANAGEMENT ───

  async generateTokenPair(payload: JwtPayload): Promise<TokenPair> {
    const accessToken = this.jwt.sign(payload);
    const refreshToken = await this.createRefreshToken(payload.sub);
    return { accessToken, refreshToken };
  }

  async createRefreshToken(userId: string, userAgent?: string, ipAddress?: string): Promise<string> {
    const token = randomBytes(40).toString('hex');

    // Primary: Redis with auto-expiry TTL
    await this.redis.setRefreshToken(token, { userId, userAgent, ipAddress, createdAt: new Date().toISOString() });
    await this.redis.trackUserToken(userId, token);

    // Audit trail: DB (fire-and-forget, don't block)
    const expiresAt = this.calculateExpiry(this.refreshExpires);
    this.prisma.refreshToken.create({ data: { userId, token, userAgent, ipAddress, expiresAt } }).catch(() => { });

    return token;
  }

  async rotateRefreshToken(oldToken: string, userAgent?: string, ipAddress?: string): Promise<TokenPair> {
    // Look up in Redis (fast)
    const tokenData = await this.redis.getRefreshToken<{ userId: string }>(oldToken);
    if (!tokenData) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: tokenData.userId },
      include: { memberships: { where: { isActive: true }, take: 1 } },
    });
    if (!user || user.deletedAt) throw new UnauthorizedException('Account has been deactivated');

    // Revoke old token in Redis
    await this.redis.deleteRefreshToken(oldToken);

    // Audit trail (fire-and-forget)
    this.prisma.refreshToken.updateMany({ where: { token: oldToken, revokedAt: null }, data: { revokedAt: new Date() } }).catch(() => { });

    const membership = user.memberships[0];
    const payload: JwtPayload = {
      sub: user.id, email: user.email,
      orgId: membership?.organizationId, role: membership?.role,
      isSuperAdmin: user.isSuperAdmin,
    };

    const accessToken = this.jwt.sign(payload);
    const refreshToken = await this.createRefreshToken(user.id, userAgent, ipAddress);

    // Refresh session cache
    await this.redis.setSession(user.id, {
      sub: user.id, email: user.email,
      orgId: membership?.organizationId, role: membership?.role,
      vendorScope: membership?.vendorScope ?? undefined,
      emailVerified: user.emailVerified,
      memberships: user.memberships.map((m) => ({ orgId: m.organizationId, role: m.role, vendorScope: m.vendorScope ?? undefined })),
      isSuperAdmin: user.isSuperAdmin,
    });

    return { accessToken, refreshToken };
  }

  async revokeRefreshToken(token: string): Promise<void> {
    await this.redis.deleteRefreshToken(token);
    // Audit trail (fire-and-forget)
    this.prisma.refreshToken.updateMany({ where: { token, revokedAt: null }, data: { revokedAt: new Date() } }).catch(() => { });
  }

  async revokeAllUserTokens(userId: string): Promise<void> {
    await this.redis.deleteAllUserTokens(userId);
    await this.redis.deleteSession(userId);
    // Audit trail (fire-and-forget)
    this.prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } }).catch(() => { });
  }

  private calculateExpiry(duration: string): Date {
    const now = new Date();
    const match = duration.match(/^(\d+)([smhd])$/);
    if (!match) return new Date(now.getTime() + 7 * 86400000);
    const value = parseInt(match[1], 10);
    const ms = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[match[2]]!;
    return new Date(now.getTime() + value * ms);
  }

  // ─── SUPER ADMIN + IMPERSONATION ───

  /**
   * Compare the user's email against the SUPER_ADMIN_EMAILS env allowlist and
   * flip `User.isSuperAdmin` if they disagree. Called on login/verifyEmail so
   * adding/removing someone from the allowlist just requires them to log in
   * again (or be force-logged-out) for the flag to sync.
   *
   * Mutates the passed-in object so callers can use the refreshed value without
   * a reload.
   */
  private async syncSuperAdminFlag(
    user: { id: string; email: string; isSuperAdmin: boolean },
  ): Promise<void> {
    const allow = this.config.get<string[]>('superAdminEmails') || [];
    const shouldBe = allow.includes(user.email.toLowerCase());
    if (shouldBe !== user.isSuperAdmin) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { isSuperAdmin: shouldBe },
      });
      user.isSuperAdmin = shouldBe;
    }
  }

  /**
   * Issue an impersonation token pair: the super admin temporarily becomes the
   * target user. The resulting JWT carries `isSuperAdmin: false` + `impersonatedBy`
   * so guards treat the caller as the target user, but the client can still show
   * a banner / offer an exit button.
   */
  async startImpersonation(
    superAdminId: string,
    targetUserId: string,
    targetOrgId: string | undefined,
    userAgent?: string,
    ipAddress?: string,
  ) {
    const superAdmin = await this.prisma.user.findUnique({ where: { id: superAdminId } });
    if (!superAdmin?.isSuperAdmin) {
      throw new ForbiddenException('Only super admins can impersonate users');
    }
    if (superAdmin.id === targetUserId) {
      throw new BadRequestException('Cannot impersonate yourself');
    }

    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      include: { memberships: { where: { isActive: true }, include: { organization: true } } },
    });
    if (!target || target.deletedAt) throw new NotFoundException('User not found');
    if (target.isSuperAdmin) {
      throw new BadRequestException('Cannot impersonate another super admin');
    }

    const membership =
      (targetOrgId && target.memberships.find((m) => m.organizationId === targetOrgId)) ||
      target.memberships[0];

    const payload: JwtPayload = {
      sub: target.id,
      email: target.email,
      orgId: membership?.organizationId,
      role: membership?.role,
      isSuperAdmin: false,
      impersonatedBy: superAdminId,
    };

    const tokens = await this.generateTokenPair(payload);

    await this.redis.setSession(target.id, {
      sub: target.id,
      email: target.email,
      orgId: membership?.organizationId,
      role: membership?.role,
      vendorScope: membership?.vendorScope ?? undefined,
      emailVerified: target.emailVerified,
      memberships: target.memberships.map((m) => ({ orgId: m.organizationId, role: m.role, vendorScope: m.vendorScope ?? undefined })),
      isSuperAdmin: false,
      impersonatedBy: superAdminId,
    });

    // Write audit row (best-effort — don't block token issue on audit failures).
    this.prisma.impersonationLog
      .create({
        data: {
          superAdminId,
          targetUserId: target.id,
          targetOrgId: membership?.organizationId,
          userAgent,
          ipAddress,
        },
      })
      .catch((err) => this.logger.error('Failed to write impersonation log', err));

    return {
      ...tokens,
      user: {
        id: target.id,
        email: target.email,
        firstName: target.firstName,
        lastName: target.lastName,
        avatarUrl: target.avatarUrl,
        emailVerified: target.emailVerified,
        twoFactorEnabled: target.twoFactorEnabled,
        isSuperAdmin: false,
      },
      organizations: target.memberships.map((m) => ({
        id: m.organization.id,
        name: m.organization.name,
        slug: m.organization.slug,
        type: m.organization.type,
        role: m.role,
        vendorScope: m.vendorScope ?? undefined,
      })),
      currentOrganization: membership
        ? {
            id: membership.organization.id,
            name: membership.organization.name,
            slug: membership.organization.slug,
            type: membership.organization.type,
            role: membership.role,
          }
        : null,
      impersonatedBy: superAdminId,
    };
  }

  /**
   * Terminate an impersonation session and restore the super admin's own token.
   * Called with the super admin's user ID (read from the caller's `impersonatedBy`
   * claim by the controller).
   */
  async stopImpersonation(impersonatedByUserId: string) {
    const superAdmin = await this.prisma.user.findUnique({
      where: { id: impersonatedByUserId },
      include: { memberships: { where: { isActive: true }, include: { organization: true } } },
    });
    if (!superAdmin?.isSuperAdmin) {
      throw new ForbiddenException('Impersonation can only be stopped by a super admin');
    }

    // Close any open log rows for this super admin (there should be exactly one).
    await this.prisma.impersonationLog.updateMany({
      where: { superAdminId: superAdmin.id, endedAt: null },
      data: { endedAt: new Date() },
    });

    const membership = superAdmin.memberships[0];
    const payload: JwtPayload = {
      sub: superAdmin.id,
      email: superAdmin.email,
      orgId: membership?.organizationId,
      role: membership?.role,
      isSuperAdmin: true,
    };

    const tokens = await this.generateTokenPair(payload);

    await this.redis.setSession(superAdmin.id, {
      sub: superAdmin.id,
      email: superAdmin.email,
      orgId: membership?.organizationId,
      role: membership?.role,
      emailVerified: superAdmin.emailVerified,
      memberships: superAdmin.memberships.map((m) => ({ orgId: m.organizationId, role: m.role })),
      isSuperAdmin: true,
    });

    return {
      ...tokens,
      user: {
        id: superAdmin.id,
        email: superAdmin.email,
        firstName: superAdmin.firstName,
        lastName: superAdmin.lastName,
        avatarUrl: superAdmin.avatarUrl,
        emailVerified: superAdmin.emailVerified,
        twoFactorEnabled: superAdmin.twoFactorEnabled,
        isSuperAdmin: true,
      },
      organizations: superAdmin.memberships.map((m) => ({
        id: m.organization.id,
        name: m.organization.name,
        slug: m.organization.slug,
        type: m.organization.type,
        role: m.role,
        vendorScope: m.vendorScope ?? undefined,
      })),
      currentOrganization: membership
        ? {
            id: membership.organization.id,
            name: membership.organization.name,
            slug: membership.organization.slug,
            type: membership.organization.type,
            role: membership.role,
          }
        : null,
    };
  }
}