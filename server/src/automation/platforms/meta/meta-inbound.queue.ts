export const META_INBOUND_QUEUE = 'meta-inbound';

/** One stored webhook delivery to process. The job id is the delivery id. */
export interface MetaInboundJobData {
    deliveryId: string;
}

export const META_INBOUND_JOB_OPTS = {
    attempts: 6,
    // 5s, 10s, 20s, 40s, 80s: enough to ride out a database or Redis blip
    // while the raw row stays safe in the table either way.
    backoff: { type: 'exponential' as const, delay: 5_000 },
    removeOnComplete: { count: 1_000 },
    removeOnFail: { count: 1_000 },
};

/** Webhook objects Meta sends, and the endpoint each one arrives on. */
export type MetaWebhookObject = 'whatsapp_business_account' | 'page' | 'instagram';
