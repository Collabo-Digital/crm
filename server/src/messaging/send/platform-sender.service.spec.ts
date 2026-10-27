import { ChannelPlatform, MessageStatus, Prisma } from '@prisma/client';
import { MetaGraphError } from '../../channel/meta-graph.types';
import { VoiceNoteError } from '../media/voice-note.converter';
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

function build(message = row(), deps: { channel?: object; storage?: object; voiceNotes?: object } = {}) {
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
        channelContact: { update: jest.fn().mockResolvedValue({}), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    const metaGraph = { request: jest.fn() };
    const broadcasts = {
        onStatus: jest.fn().mockImplementation(async (...args) => {
            writes.push({ op: 'tracker', args });
        }),
    };
    const events = { publish: jest.fn() };
    const usageMeter = { noteMessage: jest.fn().mockResolvedValue(undefined) };
    const access = { get: jest.fn().mockResolvedValue(deps.channel ?? channel) };
    const sender = new PlatformSenderService(
        prisma as never,
        access as never,
        metaGraph as never,
        (deps.storage ?? {}) as never,
        events as never,
        broadcasts as never,
        usageMeter as never,
        (deps.voiceNotes ?? {}) as never,
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

describe('PlatformSenderService.deliver, voice notes', () => {
    const voiceRow = (contact = { id: 'ct1', externalId: '919800000000', waId: '919800000000' }) =>
        row({
            body: { payload: { type: 'media', mediaKind: 'audio', storageKey: 'org1/n.ogg', mime: 'audio/ogg', filename: 'voice-note.ogg', voice: true, durationMs: 1500 } },
            contact,
        });
    const instagram = { ...channel, platform: ChannelPlatform.INSTAGRAM, address: 'IG1', sendPath: '/P1/messages', pageId: 'P1' };
    const ogg = Buffer.from('OggS voice');

    it('sends WhatsApp the Ogg file as audio with voice: true', async () => {
        const storage = { read: jest.fn().mockResolvedValue(ogg) };
        const { sender, metaGraph } = build(voiceRow(), { storage });
        metaGraph.request.mockResolvedValueOnce({ data: { id: 'media.1' } }).mockResolvedValueOnce({ data: { messages: [{ id: 'wamid.1' }] } });

        expect(await sender.deliver('m1', false)).toBe('sent');
        const [upload, send] = metaGraph.request.mock.calls.map((c) => c[0]);
        expect(upload.path).toBe('/PN1/media');
        expect(upload.multipart.get('type')).toBe('audio/ogg');
        expect(send.body).toMatchObject({ type: 'audio', audio: { id: 'media.1', voice: true } });
    });

    it('sends Instagram and Messenger an .m4a made from the stored voice note', async () => {
        const storage = { read: jest.fn().mockResolvedValue(ogg) };
        const voiceNotes = { toM4a: jest.fn().mockResolvedValue(Buffer.from('m4a')) };
        const { sender, metaGraph } = build(voiceRow({ id: 'ct1', externalId: 'IGSID1', waId: null } as never), { channel: instagram, storage, voiceNotes });
        metaGraph.request.mockResolvedValueOnce({ data: { attachment_id: 'att.1' } }).mockResolvedValueOnce({ data: { message_id: 'mid.1' } });

        expect(await sender.deliver('m1', false)).toBe('sent');
        expect(voiceNotes.toM4a).toHaveBeenCalledWith(ogg);
        const [upload, send] = metaGraph.request.mock.calls.map((c) => c[0]);
        expect(upload.path).toBe('/P1/message_attachments');
        const file = upload.multipart.get('filedata') as File;
        expect([file.name, file.type]).toEqual(['voice-note.m4a', 'audio/mp4']);
        expect(JSON.parse(upload.multipart.get('message')).attachment.type).toBe('audio');
        expect(send.body.message).toEqual({ attachment: { type: 'audio', payload: { attachment_id: 'att.1' } } });
    });

    it('fails a voice note that cannot be converted for Instagram instead of retrying it', async () => {
        const storage = { read: jest.fn().mockResolvedValue(ogg) };
        const voiceNotes = { toM4a: jest.fn().mockRejectedValue(new VoiceNoteError('This recording could not be read. Record it again.')) };
        const { sender, metaGraph, prisma } = build(voiceRow({ id: 'ct1', externalId: 'IGSID1', waId: null } as never), { channel: instagram, storage, voiceNotes });

        expect(await sender.deliver('m1', false)).toBe('failed');
        expect(metaGraph.request).not.toHaveBeenCalled();
        expect(prisma.message.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ status: MessageStatus.FAILED, errorMessage: expect.stringContaining('could not be converted') }) }),
        );
    });
});

