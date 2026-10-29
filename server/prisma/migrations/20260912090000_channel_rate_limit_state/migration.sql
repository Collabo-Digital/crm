-- Outbound rate limiter: per-channel breaker state, written when Shopify or
-- Meta actually refuse a request and a cooldown is running. Nullable and
-- additive; idempotent so re-running is harmless.
ALTER TABLE "channels" ADD COLUMN IF NOT EXISTS "rate_limited_until" TIMESTAMP(3);
ALTER TABLE "channels" ADD COLUMN IF NOT EXISTS "rate_limit_reason" TEXT;
