import { Controller, Post, Get, Delete, Body, Param, BadRequestException } from '@nestjs/common';
import { UserRole } from '@prisma/client';

import type { JwtPayload } from '../auth/interfaces/jwt-payload.interface';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { OrganizationService } from './organization.service';
import { InvitesService } from './invites.service';
import { SendInviteDto } from './dto/send-invite.dto';
import { InviteInfluencerDto } from './dto/invite-influencer.dto';

/** Who may invite anyone, including influencers. */
const INVITE_MANAGERS: UserRole[] = [UserRole.OWNER, UserRole.ADMIN];

// Route: /api/v1/organizations/:orgId/invites
// All endpoints require JWT + OWNER/ADMIN role
@Controller('organizations/:orgId/invites')
export class InvitesController {
    constructor(
        private readonly invitesService: InvitesService,
        private readonly orgService: OrganizationService,
    ) { }

    // POST — send a new invite
    //
    // `requireRole` is the authorization, and it is what stops an influencer
    // inviting another influencer: INFLUENCER is not in INVITE_MANAGERS, so the
    // call is refused however the request was constructed. (InfluencerAccessGuard
    // already closes this controller to them — this is the second lock.)
    @Post()
    async send(
        @Param('orgId') orgId: string,
        @CurrentUser() user: JwtPayload,
        @Body() dto: SendInviteDto,
    ) {
        await this.orgService.requireRole(orgId, user.sub, INVITE_MANAGERS);
        return this.invitesService.send(orgId, user.sub, dto);
    }

    // POST /influencers — invite someone as an influencer.
    //
    // A separate route rather than a role field the caller picks: the role is
    // the whole point of the action, so it is fixed by the endpoint and cannot
    // be swapped for ADMIN by editing the request body.
    @Post('influencers')
    async inviteInfluencer(
        @Param('orgId') orgId: string,
        @CurrentUser() user: JwtPayload,
        @Body() dto: InviteInfluencerDto,
    ) {
        await this.orgService.requireRole(orgId, user.sub, INVITE_MANAGERS);
        if (dto.role && dto.role !== UserRole.INFLUENCER) {
            throw new BadRequestException('This endpoint only invites influencers.');
        }
        return this.invitesService.send(orgId, user.sub, {
            ...dto,
            role: UserRole.INFLUENCER,
        });
    }

    // GET — list pending invites
    @Get()
    async findAll(@Param('orgId') orgId: string, @CurrentUser() user: JwtPayload) {
        await this.orgService.requireRole(orgId, user.sub, INVITE_MANAGERS);
        return this.invitesService.findAllPending(orgId);
    }

    // POST /:inviteId/resend — re-issue a pending invite with a fresh token
    @Post(':inviteId/resend')
    async resend(
        @Param('orgId') orgId: string,
        @Param('inviteId') inviteId: string,
        @CurrentUser() user: JwtPayload,
    ) {
        await this.orgService.requireRole(orgId, user.sub, INVITE_MANAGERS);
        return this.invitesService.resend(orgId, inviteId, user.sub);
    }

    // DELETE — revoke a pending invite
    @Delete(':inviteId')
    async revoke(
        @Param('orgId') orgId: string,
        @Param('inviteId') inviteId: string,
        @CurrentUser() user: JwtPayload,
    ) {
        await this.orgService.requireRole(orgId, user.sub, INVITE_MANAGERS);
        return this.invitesService.revoke(orgId, inviteId);
    }
}
