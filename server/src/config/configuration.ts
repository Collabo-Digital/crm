export default () => ({
    port: parseInt(process.env.PORT ?? '5000', 10),
    nodeEnv: process.env.NODE_ENV,
    appUrl: process.env.APP_URL,
    frontendUrl: process.env.FRONTEND_URL,
    database: { url: process.env.DATABASE_URL },
    redis: {
        url: process.env.REDIS_URL,
    },
    jwt: {
        accessSecret: process.env.JWT_ACCESS_SECRET,
        refreshSecret: process.env.JWT_REFRESH_SECRET,
        accessExpires: process.env.JWT_ACCESS_EXPIRES,
        refreshExpires: process.env.JWT_REFRESH_EXPIRES,
    },
    smtp: {
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT ?? '587', 10),
        secure: process.env.SMTP_SECURE === 'true',
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
        fromEmail: process.env.FROM_EMAIL || 'noreply@yourcrm.com',
        fromName: process.env.FROM_NAME || 'YourCRM',
        replyTo: process.env.REPLY_TO_EMAIL || undefined,
    },
    shopify: {
        clientId: process.env.SHOPIFY_CLIENT_ID,
        clientSecret: process.env.SHOPIFY_CLIENT_SECRET,
        apiVersion: process.env.SHOPIFY_API_VERSION || '2026-01',
        // How far back the FIRST orders backfill reaches on a newly connected
        // store. Only the initial pull is windowed — every later sync is
        // incremental off the per-entity watermark, and an older order still
        // arrives whenever it is edited in Shopify (the incremental filter is
        // `updated_at`, not `created_at`). 60 days also happens to be what
        // Shopify returns without the protected `read_all_orders` scope.
        initialOrderWindowDays: Number.parseInt(
            process.env.SHOPIFY_INITIAL_ORDER_WINDOW_DAYS || '60',
            10,
        ),
        // MUST mirror [access_scopes] in the public app's shopify.app.toml —
        // with include_config_on_deploy, Shopify grants what the TOML declares,
        // regardless of the scope param in the authorize URL.
        scopes: process.env.SHOPIFY_SCOPES ||
            // `read_all_orders` accompanies (does not replace) `read_orders`:
            // without it Shopify only returns the last 60 DAYS of orders, so a
            // merchant's historical import silently truncates and still reports
            // success. It is a protected scope — Shopify requires a written
            // justification for a public app — and, like every scope change, it
            // only applies to stores that authorise AFTER it ships. Existing
            // channels keep their old grant until reconnected, which is what
            // `describeScopeStatus` surfaces.
            'read_products,write_products,read_orders,read_all_orders,write_orders,read_customers,write_customers,read_inventory,write_inventory,read_locations,read_reports,read_draft_orders,write_draft_orders,read_merchant_managed_fulfillment_orders,write_merchant_managed_fulfillment_orders,read_assigned_fulfillment_orders,write_assigned_fulfillment_orders,read_third_party_fulfillment_orders,write_third_party_fulfillment_orders,write_fulfillments,write_pixels,read_customer_events',
    },
    instagram: {
        appId: process.env.META_APP_ID,
        appSecret: process.env.META_APP_SECRET,
        webhookVerifyToken: process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN,
        // Same Graph API version as WhatsApp — one Meta app, one version to
        // bump. Was hardcoded to v21.0 in seven places in the OAuth service.
        graphVersion: process.env.WHATSAPP_GRAPH_VERSION ?? 'v21.0',
    },
    whatsapp: {
        appId: process.env.META_APP_ID,
        appSecret: process.env.META_APP_SECRET,
        configId: process.env.WHATSAPP_CONFIG_ID,
        graphVersion: process.env.WHATSAPP_GRAPH_VERSION ?? 'v21.0',
    },
    encryptionKey: process.env.ENCRYPTION_KEY || undefined,
    superAdminEmails: (process.env.SUPER_ADMIN_EMAILS || '')
        .split(',')
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean),
});