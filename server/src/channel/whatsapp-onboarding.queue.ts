export const WHATSAPP_ONBOARDING_QUEUE = 'whatsapp-onboarding';

/** Request the one-shot coexistence contacts + history sync for a channel. */
export interface CoexistenceSyncJobData {
    channelId: string;
}

/// Spread over ~4 hours (30s doubling), well inside Meta's 24-hour window, so
/// a Meta outage at onboarding time does not cost the business its history.
export const COEXISTENCE_SYNC_JOB_OPTS = {
    attempts: 9,
    backoff: { type: 'exponential' as const, delay: 30_000 },
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 200 },
};

export const coexistenceSyncJobId = (channelId: string) => `coexistence-sync-${channelId}`;
