import {
  Injectable,
  UnauthorizedException,
  ForbiddenException,
  NotFoundException,
  BadRequestException,
  Logger,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { createHash, randomBytes } from 'crypto';
import { InviteStatus, Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { UserService } from '../user/user.service';
import { JwtPayload, TokenPair } from './interfaces/jwt-payload.interface';
import { defaultGrantsForRole, extractGrants } from './permissions';
import { SignupDto } from './dto/signup.dto';
import { LoginDto } from './dto/login.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { AcceptInviteDto } from './dto/accept-invite.dto';
import { EmailService } from '../email/email.service';
import { ACTIVE_MEMBERSHIP } from './active-membership';
import { buildSessionPayload } from './session-payload.util';

/** What is stored in Redis alongside a refresh token. */
interface RefreshTokenData {
  userId: string;
  orgId?: string;
  sid?: string;
  /** Super admin who started this session by impersonating `userId`. */
  impersonatedBy?: string;
  /** That super admin's own session at the time — see JwtPayload. */
  impersonatorSid?: string;
}

/** Who a support session belongs to; empty for an ordinary session. */
type ImpersonationOrigin = Pick<RefreshTokenData, 'impersonatedBy' | 'impersonatorSid'>;

// How long a duplicate refresh waits for the rotation it lost to: 30 x 100ms.
const ROTATION_WAIT_ATTEMPTS = 30;
const ROTATION_WAIT_INTERVAL_MS = 100;

// Accepting any code would make the flag meaningless, so until a real second
// factor check exists an account with it turned on cannot sign in at all.
const TWO_FACTOR_UNAVAILABLE =
  'Two-factor sign-in is not available yet, so this account cannot sign in. Please contact support.';

// Reset and refresh tokens are stored as SHA-256 hashes, so a read of the
// table yields nothing that works as a token. The prefix tells a hash apart
// from a raw token stored before hashing began.
const HASHED_TOKEN_PREFIX = 'sha256:';

function hashToken(token: string): string {
  return HASHED_TOKEN_PREFIX + createHash('sha256').update(token).digest('hex');
}

/**
 * Stored values a presented token may match: its hash, and the raw token for
 * rows written before hashing began. Those rows run out on their own (reset
 * links within the hour, refresh rows with their token) and must keep working
 * until then.
 */
function storedTokenValues(token: string): string[] {
  const hashed = hashToken(token);
  // A hash copied out of the table must not pass as a raw token.
  return token.startsWith(HASHED_TOKEN_PREFIX) ? [hashed] : [hashed, token];
}

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
      message: 'Verification code sent to your email.',
      nextStep: 'verify-email',
    };
  }

  async verifyEmail(userId: string, code: string) {
    // Counted per account before the code is checked: the per-IP throttle
    // alone let guesses spread over many addresses walk the six digits.
    if (await this.redis.countVerifyAttempt(userId)) {
      // Spent, so even a Redis restart cannot give it more tries.
      await this.prisma.user.updateMany({
        where: { id: userId, emailVerified: false },
        data: { emailVerifyCode: null, emailVerifyExpires: null },
      });
      throw new HttpException('Too many incorrect codes. Request a new code and try again.', HttpStatus.TOO_MANY_REQUESTS);
    }
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
        permissions: extractGrants(m.permissions),
      })),
      nextStep: hasOrgs ? null : 'choose-plan',
      message: 'Email verified successfully.',
    };
  }

  async resendVerification(userId: string) {
    // Over the limit, the code already sent stays valid; nothing new is sent.
    const user = (await this.redis.allowEmailSend('verify', userId))
      ? await this.userService.regenerateVerifyCode(userId)
      : null;
    if (user) {
      // A new code gets its own tries.
      await this.redis.resetVerifyAttempts(user.id);
      await this.emailService.sendVerificationCode(user.email, user.emailVerifyCode as string);
    }
    return {
      message: 'Verification code sent.',
      nextStep: 'verify-email',
    };
  }

  async login(dto: LoginDto, userAgent?: string, ipAddress?: string) {
    const clientIp = ipAddress ?? 'unknown';
    if (await this.redis.countLoginAttempt(dto.email, clientIp)) {
      throw new UnauthorizedException('Too many failed login attempts. Please try again in 15 minutes.');
    }

    const userId = await this.userService.findIdByEmail(dto.email);
    const user = userId
      ? await this.prisma.user.findUnique({
          where: { id: userId },
          include: {
            memberships: { where: ACTIVE_MEMBERSHIP, orderBy: { createdAt: 'asc' }, include: { organization: true } },
          },
        })
      : null;

    if (!user || user.deletedAt) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const isValid = await bcrypt.compare(dto.password, user.password);
    if (!isValid) {
      throw new UnauthorizedException('Invalid email or password');
    }

    // CHANGED: include userId in error so frontend can redirect to OTP page
    if (!user.emailVerified) {
      // Resend OTP automatically, within the same per-recipient limit as the resend button
      const updatedUser = (await this.redis.allowEmailSend('verify', user.id))
        ? await this.userService.regenerateVerifyCode(user.id)
        : null;
      if (updatedUser) {
        await this.redis.resetVerifyAttempts(user.id);
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

    if (user.twoFactorEnabled) throw new ForbiddenException(TWO_FACTOR_UNAVAILABLE);

    // Reset rate limit on successful login
    await this.redis.resetLoginAttempts(dto.email, clientIp);

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
    await this.redis.setSession(
      user.id,
      buildSessionPayload(user, membership, user.memberships, { isSuperAdmin: user.isSuperAdmin }),
    );

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
        permissions: extractGrants(m.permissions),
      })),
      nextStep: user.memberships.length === 0 ? 'choose-plan' : null,
    };
  }

  async switchOrg(userId: string, orgId: string, sid?: string, impersonation?: ImpersonationOrigin) {
    const impersonatedBy = impersonation?.impersonatedBy;
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
      include: { memberships: { where: ACTIVE_MEMBERSHIP, include: { organization: true } } },
    });

    if (!user) throw new NotFoundException('User not found');

    // Generate new JWT scoped to the selected org. Same auth session: a
    // workspace switch is not a new login, and logout must end all of it.
    const payload: JwtPayload = {
      sub: userId,
      email: user.email,
      sid,
      orgId: membership.organizationId,
      role: membership.role,
      // Switching workspace while impersonating stays an impersonation.
      isSuperAdmin: impersonatedBy ? false : user.isSuperAdmin,
      ...(impersonatedBy ? { impersonatedBy, impersonatorSid: impersonation?.impersonatorSid } : {}),
    };

    const tokens = await this.generateTokenPair(payload);

    // Update session cache with new orgId
    await this.redis.setSession(
      userId,
      buildSessionPayload(user, membership, user.memberships, {
        isSuperAdmin: impersonatedBy ? false : user.isSuperAdmin,
        impersonatedBy,
      }),
    );

    return {
      ...tokens,
      currentOrganization: {
        id: membership.organization.id,
        name: membership.organization.name,
        slug: membership.organization.slug,
        type: membership.organization.type,
        role: membership.role,
        vendorScope: membership.vendorScope ?? undefined,
        permissions: extractGrants(membership.permissions),
      },
      organizations: user.memberships.map((m) => ({
        id: m.organization.id,
        name: m.organization.name,
        slug: m.organization.slug,
        type: m.organization.type,
        role: m.role,
        vendorScope: m.vendorScope ?? undefined,
        permissions: extractGrants(m.permissions),
      })),
    };
  }

  async refresh(refreshToken: string, userAgent?: string, ipAddress?: string) {
    return this.rotateRefreshToken(refreshToken, userAgent, ipAddress);
  }

  async logout(userId: string, sid: string | undefined, refreshToken: string) {
    // Only revoke a refresh token that belongs to the caller.
    const tokenData = await this.redis.getRefreshToken<{ userId: string }>(refreshToken);
    if (tokenData?.userId === userId) {
      await this.revokeRefreshToken(refreshToken, userId);
    }
    // Kill the access token too, not just the refresh token.
    if (sid) await this.redis.deleteAuthSession(sid, userId);
    await this.redis.deleteSession(userId);
    return { message: 'Logged out successfully' };
  }

  async forgotPassword(email: string) {
    const message = 'If an account exists with this email, a reset link has been sent to your email.';
    // Limited per address before the lookup, so the answer and its timing say
    // nothing about whether an account exists.
    if (!(await this.redis.allowEmailSend('password-reset', email))) return { message };

    const user = await this.userService.findByEmail(email);
    if (user && !user.deletedAt) {
      const token = randomBytes(32).toString('hex');
      await this.prisma.passwordResetToken.create({
        data: { userId: user.id, token: hashToken(token), expiresAt: new Date(Date.now() + 3600000) },
      });
      // The account's own address: the lookup ignores case, the mailbox is the account's.
      await this.emailService.sendPasswordResetLink(user.email, token);
    }
    return { message };
  }

  async resetPassword(dto: ResetPasswordDto) {
    const resetToken = await this.prisma.passwordResetToken.findFirst({
      where: { token: { in: storedTokenValues(dto.token) }, usedAt: null, expiresAt: { gt: new Date() } },
    });
    if (!resetToken) throw new NotFoundException('Invalid or expired reset token');

    // Hash before the transaction: it is slow by design and must not hold
    // row locks while it runs.
    const hash = await bcrypt.hash(dto.newPassword, 12);
    const now = new Date();

    await this.prisma.$transaction(async (tx) => {
      // Write the user row FIRST: its lock serialises every reset for this
      // account. Claiming the link first let two resets using two different
      // links each lock their own link, then wait on the other's — a
      // deadlock the database resolves by failing one with a 500. If the
      // claim below fails, this write rolls back with the transaction.
      await tx.user.update({ where: { id: resetToken.userId }, data: { password: hash } });

      // Claim the link. The lookup above only says it WAS unused — hashing
      // takes long enough for a second request with the same link to pass
      // that check too. The condition here is re-evaluated under the row
      // lock, so exactly one request changes the row; the other sees 0.
      const claimed = await tx.passwordResetToken.updateMany({
        where: { id: resetToken.id, usedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now },
      });
      if (claimed.count !== 1) throw new NotFoundException('Invalid or expired reset token');

      // Every other outstanding link for this account dies with this reset —
      // an older email must not be able to change the password again.
      await tx.passwordResetToken.updateMany({
        where: { userId: resetToken.userId, usedAt: null },
        data: { usedAt: now },
      });
    });

    await this.revokeAllUserTokens(resetToken.userId);
    return { message: 'Password reset successfully. Please log in with your new password.' };
  }

  // ─── INVITE ACCEPTANCE ───

  async getInviteByToken(token: string) {
    // An invite into a deleted workspace no longer exists as far as the
    // invitee is concerned.
    const invite = await this.prisma.teamInvite.findUnique({
      where: { token, organization: { deletedAt: null } },
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
    // Accepting an invite into a deleted workspace would create a membership
    // (and for a new invitee, an account) that can never be used.
    const invite = await this.prisma.teamInvite.findUnique({
      where: { token: dto.token, organization: { deletedAt: null } },
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
      if (caller && caller.email.toLowerCase() !== invite.email.toLowerCase()) {
        throw new ForbiddenException(
          `This invitation was sent to ${invite.email}. You are signed in as ${caller.email}. Sign out and open the invitation link again.`,
        );
      }
    } else if (user) {
      // Existing account, nobody signed in: the invite token alone must not
      // log anyone in — the inviter chooses the email, so it would hand them
      // that account. The account's password proves ownership.
      if (user.deletedAt) throw new ForbiddenException('Account has been deactivated');
      if (!dto.password || !(await bcrypt.compare(dto.password, user.password))) {
        throw new UnauthorizedException('Enter your account password to accept this invite');
      }
      // This signs the account in, so it is held to the same rule as login.
      if (user.twoFactorEnabled) throw new ForbiddenException(TWO_FACTOR_UNAVAILABLE);
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
    // The role's default grants are seeded alongside the section access chosen
    // on the invite form, and re-joining re-seeds both.
    const grants = [...new Set([...defaultGrantsForRole(invite.role), ...extractGrants(invite.permissions)])];
    await this.prisma.organizationMember.upsert({
      where: {
        organizationId_userId: { organizationId: invite.organizationId, userId: user.id },
      },
      create: {
        organizationId: invite.organizationId,
        userId: user.id,
        role: invite.role,
        vendorScope: invite.vendorScope,
        permissions: { grants },
      },
      update: {
        role: invite.role,
        vendorScope: invite.vendorScope,
        isActive: true,
        permissions: { grants },
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
      organization: {
        id: invite.organization.id, name: invite.organization.name, slug: invite.organization.slug,
        type: invite.organization.type,
        role: invite.role,
        vendorScope: invite.vendorScope ?? undefined,
        permissions: grants,
      },
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
    // A payload that already carries a sid (switchOrg) continues that session.
    const sid = payload.sid ?? randomBytes(16).toString('hex');
    await this.redis.setAuthSession(sid, payload.sub);
    const accessToken = this.jwt.sign({ ...payload, sid });
    const refreshToken = await this.createRefreshToken(
      payload.sub, undefined, undefined, payload.orgId, sid,
      { impersonatedBy: payload.impersonatedBy, impersonatorSid: payload.impersonatorSid },
    );
    return { accessToken, refreshToken };
  }

  /**
   * `orgId` is the organization the paired access token was minted for. It is
   * stored with the refresh token so a rotation re-issues the SAME tenant —
   * without it a refresh cannot know which org a multi-org user switched to.
   * `sid` is the auth session the pair belongs to, so a rotation continues it.
   * `impersonation` marks a support session, so a rotation keeps it one.
   */
  async createRefreshToken(
    userId: string, userAgent?: string, ipAddress?: string,
    orgId?: string, sid?: string, impersonation?: ImpersonationOrigin,
  ): Promise<string> {
    const token = randomBytes(40).toString('hex');

    // Primary: Redis with auto-expiry TTL
    await this.redis.setRefreshToken(token, {
      userId, orgId, sid,
      impersonatedBy: impersonation?.impersonatedBy, impersonatorSid: impersonation?.impersonatorSid,
      userAgent, ipAddress, createdAt: new Date().toISOString(),
    });
    await this.redis.trackUserToken(userId, token);

    // Audit trail: DB (fire-and-forget, don't block)
    const expiresAt = this.calculateExpiry(this.refreshExpires);
    this.prisma.refreshToken
      .create({ data: { userId, token: hashToken(token), userAgent, ipAddress, expiresAt } })
      .catch(() => { });

    return token;
  }

  async rotateRefreshToken(oldToken: string, userAgent?: string, ipAddress?: string): Promise<TokenPair> {
    // Take the token out of Redis atomically — single use. Only the request
    // that gets the data here may issue a replacement.
    const tokenData = await this.redis.consumeRefreshToken<RefreshTokenData>(oldToken);
    if (!tokenData) {
      // Not ours to rotate. If the same token was spent a moment ago (a second
      // tab refreshing at the same instant) hand back that rotation's result
      // rather than signing the user out; otherwise it is simply invalid.
      const replayed = await this.awaitConcurrentRotation(oldToken);
      if (replayed) return replayed;
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    try {
      const tokens = await this.issueRotatedTokens(tokenData, oldToken, userAgent, ipAddress);
      await this.redis.setRefreshRotationResult(oldToken, { ...tokens });
      return tokens;
    } catch (err) {
      // No result is coming — let a waiting duplicate fail now, not time out.
      await this.redis.clearRefreshRotation(oldToken).catch(() => { });
      throw err;
    }
  }

  /**
   * A support session may continue only while the admin behind it is still a
   * super admin (per the allowlist, not just the stored flag) and the session
   * they started it from has not been logged out or revoked.
   */
  private async isImpersonationStillAuthorized(adminId: string, adminSid?: string): Promise<boolean> {
    const admin = await this.prisma.user.findUnique({
      where: { id: adminId },
      select: { id: true, email: true, isSuperAdmin: true, deletedAt: true },
    });
    if (!admin || admin.deletedAt) return false;
    await this.syncSuperAdminFlag(admin);
    if (!admin.isSuperAdmin) return false;
    // Sessions started before the origin was recorded carry no adminSid.
    return !adminSid || this.redis.isAuthSessionActive(adminSid, adminId);
  }

  /** Result of a rotation of `oldToken` that is in flight or just finished, if any. */
  private async awaitConcurrentRotation(oldToken: string): Promise<TokenPair | null> {
    for (let attempt = 0; attempt < ROTATION_WAIT_ATTEMPTS; attempt++) {
      const rotation = await this.redis.getRefreshRotation<TokenPair>(oldToken);
      if (rotation !== 'pending') return rotation;
      await new Promise((resolve) => setTimeout(resolve, ROTATION_WAIT_INTERVAL_MS));
    }
    return null;
  }

  private async issueRotatedTokens(
    tokenData: RefreshTokenData,
    oldToken: string,
    userAgent?: string,
    ipAddress?: string,
  ): Promise<TokenPair> {
    const user = await this.prisma.user.findUnique({
      where: { id: tokenData.userId },
      include: { memberships: { where: ACTIVE_MEMBERSHIP, orderBy: { createdAt: 'asc' } } },
    });
    if (!user || user.deletedAt) throw new UnauthorizedException('Account has been deactivated');

    // Audit trail (fire-and-forget)
    this.prisma.refreshToken
      .updateMany({ where: { token: { in: storedTokenValues(oldToken) }, revokedAt: null }, data: { revokedAt: new Date() } })
      .catch(() => { });

    // Keep the org the session was in. Taking memberships[0] here silently
    // moved a multi-org user back to their first org every time the access
    // token expired, while the UI still named the org they had switched to —
    // reads AND writes then hit the wrong tenant. For the same reason, an org
    // the user has since been removed from ends the session instead of
    // re-issuing it for another org. The first membership is only a fallback
    // for tokens issued before orgId was stored.
    const membership = tokenData.orgId
      ? user.memberships.find((m) => m.organizationId === tokenData.orgId)
      : user.memberships[0];
    if (tokenData.orgId && !membership) {
      // End the whole auth session, not just this refresh token — otherwise
      // its sid lingers for the full refresh TTL with nothing left to use it.
      if (tokenData.sid) await this.redis.deleteAuthSession(tokenData.sid, user.id);
      throw new UnauthorizedException('You no longer have access to this workspace');
    }
    // Re-check the allowlist on every refresh, not only at login — otherwise
    // someone removed from it stayed super admin for as long as they refreshed.
    await this.syncSuperAdminFlag(user);

    // An impersonation session stays one across refreshes — and only while the
    // admin who started it is still a super admin and the session they started
    // it from is still live (so logging that admin out everywhere ends it).
    // The marker used to be dropped on the first refresh, and the session
    // carried on as an ordinary login of the target user: no banner, no exit,
    // nothing in the audit log.
    const { impersonatedBy, impersonatorSid } = tokenData;
    if (impersonatedBy && !(await this.isImpersonationStillAuthorized(impersonatedBy, impersonatorSid))) {
      if (tokenData.sid) await this.redis.deleteAuthSession(tokenData.sid, user.id);
      // Best-effort: the support session is over, so the audit row is too.
      this.prisma.impersonationLog
        .updateMany({ where: { superAdminId: impersonatedBy, targetUserId: user.id, endedAt: null }, data: { endedAt: new Date() } })
        .catch((err) => this.logger.error('Failed to close impersonation log', err));
      throw new UnauthorizedException('Impersonation session has ended');
    }
    // The impersonated user's own flag never applies to a support session.
    const isSuperAdmin = impersonatedBy ? false : user.isSuperAdmin;

    // The same auth session continues across rotations — but only while it is
    // still live. A refresh that raced a logout/revoke-all read its token
    // before it was deleted; re-creating the session here would undo the
    // revocation. Refresh tokens issued before sessions existed carry no sid
    // and get one.
    let sid = tokenData.sid;
    if (sid) {
      if (!(await this.redis.touchAuthSession(sid, user.id))) {
        throw new UnauthorizedException('Invalid or expired refresh token');
      }
    } else {
      sid = randomBytes(16).toString('hex');
      await this.redis.setAuthSession(sid, user.id);
    }

    const payload: JwtPayload = {
      sub: user.id, email: user.email, sid,
      orgId: membership?.organizationId, role: membership?.role,
      isSuperAdmin,
      ...(impersonatedBy ? { impersonatedBy, impersonatorSid } : {}),
    };

    const accessToken = this.jwt.sign(payload);
    const refreshToken = await this.createRefreshToken(
      user.id, userAgent, ipAddress, membership?.organizationId, sid,
      impersonatedBy ? { impersonatedBy, impersonatorSid } : undefined,
    );

    // Refresh session cache
    await this.redis.setSession(
      user.id,
      buildSessionPayload(user, membership, user.memberships, { isSuperAdmin, impersonatedBy }),
    );

    return { accessToken, refreshToken };
  }

  async revokeRefreshToken(token: string, userId?: string): Promise<void> {
    await this.redis.deleteRefreshToken(token, userId);
    // Audit trail (fire-and-forget)
    this.prisma.refreshToken
      .updateMany({ where: { token: { in: storedTokenValues(token) }, revokedAt: null }, data: { revokedAt: new Date() } })
      .catch(() => { });
  }

  /** End every session of a user; `keepSid` keeps that one (the caller's own) signed in. */
  async revokeAllUserTokens(userId: string, keepSid?: string): Promise<void> {
    await this.redis.deleteAllUserTokens(userId, keepSid);
    await this.redis.deleteAllAuthSessions(userId, keepSid);
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
    superAdminSid?: string,
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
      include: { memberships: { where: ACTIVE_MEMBERSHIP, include: { organization: true } } },
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
      impersonatorSid: superAdminSid,
    };

    const tokens = await this.generateTokenPair(payload);

    await this.redis.setSession(
      target.id,
      buildSessionPayload(target, membership, target.memberships, {
        isSuperAdmin: false,
        impersonatedBy: superAdminId,
      }),
    );

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
        permissions: extractGrants(m.permissions),
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
  async stopImpersonation(
    impersonatedByUserId: string,
    impersonation?: { sid?: string; targetUserId: string; impersonatorSid?: string },
  ) {
    const superAdmin = await this.prisma.user.findUnique({
      where: { id: impersonatedByUserId },
      include: { memberships: { where: ACTIVE_MEMBERSHIP, include: { organization: true } } },
    });
    if (!superAdmin?.isSuperAdmin) {
      throw new ForbiddenException('Impersonation can only be stopped by a super admin');
    }
    // A fresh admin session is issued only while the admin session this was
    // started from is still live. Otherwise a support session that outlived a
    // forced logout of the admin could be traded for a new admin login. One
    // with no recorded origin cannot show that, so it is refused too. Checked
    // before that session is retired below.
    const impersonatorSid = impersonation?.impersonatorSid;
    const adminStillAuthorized =
      !!impersonatorSid && (await this.isImpersonationStillAuthorized(superAdmin.id, impersonatorSid));

    // End the impersonation session itself, so its tokens stop working now
    // rather than lingering after the super admin has "exited".
    if (impersonation?.sid) {
      await this.redis.deleteAuthSession(impersonation.sid, impersonation.targetUserId);
    }
    // The admin gets a fresh session below. Retire the one this was started
    // from: nothing uses it any more, and any other support session started
    // from it ends with it.
    if (impersonatorSid) {
      await this.redis.deleteAuthSession(impersonatorSid, superAdmin.id);
    }

    // Close any open log rows for this super admin (there should be exactly one).
    await this.prisma.impersonationLog.updateMany({
      where: { superAdminId: superAdmin.id, endedAt: null },
      data: { endedAt: new Date() },
    });

    if (!adminStillAuthorized) throw new UnauthorizedException('Impersonation session has ended');

    const membership = superAdmin.memberships[0];
    const payload: JwtPayload = {
      sub: superAdmin.id,
      email: superAdmin.email,
      orgId: membership?.organizationId,
      role: membership?.role,
      isSuperAdmin: true,
    };

    const tokens = await this.generateTokenPair(payload);

    await this.redis.setSession(
      superAdmin.id,
      buildSessionPayload(superAdmin, membership, superAdmin.memberships, { isSuperAdmin: true }),
    );

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
        permissions: extractGrants(m.permissions),
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