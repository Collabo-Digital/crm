import { Global, Module } from '@nestjs/common';
import { CostHintStore } from './cost-hint.store';
import { LocalFallbackLimiter } from './local-fallback.limiter';
import { RateLimitStateService } from './rate-limit-state.service';
import { RateLimiterService } from './rate-limiter.service';

/**
 * Outbound rate limiting for every third-party API the server calls.
 *
 * Global for the same reason RedisModule is: the Shopify client, the Meta
 * client and every queue processor need it, and none of them should have to
 * import a module to get it.
 */
@Global()
@Module({
  providers: [LocalFallbackLimiter, RateLimiterService, CostHintStore, RateLimitStateService],
  exports: [RateLimiterService, CostHintStore, RateLimitStateService],
})
export class RateLimitModule {}
