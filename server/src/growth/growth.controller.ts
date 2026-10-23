import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { RequireSection } from '../auth/decorators/require-section.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import type { SessionPayload } from '../auth/interfaces/jwt-payload.interface';
import { CAMPAIGN_EDITORS, CAMPAIGN_READERS } from '../campaigns/campaign-roles';
import { CreateGrowthLinkDto, SaveWidgetDto, UpdateGrowthLinkDto } from './dto/growth.dto';
import { WidgetSettingsSchema } from './growth.util';
import { GrowthService } from './growth.service';

/** Campaigns → Growth: chat links with QR codes, and the website button and pop-up. */
@Controller('growth')
@RequireSection('campaigns')
export class GrowthController {
    constructor(private readonly growth: GrowthService) { }

    @Get('links')
    @Roles(...CAMPAIGN_READERS)
    @RequirePermissions('campaigns.view')
    links(@CurrentUser() user: SessionPayload) {
        return this.growth.listLinks(user.orgId!);
    }

    @Post('links')
    @Roles(...CAMPAIGN_EDITORS)
    @RequirePermissions('campaigns.manage')
    create(@CurrentUser() user: SessionPayload, @Body() dto: CreateGrowthLinkDto) {
        return this.growth.createLink(user.orgId!, user.sub, dto);
    }

    @Patch('links/:id')
    @Roles(...CAMPAIGN_EDITORS)
    @RequirePermissions('campaigns.manage')
    update(@CurrentUser() user: SessionPayload, @Param('id') id: string, @Body() dto: UpdateGrowthLinkDto) {
        return this.growth.updateLink(user.orgId!, id, dto);
    }

    @Delete('links/:id')
    @Roles(...CAMPAIGN_EDITORS)
    @RequirePermissions('campaigns.manage')
    @HttpCode(204)
    async archive(@CurrentUser() user: SessionPayload, @Param('id') id: string) {
        await this.growth.archiveLink(user.orgId!, id);
    }

    @Get('links/:id/qr')
    @Roles(...CAMPAIGN_READERS)
    @RequirePermissions('campaigns.view')
    async qr(@CurrentUser() user: SessionPayload, @Param('id') id: string, @Query('format') format: string | undefined, @Res() res: Response) {
        const qr = await this.growth.qr(user.orgId!, id, format === 'png' ? 'png' : 'svg');
        res.setHeader('Content-Type', qr.type);
        res.setHeader('Content-Disposition', `attachment; filename="${qr.filename}"`);
        res.setHeader('Cache-Control', 'private, max-age=300');
        res.send(qr.body);
    }

    @Get('widget')
    @Roles(...CAMPAIGN_READERS)
    @RequirePermissions('campaigns.view')
    widget(@CurrentUser() user: SessionPayload) {
        return this.growth.widget(user.orgId!);
    }

    @Put('widget')
    @Roles(...CAMPAIGN_EDITORS)
    @RequirePermissions('campaigns.manage')
    saveWidget(@CurrentUser() user: SessionPayload, @Body() dto: SaveWidgetDto) {
        const settings = WidgetSettingsSchema.safeParse(dto.settings);
        if (!settings.success) throw new BadRequestException(settings.error.issues[0]?.message ?? 'Check the widget settings.');
        return this.growth.saveWidget(user.orgId!, user.sub, { ...dto, settings: settings.data });
    }
}
