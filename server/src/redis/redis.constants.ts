export const REDIS_PREFIX = 'crm:';

export const REDIS_KEYS = {
    SESSION: 'session:',
    LOGIN_ATTEMPTS: 'login_attempts:',
    REFRESH_TOKEN: 'refresh:',
    USER_REFRESH_TOKENS: 'user_tokens:',
    REFRESH_ROTATION: 'refresh_rotation:',
    AUTH_SESSION: 'sid:',
    USER_AUTH_SESSIONS: 'user_sids:',
    OAUTH_SHOPIFY: 'oauth:shopify:',
    OAUTH_INSTAGRAM: 'oauth:instagram:',
    OAUTH_WHATSAPP: 'oauth:whatsapp:',
    /// Holds the Instagram accounts one login turned out to grant, between the
    /// Meta redirect and the merchant picking one. Short-lived and single-use.
    OAUTH_INSTAGRAM_PENDING: 'oauth:instagram:pending:',
    /// Facebook Login for Business for Pages + their Instagram accounts.
    OAUTH_META_PAGES: 'oauth:meta-pages:',
    /// Facebook Login with ads_read, for the Ads page's results.
    OAUTH_META_ADS: 'oauth:meta-ads:',
};

export const REDIS_TTL = {
    SESSION: 900,           // 15 minutes (matches access token)
    LOGIN_ATTEMPTS: 900,    // 15 minute window
    REFRESH_TOKEN: 604800,  // 7 days
    REFRESH_ROTATION: 10,   // grace for a duplicate of a just-spent refresh token
    OAUTH_STATE: 600,       // 10 minutes
};

export const LOGIN_RATE_LIMIT = {
    MAX_ATTEMPTS: 5,
    WINDOW_SECONDS: 900,
};
