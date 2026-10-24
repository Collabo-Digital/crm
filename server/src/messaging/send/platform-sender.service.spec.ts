import { ChannelPlatform, MessageStatus, Prisma } from '@prisma/client';
import { MetaGraphError } from '../../channel/meta-graph.types';
import { RateLimitedError } from '../../rate-limit/rate-limit.types';
import { PlatformSenderService, UNCONFIRMED_SEND, maySendHaveGoneOut } from './platform-sender.service';

const channel = {
    id: 'ch1',
    organizationId: 'org1',
    platform: ChannelPlatform.WHATSAPP,
    address: 'PN1',
    token: 'tok',
    sendPath: '/PN1/messages',
    baseUrl: null,
    scopes: [],
    pageId: null,
    wabaId: 'W1',
    marketingMessagesApi: false,
};

function row(overrides: Record<string, unknown> = {}) {
    return {
        id: 'm1',
        organizationId: 'org1',
        channelId: 'ch1',
        conversationId: 'c1',
        contactId: 'ct1',
        status: MessageStatus.QUEUED,
        responsePayload: null,
        replyToExternalId: null,
        body: { payload: { type: 'text', text: 'Hello' } },
        contact: { id: 'ct1', externalId: '919800000000', waId: '919800000000' },
        ...overrides,
    };
}

function build(message = row()) {
    const writes: Array<{ op: string; args: any }> = [];
    const prisma = {
        message: {
            findUnique: jest.fn().mockResolvedValue(message),
            updateMany: jest.fn().mockImplementation(async (args) => {
                writes.push({ op: 'updateMany', args });
                return { count: 1 };
            }),
            update: jest.fn().mockImplementation(async (args) => {
                writes.push({ op: 'update', args });
                return {};
            }),
            deleteMany: jest.fn(),
        },
        channelContact: { update: jest.fn().mockResolvedValue({}) },
    };
    const metaGraph = { request: jest.fn() };
    const broadcasts = {
        onStatus: jest.fn().mockImplementation(async (...args) => {
            writes.push({ op: 'tracker', args });
        }),
    };
    const events = { publish: jest.fn() };
    const usageMeter = { noteMessage: jest.fn().mockResolvedValue(undefined) };
    const access = { get: jest.fn().mockResolvedValue(channel) };
    const sender = new PlatformSenderService(
        prisma as never,
        access as never,
        metaGraph as never,
        {} as never,
        events as never,
        broadcasts as never,
        usageMeter as never,
    );
    return { sender, prisma, metaGraph, broadcasts, writes };
}

const handOverWrites = (writes: Array<{ op: string; args: any }>) =>
    writes.filter((w) => w.op === 'updateMany' && w.args.data.responsePayload !== undefined).map((w) => w.args.data.responsePayload);

