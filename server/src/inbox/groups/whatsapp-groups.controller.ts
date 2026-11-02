import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Res } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import type { Response } from 'express';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { RequireSection } from '../../auth/decorators/require-section.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import type { SessionPayload } from '../../auth/interfaces/jwt-payload.interface';
import { INBOX_ROLES } from '../inbox.controller';
import { CreateGroupDto, UpdateGroupDto } from './whatsapp-groups.dto';
import { WhatsAppGroupsService } from './whatsapp-groups.service';

const GROUP_MANAGERS = [UserRole.OWNER, UserRole.ADMIN, UserRole.MANAGER];

/** WhatsApp groups: everyone in the inbox can see them; managers run them. Their chats are inbox conversations. */
@Controller('inbox/groups')
@RequireSection('chat')
@Roles(...INBOX_ROLES)
export class WhatsAppGroupsController {
    constructor(private readonly groups: WhatsAppGroupsService) { }

    @Get()
    list(@CurrentUser() user: SessionPayload) {
        return this.groups.list(user.orgId!);
    }

    @Get(':id')
    get(@CurrentUser() user: SessionPayload, @Param('id') id: string) {
        return this.groups.get(user.orgId!, id);
    }

    @Get(':id/qr')
    async qr(@CurrentUser() user: SessionPayload, @Param('id') id: string, @Query('format') format: string | undefined, @Res() res: Response) {
        const qr = await this.groups.qr(user.orgId!, id, format === 'png' ? 'png' : 'svg');
        res.setHeader('Content-Type', qr.type);
        res.setHeader('Content-Disposition', `attachment; filename="${qr.filename}"`);
        res.setHeader('Cache-Control', 'private, max-age=60');
        res.send(qr.body);
    }

    @Post()
    @Roles(...GROUP_MANAGERS)
    create(@CurrentUser() user: SessionPayload, @Body() dto: CreateGroupDto) {
        return this.groups.create(user.orgId!, user.sub, dto);
    }

    @Post(':id/refresh')
    @Roles(...GROUP_MANAGERS)
    refresh(@CurrentUser() user: SessionPayload, @Param('id') id: string) {
        return this.groups.refresh(user.orgId!, id);
    }

    @Patch(':id')
    @Roles(...GROUP_MANAGERS)
    update(@CurrentUser() user: SessionPayload, @Param('id') id: string, @Body() dto: UpdateGroupDto) {
        return this.groups.update(user.orgId!, id, dto);
    }

    @Post(':id/invite-link')
    @Roles(...GROUP_MANAGERS)
    resetInviteLink(@CurrentUser() user: SessionPayload, @Param('id') id: string) {
        return this.groups.resetInviteLink(user.orgId!, id);
    }

    @Delete(':id/participants/:waId')
    @Roles(...GROUP_MANAGERS)
    removeParticipant(@CurrentUser() user: SessionPayload, @Param('id') id: string, @Param('waId') waId: string) {
        return this.groups.removeParticipant(user.orgId!, id, waId);
    }

    @Post(':id/join-requests/:requestId/approve')
    @Roles(...GROUP_MANAGERS)
    approve(@CurrentUser() user: SessionPayload, @Param('id') id: string, @Param('requestId') requestId: string) {
        return this.groups.decideJoinRequest(user.orgId!, user.sub, id, requestId, true);
    }

    @Post(':id/join-requests/:requestId/reject')
    @Roles(...GROUP_MANAGERS)
    reject(@CurrentUser() user: SessionPayload, @Param('id') id: string, @Param('requestId') requestId: string) {
        return this.groups.decideJoinRequest(user.orgId!, user.sub, id, requestId, false);
    }

    @Delete(':id')
    @Roles(...GROUP_MANAGERS)
    remove(@CurrentUser() user: SessionPayload, @Param('id') id: string) {
        return this.groups.remove(user.orgId!, id);
    }
}
