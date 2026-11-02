import { Controller, Get, Logger, Post, Query } from '@nestjs/common';
import { OrgId } from '../auth/decorators/org-id.decorator';
import { RequireSection } from '../auth/decorators/require-section.decorator';
import { ORG_OPERATORS, Roles } from '../auth/decorators/roles.decorator';
import { AnalyticsService } from './analytics.service';
import { AnalyticsDashboardService } from './analytics-dashboard.service';
import {
  RefreshResult,
  ShopifyAnalyticsService,
} from '../channel/shopify-analytics.service';
import { CartEventsAggregator } from './cart-events-aggregator.service';
import { PixelEventsAggregator } from './pixel-events-aggregator.service';
import { QueryAnalyticsDto, rangeToDays } from './dto/query-analytics.dto';
import { PrismaService } from '../prisma/prisma.service';

@RequireSection('analytics')
@Controller('analytics')
export class AnalyticsController {
  private readonly logger = new Logger(AnalyticsController.name);

  constructor(
    private readonly analytics: AnalyticsService,
    private readonly dashboard: AnalyticsDashboardService,
    private readonly shopifyAnalytics: ShopifyAnalyticsService,
    private readonly cartAggregator: CartEventsAggregator,
    private readonly pixelAggregator: PixelEventsAggregator,
    private readonly prisma: PrismaService,
  ) {}

  // GET /api/v1/analytics/overview?range=30d|6m|12m&channelId=xxx
  @Get('overview')
  getOverview(
    @OrgId() orgId: string,
    @Query() query: QueryAnalyticsDto,
  ) {
    return this.analytics.getOverview(orgId, query);
  }

  // GET /api/v1/analytics/dashboard?range=30d|6m|12m&channel=all|shopify|instagram|whatsapp
  // Pixel-first dashboard: 3 stat cards, top pages, top add-to-cart
  // products, and the cart→checkout→orders trend. Returns the same shape
  // for every channel filter.
  @Get('dashboard')
  getDashboard(
    @OrgId() orgId: string,
    @Query() query: QueryAnalyticsDto,
  ) {
    return this.dashboard.getDashboard(orgId, query);
  }

  // POST /api/v1/analytics/refresh?channelId=xxx
  // On-demand refresh trigger for the merchant. Used by the "Refresh"
  // action on the analytics page. Returns per-channel diagnostics so
  // the UI can show *why* a fallback was used when one was.
  //
  // This endpoint never throws: per-channel failures are captured as
  // structured `RefreshResult` entries so a single Shopify hiccup can't
  // produce a generic "Could not refresh" toast.
  //
  // It calls Shopify and rewrites the snapshots, so viewers, who only read,
  // are left out.
  @Post('refresh')
  @Roles(...ORG_OPERATORS)
  async refresh(
    @OrgId() orgId: string,
    @Query() query: QueryAnalyticsDto,
  ) {
    const channels = await this.prisma.channel.findMany({
      where: {
        organizationId: orgId,
        platform: 'SHOPIFY',
        ...(query.channelId && { id: query.channelId }),
      },
      select: { id: true },
    });
    // Respect the date-range selector — refresh as far back as the merchant
    // is viewing. Defaults to 12m when not provided. The scheduler still
    // runs daily on a 35-day sliding window to keep recent data fresh.
    const daysBack = rangeToDays(query.range);
    this.logger.log(
      `[analytics] Refresh requested for ${channels.length} channel(s), window=${daysBack}d (range=${query.range ?? '12m'})`,
    );
    const results: RefreshResult[] = await Promise.all(
      channels.map(async (c) => {
        try {
          return await this.shopifyAnalytics.refreshForChannel(c.id, daysBack);
        } catch (err) {
          this.logger.error(
            `[analytics] refreshForChannel threw for channel=${c.id}`,
            err instanceof Error ? err.stack : String(err),
          );
          return {
            channelId: c.id,
            source: 'shopify_orders_fb' as const,
            snapshotsWritten: 0,
            error:
              err instanceof Error
                ? err.message
                : `Unexpected error: ${String(err)}`,
            errorCode: 'UNEXPECTED_ERROR',
          };
        }
      }),
    );

    // Also roll up the last 24h of cart + checkout webhook events so the
    // user sees per-product add-to-cart and conversion data without
    // waiting for the next hourly cron tick.
    try {
      await this.cartAggregator.rollupRecentDay(orgId);
    } catch (err) {
      this.logger.warn(
        `[analytics] Cart aggregation failed during refresh: ${err instanceof Error ? err.message : err}`,
      );
    }

    // Same for the last 24h of Web Pixel events — feeds the pixel-first
    // dashboard (pages, add-to-cart, abandoned carts) immediately.
    try {
      await this.pixelAggregator.rollupRecentDay(orgId);
    } catch (err) {
      this.logger.warn(
        `[analytics] Pixel aggregation failed during refresh: ${err instanceof Error ? err.message : err}`,
      );
    }

    return {
      refreshed: results.length,
      results,
    };
  }
}
