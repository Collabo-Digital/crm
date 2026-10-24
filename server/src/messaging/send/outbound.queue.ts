import { Priority } from '../../rate-limit/rate-limit.types';
import type { SendOrigin } from '../outbound';

export const MESSAGING_OUTBOUND_QUEUE = 'messaging-outbound';

export type OutboundJobData =
    /** Deliver one QUEUED message row. */
    | { kind: 'deliver'; messageId: string; humanAgentTag: boolean }
    /** Tell the platform the business has seen the customer's messages. */
    | { kind: 'mark-read'; channelId: string; contactExternalId: string; messageExternalId: string | null };

/** A person waiting beats an automation, which beats a broadcast. */
export const ORIGIN_PRIORITY: Record<SendOrigin, Priority> = {
    agent: Priority.INTERACTIVE,
    system: Priority.INTERACTIVE,
    automation: Priority.NORMAL,
    broadcast: Priority.BULK,
    // Another system's sends: like an automation's, after people in the inbox.
    api: Priority.NORMAL,
};

/// BullMQ's lowest priority.
const LOWEST_PRIORITY = 2 ** 21;

/**
 * A broadcast message's place in the shared queue: later hand-over batches
 * of one broadcast go behind the early batches of every other, so a large
 * broadcast cannot hold up another workspace's for hours.
 */
export const broadcastPriority = (batch: number): number =>
    Math.min(LOWEST_PRIORITY, Priority.BULK + Math.max(0, Math.floor(batch)));

/**
 * How long a message may wait to go out (rate limits, lost jobs) before it is
 * failed rather than sent late: a reply someone is waiting on is stale
 * sooner than an automation or broadcast message.
 */
export const maxSendWaitMs = (priority: number | undefined): number =>
    (priority ?? Priority.BULK) <= Priority.INTERACTIVE ? 30 * 60_000 : 6 * 3600_000;

export const OUTBOUND_JOB_OPTS = {
    attempts: 5,
    backoff: { type: 'exponential' as const, delay: 5_000 },
    removeOnComplete: { count: 2_000 },
    removeOnFail: { count: 2_000 },
};
