import { Module } from '@nestjs/common';
import { UserModule } from '../user/user.module';
import { BillingModule } from '../billing/billing.module';
import { ChannelModule } from '../channel/channel.module';
import { MessagingModule } from '../messaging/messaging.module';
import { OrganizationService } from './organization.service';
import { MembersService } from './members.service';
import { InvitesService } from './invites.service';
import { OrganizationController } from './organization.controller';
import { MembersController } from './members.controller';
import { InfluencersController } from './influencers.controller';
import { InvitesController } from './invites.controller';

// WHY import UserModule?
// OrganizationController needs UserService.findById() to get firstName for personal workspace.
//
// WHY import BillingModule?
// OrganizationService.create()/createPersonal() call BillingService.applyPendingSubscriptionToOrg
// inside a transaction to gate org creation behind a paid subscription.
//
// WHY import ChannelModule and MessagingModule?
// Deleting a workspace disconnects its channels; removing a member tells open
// inboxes about the conversations released. Neither imports this module.
@Module({
  imports: [UserModule, BillingModule, ChannelModule, MessagingModule],
  controllers: [OrganizationController, MembersController, InvitesController, InfluencersController],
  providers: [OrganizationService, MembersService, InvitesService],
  exports: [OrganizationService, MembersService],
})
export class OrganizationModule { }