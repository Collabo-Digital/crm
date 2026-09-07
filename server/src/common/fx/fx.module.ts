import { Global, Module } from '@nestjs/common';
import { FxRateService } from './fx-rate.service';

/**
 * Global so the order sync, the dashboard and the backfill script all resolve
 * the same instance — and therefore share its Redis-backed rate cache rather
 * than each hitting the provider for the same day.
 */
@Global()
@Module({
  providers: [FxRateService],
  exports: [FxRateService],
})
export class FxModule {}