describe('PlatformSenderService.deliver, failures that pause automations to a person', () => {
    const instagram = { ...channel, platform: ChannelPlatform.INSTAGRAM, address: 'IG1', sendPath: '/P1/messages', pageId: 'P1' };
    const person = (over: Record<string, unknown> = {}) => ({ id: 'ct1', externalId: 'IGSID1', waId: null, consecutiveFailures: 0, mutedUntil: null, ...over });

    it('counts a person who blocked the account against them, and pauses them at the third failure in a row', async () => {
        const { sender, metaGraph, prisma } = build(row({ contact: person({ consecutiveFailures: 2 }) }), { channel: instagram });
        prisma.channelContact.update.mockResolvedValueOnce({}).mockResolvedValueOnce({ consecutiveFailures: 3 });
        metaGraph.request.mockRejectedValueOnce(new MetaGraphError('This person isn’t available right now.', 'API_ERROR', 551, 1545041, 400));

        expect(await sender.deliver('m1', false)).toBe('failed');
        const updates = prisma.channelContact.update.mock.calls.map((c) => c[0]);
        expect(updates).toEqual([
            { where: { id: 'ct1' }, data: { outboundFailedCount: { increment: 1 } } },
            { where: { id: 'ct1' }, data: { consecutiveFailures: { increment: 1 } }, select: { consecutiveFailures: true } },
            { where: { id: 'ct1' }, data: { mutedUntil: expect.any(Date) } },
        ]);
        const pausedFor = updates[2].data.mutedUntil.getTime() - Date.now();
        expect(pausedFor).toBeGreaterThan(23.9 * 3600_000);
        expect(pausedFor).toBeLessThanOrEqual(24 * 3600_000);
    });

    it('never counts the account’s own problems against the person', async () => {
        const { sender, metaGraph, prisma } = build(row({ contact: { ...person(), externalId: '919800000000', waId: '919800000000' } }));
        metaGraph.request.mockRejectedValueOnce(new MetaGraphError('Payment issue', 'API_ERROR', 131042, undefined, 400));

        expect(await sender.deliver('m1', false)).toBe('failed');
        expect(prisma.channelContact.update.mock.calls.map((c) => c[0])).toEqual([{ where: { id: 'ct1' }, data: { outboundFailedCount: { increment: 1 } } }]);
    });

    it('clears earlier failures once Instagram takes a message', async () => {
        const { sender, metaGraph, prisma } = build(row({ contact: person({ consecutiveFailures: 2 }) }), { channel: instagram });
        metaGraph.request.mockResolvedValueOnce({ data: { message_id: 'mid.1' } });

        expect(await sender.deliver('m1', false)).toBe('sent');
        expect(prisma.channelContact.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { consecutiveFailures: 0, mutedUntil: null } }));
    });

    it('waits for WhatsApp’s "delivered" before clearing them: an accepted send can still fail', async () => {
        const { sender, metaGraph, prisma } = build(row({ contact: { ...person({ consecutiveFailures: 2 }), externalId: '919800000000', waId: '919800000000' } }));
        metaGraph.request.mockResolvedValueOnce({ data: { messages: [{ id: 'wamid.1' }] } });

        expect(await sender.deliver('m1', false)).toBe('sent');
        expect(prisma.channelContact.updateMany).not.toHaveBeenCalled();
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
