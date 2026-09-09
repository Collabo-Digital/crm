import { Module } from '@nestjs/common';
import { UserModule } from '../user/user.module';
import { BillingModule } from '../billing/billing.module';
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
@Module({
  imports: [UserModule, BillingModule],
  controllers: [OrganizationController, MembersController, InvitesController, InfluencersController],
  providers: [OrganizationService, MembersService, InvitesService],
  exports: [OrganizationService, MembersService],
})
export class OrganizationModule { }