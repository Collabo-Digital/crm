import { Body, Controller, Delete, Get, HttpCode, Put, Query } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { RequireSection } from '../auth/decorators/require-section.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import type { SessionPayload } from '../auth/interfaces/jwt-payload.interface';
import { CAMPAIGN_READERS } from '../campaigns/campaign-roles';
import { ConnectJudgemeDto, ListReviewsQuery } from './reviews.dto';
import { ReviewsService } from './reviews.service';

/** Connecting the store's Judge.me is for owners and admins. */
const ACCOUNT_OWNERS: UserRole[] = [UserRole.OWNER, UserRole.ADMIN];

/** Campaigns → Reviews: ratings and reviews customers gave on WhatsApp, and the Judge.me they are published to. */
@Controller('reviews')
@RequireSection('campaigns')
export class ReviewsController {
    constructor(private readonly reviews: ReviewsService) { }

    @Get()
    @Roles(...CAMPAIGN_READERS)
    @RequirePermissions('campaigns.view')
    list(@CurrentUser() user: SessionPayload, @Query() q: ListReviewsQuery) {
        return this.reviews.list(user.orgId!, q);
    }

    @Get('judgeme')
    @Roles(...CAMPAIGN_READERS)
    @RequirePermissions('campaigns.view')
    account(@CurrentUser() user: SessionPayload) {
        return this.reviews.account(user.orgId!);
    }

    @Put('judgeme')
    @Roles(...ACCOUNT_OWNERS)
    connect(@CurrentUser() user: SessionPayload, @Body() dto: ConnectJudgemeDto) {
        return this.reviews.connect(user.orgId!, user.sub, dto);
    }

    @Delete('judgeme')
    @Roles(...ACCOUNT_OWNERS)
    @HttpCode(204)
    async disconnect(@CurrentUser() user: SessionPayload) {
        await this.reviews.disconnect(user.orgId!);
    }
}
