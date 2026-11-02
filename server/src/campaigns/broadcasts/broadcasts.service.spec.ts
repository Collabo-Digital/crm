import { BadRequestException } from '@nestjs/common';
import { BroadcastRecipientStatus as R, BroadcastStatus, MessageStatus } from '@prisma/client';
import { assertOwnHeaderFile, parseVariables } from './broadcast-variables';
import { BroadcastsService } from './broadcasts.service';

const approved = { id: 'tpl_1', name: 'diwali', language: 'en', category: 'MARKETING', status: 'APPROVED', wabaId: 'waba_1', parameterFormat: 'POSITIONAL', components: [{ type: 'BODY', text: 'Hi' }] };

function setup(over: { broadcast?: Record<string, unknown>; template?: Record<string, unknown> | null } = {}) {
    const broadcast = { id: 'b_1', organizationId: 'org_1', channelId: 'ch_1', name: 'Diwali', campaign: null, status: BroadcastStatus.SENDING, templateId: 'tpl_1', variables: null, audience: null, startedAt: new Date(), ...over.broadcast };
    const template = over.template === undefined ? approved : over.template;
    const recipientUpdates: any[] = [];
    const messageUpdates: any[] = [];
    const queued: any[] = [];
    const prisma = {
        broadcast: {
            findFirst: jest.fn(async () => broadcast),
            findUnique: jest.fn(async () => broadcast),
            update: jest.fn(async ({ data }: any) => Object.assign(broadcast, data)),
            create: jest.fn(async ({ data }: any) => ({ id: 'b_2', ...data })),
        },
        messageTemplate: { findUnique: jest.fn(async () => template) },
        broadcastRecipient: {
            findMany: jest.fn(async ({ where }: any) => (where.status === R.QUEUED ? [{ messageId: 'm_1' }, { messageId: 'm_2' }] : [])),
            updateMany: jest.fn(async (args: any) => {
                recipientUpdates.push(args);
                return { count: 3 };
            }),
            count: jest.fn(async () => 0),
            groupBy: jest.fn(async () => []),
        },
        message: {
            updateMany: jest.fn(async (args: any) => {
                messageUpdates.push(args);
                return { count: 1 };
            }),
            // m_2 was picked up by the sender before the stop.
            findMany: jest.fn(async () => [{ id: 'm_1' }]),
        },
    };
    const queue = { add: jest.fn(async (...args: unknown[]) => queued.push(args)), remove: jest.fn(), addBulk: jest.fn() };
    const templates = { view: (t: unknown) => t, load: jest.fn(), channelFor: jest.fn() };
    const service = new BroadcastsService(prisma as any, templates as any, {} as any, {} as any, {} as any, queue as any);
    return { service, prisma, broadcast, recipientUpdates, messageUpdates, queued };
}

