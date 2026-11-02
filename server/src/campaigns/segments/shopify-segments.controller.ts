import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { IsString, MaxLength } from 'class-validator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../../auth/decorators/require-permissions.decorator';
import { RequireSection } from '../../auth/decorators/require-section.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import type { SessionPayload } from '../../auth/interfaces/jwt-payload.interface';
import { CAMPAIGN_EDITORS, CAMPAIGN_READERS } from '../campaign-roles';
import { ShopifySegmentsService } from './shopify-segments.service';

class LinkShopifySegmentDto {
    @IsString() @MaxLength(80) externalId!: string;
}

/** Segments → Shopify segments: customer segments from the Shopify admin, as audiences. */
@Controller('campaigns/shopify-segments')
@RequireSection('campaigns')
export class ShopifySegmentsController {
    constructor(private readonly segments: ShopifySegmentsService) { }

    @Get()
    @Roles(...CAMPAIGN_READERS)
    @RequirePermissions('campaigns.view')
    list(@CurrentUser() user: SessionPayload) {
        return this.segments.list(user.orgId!);
    }

    @Post()
    @Roles(...CAMPAIGN_EDITORS)
    @RequirePermissions('campaigns.manage')
    link(@CurrentUser() user: SessionPayload, @Body() dto: LinkShopifySegmentDto) {
        return this.segments.link(user.orgId!, dto.externalId);
    }

    @Post(':id/sync')
    @Roles(...CAMPAIGN_EDITORS)
    @RequirePermissions('campaigns.manage')
    sync(@CurrentUser() user: SessionPayload, @Param('id') id: string) {
        return this.segments.sync(user.orgId!, id);
    }

    @Delete(':id')
    @Roles(...CAMPAIGN_EDITORS)
    @RequirePermissions('campaigns.manage')
    @HttpCode(204)
    async unlink(@CurrentUser() user: SessionPayload, @Param('id') id: string) {
        await this.segments.unlink(user.orgId!, id);
    }
}
