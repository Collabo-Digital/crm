export const BROADCAST_QUEUE = 'broadcasts';

export type BroadcastJobData =
    | { kind: 'start'; broadcastId: string }
    /** `batch`: this hand-over's place in the broadcast, for its messages' queue priority. */
    | { kind: 'send'; broadcastId: string; recipientIds: string[]; batch?: number }
    /** `attempt`: checks in a row without progress; `waiting`: how many were still waiting at the last check. */
    | { kind: 'finish'; broadcastId: string; attempt: number; waiting?: number };

export const startJobId = (broadcastId: string) => `broadcast-start-${broadcastId}`;

export const START_JOB_OPTS = { attempts: 3, backoff: { type: 'exponential', delay: 30_000 }, removeOnComplete: true, removeOnFail: { count: 100 } };
