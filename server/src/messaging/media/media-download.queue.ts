export const MEDIA_DOWNLOAD_QUEUE = 'messaging-media';

/**
 * Background lookups against Meta for the inbox: copy one message's media into
 * private storage before the platform link expires (`download`), or read a
 * Messenger / Instagram contact's name and photo (`profile`).
 */
export type MediaDownloadJobData = { messageId: string } | { contactId: string };

/// WhatsApp media ids expire after 7 days and download URLs after 5 minutes,
/// so retries are quick and few; a file still missing after them is marked.
export const MEDIA_DOWNLOAD_JOB_OPTS = {
    attempts: 5,
    backoff: { type: 'exponential' as const, delay: 10_000 },
    removeOnComplete: { count: 500 },
    removeOnFail: { count: 500 },
};

/** WhatsApp's own ceiling for inbound media. */
export const MAX_MEDIA_BYTES = 100 * 1024 * 1024;
