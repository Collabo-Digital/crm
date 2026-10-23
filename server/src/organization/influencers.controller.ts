import { Controller, Get, Param } from '@nestjs/common';
import { UserRole } from '@prisma/client';

import type { JwtPayload } from '../auth/interfaces/jwt-payload.interface';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { OrganizationService } from './organization.service';
import { InvitesService } from './invites.service';

/**
 * Route: /api/v1/organizations/:orgId/influencers
 *
 * Read side of influencer management: one list combining people who have joined
 * with invitations still outstanding, each with the Instagram account they have
 * connected. Writes go through the invites routes — an influencer is created by
 * inviting one, not by posting here.
 *
 * OWNER/ADMIN only, and deliberately NOT `@AllowInfluencer()`: this is the list
 * of everyone else's influencers, which is exactly what an influencer must not
 * see.
 */
@Controller('organizations/:orgId/influencers')
export class InfluencersController {
    constructor(
        private readonly invitesService: InvitesService,
        private readonly orgService: OrganizationService,
    ) { }

    @Get()
    async findAll(@Param('orgId') orgId: string, @CurrentUser() user: JwtPayload) {
        await this.orgService.requireRole(orgId, user.sub, [UserRole.OWNER, UserRole.ADMIN]);
        return this.invitesService.listInfluencers(orgId);
    }
}
