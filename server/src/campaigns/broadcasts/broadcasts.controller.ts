import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../../auth/decorators/require-permissions.decorator';
import { RequireSection } from '../../auth/decorators/require-section.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import type { SessionPayload } from '../../auth/interfaces/jwt-payload.interface';
import { CAMPAIGN_EDITORS, CAMPAIGN_READERS } from '../campaign-roles';
import {
    QueryBroadcastsDto,
    QueryRecipientsDto,
    ReplaceRatesDto,
    SaveBroadcastDto,
    ScheduleBroadcastDto,
    TestSendDto,
} from '../dto/campaign.dto';
import { CampaignsOverviewService } from '../overview/campaigns-overview.service';
import { MessageRatesService } from '../rates/message-rates.service';
import { BroadcastsService } from './broadcasts.service';

/**
 * WhatsApp broadcasts. Sending, testing, cancelling and retrying need
 * `broadcasts.send`: they reach customers and Meta bills them.
 */
@Controller('campaigns')
@RequireSection('campaigns')
export class BroadcastsController {
    constructor(
        private readonly broadcasts: BroadcastsService,
        private readonly rates: MessageRatesService,
        private readonly overviewService: CampaignsOverviewService,
    ) { }

    @Get('overview')
    @Roles(...CAMPAIGN_READERS)
    @RequirePermissions('campaigns.view')
    overview(@CurrentUser() user: SessionPayload) {
        return this.overviewService.overview(user.orgId!);
    }

    @Get('rates')
    @Roles(...CAMPAIGN_READERS)
    @RequirePermissions('campaigns.view')
    listRates(@CurrentUser() user: SessionPayload) {
        return this.rates.list(user.orgId!);
    }

    @Put('rates')
    @Roles(...CAMPAIGN_EDITORS)
    @RequirePermissions('campaigns.manage')
    replaceRates(@CurrentUser() user: SessionPayload, @Body() dto: ReplaceRatesDto) {
        return this.rates.replace(user.orgId!, dto.rows);
    }

    @Get('broadcasts')
    @Roles(...CAMPAIGN_READERS)
    @RequirePermissions('campaigns.view')
    list(@CurrentUser() user: SessionPayload, @Query() q: QueryBroadcastsDto) {
        return this.broadcasts.list(user.orgId!, q);
    }

    @Post('broadcasts')
    @Roles(...CAMPAIGN_EDITORS)
    @RequirePermissions('campaigns.manage')
    create(@CurrentUser() user: SessionPayload, @Body() dto: SaveBroadcastDto) {
        return this.broadcasts.create(user.orgId!, user.sub, dto);
    }

    @Get('broadcasts/:id')
    @Roles(...CAMPAIGN_READERS)
    @RequirePermissions('campaigns.view')
    get(@CurrentUser() user: SessionPayload, @Param('id') id: string) {
        return this.broadcasts.get(user.orgId!, id);
    }

    @Get('broadcasts/:id/recipients')
    @Roles(...CAMPAIGN_READERS)
    @RequirePermissions('campaigns.view')
    recipients(@CurrentUser() user: SessionPayload, @Param('id') id: string, @Query() q: QueryRecipientsDto) {
        return this.broadcasts.recipients(user.orgId!, id, q);
    }

    @Patch('broadcasts/:id')
    @Roles(...CAMPAIGN_EDITORS)
    @RequirePermissions('campaigns.manage')
    update(@CurrentUser() user: SessionPayload, @Param('id') id: string, @Body() dto: SaveBroadcastDto) {
        return this.broadcasts.update(user.orgId!, id, dto);
    }

    @Delete('broadcasts/:id')
    @Roles(...CAMPAIGN_EDITORS)
    @RequirePermissions('campaigns.manage')
    remove(@CurrentUser() user: SessionPayload, @Param('id') id: string) {
        return this.broadcasts.remove(user.orgId!, id);
    }

    @Post('broadcasts/:id/duplicate')
    @Roles(...CAMPAIGN_EDITORS)
    @RequirePermissions('campaigns.manage')
    duplicate(@CurrentUser() user: SessionPayload, @Param('id') id: string) {
        return this.broadcasts.duplicate(user.orgId!, user.sub, id);
    }

    @Post('broadcasts/:id/preview')
    @Roles(...CAMPAIGN_READERS)
    @RequirePermissions('campaigns.view')
    preview(@CurrentUser() user: SessionPayload, @Param('id') id: string) {
        return this.broadcasts.preview(user.orgId!, id);
    }

    @Post('broadcasts/:id/test')
    @Roles(...CAMPAIGN_EDITORS)
    @RequirePermissions('broadcasts.send')
    test(@CurrentUser() user: SessionPayload, @Param('id') id: string, @Body() dto: TestSendDto) {
        return this.broadcasts.testSend(user.orgId!, id, dto.phone);
    }

    @Post('broadcasts/:id/send')
    @Roles(...CAMPAIGN_EDITORS)
    @RequirePermissions('broadcasts.send')
    send(@CurrentUser() user: SessionPayload, @Param('id') id: string, @Body() dto: ScheduleBroadcastDto) {
        return this.broadcasts.schedule(user.orgId!, id, dto.scheduledAt);
    }

    @Post('broadcasts/:id/cancel')
    @Roles(...CAMPAIGN_EDITORS)
    @RequirePermissions('broadcasts.send')
    cancel(@CurrentUser() user: SessionPayload, @Param('id') id: string) {
        return this.broadcasts.cancel(user.orgId!, id);
    }

    @Post('broadcasts/:id/retry')
    @Roles(...CAMPAIGN_EDITORS)
    @RequirePermissions('broadcasts.send')
    retry(@CurrentUser() user: SessionPayload, @Param('id') id: string) {
        return this.broadcasts.retryFailed(user.orgId!, id);
    }
}
