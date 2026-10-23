export const BROADCAST_QUEUE = 'broadcasts';

export type BroadcastJobData =
    | { kind: 'start'; broadcastId: string }
    | { kind: 'send'; broadcastId: string; recipientIds: string[] }
    | { kind: 'finish'; broadcastId: string; attempt: number };

export const startJobId = (broadcastId: string) => `broadcast-start-${broadcastId}`;
