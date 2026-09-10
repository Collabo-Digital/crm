import { Controller, Post, Get, Patch, Delete, Body, Param } from '@nestjs/common';

import type { JwtPayload } from '../auth/interfaces/jwt-payload.interface';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { NoOrgRequired } from '../auth/decorators/no-org-required.decorator';
import { AllowVendor } from '../auth/decorators/allow-vendor.decorator';
import { AllowInfluencer } from '../auth/decorators/allow-influencer.decorator';
import { UserService } from '../user/user.service';
import { OrganizationService } from './organization.service';
import { CreateOrganizationDto } from './dto/create-organization.dto';
import { CreatePersonalDto } from './dto/create-personal.dto';
import { UpdateOrganizationDto } from './dto/update-organization.dto';
import { UpgradeToOrganizationDto } from './dto/upgrade-to-organization.dto';

// JWT required. @NoOrgRequired: create/list orgs must work before JWT has orgId.
@Controller('organizations')
@NoOrgRequired()
export class OrganizationController {
  constructor(
    private readonly orgService: OrganizationService,
    private readonly userService: UserService,
  ) { }

  // POST /api/v1/organizations — create a team org
  @Post()
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateOrganizationDto) {
    return this.orgService.create(user.sub, dto);
  }

  // POST /api/v1/organizations/personal — create personal workspace
  // WHY we need UserService? To get the user's firstName for the workspace name.
  // The body carries the plan chosen during onboarding.
  @Post('personal')
  async createPersonal(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreatePersonalDto,
  ) {
    const fullUser = await this.userService.findById(user.sub);
    return this.orgService.createPersonal(user.sub, fullUser!.firstName, dto);
  }

  // GET /api/v1/organizations — list user's orgs (for org switcher UI)
  @Get()
  @AllowVendor()
  @AllowInfluencer()
  findAll(@CurrentUser() user: JwtPayload) {
    return this.orgService.findAllForUser(user.sub);
  }

  // GET /api/v1/organizations/:orgId — get org details
  @Get(':orgId')
  @AllowVendor()
  @AllowInfluencer()
  findOne(@Param('orgId') orgId: string, @CurrentUser() user: JwtPayload) {
    return this.orgService.findOne(orgId, user.sub);
  }

  // PATCH /api/v1/organizations/:orgId — update settings (OWNER/ADMIN only)
  @Patch(':orgId')
  update(
    @Param('orgId') orgId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateOrganizationDto,
  ) {
    return this.orgService.update(orgId, user.sub, dto);
  }

  // POST /api/v1/organizations/:orgId/upgrade-to-organization
  // Flips a PERSONAL workspace to ORGANIZATION in place. OWNER only.
  // Body collects the onboarding fields (name + logo + industry + website + timezone).
  @Post(':orgId/upgrade-to-organization')
  upgradeToOrganization(
    @Param('orgId') orgId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpgradeToOrganizationDto,
  ) {
    return this.orgService.upgradeToOrganization(orgId, user.sub, dto);
  }

  // DELETE /api/v1/organizations/:orgId — soft delete (OWNER only)
  @Delete(':orgId')
  delete(@Param('orgId') orgId: string, @CurrentUser() user: JwtPayload) {
    return this.orgService.delete(orgId, user.sub);
  }
}