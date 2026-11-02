import { Controller, Get, Query, Res } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, MaxLength } from 'class-validator';
import type { Response } from 'express';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { RequireSection } from '../../auth/decorators/require-section.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import type { SessionPayload } from '../../auth/interfaces/jwt-payload.interface';
import { MessagingAnalyticsService } from './messaging-analytics.service';

export class QueryMessagingAnalyticsDto {
    @IsOptional() @Type(() => Number) @IsInt() @IsIn([7, 30, 90])
    days?: number;

    @IsOptional() @IsString() @MaxLength(40)
    channelId?: string;
}

/**
 * Analytics → Messaging. Per-person figures are for the people who run the
 * team, so agents and viewers do not get them here.
 */
@Controller('analytics/messaging')
@RequireSection('analytics')
@Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.MANAGER)
export class MessagingAnalyticsController {
    constructor(private readonly analytics: MessagingAnalyticsService) { }

    @Get()
    async overview(@CurrentUser() user: SessionPayload, @Query() q: QueryMessagingAnalyticsDto) {
        return this.analytics.overview(user.orgId!, await this.analytics.period(user.orgId!, q.days ?? 30, q.channelId ?? null));
    }

    @Get('agents.csv')
    async agentsCsv(@CurrentUser() user: SessionPayload, @Query() q: QueryMessagingAnalyticsDto, @Res() res: Response) {
        const p = await this.analytics.period(user.orgId!, q.days ?? 30, q.channelId ?? null);
        this.sendCsv(res, `team-${p.days}d.csv`, await this.analytics.agentsCsv(user.orgId!, p));
    }

    @Get('daily.csv')
    async dailyCsv(@CurrentUser() user: SessionPayload, @Query() q: QueryMessagingAnalyticsDto, @Res() res: Response) {
        const p = await this.analytics.period(user.orgId!, q.days ?? 30, q.channelId ?? null);
        this.sendCsv(res, `messages-${p.days}d.csv`, await this.analytics.dailyCsv(user.orgId!, p));
    }

    private sendCsv(res: Response, filename: string, body: string) {
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        // A byte-order mark so spreadsheet apps read ₹ and names correctly.
        res.send(`﻿${body}\n`);
    }
}
