export const REDIS_PREFIX = 'crm:';

export const REDIS_KEYS = {
    SESSION: 'session:',
    LOGIN_ATTEMPTS: 'login_attempts:',
    /// Set for a short gap after an email of one kind goes to one recipient.
    EMAIL_SEND_GAP: 'email_gap:',
    /// Emails of one kind sent to one recipient in the last hour.
    EMAIL_SEND_COUNT: 'email_count:',
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
    /// Google OAuth for Google Sheets in automations.
    OAUTH_GOOGLE: 'oauth:google:',
    /// A Google access token minted from the organization's refresh token, kept until just before it expires.
    GOOGLE_ACCESS_TOKEN: 'google:access:',
};

export const REDIS_TTL = {
    SESSION: 900,           // 15 minutes (matches access token)
    LOGIN_ATTEMPTS: 900,    // 15 minute window
    REFRESH_TOKEN: 604800,  // 7 days
    REFRESH_ROTATION: 10,   // grace for a duplicate of a just-spent refresh token
    OAUTH_STATE: 600,       // 10 minutes
};

export const LOGIN_RATE_LIMIT = {
    /** Per address from one IP address. */
    MAX_ATTEMPTS: 5,
    /**
     * Per address from anywhere. High enough that a stranger who knows the
     * address must work at it to lock the owner out, low enough to stop
     * guessing spread over many IP addresses.
     */
    MAX_ATTEMPTS_ANY_IP: 50,
    WINDOW_SECONDS: 900,
};

/**
 * Password reset and verification emails, per recipient. The gap is a little
 * under the client's 60-second resend timer so a patient click always sends.
 */
export const EMAIL_SEND_LIMIT = {
    MIN_GAP_SECONDS: 50,
    MAX_PER_HOUR: 5,
};