describe('broadcasts', () => {
    it('stop also withdraws messages still waiting in the send queue', async () => {
        const { service, broadcast, recipientUpdates, messageUpdates } = setup();
        jest.spyOn(service, 'get').mockResolvedValue({} as any);
        await service.cancel('org_1', 'b_1');
        expect(broadcast.status).toBe(BroadcastStatus.CANCELLED);
        expect(recipientUpdates[0]).toEqual({ where: { broadcastId: 'b_1', status: R.PENDING }, data: { status: R.SKIPPED, skipReason: 'cancelled' } });
        // Queued messages become failed, which the sender skips.
        expect(messageUpdates[0].where).toEqual({ id: { in: ['m_1', 'm_2'] }, status: MessageStatus.QUEUED });
        expect(messageUpdates[0].data).toMatchObject({ status: MessageStatus.FAILED, errorMessage: 'Not sent: the broadcast was stopped.' });
        // Only the recipient whose message was withdrawn is left out; m_2 is on its way.
        expect(recipientUpdates[1]).toEqual({ where: { broadcastId: 'b_1', status: R.QUEUED, messageId: { in: ['m_1'] } }, data: { status: R.SKIPPED, skipReason: 'cancelled' } });
    });

    it('a template paused mid-send stops the broadcast, and the rest can be retried later', async () => {
        const { service, broadcast, recipientUpdates } = setup({ template: { ...approved, status: 'PAUSED' } });
        await service.sendBatch('b_1', ['r_1']);
        expect(broadcast.status).toBe(BroadcastStatus.FAILED);
        expect(broadcast).toMatchObject({ failureReason: expect.stringContaining('paused') });
        expect(recipientUpdates[0].where).toEqual({ broadcastId: 'b_1', status: R.PENDING });
        // Failed with no error code, so Retry failed takes them.
        expect(recipientUpdates[0].data).toMatchObject({ status: R.FAILED, errorMessage: 'Not sent: the template is paused.' });
        expect(recipientUpdates[0].data.errorCode).toBeUndefined();
    });

    it('a template deleted mid-send fails the broadcast instead of leaving it sending', async () => {
        const { service, broadcast } = setup({ broadcast: { templateId: null }, template: null });
        await service.sendBatch('b_1', ['r_1']);
        expect(broadcast.status).toBe(BroadcastStatus.FAILED);
        expect(broadcast).toMatchObject({ failureReason: expect.stringContaining('deleted') });
    });

    it('retry refuses while the template is paused, and allows a failed broadcast once it is approved', async () => {
        const paused = setup({ broadcast: { status: BroadcastStatus.FAILED }, template: { ...approved, status: 'PAUSED' } });
        await expect(paused.service.retryFailed('org_1', 'b_1')).rejects.toThrow('The template is paused');

        const { service, prisma } = setup({ broadcast: { status: BroadcastStatus.FAILED } });
        prisma.broadcastRecipient.findMany.mockResolvedValueOnce([
            { id: 'r_paused', errorCode: '132015' },
            { id: 'r_optout', errorCode: '131050' },
        ] as any);
        (prisma as any).channel = { findUnique: jest.fn(async () => ({ credentials: {} })) };
        await expect(service.retryFailed('org_1', 'b_1')).resolves.toEqual({ retrying: 1, notRetryable: 1 });
    });

    describe('finishing', () => {
        it('completes once nobody is pending or queued', async () => {
            const { service, prisma, broadcast, queued } = setup();
            prisma.broadcastRecipient.count.mockResolvedValue(0);
            await service.finishIfDone('b_1', 0);
            expect(broadcast.status).toBe(BroadcastStatus.COMPLETED);
            expect(queued).toHaveLength(0);
        });

        it('keeps checking while the count still waiting falls, however long that takes', async () => {
            const { service, prisma, broadcast, queued } = setup();
            prisma.broadcastRecipient.count.mockResolvedValue(900);
            await service.finishIfDone('b_1', 19, 1000);
            expect(broadcast.status).toBe(BroadcastStatus.SENDING);
            expect(queued[0][1]).toEqual({ kind: 'finish', broadcastId: 'b_1', attempt: 0, waiting: 900 });
        });

        it('closes a stalled broadcast, marking people never handed over as failed so they can be retried', async () => {
            const { service, prisma, broadcast, recipientUpdates, queued } = setup();
            prisma.broadcastRecipient.count.mockResolvedValue(40);
            await service.finishIfDone('b_1', 18, 40);
            expect(queued[0][1]).toMatchObject({ attempt: 19 });

            await service.finishIfDone('b_1', 19, 40);
            expect(recipientUpdates[0].where).toEqual({ broadcastId: 'b_1', status: R.PENDING });
            expect(recipientUpdates[0].data).toMatchObject({ status: R.FAILED });
            expect(broadcast.status).toBe(BroadcastStatus.COMPLETED);
            expect(broadcast).toMatchObject({ failureReason: 'Sending stalled, so 3 people were not sent to. Use Retry failed to send to them.' });
        });
    });

    it('a duplicate does not reuse the original’s uploaded header media id', async () => {
        const headerMedia = { storageKey: 'org_1/a.jpg', mime: 'image/jpeg', kind: 'image' };
        const { service, prisma } = setup({ broadcast: { variables: { values: {}, headerMedia, headerMediaId: 'meta_media_1', headerMediaUploadedAt: '2026-09-01T00:00:00.000Z' } } });
        jest.spyOn(service, 'get').mockResolvedValue({} as any);
        await service.duplicate('org_1', 'user_1', 'b_1');
        expect(prisma.broadcast.create.mock.calls[0][0].data.variables).toEqual({ values: {}, headerMedia });
    });
});

describe('who a broadcast leaves out', () => {
    const contact = (id: string) => ({ id, externalId: id, waId: id, phone: `+${id}`, displayName: null, addressBookName: null, username: null, attributes: null, blockedAt: null, optedOutAt: null, optInAt: null, customer: null });

    it('counts only people a past broadcast reached, looked up a page at a time', async () => {
        const { service, prisma } = setup();
        (prisma as any).channelContact = { findMany: jest.fn(async () => [contact('911'), contact('912'), contact('913')]) };
        const groupBy = prisma.broadcastRecipient.groupBy;
        groupBy.mockImplementation((async ({ where }: any) => (where.broadcastId?.in ? [{ contactId: '911' }] : where.sentAt ? [{ contactId: '912' }] : [])) as any);
        const audience = { everyone: true, segmentIds: [], tags: [], requireOptIn: false, exclude: { segmentIds: [], tags: [], broadcastIds: ['b_0'], messagedWithinHours: 24 } };
        const out = await (service as any).evaluate('org_1', { id: 'b_1', channelId: 'ch_1' }, audience, 'MARKETING', [], { values: {} }, 'review');

        expect(out.map((e: { reason: string | null }) => e.reason)).toEqual(['already_received', 'recently_messaged', null]);
        const received = groupBy.mock.calls.map((c: any[]) => c[0]).find((a: any) => a.where.broadcastId?.in);
        // A message that failed after Meta accepted it still has sentAt; status says whether it arrived.
        expect(received.where).toMatchObject({ contactId: { in: ['911', '912', '913'] }, broadcastId: { in: ['b_0'] }, status: { in: [R.SENT, R.DELIVERED, R.READ] } });
        expect(received.where.sentAt).toBeUndefined();
    });
});

describe('broadcast header files', () => {
    it('must be the organization’s own upload', () => {
        const vars = parseVariables({ headerMedia: { storageKey: 'org_2/secret.pdf', mime: 'application/pdf', kind: 'document' } });
        expect(() => assertOwnHeaderFile(vars, 'org_1')).toThrow(BadRequestException);
        expect(() => assertOwnHeaderFile({ ...vars, headerMedia: { ...vars.headerMedia!, storageKey: 'org_1/menu.pdf' } }, 'org_1')).not.toThrow();
    });
});
