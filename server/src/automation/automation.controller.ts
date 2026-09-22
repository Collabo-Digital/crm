import {
    Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import type { JwtPayload } from '../auth/interfaces/jwt-payload.interface';
import { AllowInfluencer } from '../auth/decorators/allow-influencer.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { OrgId } from '../auth/decorators/org-id.decorator';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { CHANNEL_MANAGERS, Roles } from '../auth/decorators/roles.decorator';
import { AutomationService, type AutomationViewer } from './automation.service';
import { CreateAutomationDto } from './dto/create-automation.dto';
import { DuplicateAutomationDto } from './dto/duplicate-automation.dto';
import { QueryAutomationsDto } from './dto/query-automations.dto';
import { SaveDefinitionDto } from './dto/save-definition.dto';
import { UpdateAutomationDto } from './dto/update-automation.dto';

/**
 * Every route declares explicit @Roles (RolesGuard is allow-by-default),
 * @AllowInfluencer (the influencer guard denies by default) and a
 * @RequirePermissions key. The @Roles group MUST include INFLUENCER or the
 * influencer guard never gets to run (roles.decorator.ts:14-21).
 * CHANNEL_MANAGERS = [OWNER, ADMIN, INFLUENCER]; staff roles are added here.
 */
const READERS: UserRole[] = [...CHANNEL_MANAGERS, UserRole.MANAGER, UserRole.AGENT, UserRole.VIEWER];
const EDITORS: UserRole[] = [...CHANNEL_MANAGERS, UserRole.MANAGER];

function viewerOf(user: JwtPayload): AutomationViewer {
    return { userId: user.sub, role: user.role };
}

@Controller('automations')
export class AutomationController {
    constructor(private readonly automations: AutomationService) { }

    // GET /automations — list page
    @Get()
    @Roles(...READERS)
    @AllowInfluencer()
    @RequirePermissions('campaigns.view')
    list(@OrgId() orgId: string, @CurrentUser() user: JwtPayload, @Query() query: QueryAutomationsDto) {
        return this.automations.list(orgId, viewerOf(user), query);
    }

    // POST /automations — Create dialog
    @Post()
    @Roles(...EDITORS)
    @AllowInfluencer()
    @RequirePermissions('campaigns.manage')
    create(@OrgId() orgId: string, @CurrentUser() user: JwtPayload, @Body() dto: CreateAutomationDto) {
        return this.automations.create(orgId, viewerOf(user), dto);
    }

    // NOTE: static segments must be declared before ':id' routes.
    // GET /automations/media is added with the post-picker step.

    // GET /automations/:id — editor load
    @Get(':id')
    @Roles(...READERS)
    @AllowInfluencer()
    @RequirePermissions('campaigns.view')
    findOne(@Param('id') id: string, @OrgId() orgId: string, @CurrentUser() user: JwtPayload) {
        return this.automations.findOne(id, orgId, viewerOf(user));
    }

    // GET /automations/:id/issues — "N things need your attention"
    @Get(':id/issues')
    @Roles(...READERS)
    @AllowInfluencer()
    @RequirePermissions('campaigns.view')
    issues(@Param('id') id: string, @OrgId() orgId: string, @CurrentUser() user: JwtPayload) {
        return this.automations.issues(id, orgId, viewerOf(user));
    }

    // PATCH /automations/:id — rename / description
    @Patch(':id')
    @Roles(...EDITORS)
    @AllowInfluencer()
    @RequirePermissions('campaigns.manage')
    update(@Param('id') id: string, @OrgId() orgId: string, @CurrentUser() user: JwtPayload, @Body() dto: UpdateAutomationDto) {
        return this.automations.update(id, orgId, viewerOf(user), dto);
    }

    // PUT /automations/:id/definition — Save draft
    @Put(':id/definition')
    @Roles(...EDITORS)
    @AllowInfluencer()
    @RequirePermissions('campaigns.manage')
    saveDefinition(@Param('id') id: string, @OrgId() orgId: string, @CurrentUser() user: JwtPayload, @Body() dto: SaveDefinitionDto) {
        return this.automations.saveDefinition(id, orgId, viewerOf(user), dto);
    }

    // POST /automations/:id/publish — Publish / Update
    @Post(':id/publish')
    @HttpCode(200)
    @Roles(...EDITORS)
    @AllowInfluencer()
    @RequirePermissions('campaigns.manage')
    publish(@Param('id') id: string, @OrgId() orgId: string, @CurrentUser() user: JwtPayload) {
        return this.automations.publish(id, orgId, viewerOf(user));
    }

    @Post(':id/pause')
    @HttpCode(200)
    @Roles(...EDITORS)
    @AllowInfluencer()
    @RequirePermissions('campaigns.manage')
    pause(@Param('id') id: string, @OrgId() orgId: string, @CurrentUser() user: JwtPayload) {
        return this.automations.pause(id, orgId, viewerOf(user));
    }

    @Post(':id/resume')
    @HttpCode(200)
    @Roles(...EDITORS)
    @AllowInfluencer()
    @RequirePermissions('campaigns.manage')
    resume(@Param('id') id: string, @OrgId() orgId: string, @CurrentUser() user: JwtPayload) {
        return this.automations.resume(id, orgId, viewerOf(user));
    }

    @Post(':id/duplicate')
    @Roles(...EDITORS)
    @AllowInfluencer()
    @RequirePermissions('campaigns.manage')
    duplicate(@Param('id') id: string, @OrgId() orgId: string, @CurrentUser() user: JwtPayload, @Body() dto: DuplicateAutomationDto) {
        return this.automations.duplicate(id, orgId, viewerOf(user), dto);
    }

    // DELETE /automations/:id — archive (soft)
    @Delete(':id')
    @Roles(...EDITORS)
    @AllowInfluencer()
    @RequirePermissions('campaigns.manage')
    archive(@Param('id') id: string, @OrgId() orgId: string, @CurrentUser() user: JwtPayload) {
        return this.automations.archive(id, orgId, viewerOf(user));
    }
}