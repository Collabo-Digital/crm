import { Module } from '@nestjs/common';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';
import { AnalyticsDashboardService } from './analytics-dashboard.service';
import { AnalyticsScheduler } from './analytics.scheduler';
import { CartEventsAggregator } from './cart-events-aggregator.service';
import { PixelEventsAggregator } from './pixel-events-aggregator.service';
import { PixelIngestController } from './pixel-ingest.controller';
import { PixelIngestService } from './pixel-ingest.service';
import { ChannelModule } from '../channel/channel.module';
import { MessagingAnalyticsController } from './messaging/messaging-analytics.controller';
import { MessagingAnalyticsService } from './messaging/messaging-analytics.service';

@Module({
  imports: [ChannelModule],
  controllers: [MessagingAnalyticsController, AnalyticsController, PixelIngestController],
  providers: [
    AnalyticsService,
    AnalyticsDashboardService,
    AnalyticsScheduler,
    CartEventsAggregator,
    PixelIngestService,
    PixelEventsAggregator,
    MessagingAnalyticsService,
  ],
  exports: [AnalyticsService, CartEventsAggregator],
})
export class AnalyticsModule { }
