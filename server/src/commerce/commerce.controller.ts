import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { RequireSection } from '../auth/decorators/require-section.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import type { SessionPayload } from '../auth/interfaces/jwt-payload.interface';
import { CAMPAIGN_EDITORS, CAMPAIGN_READERS } from '../campaigns/campaign-roles';
import { CatalogService } from './catalog.service';
import { CommerceSettingsDto, ConnectCatalogDto } from './dto/commerce.dto';

/** Campaigns → Catalog: the WhatsApp number's Meta catalog and commerce settings. */
@Controller('commerce/catalog')
@RequireSection('campaigns')
export class CommerceController {
    constructor(private readonly catalog: CatalogService) { }

    @Get(':channelId')
    @Roles(...CAMPAIGN_READERS)
    @RequirePermissions('campaigns.view')
    view(@CurrentUser() user: SessionPayload, @Param('channelId') channelId: string) {
        return this.catalog.view(user.orgId!, channelId);
    }

    @Put(':channelId')
    @Roles(...CAMPAIGN_EDITORS)
    @RequirePermissions('campaigns.manage')
    connect(@CurrentUser() user: SessionPayload, @Param('channelId') channelId: string, @Body() dto: ConnectCatalogDto) {
        return this.catalog.connect(user.orgId!, channelId, dto.catalogId);
    }

    @Delete(':channelId')
    @Roles(...CAMPAIGN_EDITORS)
    @RequirePermissions('campaigns.manage')
    disconnect(@CurrentUser() user: SessionPayload, @Param('channelId') channelId: string) {
        return this.catalog.disconnect(user.orgId!, channelId);
    }

    @Patch(':channelId/settings')
    @Roles(...CAMPAIGN_EDITORS)
    @RequirePermissions('campaigns.manage')
    settings(@CurrentUser() user: SessionPayload, @Param('channelId') channelId: string, @Body() dto: CommerceSettingsDto) {
        return this.catalog.setCommerce(user.orgId!, channelId, dto);
    }

    @Post(':channelId/sync')
    @HttpCode(200)
    @Roles(...CAMPAIGN_EDITORS)
    @RequirePermissions('campaigns.manage')
    sync(@CurrentUser() user: SessionPayload, @Param('channelId') channelId: string) {
        return this.catalog.sync(user.orgId!, channelId);
    }
}