describe('PlatformSenderService.deliver', () => {
    it('marks the row handed over before the POST, then writes the wamid before the broadcast tracker', async () => {
        const { sender, metaGraph, writes } = build();
        metaGraph.request.mockResolvedValueOnce({ data: { messages: [{ id: 'wamid.1' }] } });

        expect(await sender.deliver('m1', false)).toBe('sent');
        expect(metaGraph.request).toHaveBeenCalledTimes(1);
        expect(metaGraph.request.mock.calls[0][0]).toMatchObject({ method: 'POST', path: '/PN1/messages', idempotent: false });
        expect(writes.map((w) => w.op)).toEqual(['updateMany', 'update', 'tracker']);
        expect(writes[0].args.where).toEqual({ id: 'm1', status: MessageStatus.QUEUED, responsePayload: { equals: Prisma.AnyNull } });
        expect(writes[1].args.data).toMatchObject({ status: MessageStatus.SENT, externalId: 'wamid.1' });
    });

    it('never sends a row an earlier attempt handed over: it fails as unconfirmed', async () => {
        const { sender, metaGraph, broadcasts, prisma } = build(row({ responsePayload: { handedOverAt: '2026-10-25T10:00:00.000Z' } }));

        expect(await sender.deliver('m1', false)).toBe('failed');
        expect(metaGraph.request).not.toHaveBeenCalled();
        expect(prisma.message.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: 'm1', status: MessageStatus.QUEUED }, data: expect.objectContaining({ status: MessageStatus.FAILED, errorMessage: UNCONFIRMED_SEND }) }),
        );
        expect(broadcasts.onStatus).toHaveBeenCalledWith('m1', MessageStatus.FAILED, expect.any(Date), { code: null, message: UNCONFIRMED_SEND });
    });

    it('a timeout after the hand-over fails as unconfirmed instead of being retried', async () => {
        const { sender, metaGraph } = build();
        metaGraph.request.mockRejectedValueOnce(new MetaGraphError('timed out', 'TIMEOUT'));

        expect(await sender.deliver('m1', false)).toBe('failed');
        expect(metaGraph.request).toHaveBeenCalledTimes(1);
    });

    it('a refusal Meta answered with releases the mark and is retried by the queue', async () => {
        const { sender, metaGraph, writes } = build();
        const outage = new MetaGraphError('Service temporarily unavailable', 'RETRY_EXHAUSTED', 2, undefined, 503, { code: 2 });
        metaGraph.request.mockRejectedValueOnce(outage);

        await expect(sender.deliver('m1', false)).rejects.toBe(outage);
        expect(handOverWrites(writes)).toEqual([{ handedOverAt: expect.any(String) }, Prisma.DbNull]);
    });

    it('a rate limit releases the mark and parks', async () => {
        const { sender, metaGraph, writes } = build();
        const limited = new RateLimitedError({ platform: 'meta', kind: 'phone', id: 'PN1' }, Date.now() + 10_000, 'BREAKER', 131056);
        metaGraph.request.mockRejectedValueOnce(limited);

        await expect(sender.deliver('m1', false)).rejects.toBe(limited);
        expect(handOverWrites(writes)).toEqual([{ handedOverAt: expect.any(String) }, Prisma.DbNull]);
    });

    it('skips a row another attempt is already sending', async () => {
        const { sender, metaGraph, prisma } = build();
        prisma.message.updateMany.mockResolvedValueOnce({ count: 0 });

        expect(await sender.deliver('m1', false)).toBe('skipped');
        expect(metaGraph.request).not.toHaveBeenCalled();
    });

    it('keeps trying to record a sent message on a database error, and never sends it again', async () => {
        const { sender, metaGraph, prisma } = build();
        metaGraph.request.mockResolvedValueOnce({ data: { messages: [{ id: 'wamid.1' }] } });
        prisma.message.update.mockRejectedValueOnce(new Error('Timed out fetching a new connection from the connection pool'));

        expect(await sender.deliver('m1', false)).toBe('sent');
        expect(metaGraph.request).toHaveBeenCalledTimes(1);
        expect(prisma.message.update).toHaveBeenCalledTimes(2);
    });

    it('fails a message whose contact was deleted instead of leaving it queued', async () => {
        const { sender, metaGraph } = build(row({ contact: null }));
        expect(await sender.deliver('m1', false)).toBe('failed');
        expect(metaGraph.request).not.toHaveBeenCalled();
    });
});

describe('PlatformSenderService.giveUp', () => {
    it('fails a still-queued message and updates its broadcast recipient', async () => {
        const { sender, broadcasts } = build();
        await sender.giveUp('m1', 'Meta could not be reached. Try sending again.');
        expect(broadcasts.onStatus).toHaveBeenCalledWith('m1', MessageStatus.FAILED, expect.any(Date), {
            code: null,
            message: 'Meta could not be reached. Try sending again.',
        });
    });

    it('leaves a message that already went out', async () => {
        const { sender, broadcasts, prisma } = build(row({ status: MessageStatus.SENT }));
        await sender.giveUp('m1', 'whatever');
        expect(prisma.message.updateMany).not.toHaveBeenCalled();
        expect(broadcasts.onStatus).not.toHaveBeenCalled();
    });
});

describe('maySendHaveGoneOut', () => {
    const fetchFailed = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: { code } });

    it('is false when nothing can have reached Meta', () => {
        expect(maySendHaveGoneOut(new MetaGraphError('Invalid parameter', 'API_ERROR', 100, undefined, 400))).toBe(false);
        expect(maySendHaveGoneOut(fetchFailed('ECONNREFUSED'))).toBe(false);
        expect(maySendHaveGoneOut(fetchFailed('ENOTFOUND'))).toBe(false);
        expect(maySendHaveGoneOut(new MetaGraphError('Bad Request', 'HTTP_ERROR', undefined, undefined, 413))).toBe(false);
    });

    it('is true when Meta may have taken the message', () => {
        expect(maySendHaveGoneOut(new MetaGraphError('timed out', 'TIMEOUT'))).toBe(true);
        expect(maySendHaveGoneOut(new MetaGraphError('Gateway Timeout', 'HTTP_ERROR', undefined, undefined, 504))).toBe(true);
        expect(maySendHaveGoneOut(fetchFailed('ECONNRESET'))).toBe(true);
        expect(maySendHaveGoneOut(new Error('something else'))).toBe(true);
    });
});
