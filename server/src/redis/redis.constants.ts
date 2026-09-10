export const REDIS_PREFIX = 'crm:';

export const REDIS_KEYS = {
    SESSION: 'session:',
    LOGIN_ATTEMPTS: 'login_attempts:',
    REFRESH_TOKEN: 'refresh:',
    USER_REFRESH_TOKENS: 'user_tokens:',
    OAUTH_SHOPIFY: 'oauth:shopify:',
    OAUTH_INSTAGRAM: 'oauth:instagram:',
    OAUTH_WHATSAPP: 'oauth:whatsapp:',
    /// Holds the Instagram accounts one login turned out to grant, between the
    /// Meta redirect and the merchant picking one. Short-lived and single-use.
    OAUTH_INSTAGRAM_PENDING: 'oauth:instagram:pending:',
};

export const REDIS_TTL = {
    SESSION: 900,           // 15 minutes (matches access token)
    LOGIN_ATTEMPTS: 900,    // 15 minute window
    REFRESH_TOKEN: 604800,  // 7 days
    OAUTH_STATE: 600,       // 10 minutes
};

export const LOGIN_RATE_LIMIT = {
    MAX_ATTEMPTS: 5,
    WINDOW_SECONDS: 900,
};
