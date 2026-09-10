import * as Joi from 'joi';

export const validationSchema = Joi.object({
    NODE_ENV: Joi.string().valid('development', 'production', 'test').required(),
    PORT: Joi.number().default(5000),
    DATABASE_URL: Joi.string().required(),
    // Session-mode URL read by the Prisma CLI for migrations; the app itself never uses it.
    DIRECT_URL: Joi.string().optional(),
    REDIS_URL: Joi.string().required(),
    JWT_ACCESS_SECRET: Joi.string().min(32).required(),
    JWT_REFRESH_SECRET: Joi.string().min(32).required(),
    RESEND_API_KEY: Joi.string().optional(),
    SHOPIFY_CLIENT_ID: Joi.string().optional(),
    SHOPIFY_CLIENT_SECRET: Joi.string().optional(),
    SHOPIFY_SCOPES: Joi.string().optional(),
    // Floor for the first orders backfill. Bounded so a typo cannot turn the
    // initial pull into an unbounded full-history scan (or into nothing).
    SHOPIFY_INITIAL_ORDER_WINDOW_DAYS: Joi.number().integer().min(1).max(3650).optional(),
    ENCRYPTION_KEY: Joi.string().length(32).optional(),
    META_APP_ID: Joi.string().optional(),
    META_APP_SECRET: Joi.string().optional(),
    INSTAGRAM_WEBHOOK_VERIFY_TOKEN: Joi.string().optional(),
    WHATSAPP_WEBHOOK_VERIFY_TOKEN: Joi.string().optional(),
    WHATSAPP_CONFIG_ID: Joi.string().optional(),
    WHATSAPP_GRAPH_VERSION: Joi.string().optional(),
    META_GRAPH_VERSION: Joi.string().optional(),
    // Outbound rate limiter (see config/configuration.ts `rateLimit`).
    RATE_LIMIT_MODE: Joi.string().valid('enforce', 'observe', 'off').optional(),
    RATE_LIMIT_REDIS_TIMEOUT_MS: Joi.number().integer().min(50).max(5000).optional(),
    RATE_LIMIT_SHOPIFY_DEFAULT_COST: Joi.number().integer().min(1).max(1000).optional(),
    RATE_LIMIT_SHOPIFY_BULK_WATERMARK: Joi.number().min(0).max(0.9).optional(),
    RATE_LIMIT_META_PHONE_MPS: Joi.number().integer().min(1).max(1000).optional(),
    SHOPIFY_PUSH_CONCURRENCY: Joi.number().integer().min(1).max(10).optional(),
    WHATSAPP_MESSAGING_CONCURRENCY: Joi.number().integer().min(1).max(10).optional(),
    SUPER_ADMIN_EMAILS: Joi.string().allow('').optional(),
    RAZORPAY_KEY_ID: Joi.string().optional(),
    RAZORPAY_KEY_SECRET: Joi.string().optional(),
    RAZORPAY_WEBHOOK_SECRET: Joi.string().optional(),
});
