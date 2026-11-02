import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { BillingProvider, Prisma, SubscriptionStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { QueryUsersDto } from './dto/query-users.dto';
import { SetOrganizationBillingDto } from './dto/set-organization-billing.dto';

/** What the "Set plan / extend trial" action shows and changes. */
const ORG_BILLING_SELECT = {
    id: true,
    billingPlan: true,
    billingInterval: true,
    billingProvider: true,
    subscriptionStatus: true,
    trialEndsAt: true,
    currentPeriodEnd: true,
} satisfies Prisma.OrganizationSelect;

/**
 * Super-admin operations. Every method assumes the caller has already passed
 * SuperAdminGuard at the controller level — no role re-check inside.
 */
@Injectable()
export class AdminService {
    private readonly logger = new Logger(AdminService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly redis: RedisService,
    ) { }

    /**
     * Paginated user list. Returns the shared `{ data, meta }` envelope so
     * the client can reuse `PaginatedResponse<T>`.
     */
    async listUsers(query: QueryUsersDto) {
        const page = query.page ?? 1;
        const limit = query.limit ?? 20;
        const search = query.search;

        const where: Prisma.UserWhereInput = search
            ? {
                OR: [
                    { email: { contains: search, mode: 'insensitive' } },
                    { firstName: { contains: search, mode: 'insensitive' } },
                    { lastName: { contains: search, mode: 'insensitive' } },
                ],
            }
            : {};

        const [items, total] = await Promise.all([
            this.prisma.user.findMany({
                where,
                skip: (page - 1) * limit,
                take: limit,
                orderBy: { createdAt: 'desc' },
                include: { _count: { select: { memberships: true } } },
            }),
            this.prisma.user.count({ where }),
        ]);

        return {
            data: items.map((u) => ({
                id: u.id,
                email: u.email,
                firstName: u.firstName,
                lastName: u.lastName,
                avatarUrl: u.avatarUrl,
                emailVerified: u.emailVerified,
                lastLoginAt: u.lastLoginAt,
                createdAt: u.createdAt,
                deletedAt: u.deletedAt,
                isSuperAdmin: u.isSuperAdmin,
                organizationCount: u._count.memberships,
            })),
            meta: {
                total,
                page,
                limit,
                totalPages: Math.max(1, Math.ceil(total / limit)),
            },
        };
    }

    async getUserDetail(userId: string) {
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            include: { memberships: { include: { organization: true } } },
        });
        if (!user) throw new NotFoundException('User not found');

        return {
            id: user.id,
            email: user.email,
            firstName: user.firstName,
            lastName: user.lastName,
            avatarUrl: user.avatarUrl,
            emailVerified: user.emailVerified,
            emailVerifiedAt: user.emailVerifiedAt,
            twoFactorEnabled: user.twoFactorEnabled,
            lastLoginAt: user.lastLoginAt,
            createdAt: user.createdAt,
            updatedAt: user.updatedAt,
            deletedAt: user.deletedAt,
            isSuperAdmin: user.isSuperAdmin,
            memberships: user.memberships.map((m) => ({
                organizationId: m.organizationId,
                orgName: m.organization.name,
                orgSlug: m.organization.slug,
                orgType: m.organization.type,
                role: m.role,
                isActive: m.isActive,
                billing: {
                    billingPlan: m.organization.billingPlan,
                    billingInterval: m.organization.billingInterval,
                    billingProvider: m.organization.billingProvider,
                    subscriptionStatus: m.organization.subscriptionStatus,
                    trialEndsAt: m.organization.trialEndsAt,
                    currentPeriodEnd: m.organization.currentPeriodEnd,
                },
            })),
        };
    }

    /**
     * "Set plan / extend trial": a plan the Collabo team invoices (Scale,
     * Enterprise, or any plan billed by hand), or a trial's new end. A
     * workspace paying through Razorpay keeps the plan its subscription is
     * on, so that is not changed here. Logged with who did it and what it was.
     */
    async setOrganizationBilling(orgId: string, dto: SetOrganizationBillingDto, adminId: string) {
        const org = await this.prisma.organization.findFirst({ where: { id: orgId, deletedAt: null }, select: ORG_BILLING_SELECT });
        if (!org) throw new NotFoundException('Organization not found');
        const paying = org.billingProvider === BillingProvider.RAZORPAY
            && (org.subscriptionStatus === SubscriptionStatus.ACTIVE || org.subscriptionStatus === SubscriptionStatus.AUTHENTICATED);
        if (paying && (dto.billingPlan || dto.billingInterval || dto.manual)) {
            throw new BadRequestException('This workspace pays through a Razorpay subscription, which sets its plan. Cancel the subscription in Razorpay first.');
        }

        const data: Prisma.OrganizationUpdateInput = {
            ...(dto.billingPlan ? { billingPlan: dto.billingPlan } : {}),
            ...(dto.billingInterval ? { billingInterval: dto.billingInterval } : {}),
            ...(dto.manual === true ? { billingProvider: BillingProvider.MANUAL } : {}),
            ...(dto.manual === false && org.billingProvider === BillingProvider.MANUAL ? { billingProvider: null } : {}),
            ...(dto.trialEndsAt !== undefined ? { trialEndsAt: dto.trialEndsAt ? new Date(dto.trialEndsAt) : null } : {}),
        };
        const updated = await this.prisma.organization.update({ where: { id: orgId }, data, select: ORG_BILLING_SELECT });
        const changes = (Object.keys(data) as Array<keyof typeof org>).map((k) => `${k} ${JSON.stringify(org[k])} → ${JSON.stringify(updated[k])}`);
        this.logger.log(`Billing of org ${orgId} set by super admin ${adminId}: ${changes.join(', ') || 'no change'}`);
        return updated;
    }

    async softDeleteUser(userId: string) {
        await this.prisma.user.update({ where: { id: userId }, data: { deletedAt: new Date() } });
        // Kill their active sessions as well — they shouldn't stay logged in.
        await this.redis.deleteAllUserTokens(userId);
        await this.redis.deleteAllAuthSessions(userId);
        await this.redis.deleteSession(userId);
        this.logger.log(`User ${userId} soft-deleted by super admin`);
        return { ok: true };
    }

    async reactivateUser(userId: string) {
        await this.prisma.user.update({ where: { id: userId }, data: { deletedAt: null } });
        this.logger.log(`User ${userId} reactivated by super admin`);
        return { ok: true };
    }

    async forceVerifyEmail(userId: string) {
        await this.prisma.user.update({
            where: { id: userId },
            data: {
                emailVerified: true,
                emailVerifiedAt: new Date(),
                emailVerifyCode: null,
                emailVerifyExpires: null,
            },
        });
        this.logger.log(`Email force-verified for user ${userId} by super admin`);
        return { ok: true };
    }

    async forceLogout(userId: string) {
        // Revoke all refresh tokens (Redis) and blow away the session cache.
        await this.redis.deleteAllUserTokens(userId);
        await this.redis.deleteAllAuthSessions(userId);
        await this.redis.deleteSession(userId);
        this.prisma.refreshToken
            .updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } })
            .catch((err) => this.logger.error('Failed to revoke refresh tokens in DB', err));
        this.logger.log(`All sessions revoked for user ${userId} by super admin`);
        return { ok: true };
    }
}
