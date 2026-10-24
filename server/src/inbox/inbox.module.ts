import { Module } from '@nestjs/common';
import { ChannelModule } from '../channel/channel.module';
import { MessagingModule } from '../messaging/messaging.module';
import { CampaignsModule } from '../campaigns/campaigns.module';
import { CommerceModule } from '../commerce/commerce.module';
import { PaymentsModule } from '../payments/payments.module';
import { InboxController } from './inbox.controller';
import { InboxContactsController } from './inbox-contacts.controller';
import { InboxWorkspaceController } from './inbox-workspace.controller';
import { InboxMediaController } from './inbox-media.controller';
import { InboxService } from './inbox.service';
import { InboxContactsService } from './inbox-contacts.service';
import { ContactImportService } from './contact-import.service';
import { InboxTeamService } from './inbox-team.service';
import { InboxViewService } from './inbox-view.service';
import { QuickReplyService } from './quick-reply.service';
import { InboxMaintenance } from './inbox.maintenance';
import { InboxSettingsService } from './inbox-settings.service';
import { InboxRulesService } from './inbox-rules.service';
import { WhatsAppGroupsController } from './groups/whatsapp-groups.controller';
import { WhatsAppGroupsService } from './groups/whatsapp-groups.service';

@Module({
    imports: [ChannelModule, MessagingModule, CampaignsModule, CommerceModule, PaymentsModule],
    controllers: [InboxController, InboxContactsController, InboxWorkspaceController, InboxMediaController, WhatsAppGroupsController],
    providers: [
        InboxService, InboxContactsService, ContactImportService, InboxTeamService, InboxViewService, QuickReplyService, InboxMaintenance,
        InboxSettingsService, InboxRulesService, WhatsAppGroupsService,
    ],
    exports: [InboxTeamService, InboxSettingsService, InboxRulesService, WhatsAppGroupsService],
})
export class InboxModule { }
