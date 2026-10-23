export const SYNC_QUEUE = 'shopify-sync';

/// Pull data from Shopify (and, on success, push local items back up).
export interface SyncPullJobData {
    /// Optional so jobs enqueued by the previous release - which had no
    /// discriminator - still deserialise after this deploys.
    type?: 'sync';
    channelId: string;
    organizationId: string;
    entityTypes: string[];   // see PULL_ENTITY_TYPES in shopify-sync.service
    /// Outbound rate-limit priority for every Shopify call this run makes
    /// (Priority enum: 1 interactive, 5 normal, 10 bulk). A user-clicked sync
    /// is interactive; the post-connect backfill and cron pulls are bulk.
    /// Also passed to BullMQ as the job priority. Absent on old jobs = normal.
    priority?: number;
}

/// Post-connect store setup: register webhooks, activate the web pixel.
///
/// This is ~20 sequential Shopify mutations. It used to be awaited INSIDE the
/// OAuth callback and the manual-connect handler, where it routinely outlived
/// the client's 30s HTTP timeout and the edge proxy's limit - so a store that
/// had connected perfectly well reported a connection error, and the retry
/// then hit "a Shopify store is already connected".
export interface SyncSetupJobData {
    type: 'setup';
    channelId: string;
    organizationId: string;
}

export type SyncJobData = SyncPullJobData | SyncSetupJobData;