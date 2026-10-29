import { HttpException, HttpStatus, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { Observable, ReplaySubject, Subscriber } from 'rxjs';

/** What changed, so an open inbox knows what to refetch. Ids only, never content. */
export type InboxEvent =
    | { type: 'conversation.updated'; conversationId: string }
    | { type: 'message.created'; conversationId: string; messageId: string }
    | { type: 'message.updated'; conversationId: string; messageId: string }
    | { type: 'note.created'; conversationId: string; noteId: string }
    | { type: 'call.updated'; conversationId: string; callId: string };

const channelFor = (orgId: string) => `crm:inbox:${orgId}`;

/**
 * Live streams one member may hold open on one server: a few inbox tabs and
 * a phone, with room for connections a dropped network has not closed yet.
 * A stream past this is refused, and the inbox polls instead.
 */
export const MAX_STREAMS_PER_USER = 10;

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
    /** One subscriber connection for every stream on this server, opened with the first. */
    private subscriber: Redis | null = null;
    /** The open streams of each organization's channel. */
    private readonly streams = new Map<string, Set<Subscriber<InboxEvent>>>();
    private readonly openByUser = new Map<string, number>();
    private readonly closing = new ReplaySubject<void>(1);
    /**
     * Emits on shutdown. An open stream holds its HTTP response open, and the
     * server cannot close (nor the process exit) until every stream ends on it.
     */
    readonly closing$ = this.closing.asObservable();

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
     * Events for one organization, for one member's open inbox. Streams share
     * the server's subscriber connection, which subscribes to an organization
     * while any of its streams is open. Each stream used to hold a Redis
     * connection of its own, so one account opening thousands could use up
     * Redis's connections and stop live updates for every workspace.
     */
    stream(orgId: string, userId: string): Observable<InboxEvent> {
        return new Observable<InboxEvent>((subscriber) => {
            const open = this.openByUser.get(userId) ?? 0;
            if (open >= MAX_STREAMS_PER_USER) {
                subscriber.error(new HttpException(
                    'Too many live inbox connections are open for this account. Close an inbox tab you are not using.',
                    HttpStatus.TOO_MANY_REQUESTS,
                ));
                return;
            }
            this.openByUser.set(userId, open + 1);

            const channel = channelFor(orgId);
            let streams = this.streams.get(channel);
            if (!streams) {
                const created = new Set<Subscriber<InboxEvent>>();
                streams = created;
                this.streams.set(channel, created);
                this.connection().subscribe(channel).catch((err: unknown) => {
                    // Ended streams reconnect, and the next one subscribes again.
                    if (this.streams.get(channel) === created) this.streams.delete(channel);
                    for (const s of created) s.error(err);
                });
            }
            streams.add(subscriber);

            const own = streams;
            return () => {
                const left = (this.openByUser.get(userId) ?? 1) - 1;
                if (left > 0) this.openByUser.set(userId, left);
                else this.openByUser.delete(userId);
                own.delete(subscriber);
                if (own.size === 0 && this.streams.get(channel) === own) {
                    this.streams.delete(channel);
                    this.subscriber?.unsubscribe(channel).catch(() => undefined);
                }
            };
        });
    }

    async onModuleDestroy() {
        this.closing.next();
        this.publisher?.disconnect();
        this.subscriber?.disconnect();
    }

    /** A subscriber connection cannot run other commands, so it is kept apart from the publisher. */
    private connection(): Redis {
        if (!this.subscriber) {
            const sub = new Redis(this.url, { maxRetriesPerRequest: null });
            sub.on('message', (channel: string, raw: string) => {
                const streams = this.streams.get(channel);
                if (!streams) return;
                let event: InboxEvent;
                try {
                    event = JSON.parse(raw) as InboxEvent;
                } catch {
                    // A malformed message is skipped, not fatal to the streams.
                    return;
                }
                for (const s of streams) s.next(event);
            });
            this.subscriber = sub;
        }
        return this.subscriber;
    }
}
