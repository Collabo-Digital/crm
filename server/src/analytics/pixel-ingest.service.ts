import { HttpException, HttpStatus, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ChannelStatus, Prisma } from '@prisma/client';
import { visitorAddress } from '../common/utils/visitor-address.util';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { PixelEventDto, PixelIngestDto } from './dto/pixel-ingest.dto';

interface ChannelRef {
    id: string;
    organizationId: string;
}

const MAX_PAYLOAD_JSON = 8_192;
const MAX_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;
/// Longest text kept from an event's data, such as a page title or a search.
const MAX_TEXT = 512;
/// Longest id kept (customer, cart, checkout, product); a longer one is not real.
const MAX_ID = 256;

/**
 * Events a store's pixel may send. Its token is in every page of the store,
 * so anyone can post with it: one visitor address (an IPv6 /64) is held to a
 * browsing pace, and the store as a whole to a rate and a daily total far
 * above what its real visitors send, which bound the rows anyone can add.
 */
export const PIXEL_EVENTS_PER_ADDRESS_PER_MINUTE = 120;
export const PIXEL_EVENTS_PER_MINUTE = 3_000;
export const PIXEL_EVENTS_PER_DAY = 200_000;
/**
 * KEYS: the address's events this minute, the store's this minute, the
 * store's today; ARGV[1] the request's events, ARGV[2..4] the limits,
 * ARGV[5..7] the TTLs. Counts the events in all three only when they fit in
 * all three; else answers which one is full (1-3).
 */
const ADMIT_LUA = `local n = tonumber(ARGV[1])
for i = 1, 3 do
  if tonumber(redis.call('GET', KEYS[i]) or '0') + n > tonumber(ARGV[i + 1]) then return i end
end
for i = 1, 3 do
  if redis.call('INCRBY', KEYS[i], n) == n then redis.call('EXPIRE', KEYS[i], ARGV[i + 4]) end
end
return 0`;
const REFUSALS = [
    'Too many pixel events from this visitor; these were not recorded.',
    'Too many pixel events for this store this minute; these were not recorded.',
    `This store has sent today’s ${PIXEL_EVENTS_PER_DAY.toLocaleString('en-US')} pixel events; more are recorded from midnight UTC.`,
];

/** Text from a visitor's browser, cut to MAX_TEXT; anything else is dropped. */
const text = (v: unknown): string | null => (typeof v === 'string' ? v.slice(0, MAX_TEXT) : null);
/** An id or an amount as sent: a number, or a string no longer than MAX_ID. */
const idOf = (v: unknown): string | number | null =>
    (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length <= MAX_ID) ? v : null;
const idText = (v: unknown): string | null => {
    const id = idOf(v);
    return id != null ? String(id) : null;
};

@Injectable()
export class PixelIngestService {
    private readonly logger = new Logger(PixelIngestService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly redis: RedisService,
    ) { }

    async ingest(dto: PixelIngestDto, ip: string | undefined): Promise<{ accepted: number }> {
        const channel = await this.resolveChannel(dto.token);
        if (dto.events.length > 0) await this.admit(channel.id, ip, dto.events.length);

        const rows: Prisma.RawAnalyticsEventCreateManyInput[] = [];
        for (const event of dto.events) {
            const fresh = await this.redis.acquireLock(
                `pixel:evt:${channel.id}:${event.id}`,
                86_400,
            );
            if (!fresh) continue;

            rows.push({
                organizationId: channel.organizationId,
                channelId: channel.id,
                eventName: event.name,
                occurredAt: this.clampTimestamp(event.timestamp),
                visitorId: dto.clientId,
                sessionId: this.extractSessionId(event),
                externalCustomerId: this.extractCustomerId(event),
                payload: this.trimPayload(event) as Prisma.InputJsonValue,
            });
        }

        if (rows.length > 0) {
            await this.prisma.rawAnalyticsEvent.createMany({ data: rows });
        }
        return { accepted: rows.length };
    }

