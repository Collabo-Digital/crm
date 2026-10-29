import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../../auth/decorators/require-permissions.decorator';
import { RequireSection } from '../../auth/decorators/require-section.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import type { SessionPayload } from '../../auth/interfaces/jwt-payload.interface';
import { CAMPAIGN_EDITORS, CAMPAIGN_READERS } from '../campaign-roles';
import { PreviewSegmentDto, SaveSegmentDto, UpdateSegmentDto } from '../dto/campaign.dto';
import { SegmentsService } from './segments.service';

/** Saved audiences built from rules. */
@Controller('campaigns/segments')
@RequireSection('campaigns')
export class SegmentsController {
    constructor(private readonly segments: SegmentsService) { }

    @Get()
    @Roles(...CAMPAIGN_READERS)
    @RequirePermissions('campaigns.view')
    list(@CurrentUser() user: SessionPayload) {
        return this.segments.list(user.orgId!);
    }

    @Get('rfm')
    @Roles(...CAMPAIGN_READERS)
    @RequirePermissions('campaigns.view')
    rfm(@CurrentUser() user: SessionPayload) {
        return this.segments.rfmSummary(user.orgId!);
    }

    @Post('preview')
    @Roles(...CAMPAIGN_READERS)
    @RequirePermissions('campaigns.view')
    preview(@CurrentUser() user: SessionPayload, @Body() dto: PreviewSegmentDto) {
        return this.segments.preview(user.orgId!, dto.definition);
    }

    @Get(':id')
    @Roles(...CAMPAIGN_READERS)
    @RequirePermissions('campaigns.view')
    get(@CurrentUser() user: SessionPayload, @Param('id') id: string) {
        return this.segments.get(user.orgId!, id);
    }

    @Post()
    @Roles(...CAMPAIGN_EDITORS)
    @RequirePermissions('campaigns.manage')
    create(@CurrentUser() user: SessionPayload, @Body() dto: SaveSegmentDto) {
        return this.segments.create(user.orgId!, user.sub, dto);
    }

    @Patch(':id')
    @Roles(...CAMPAIGN_EDITORS)
    @RequirePermissions('campaigns.manage')
    update(@CurrentUser() user: SessionPayload, @Param('id') id: string, @Body() dto: UpdateSegmentDto) {
        return this.segments.update(user.orgId!, id, dto);
    }

    @Delete(':id')
    @Roles(...CAMPAIGN_EDITORS)
    @RequirePermissions('campaigns.manage')
    remove(@CurrentUser() user: SessionPayload, @Param('id') id: string) {
        return this.segments.remove(user.orgId!, id);
    }
}
