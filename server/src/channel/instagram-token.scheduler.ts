import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ChannelPlatform, ChannelStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { Priority } from '../rate-limit/rate-limit.types';
import { InstagramOAuthService } from './instagram-oauth.service';
import {
    INSTAGRAM_LOGIN_FLOW,
    INSTAGRAM_SCHEDULED_REFRESH_AHEAD_MS,
    isInstagramTokenRefreshDue,
} from './instagram-login.util';

/**
 * Keeps Instagram Login tokens alive.
 *
 * A long-lived Instagram token lasts 60 days and cannot be refreshed once it
 * expires, so an account nobody sends anything through would otherwise
 * disconnect on its own. Once a day, every connected account inside the refresh
 * window gets a fresh token. A failure is left for tomorrow's run unless Meta
 * rejected the token outright, in which case the service marks it ERROR.
 */
@Injectable()
export class InstagramTokenScheduler {
    private readonly logger = new Logger(InstagramTokenScheduler.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly instagramOAuth: InstagramOAuthService,
    ) { }

    @Cron(CronExpression.EVERY_DAY_AT_3AM)
    async refreshExpiringTokens() {
        const rows = await this.prisma.channel.findMany({
            where: {
                platform: ChannelPlatform.INSTAGRAM,
                status: ChannelStatus.CONNECTED,
                credentials: { path: ['authFlow'], equals: INSTAGRAM_LOGIN_FLOW },
            },
            select: { id: true, credentials: true },
        });

        const now = new Date();
        const due = rows.filter((r) =>
            isInstagramTokenRefreshDue(r.credentials, now, INSTAGRAM_SCHEDULED_REFRESH_AHEAD_MS),
        );
        if (due.length === 0) return;

        let refreshed = 0;
        for (const row of due) {
            try {
                await this.instagramOAuth.refreshToken(row.id, Priority.NORMAL);
                refreshed++;
            } catch (err) {
                this.logger.warn(
                    `Instagram token refresh for channel ${row.id} failed: ${err instanceof Error ? err.message : String(err)}`,
                );
            }
        }
        this.logger.log(`Instagram token refresh: ${refreshed}/${due.length} refreshed`);
    }
}
