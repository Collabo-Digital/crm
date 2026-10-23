import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { Observable } from 'rxjs';

/** What changed, so an open inbox knows what to refetch. Ids only, never content. */
export type InboxEvent =
    | { type: 'conversation.updated'; conversationId: string }
    | { type: 'message.created'; conversationId: string; messageId: string }
    | { type: 'message.updated'; conversationId: string; messageId: string }
    | { type: 'note.created'; conversationId: string; noteId: string };

const channelFor = (orgId: string) => `crm:inbox:${orgId}`;

/**
 * Fan-out of inbox changes to every open inbox of an organization, across API
 * instances, over Redis pub/sub. Publishing is fire-and-forget: a missed event
 * costs a live update, and the client also refetches on focus and on a timer.
 */
@Injectable()
export class InboxEventsService implements OnModuleDestroy {
    private readonly logger = new Logger(InboxEventsService.name);
    private readonly url: string;
    private publisher: Redis | null = null;

    constructor(config: ConfigService) {
        this.url = config.get<string>('redis.url')!;
    }

    publish(orgId: string, event: InboxEvent): void {
        this.publisher ??= new Redis(this.url, { maxRetriesPerRequest: 1, lazyConnect: false });
        this.publisher.publish(channelFor(orgId), JSON.stringify(event)).catch((err) => {
            this.logger.warn(`Inbox event not published: ${err instanceof Error ? err.message : err}`);
        });
    }

    /**
     * Events for one organization, for one subscriber. A subscriber connection
     * cannot run other commands, so each stream holds its own and closes it
     * when the client goes away.
     */
    stream(orgId: string): Observable<InboxEvent> {
        return new Observable<InboxEvent>((subscriber) => {
            const sub = new Redis(this.url, { maxRetriesPerRequest: null });
            const channel = channelFor(orgId);
            sub.subscribe(channel).catch((err) => subscriber.error(err));
            sub.on('message', (_ch, raw: string) => {
                try {
                    subscriber.next(JSON.parse(raw) as InboxEvent);
                } catch {
                    // A malformed message is skipped, not fatal to the stream.
                }
            });
            return () => {
                sub.disconnect();
            };
        });
    }

    async onModuleDestroy() {
        this.publisher?.disconnect();
    }
}
