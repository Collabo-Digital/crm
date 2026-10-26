import * as Joi from 'joi';

/** Optional elsewhere, but production boots "healthy" without it and then quietly breaks. */
const requiredInProduction = (schema: Joi.Schema) => Joi.any().when('NODE_ENV', { is: 'production', then: schema.required() });

export const validationSchema = Joi.object({
    NODE_ENV: Joi.string().valid('development', 'production', 'test').required(),
    PORT: Joi.number().default(5000),
    DATABASE_URL: Joi.string().required(),
    // Session-mode URL read by the Prisma CLI for migrations; the app itself never uses it.
    DIRECT_URL: Joi.string().optional(),
    REDIS_URL: Joi.string().required(),
    // Required: an unset CORS origin makes the `cors` library allow every origin.
    FRONTEND_URL: Joi.string().uri().required(),
    // Number of reverse-proxy hops in front of the API (1 behind Caddy, 0 when
    // Node is reached directly). Without it req.ip is the proxy's address and
    // every client shares one throttle bucket.
    TRUST_PROXY: Joi.number().integer().min(0).max(5).when('NODE_ENV', { is: 'production', then: Joi.required() }),
    // OAuth callbacks, Shopify webhook registration and product image links;
    // Shopify registers webhooks only on https.
    APP_URL: requiredInProduction(Joi.string().uri({ scheme: ['https'] })),
    JWT_ACCESS_SECRET: Joi.string().min(32).required(),
    JWT_REFRESH_SECRET: Joi.string().min(32).required(),
    // Sign-up verification codes, password resets and invites. Without SMTP
    // they are dropped and new users can never sign in.
    SMTP_HOST: requiredInProduction(Joi.string()),
    SMTP_USER: requiredInProduction(Joi.string()),
    SMTP_PASS: requiredInProduction(Joi.string()),
    SHOPIFY_CLIENT_ID: Joi.string().optional(),
    SHOPIFY_CLIENT_SECRET: Joi.string().optional(),
    SHOPIFY_SCOPES: Joi.string().optional(),
    // Floor for the first orders backfill. Bounded so a typo cannot turn the
    // initial pull into an unbounded full-history scan (or into nothing).
    SHOPIFY_INITIAL_ORDER_WINDOW_DAYS: Joi.number().integer().min(1).max(3650).optional(),
    // Fractions allowed so a test can run the catch-up every few seconds.
    SHOPIFY_RECONCILE_MINUTES: Joi.number().positive().max(1440).optional(),
    // Encrypts channel credentials; without it every channel connect fails.
    ENCRYPTION_KEY: Joi.string().length(32).when('NODE_ENV', { is: 'production', then: Joi.required() }),
    META_APP_ID: Joi.string().optional(),
    META_APP_SECRET: Joi.string().optional(),
    INSTAGRAM_APP_ID: Joi.string().optional(),
    INSTAGRAM_APP_SECRET: Joi.string().optional(),
    INSTAGRAM_WEBHOOK_VERIFY_TOKEN: Joi.string().optional(),
    WHATSAPP_WEBHOOK_VERIFY_TOKEN: Joi.string().optional(),
    WHATSAPP_CONFIG_ID: Joi.string().optional(),
    MESSENGER_CONFIG_ID: Joi.string().optional(),
    MESSENGER_WEBHOOK_VERIFY_TOKEN: Joi.string().optional(),
    MESSAGING_MEDIA_DIR: Joi.string().optional(),
    MESSAGING_MEDIA_SECRET: Joi.string().min(32).optional(),
    FFMPEG_PATH: Joi.string().optional(),
    WHATSAPP_GRAPH_VERSION: Joi.string().optional(),
    META_GRAPH_VERSION: Joi.string().optional(),
    META_GRAPH_BASE_URL: Joi.string().uri().optional(),
    // Outbound rate limiter (see config/configuration.ts `rateLimit`).
    RATE_LIMIT_MODE: Joi.string().valid('enforce', 'observe', 'off').optional(),
    RATE_LIMIT_REDIS_TIMEOUT_MS: Joi.number().integer().min(50).max(5000).optional(),
    RATE_LIMIT_SHOPIFY_DEFAULT_COST: Joi.number().integer().min(1).max(1000).optional(),
    RATE_LIMIT_SHOPIFY_BULK_WATERMARK: Joi.number().min(0).max(0.9).optional(),
    RATE_LIMIT_META_PHONE_MPS: Joi.number().integer().min(1).max(1000).optional(),
    SHOPIFY_PUSH_CONCURRENCY: Joi.number().integer().min(1).max(10).optional(),
    LOCATIONS_AUTO_ENABLE: Joi.string().valid('true', 'false').optional(),
    TEMPLATE_PACK_AUTO_ENABLE: Joi.string().valid('true', 'false').optional(),
    WHATSAPP_MESSAGING_CONCURRENCY: Joi.number().integer().min(1).max(10).optional(),
    SUPER_ADMIN_EMAILS: Joi.string().allow('').optional(),
    RAZORPAY_KEY_ID: Joi.string().optional(),
    RAZORPAY_KEY_SECRET: Joi.string().optional(),
    RAZORPAY_WEBHOOK_SECRET: Joi.string().optional(),
    RAZORPAY_MERCHANT_API_BASE: Joi.string().uri().optional(),
    RAZORPAY_API_BASE: Joi.string().uri().optional(),
    MESSAGING_CHANNELS: Joi.string().pattern(/^(WHATSAPP|INSTAGRAM|FACEBOOK)(,(WHATSAPP|INSTAGRAM|FACEBOOK))*$/i).optional(),
    RAZORPAY_PLAN_BASIC_INR: Joi.string().pattern(/^plan_[A-Za-z0-9]+$/).optional(),
    RAZORPAY_PLAN_BASIC_USD: Joi.string().pattern(/^plan_[A-Za-z0-9]+$/).optional(),
    RAZORPAY_PLAN_GROWTH_INR: Joi.string().pattern(/^plan_[A-Za-z0-9]+$/).optional(),
    RAZORPAY_PLAN_GROWTH_USD: Joi.string().pattern(/^plan_[A-Za-z0-9]+$/).optional(),
    BILLING_SALES_EMAIL: Joi.string().email({ tlds: { allow: false } }).optional(),
    BILLING_USAGE_POLL_SECONDS: Joi.number().integer().min(1).max(86400).optional(),
    JUDGEME_API_BASE: Joi.string().uri().optional(),
    GOOGLE_CLIENT_ID: Joi.string().optional(),
    GOOGLE_CLIENT_SECRET: Joi.string().optional(),
    GOOGLE_OAUTH_AUTH_URL: Joi.string().uri().optional(),
    GOOGLE_OAUTH_TOKEN_URL: Joi.string().uri().optional(),
    GOOGLE_OAUTH_REVOKE_URL: Joi.string().uri().optional(),
    GOOGLE_SHEETS_API_BASE: Joi.string().uri().optional(),
    GOOGLE_SHEETS_POLL_SECONDS: Joi.number().integer().min(1).max(3600).optional(),
    META_ADS_CONFIG_ID: Joi.string().optional(),
    ANTHROPIC_API_KEY: Joi.string().optional(),
    ANTHROPIC_BASE_URL: Joi.string().uri().optional(),
});
