export const BROADCAST_QUEUE = 'broadcasts';

export type BroadcastJobData =
    | { kind: 'start'; broadcastId: string }
    | { kind: 'send'; broadcastId: string; recipientIds: string[] }
    /** `attempt`: checks in a row without progress; `waiting`: how many were still waiting at the last check. */
    | { kind: 'finish'; broadcastId: string; attempt: number; waiting?: number };

export const startJobId = (broadcastId: string) => `broadcast-start-${broadcastId}`;
