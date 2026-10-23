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
};

export const OUTBOUND_JOB_OPTS = {
    attempts: 5,
    backoff: { type: 'exponential' as const, delay: 5_000 },
    removeOnComplete: { count: 2_000 },
    removeOnFail: { count: 2_000 },
};
