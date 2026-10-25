import { Body, Controller, Delete, Param, Post } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequireSection } from '../auth/decorators/require-section.decorator';
import type { SessionPayload } from '../auth/interfaces/jwt-payload.interface';
import { INBOX_ROLES } from './inbox.controller';
import { InboxContactsService } from './inbox-contacts.service';
import { InboxTeamService } from './inbox-team.service';
import { LinkContactDto } from './dto/link-contact.dto';

/**
 * A customer's chats, linked and unlinked from the customer's page. The list
 * itself comes with the customer; these are inbox edits, so the inbox's rules apply.
 */
@Controller('customers/:customerId/chats')
@RequireSection('chat')
@Roles(...INBOX_ROLES)
export class CustomerChatsController {
    constructor(
        private readonly contacts: InboxContactsService,
        private readonly teams: InboxTeamService,
    ) { }

    @Post()
    async link(@CurrentUser() user: SessionPayload, @Param('customerId') customerId: string, @Body() dto: LinkContactDto) {
        return this.contacts.linkToCustomer(user.orgId!, await this.teams.viewer(user), customerId, dto.contactId);
    }

    @Delete(':contactId')
    async unlink(@CurrentUser() user: SessionPayload, @Param('customerId') customerId: string, @Param('contactId') contactId: string) {
        return this.contacts.unlinkFromCustomer(user.orgId!, await this.teams.viewer(user), customerId, contactId);
    }
}
