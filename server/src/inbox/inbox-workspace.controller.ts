import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { PartialType } from '@nestjs/mapped-types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequireSection } from '../auth/decorators/require-section.decorator';
import type { SessionPayload } from '../auth/interfaces/jwt-payload.interface';
import { INBOX_ROLES } from './inbox.controller';
import { InboxTeamService } from './inbox-team.service';
import { QuickReplyService } from './quick-reply.service';
import { InboxViewService } from './inbox-view.service';
import { SaveTeamDto } from './dto/save-team.dto';
import { SetAvailabilityDto } from './dto/set-availability.dto';
import { SaveQuickReplyDto } from './dto/save-quick-reply.dto';
import { SaveInboxViewDto } from './dto/save-inbox-view.dto';

class UpdateTeamDto extends PartialType(SaveTeamDto) { }
class UpdateQuickReplyDto extends PartialType(SaveQuickReplyDto) { }
class UpdateInboxViewDto extends PartialType(SaveInboxViewDto) { }

/** How the team works the inbox: who is here, teams, quick replies and saved views. */
@Controller('inbox')
@RequireSection('chat')
@Roles(...INBOX_ROLES)
export class InboxWorkspaceController {
    constructor(
        private readonly teams: InboxTeamService,
        private readonly quickReplies: QuickReplyService,
        private readonly views: InboxViewService,
    ) { }

    /** The signed-in member: availability, teams and what the inbox lets them do. */
    @Get('me')
    async me(@CurrentUser() user: SessionPayload) {
        return this.teams.me(user.orgId!, await this.teams.viewer(user));
    }

    @Patch('me')
    setStatus(@CurrentUser() user: SessionPayload, @Body() dto: SetAvailabilityDto) {
        return this.teams.setStatus(user.orgId!, user.sub, dto.status);
    }

    @Get('members')
    members(@CurrentUser() user: SessionPayload) {
        return this.teams.members(user.orgId!);
    }

    @Get('teams')
    listTeams(@CurrentUser() user: SessionPayload) {
        return this.teams.listTeams(user.orgId!);
    }

    @Post('teams')
    async createTeam(@CurrentUser() user: SessionPayload, @Body() dto: SaveTeamDto) {
        return this.teams.createTeam(user.orgId!, await this.teams.viewer(user), dto);
    }

    @Patch('teams/:id')
    async updateTeam(@CurrentUser() user: SessionPayload, @Param('id') id: string, @Body() dto: UpdateTeamDto) {
        return this.teams.updateTeam(user.orgId!, await this.teams.viewer(user), id, dto);
    }

    @Delete('teams/:id')
    async deleteTeam(@CurrentUser() user: SessionPayload, @Param('id') id: string) {
        return this.teams.deleteTeam(user.orgId!, await this.teams.viewer(user), id);
    }

    @Get('quick-replies')
    async listQuickReplies(@CurrentUser() user: SessionPayload, @Query('manage') manage?: string) {
        return this.quickReplies.list(user.orgId!, await this.teams.viewer(user), manage === 'true');
    }

    @Post('quick-replies')
    async createQuickReply(@CurrentUser() user: SessionPayload, @Body() dto: SaveQuickReplyDto) {
        return this.quickReplies.create(user.orgId!, await this.teams.viewer(user), dto);
    }

    @Patch('quick-replies/:id')
    async updateQuickReply(@CurrentUser() user: SessionPayload, @Param('id') id: string, @Body() dto: UpdateQuickReplyDto) {
        return this.quickReplies.update(user.orgId!, await this.teams.viewer(user), id, dto);
    }

    @Delete('quick-replies/:id')
    async deleteQuickReply(@CurrentUser() user: SessionPayload, @Param('id') id: string) {
        return this.quickReplies.remove(user.orgId!, await this.teams.viewer(user), id);
    }

    @Get('views')
    async listViews(@CurrentUser() user: SessionPayload) {
        return this.views.list(user.orgId!, await this.teams.viewer(user));
    }

    @Post('views')
    async createView(@CurrentUser() user: SessionPayload, @Body() dto: SaveInboxViewDto) {
        return this.views.create(user.orgId!, await this.teams.viewer(user), dto);
    }

    @Patch('views/:id')
    async updateView(@CurrentUser() user: SessionPayload, @Param('id') id: string, @Body() dto: UpdateInboxViewDto) {
        return this.views.update(user.orgId!, await this.teams.viewer(user), id, dto);
    }

    @Delete('views/:id')
    async deleteView(@CurrentUser() user: SessionPayload, @Param('id') id: string) {
        return this.views.remove(user.orgId!, await this.teams.viewer(user), id);
    }
}
