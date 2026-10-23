import {
    Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import type { SessionPayload } from '../auth/interfaces/jwt-payload.interface';
import { AllowInfluencer } from '../auth/decorators/allow-influencer.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { OrgId } from '../auth/decorators/org-id.decorator';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { CHANNEL_MANAGERS, Roles } from '../auth/decorators/roles.decorator';
import { hasPermission } from '../auth/permissions';
import { AutomationService, type AutomationViewer } from './automation.service';
import { InstagramMediaService } from './platforms/instagram/instagram-media.service';
import { CreateAutomationDto } from './dto/create-automation.dto';
import { DuplicateAutomationDto } from './dto/duplicate-automation.dto';
import { QueryAutomationsDto } from './dto/query-automations.dto';
import { SaveDefinitionDto } from './dto/save-definition.dto';
import { UpdateAutomationDto } from './dto/update-automation.dto';
import { QueryMediaDto } from './dto/query-media.dto';
import { SyncMediaDto } from './dto/sync-media.dto';
import { QueryRunsDto, SaveStartersDto, TestAutomationDto } from './dto/automation-insights.dto';
import { AutomationInsightsService } from './automation-insights.service';
import { ConversationStartersService } from './conversation-starters.service';

/**
 * Every route declares explicit @Roles (RolesGuard is allow-by-default),
 * @AllowInfluencer (the influencer guard denies by default) and a
 * @RequirePermissions key. The @Roles group MUST include INFLUENCER or the
 * influencer guard never gets to run (roles.decorator.ts:14-21).
 * CHANNEL_MANAGERS = [OWNER, ADMIN, INFLUENCER]; staff roles are added here.
 */
const READERS: UserRole[] = [...CHANNEL_MANAGERS, UserRole.MANAGER, UserRole.AGENT, UserRole.VIEWER];
const EDITORS: UserRole[] = [...CHANNEL_MANAGERS, UserRole.MANAGER];

function viewerOf(user: SessionPayload): AutomationViewer {
    // Exactly what lets a request through the EDITORS routes below.
    const canManage = !!user.role && EDITORS.includes(user.role) && hasPermission(user.role, user.permissions, 'campaigns.manage');
    return { userId: user.sub, role: user.role, canManage };
}

@Controller('automations')
export class AutomationController {
    constructor(
        private readonly automations: AutomationService,
        private readonly media: InstagramMediaService,
        private readonly insights: AutomationInsightsService,
        private readonly starters: ConversationStartersService,
    ) { }

    // GET /automations — list page
    @Get()
    @Roles(...READERS)
    @AllowInfluencer()
    @RequirePermissions('campaigns.view')
    list(@OrgId() orgId: string, @CurrentUser() user: SessionPayload, @Query() query: QueryAutomationsDto) {
        return this.automations.list(orgId, viewerOf(user), query);
    }

    // POST /automations — Create dialog
    @Post()
    @Roles(...EDITORS)
    @AllowInfluencer()
    @RequirePermissions('campaigns.manage')
    create(@OrgId() orgId: string, @CurrentUser() user: SessionPayload, @Body() dto: CreateAutomationDto) {
        return this.automations.create(orgId, viewerOf(user), dto);
    }

    // GET /automations/media?channelId= — the trigger step's post picker.
    // Refreshes the cache inline when it is older than 30 minutes or ?refresh=1.
    @Get('media')
    @Roles(...READERS)
    @AllowInfluencer()
    @RequirePermissions('campaigns.view')
    listMedia(@OrgId() orgId: string, @CurrentUser() user: SessionPayload, @Query() query: QueryMediaDto) {
        return this.media.list(query.channelId, orgId, viewerOf(user), query);
    }

    // POST /automations/media/sync — "Refresh posts" button.
    @Post('media/sync')
    @HttpCode(200)
    @Roles(...EDITORS)
    @AllowInfluencer()
    @RequirePermissions('campaigns.manage')
    syncMedia(@OrgId() orgId: string, @CurrentUser() user: SessionPayload, @Body() dto: SyncMediaDto) {
        return this.media.refresh(dto.channelId, orgId, viewerOf(user));
    }

    // GET /automations/starters/:channelId — ice breakers, Get Started and menu of a Page or Instagram account
    @Get('starters/:channelId')
    @Roles(...READERS)
    @AllowInfluencer()
    @RequirePermissions('campaigns.view')
    getStarters(@Param('channelId') channelId: string, @OrgId() orgId: string, @CurrentUser() user: SessionPayload) {
        return this.starters.get(orgId, viewerOf(user), channelId);
    }

    // PUT /automations/starters/:channelId — saves and pushes them to Meta
    @Put('starters/:channelId')
    @Roles(...EDITORS)
    @AllowInfluencer()
    @RequirePermissions('campaigns.manage')
    saveStarters(@Param('channelId') channelId: string, @OrgId() orgId: string, @CurrentUser() user: SessionPayload, @Body() dto: SaveStartersDto) {
        return this.starters.save(orgId, viewerOf(user), channelId, dto.starters);
    }

    // GET /automations/:id — editor load
    @Get(':id')
    @Roles(...READERS)
    @AllowInfluencer()
    @RequirePermissions('campaigns.view')
    findOne(@Param('id') id: string, @OrgId() orgId: string, @CurrentUser() user: SessionPayload) {
        return this.automations.findOne(id, orgId, viewerOf(user));
    }

    // GET /automations/:id/issues — "N things need your attention"
    @Get(':id/issues')
    @Roles(...READERS)
    @AllowInfluencer()
    @RequirePermissions('campaigns.view')
    issues(@Param('id') id: string, @OrgId() orgId: string, @CurrentUser() user: SessionPayload) {
        return this.automations.issues(id, orgId, viewerOf(user));
    }

    // GET /automations/:id/stats — runs, per-step counts, messages
    @Get(':id/stats')
    @Roles(...READERS)
    @AllowInfluencer()
    @RequirePermissions('campaigns.view')
    async stats(@Param('id') id: string, @OrgId() orgId: string, @CurrentUser() user: SessionPayload) {
        return this.insights.stats(await this.automations.getVisible(id, orgId, viewerOf(user)));
    }

    // GET /automations/:id/runs — the run log
    @Get(':id/runs')
    @Roles(...READERS)
    @AllowInfluencer()
    @RequirePermissions('campaigns.view')
    async runs(@Param('id') id: string, @OrgId() orgId: string, @CurrentUser() user: SessionPayload, @Query() query: QueryRunsDto) {
        return this.insights.runs(await this.automations.getVisible(id, orgId, viewerOf(user)), query);
    }

    // POST /automations/:id/test — walk the draft without sending anything
    @Post(':id/test')
    @HttpCode(200)
    @Roles(...EDITORS)
    @AllowInfluencer()
    @RequirePermissions('campaigns.manage')
    async test(@Param('id') id: string, @OrgId() orgId: string, @CurrentUser() user: SessionPayload, @Body() dto: TestAutomationDto) {
        return this.insights.test(orgId, await this.automations.getVisible(id, orgId, viewerOf(user)), dto);
    }

    // PATCH /automations/:id — rename / description
    @Patch(':id')
    @Roles(...EDITORS)
    @AllowInfluencer()
    @RequirePermissions('campaigns.manage')
    update(@Param('id') id: string, @OrgId() orgId: string, @CurrentUser() user: SessionPayload, @Body() dto: UpdateAutomationDto) {
        return this.automations.update(id, orgId, viewerOf(user), dto);
    }

    // PUT /automations/:id/definition — Save draft
    @Put(':id/definition')
    @Roles(...EDITORS)
    @AllowInfluencer()
    @RequirePermissions('campaigns.manage')
    saveDefinition(@Param('id') id: string, @OrgId() orgId: string, @CurrentUser() user: SessionPayload, @Body() dto: SaveDefinitionDto) {
        return this.automations.saveDefinition(id, orgId, viewerOf(user), dto);
    }

    // POST /automations/:id/publish — Publish / Update
    @Post(':id/publish')
    @HttpCode(200)
    @Roles(...EDITORS)
    @AllowInfluencer()
    @RequirePermissions('campaigns.manage')
    publish(@Param('id') id: string, @OrgId() orgId: string, @CurrentUser() user: SessionPayload) {
        return this.automations.publish(id, orgId, viewerOf(user));
    }

    @Post(':id/pause')
    @HttpCode(200)
    @Roles(...EDITORS)
    @AllowInfluencer()
    @RequirePermissions('campaigns.manage')
    pause(@Param('id') id: string, @OrgId() orgId: string, @CurrentUser() user: SessionPayload) {
        return this.automations.pause(id, orgId, viewerOf(user));
    }

    @Post(':id/resume')
    @HttpCode(200)
    @Roles(...EDITORS)
    @AllowInfluencer()
    @RequirePermissions('campaigns.manage')
    resume(@Param('id') id: string, @OrgId() orgId: string, @CurrentUser() user: SessionPayload) {
        return this.automations.resume(id, orgId, viewerOf(user));
    }

    @Post(':id/duplicate')
    @Roles(...EDITORS)
    @AllowInfluencer()
    @RequirePermissions('campaigns.manage')
    duplicate(@Param('id') id: string, @OrgId() orgId: string, @CurrentUser() user: SessionPayload, @Body() dto: DuplicateAutomationDto) {
        return this.automations.duplicate(id, orgId, viewerOf(user), dto);
    }

    // DELETE /automations/:id — archive (soft)
    @Delete(':id')
    @Roles(...EDITORS)
    @AllowInfluencer()
    @RequirePermissions('campaigns.manage')
    archive(@Param('id') id: string, @OrgId() orgId: string, @CurrentUser() user: SessionPayload) {
        return this.automations.archive(id, orgId, viewerOf(user));
    }
}