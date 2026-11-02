import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { IsBoolean, IsString, MaxLength } from 'class-validator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { RequireSection } from '../auth/decorators/require-section.decorator';
import { ORG_MANAGERS, Roles } from '../auth/decorators/roles.decorator';
import type { SessionPayload } from '../auth/interfaces/jwt-payload.interface';
import { CAMPAIGN_READERS } from '../campaigns/campaign-roles';
import { AdsService } from './ads.service';

class ConnectAdsDto {
    @IsString() @MaxLength(2000) code!: string;
    @IsString() @MaxLength(64) state!: string;
}

class ChooseAccountDto {
    @IsString() @MaxLength(40) externalId!: string;
}

class ConversionsDto {
    @IsBoolean() enabled!: boolean;
}

/** Sending customers' ad click ids to Meta is for owners and admins. */
const ACCOUNT_OWNERS: UserRole[] = [UserRole.OWNER, UserRole.ADMIN];

/** Campaigns → Ads: chats, orders and revenue per click-to-message ad, with Meta's results when connected. */
@Controller('ads')
@RequireSection('campaigns')
export class AdsController {
    constructor(private readonly ads: AdsService) { }

    @Get('report')
    @Roles(...CAMPAIGN_READERS)
    @RequirePermissions('campaigns.view')
    report(@CurrentUser() user: SessionPayload, @Query('days') days?: string) {
        const n = Number(days);
        return this.ads.report(user.orgId!, [7, 30, 90].includes(n) ? n : 30);
    }

    @Get('account')
    @Roles(...CAMPAIGN_READERS)
    @RequirePermissions('campaigns.view')
    account(@CurrentUser() user: SessionPayload) {
        return this.ads.accountView(user.orgId!);
    }

    @Get('account/connect')
    @Roles(...ORG_MANAGERS)
    connectConfig(@CurrentUser() user: SessionPayload) {
        return this.ads.connectConfig(user.orgId!, user.sub);
    }

    @Post('account/connect')
    @Roles(...ORG_MANAGERS)
    connect(@CurrentUser() user: SessionPayload, @Body() dto: ConnectAdsDto) {
        return this.ads.completeConnect(user.orgId!, user.sub, dto.code, dto.state);
    }

    @Put('account')
    @Roles(...ORG_MANAGERS)
    choose(@CurrentUser() user: SessionPayload, @Body() dto: ChooseAccountDto) {
        return this.ads.chooseAccount(user.orgId!, dto.externalId);
    }

    @Delete('account')
    @Roles(...ORG_MANAGERS)
    @HttpCode(204)
    async disconnect(@CurrentUser() user: SessionPayload) {
        await this.ads.disconnect(user.orgId!);
    }

    @Get('conversions')
    @Roles(...CAMPAIGN_READERS)
    @RequirePermissions('campaigns.view')
    conversions(@CurrentUser() user: SessionPayload) {
        return this.ads.conversionSettings(user.orgId!);
    }

    @Put('conversions/:channelId')
    @Roles(...ACCOUNT_OWNERS)
    setConversions(@CurrentUser() user: SessionPayload, @Param('channelId') channelId: string, @Body() dto: ConversionsDto) {
        return this.ads.setConversions(user.orgId!, channelId, dto.enabled);
    }
}
