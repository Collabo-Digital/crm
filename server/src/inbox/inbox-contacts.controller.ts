import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequireSection } from '../auth/decorators/require-section.decorator';
import type { SessionPayload } from '../auth/interfaces/jwt-payload.interface';
import { INBOX_ROLES } from './inbox.controller';
import { InboxContactsService } from './inbox-contacts.service';
import { InboxTeamService } from './inbox-team.service';
import { QueryContactsDto } from './dto/query-contacts.dto';
import { UpdateContactDto } from './dto/update-contact.dto';
import { RecordConsentDto } from './dto/record-consent.dto';
import { BulkTagContactsDto } from './dto/bulk-tag-contacts.dto';

/** The people behind the conversations: list, profile, tags, owner, consent, store link. */
@Controller('inbox/contacts')
@RequireSection('chat')
@Roles(...INBOX_ROLES)
export class InboxContactsController {
    constructor(
        private readonly contacts: InboxContactsService,
        private readonly teams: InboxTeamService,
    ) { }

    @Get()
    async list(@CurrentUser() user: SessionPayload, @Query() q: QueryContactsDto) {
        return this.contacts.list(user.orgId!, await this.teams.viewer(user), q);
    }

    @Post('bulk-tag')
    async bulkTag(@CurrentUser() user: SessionPayload, @Body() dto: BulkTagContactsDto) {
        return this.contacts.bulkTag(user.orgId!, await this.teams.viewer(user), dto);
    }

    /** Declared before :id so "tags" is not read as a contact id. */
    @Get('tags')
    async tags(@CurrentUser() user: SessionPayload) {
        return this.contacts.tags(user.orgId!, await this.teams.viewer(user));
    }

    @Get(':id')
    async get(@CurrentUser() user: SessionPayload, @Param('id') id: string) {
        return this.contacts.get(user.orgId!, await this.teams.viewer(user), id);
    }

    @Patch(':id')
    async update(@CurrentUser() user: SessionPayload, @Param('id') id: string, @Body() dto: UpdateContactDto) {
        return this.contacts.update(user.orgId!, await this.teams.viewer(user), id, dto);
    }

    @Post(':id/consent')
    async consent(@CurrentUser() user: SessionPayload, @Param('id') id: string, @Body() dto: RecordConsentDto) {
        return this.contacts.recordConsent(user.orgId!, await this.teams.viewer(user), id, dto);
    }

    /** Store customers to link: the ones sharing the number, or a search. */
    @Get(':id/customers')
    async customers(@CurrentUser() user: SessionPayload, @Param('id') id: string, @Query('q') q?: string) {
        return this.contacts.customerCandidates(user.orgId!, await this.teams.viewer(user), id, q?.slice(0, 120));
    }
}
