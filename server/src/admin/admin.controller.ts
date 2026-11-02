import { BadRequestException, Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { NoOrgRequired } from '../auth/decorators/no-org-required.decorator';
import { AllowImpersonated, SuperAdmin } from '../auth/decorators/super-admin.decorator';
import type { JwtPayload } from '../auth/interfaces/jwt-payload.interface';
import { AuthService } from '../auth/auth.service';
import { AdminService } from './admin.service';
import { ImpersonateDto } from './dto/impersonate.dto';
import { QueryUsersDto } from './dto/query-users.dto';
import { SetOrganizationBillingDto } from './dto/set-organization-billing.dto';

/**
 * Collabo-team-only endpoints. Every route is gated by `SuperAdminGuard`,
 * which is registered globally and reads the `@SuperAdmin()` metadata applied
 * at the class level here.
 *
 * `stop-impersonating` is reachable with an impersonation token too — it is
 * marked `@AllowImpersonated()`, so the guard accepts `JwtPayload.impersonatedBy`
 * as a sibling credential on that route only. The underlying service
 * re-validates the super admin via that claim before issuing any new tokens.
 *
 * @NoOrgRequired: super admins operate across tenants and may have no orgId.
 */
@Controller('admin')
@SuperAdmin()
@NoOrgRequired()
export class AdminController {
    constructor(
        private readonly admin: AdminService,
        private readonly auth: AuthService,
    ) { }

    @Get('users')
    list(@Query() query: QueryUsersDto) {
        return this.admin.listUsers(query);
    }

    @Get('users/:userId')
    detail(@Param('userId') userId: string) {
        return this.admin.getUserDetail(userId);
    }

    @Post('users/:userId/impersonate')
    impersonate(
        @Param('userId') userId: string,
        @Body() dto: ImpersonateDto,
        @CurrentUser() user: JwtPayload,
        @Req() req: Request,
    ) {
        // Only a real super admin can start impersonating — block nested impersonation.
        if (!user.isSuperAdmin) {
            throw new BadRequestException('Already impersonating. Exit the current session first.');
        }
        return this.auth.startImpersonation(
            user.sub,
            userId,
            dto.orgId,
            req.headers['user-agent'] as string | undefined,
            req.ip,
            user.sid,
        );
    }

    @Post('stop-impersonating')
    @AllowImpersonated()
    stop(@CurrentUser() user: JwtPayload) {
        const superAdminId = user.impersonatedBy;
        if (!superAdminId) {
            throw new BadRequestException('No active impersonation session');
        }
        return this.auth.stopImpersonation(superAdminId, {
            sid: user.sid,
            targetUserId: user.sub,
            impersonatorSid: user.impersonatorSid,
        });
    }

    @Patch('users/:userId/soft-delete')
    softDelete(@Param('userId') userId: string) {
        return this.admin.softDeleteUser(userId);
    }

    @Patch('users/:userId/reactivate')
    reactivate(@Param('userId') userId: string) {
        return this.admin.reactivateUser(userId);
    }

    @Post('users/:userId/force-verify-email')
    forceVerifyEmail(@Param('userId') userId: string) {
        return this.admin.forceVerifyEmail(userId);
    }

    @Post('users/:userId/force-logout')
    forceLogout(@Param('userId') userId: string) {
        return this.admin.forceLogout(userId);
    }

    /** Set plan / extend trial, for a plan the Collabo team invoices or a longer trial. */
    @Patch('organizations/:orgId/billing')
    setOrganizationBilling(
        @Param('orgId') orgId: string,
        @Body() dto: SetOrganizationBillingDto,
        @CurrentUser() user: JwtPayload,
    ) {
        return this.admin.setOrganizationBilling(orgId, dto, user.sub);
    }
}