    /** Counts the request's events against the address's and the store's limits, or refuses them all with a 429. */
    private async admit(channelId: string, ip: string | undefined, events: number): Promise<void> {
        const now = Date.now();
        const minute = Math.floor(now / 60_000);
        const day = new Date(now).toISOString().slice(0, 10);
        const full = Number(await this.redis.runScript(
            'pixelAdmit',
            ADMIT_LUA,
            3,
            [`pixel:rate:${channelId}:${visitorAddress(ip)}:${minute}`, `pixel:rate:${channelId}:${minute}`, `pixel:day:${channelId}:${day}`],
            [events, PIXEL_EVENTS_PER_ADDRESS_PER_MINUTE, PIXEL_EVENTS_PER_MINUTE, PIXEL_EVENTS_PER_DAY, 120, 120, 2 * 86_400],
        ));
        if (full === 0) return;
        // A store's own limit may need raising for a big store: say so, once an hour, not per request.
        if (full > 1 && (await this.redis.acquireLock(`pixel:limit_logged:${channelId}:${full}`, 3600))) {
            this.logger.warn(`Pixel events refused for channel ${channelId}: its ${full === 3 ? 'daily' : 'per-minute'} limit is reached`);
        }
        throw new HttpException(REFUSALS[full - 1], HttpStatus.TOO_MANY_REQUESTS);
    }

    private async resolveChannel(token: string): Promise<ChannelRef> {
        const cacheKey = `pixel:token:${token}`;
        const cached = await this.redis.get<ChannelRef>(cacheKey);
        if (cached) return cached;

        const channel = await this.prisma.channel.findUnique({
            where: { pixelIngestToken: token },
            select: { id: true, organizationId: true, status: true },
        });
        if (!channel || channel.status === ChannelStatus.DISCONNECTED) {
            throw new NotFoundException();
        }
        const ref: ChannelRef = { id: channel.id, organizationId: channel.organizationId };
        await this.redis.set(cacheKey, ref, 600);
        return ref;
    }

    private clampTimestamp(iso: string): Date {
        const t = new Date(iso).getTime();
        const now = Date.now();
        if (!Number.isFinite(t) || Math.abs(now - t) > MAX_CLOCK_SKEW_MS) return new Date(now);
        return new Date(t);
    }

    private extractSessionId(event: PixelEventDto): string | null {
        const data = (event.data ?? {}) as Record<string, any>;
        if (event.name === 'checkout_started' || event.name === 'checkout_completed') {
            return idText(data.checkout?.token);
        }
        if (event.name === 'cart_viewed') return idText(data.cart?.id);
        if (event.name === 'product_added_to_cart') return idText(data.cartLine?.cart?.id);
        return null;
    }

    private extractCustomerId(event: PixelEventDto): string | null {
        const data = (event.data ?? {}) as Record<string, any>;
        return idText(data.checkout?.order?.customer?.id);
    }

    private trimPayload(event: PixelEventDto): Record<string, unknown> {
        const data = (event.data ?? {}) as Record<string, any>;
        const out: Record<string, unknown> = { pixelEventId: event.id };

        switch (event.name) {
            case 'page_viewed': {
                // Sent by the pixel extension as data.page — the standard
                // page_viewed event carries no location in `data`, so the
                // extension copies it from event.context.document.
                const page = (data.page ?? {}) as { pathname?: unknown; title?: unknown };
                out.pagePath = text(page.pathname);
                out.pageTitle = text(page.title);
                break;
            }
            case 'product_viewed': {
                const v = data.productVariant;
                out.productId = idOf(v?.product?.id);
                out.productTitle = text(v?.product?.title);
                out.price = idOf(v?.price?.amount);
                break;
            }
            case 'product_added_to_cart': {
                const line = data.cartLine;
                out.productId = idOf(line?.merchandise?.product?.id);
                out.productTitle = text(line?.merchandise?.product?.title);
                out.quantity = idOf(line?.quantity);
                break;
            }
            case 'collection_viewed':
                out.collectionTitle = text(data.collection?.title);
                break;
            case 'search_submitted':
                out.query = text(data.searchResult?.query);
                break;
            case 'checkout_started':
            case 'checkout_completed':
                out.checkoutToken = idOf(data.checkout?.token);
                out.totalPrice = idOf(data.checkout?.totalPrice?.amount);
                if (event.name === 'checkout_completed') {
                    out.orderId = idOf(data.checkout?.order?.id);
                }
                break;
            default:
                break;
        }

        if (JSON.stringify(out).length > MAX_PAYLOAD_JSON) {
            return { pixelEventId: event.id, truncated: true };
        }
        return out;
    }
}