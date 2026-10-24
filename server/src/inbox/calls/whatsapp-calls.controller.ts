import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { RequireSection } from '../../auth/decorators/require-section.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import type { SessionPayload } from '../../auth/interfaces/jwt-payload.interface';
import { InboxService } from '../inbox.service';
import { InboxTeamService } from '../inbox-team.service';
import { CallPermissionRequestDto, CallSdpDto, CallSettingsDto } from './whatsapp-calls.dto';
import { WhatsAppCallsService } from './whatsapp-calls.service';

/** Members who can talk to customers; viewers cannot take or place calls. */
const CALLERS = [UserRole.OWNER, UserRole.ADMIN, UserRole.MANAGER, UserRole.AGENT];

/** WhatsApp calls in the browser: signalling for WebRTC between a teammate and WhatsApp. */
@Controller('inbox')
@RequireSection('chat')
@Roles(...CALLERS)
export class WhatsAppCallsController {
    constructor(
        private readonly calls: WhatsAppCallsService,
        private readonly inbox: InboxService,
        private readonly teams: InboxTeamService,
    ) { }

    @Get('calls/live')
    live(@CurrentUser() user: SessionPayload) {
        return this.calls.live(user.orgId!);
    }

    @Get('calls/settings/:channelId')
    @Roles(UserRole.OWNER, UserRole.ADMIN)
    settings(@CurrentUser() user: SessionPayload, @Param('channelId') channelId: string) {
        return this.calls.settings(user.orgId!, channelId);
    }

    @Put('calls/settings/:channelId')
    @Roles(UserRole.OWNER, UserRole.ADMIN)
    saveSettings(@CurrentUser() user: SessionPayload, @Param('channelId') channelId: string, @Body() dto: CallSettingsDto) {
        return this.calls.saveSettings(user.orgId!, channelId, dto);
    }

    @Get('calls/:id')
    get(@CurrentUser() user: SessionPayload, @Param('id') id: string) {
        return this.calls.get(user.orgId!, id);
    }

    @Post('calls/:id/accept')
    accept(@CurrentUser() user: SessionPayload, @Param('id') id: string, @Body() dto: CallSdpDto) {
        return this.calls.accept(user.orgId!, user.sub, id, dto.sdp);
    }

    @Post('calls/:id/reject')
    reject(@CurrentUser() user: SessionPayload, @Param('id') id: string) {
        return this.calls.reject(user.orgId!, user.sub, id);
    }

    @Post('calls/:id/terminate')
    terminate(@CurrentUser() user: SessionPayload, @Param('id') id: string) {
        return this.calls.terminate(user.orgId!, id);
    }

    @Get('conversations/:id/call-permission')
    async permission(@CurrentUser() user: SessionPayload, @Param('id') id: string) {
        await this.inbox.getConversation(user.orgId!, await this.teams.viewer(user), id);
        return this.calls.permissionFor(user.orgId!, id);
    }

    @Post('conversations/:id/call-permission')
    async requestPermission(@CurrentUser() user: SessionPayload, @Param('id') id: string, @Body() dto: CallPermissionRequestDto) {
        await this.inbox.getConversation(user.orgId!, await this.teams.viewer(user), id);
        return this.calls.requestPermission(user.orgId!, user.sub, id, dto.text);
    }

    @Post('conversations/:id/calls')
    async start(@CurrentUser() user: SessionPayload, @Param('id') id: string, @Body() dto: CallSdpDto) {
        await this.inbox.getConversation(user.orgId!, await this.teams.viewer(user), id);
        return this.calls.start(user.orgId!, user.sub, id, dto.sdp);
    }
}
