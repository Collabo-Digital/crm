import { Prisma } from '@prisma/client';

/**
 * Merge `patch` into `channels.metadata[key]` in one statement.
 *
 * Several writers own different keys of the same JSON blob — webhook handlers
 * write `health` and `coexistence`, the onboarding job writes `historySync`,
 * disconnect writes `lastAccount` — and they run concurrently on the queue.
 * A read-modify-write through Prisma would let one silently undo another, so
 * the merge happens inside Postgres. Top-level keys of `patch` replace the
 * same keys under `metadata[key]`; everything else is kept.
 */
export function patchChannelMetadataSql(
    channelId: string,
    key: string,
    patch: Record<string, unknown>,
): Prisma.Sql {
    return Prisma.sql`
        UPDATE "channels"
        SET "metadata" = jsonb_set(
                coalesce("metadata", '{}'::jsonb),
                ARRAY[${key}]::text[],
                coalesce("metadata" -> ${key}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb
            ),
            "updated_at" = now()
        WHERE "id" = ${channelId}
    `;
}

/**
 * Replace `channels.metadata[key]` with `value` in one statement, for a key
 * that is a list (which a merge would not shorten); other keys are kept.
 */
export function setChannelMetadataSql(channelId: string, key: string, value: unknown): Prisma.Sql {
    return Prisma.sql`
        UPDATE "channels"
        SET "metadata" = jsonb_set(coalesce("metadata", '{}'::jsonb), ARRAY[${key}]::text[], ${JSON.stringify(value)}::jsonb),
            "updated_at" = now()
        WHERE "id" = ${channelId}
    `;
}

/**
 * Record one coexistence history chunk: count it, keep the highest progress
 * seen (chunks arrive out of order), and mark the import complete at 100.
 */
export function recordHistoryChunkSql(
    channelId: string,
    chunk: { phase: number | null; progress: number | null; messages: number },
    now: Date = new Date(),
): Prisma.Sql {
    const progress = chunk.progress ?? 0;
    return Prisma.sql`
        UPDATE "channels"
        SET "metadata" = jsonb_set(
                coalesce("metadata", '{}'::jsonb),
                '{historySync}',
                coalesce("metadata" -> 'historySync', '{}'::jsonb) || jsonb_build_object(
                    'status', CASE
                        WHEN greatest(coalesce(("metadata" -> 'historySync' ->> 'progress')::int, 0), ${progress}::int) >= 100
                            THEN 'complete'
                        ELSE 'importing'
                    END,
                    'progress', greatest(coalesce(("metadata" -> 'historySync' ->> 'progress')::int, 0), ${progress}::int),
                    'phase', ${chunk.phase}::int,
                    'chunksReceived', coalesce(("metadata" -> 'historySync' ->> 'chunksReceived')::int, 0) + 1,
                    'messagesReceived', coalesce(("metadata" -> 'historySync' ->> 'messagesReceived')::int, 0) + ${chunk.messages}::int,
                    'lastChunkAt', ${now.toISOString()}::text
                )
            ),
            "updated_at" = now()
        WHERE "id" = ${channelId}
    `;
}
