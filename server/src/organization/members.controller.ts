import { Controller, Get, Patch, Delete, Body, Param } from '@nestjs/common';
import { UserRole } from '@prisma/client';

import type { JwtPayload } from '../auth/interfaces/jwt-payload.interface';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { OrganizationService } from './organization.service';
import { MembersService } from './members.service';
import { UpdateMemberRoleDto } from './dto/update-member-role.dto';
import { UpdateMemberPermissionsDto } from './dto/update-member-permissions.dto';

// Route: /api/v1/organizations/:orgId/members
// All endpoints require JWT (no @Public())
@Controller('organizations/:orgId/members')
export class MembersController {
    constructor(
        private readonly membersService: MembersService,
        private readonly orgService: OrganizationService,
    ) { }

    // GET — any org member can see the team list
    @Get()
    async findAll(@Param('orgId') orgId: string, @CurrentUser() user: JwtPayload) {
        // Verify the requesting user is a member of this org (any role)
        await this.orgService.requireRole(orgId, user.sub, [
            UserRole.OWNER, UserRole.ADMIN, UserRole.MANAGER, UserRole.AGENT, UserRole.VIEWER,
        ]);
        return this.membersService.findAll(orgId);
    }

    // PATCH — only OWNER and ADMIN can change roles
    @Patch(':memberId')
    async updateRole(
        @Param('orgId') orgId: string,
        @Param('memberId') memberId: string,
        @CurrentUser() user: JwtPayload,
        @Body() dto: UpdateMemberRoleDto,
    ) {
        await this.orgService.requireRole(orgId, user.sub, [UserRole.OWNER, UserRole.ADMIN]);
        return this.membersService.updateRole(orgId, memberId, dto.role, dto.vendorScope);
    }

    // PATCH permissions — only OWNER and ADMIN can change grants
    @Patch(':memberId/permissions')
    async updatePermissions(
        @Param('orgId') orgId: string,
        @Param('memberId') memberId: string,
        @CurrentUser() user: JwtPayload,
        @Body() dto: UpdateMemberPermissionsDto,
    ) {
        await this.orgService.requireRole(orgId, user.sub, [UserRole.OWNER, UserRole.ADMIN]);
        return this.membersService.updatePermissions(orgId, memberId, dto.grants, dto.preset);
    }

    // DELETE — only OWNER and ADMIN can remove members
    @Delete(':memberId')
    async remove(
        @Param('orgId') orgId: string,
        @Param('memberId') memberId: string,
        @CurrentUser() user: JwtPayload,
    ) {
        await this.orgService.requireRole(orgId, user.sub, [UserRole.OWNER, UserRole.ADMIN]);
        return this.membersService.remove(orgId, memberId);
    }
}