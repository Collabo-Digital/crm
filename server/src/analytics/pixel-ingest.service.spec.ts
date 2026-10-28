import { HttpException } from '@nestjs/common';
import RedisMock from 'ioredis-mock';
import { RedisService } from '../redis/redis.service';
import { PixelEventDto } from './dto/pixel-ingest.dto';
import {
    PIXEL_EVENTS_PER_ADDRESS_PER_MINUTE,
    PIXEL_EVENTS_PER_DAY,
    PIXEL_EVENTS_PER_MINUTE,
    PixelIngestService,
} from './pixel-ingest.service';

/**
 * The storefront pixel's token is in every page of the store, so anyone can
 * post events with it. What one address, and the store as a whole, can add is
 * bounded, and so is the text each event stores.
 */
const NOW = Date.UTC(2026, 9, 28, 10, 30, 15);
const TOKEN = 'pxt_0123456789abcdefghijklmnop';

function setup() {
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    const redis = new RedisService({ get: () => 'redis://localhost:6379' } as never);
    const client = new RedisMock();
    (redis as unknown as { client: unknown }).client = client;
    const rows: Array<Record<string, unknown>> = [];
    const prisma = {
        channel: { findUnique: jest.fn(() => Promise.resolve({ id: 'ch_1', organizationId: 'org_1', status: 'CONNECTED' })) },
        rawAnalyticsEvent: {
            createMany: jest.fn(({ data }: { data: Array<Record<string, unknown>> }) => {
                rows.push(...data);
                return Promise.resolve({ count: data.length });
            }),
        },
    };
    const service = new PixelIngestService(prisma as never, redis);
    jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
    return { service, client, rows };
}

let next = 0;
const event = (name: PixelEventDto['name'], data: Record<string, unknown> = {}): PixelEventDto => ({
    id: `evt_${next++}`,
    name,
    timestamp: new Date(NOW - 1000).toISOString(),
    data,
});
const pageViews = (n: number) => Array.from({ length: n }, () => event('page_viewed', { page: { pathname: '/', title: 'Home' } }));
const status = (p: Promise<unknown>) => p.then(() => 200, (e: HttpException) => e.getStatus());

beforeEach(async () => {
    await new RedisMock().flushall();
});
afterEach(() => jest.restoreAllMocks());

describe('PixelIngestService limits', () => {
    it('holds one visitor address to a browsing pace, without holding up the store’s other visitors', async () => {
        const { service, rows } = setup();
        const batches = PIXEL_EVENTS_PER_ADDRESS_PER_MINUTE / 20;
        for (let i = 0; i < batches; i++) {
            await expect(service.ingest({ token: TOKEN, clientId: 'v1', events: pageViews(20) }, '198.51.100.1')).resolves.toEqual({ accepted: 20 });
        }

        const refused: unknown = await service.ingest({ token: TOKEN, clientId: 'v1', events: pageViews(20) }, '198.51.100.1').catch((e: unknown) => e);
        expect(refused).toBeInstanceOf(HttpException);
        expect((refused as HttpException).getStatus()).toBe(429);
        expect((refused as HttpException).message).toBe('Too many pixel events from this visitor; these were not recorded.');
        expect(rows).toHaveLength(PIXEL_EVENTS_PER_ADDRESS_PER_MINUTE);

        await expect(service.ingest({ token: TOKEN, clientId: 'v2', events: pageViews(20) }, '198.51.100.2')).resolves.toEqual({ accepted: 20 });
    });

    it('holds the whole store to a rate per minute, however many addresses post', async () => {
        const { service, client } = setup();
        await client.set(`crm:pixel:rate:ch_1:${Math.floor(NOW / 60_000)}`, PIXEL_EVENTS_PER_MINUTE - 10);

        await expect(status(service.ingest({ token: TOKEN, clientId: 'v1', events: pageViews(20) }, '198.51.100.3'))).resolves.toBe(429);
        await expect(service.ingest({ token: TOKEN, clientId: 'v1', events: pageViews(10) }, '198.51.100.3')).resolves.toEqual({ accepted: 10 });
        await expect(status(service.ingest({ token: TOKEN, clientId: 'v1', events: pageViews(1) }, '198.51.100.4'))).resolves.toBe(429);
    });

    it('holds the store to a daily total', async () => {
        const { service, client, rows } = setup();
        await client.set('crm:pixel:day:ch_1:2026-10-28', PIXEL_EVENTS_PER_DAY - 5);

        const refused: unknown = await service.ingest({ token: TOKEN, clientId: 'v1', events: pageViews(6) }, '198.51.100.5').catch((e: unknown) => e);
        expect((refused as HttpException).getStatus()).toBe(429);
        expect((refused as HttpException).message).toBe('This store has sent today’s 200,000 pixel events; more are recorded from midnight UTC.');
        expect(rows).toHaveLength(0);

        await expect(service.ingest({ token: TOKEN, clientId: 'v1', events: pageViews(5) }, '198.51.100.5')).resolves.toEqual({ accepted: 5 });
    });

    it('counts nothing for a request it refuses', async () => {
        const { service, client } = setup();
        await client.set('crm:pixel:day:ch_1:2026-10-28', PIXEL_EVENTS_PER_DAY);
        await status(service.ingest({ token: TOKEN, clientId: 'v1', events: pageViews(20) }, '198.51.100.6'));

        expect(await client.get(`crm:pixel:rate:ch_1:${Math.floor(NOW / 60_000)}`)).toBeNull();
        expect(await client.get(`crm:pixel:rate:ch_1:198.51.100.6:${Math.floor(NOW / 60_000)}`)).toBeNull();
    });
});

describe('PixelIngestService stored fields', () => {
    it('cuts long text and drops ids too long or not text to be real', async () => {
        const { service, rows } = setup();
        const long = 'x'.repeat(10_000);
        await service.ingest(
            {
                token: TOKEN,
                clientId: 'v1',
                events: [
                    event('page_viewed', { page: { pathname: `/${long}`, title: long } }),
                    event('checkout_completed', { checkout: { token: 'y'.repeat(300), order: { id: { nested: long }, customer: { id: 'z'.repeat(1_000_000) } } } }),
                    event('product_viewed', { productVariant: { product: { id: 'gid://shopify/Product/42', title: 'Kurta' }, price: { amount: 1299 } } }),
                    event('search_submitted', { searchResult: { query: ['not', 'text'] } }),
                ],
            },
            '198.51.100.7',
        );

        const [page, checkout, product, search] = rows;
        const pagePayload = page.payload as { pagePath: string; pageTitle: string };
        expect(pagePayload.pagePath).toHaveLength(512);
        expect(pagePayload.pageTitle).toHaveLength(512);
        expect(checkout).toMatchObject({ sessionId: null, externalCustomerId: null });
        expect(checkout.payload).toMatchObject({ checkoutToken: null, orderId: null });
        expect(product.payload).toMatchObject({ productId: 'gid://shopify/Product/42', productTitle: 'Kurta', price: 1299 });
        expect(search.payload).toMatchObject({ query: null });
    });

    it('keeps real ids as text', async () => {
        const { service, rows } = setup();
        await service.ingest(
            { token: TOKEN, clientId: 'v1', events: [event('checkout_completed', { checkout: { token: 'c1d2e3', order: { id: 'gid://shopify/Order/9', customer: { id: 7012345678 } } } })] },
            '198.51.100.8',
        );

        expect(rows[0]).toMatchObject({ sessionId: 'c1d2e3', externalCustomerId: '7012345678' });
    });
});
