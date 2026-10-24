import { BroadcastStatus } from '@prisma/client';
import { TemplatesService } from './templates.service';

function setup() {
    const updates: any[] = [];
    const prisma = {
        channel: { findFirst: jest.fn(async () => ({ id: 'ch_b', externalStoreId: 'waba_1', metadata: null, status: 'CONNECTED' })) },
        messageTemplate: {
            findFirst: jest.fn(async () => ({ id: 'tpl_1', organizationId: 'org_b', status: 'PAUSED', category: 'MARKETING' })),
            findUnique: jest.fn(async () => null),
            findMany: jest.fn(async (_args: any) => []),
            update: jest.fn(async (args: any) => updates.push(args)),
            upsert: jest.fn(async () => ({})),
            deleteMany: jest.fn(async (_args: any) => ({ count: 0 })),
            delete: jest.fn(),
        },
        broadcast: { findFirst: jest.fn(async () => null) },
        $executeRaw: jest.fn(async () => 1),
    };
    const metaGraph = { request: jest.fn(async () => ({ data: { data: [{ id: 'meta_1', name: 'diwali', language: 'en', status: 'APPROVED', category: 'MARKETING' }] } })) };
    const accounts = { load: jest.fn(async () => ({ token: 't', creds: { wabaId: 'waba_1' } })), scopes: jest.fn(() => ({})) };
    const service = new TemplatesService(prisma as any, metaGraph as any, accounts as any, {} as any, { get: () => 'app_1' } as any);
    return { service, prisma, metaGraph, updates };
}

const statusEvent = (event: string) => ({ field: 'message_template_status_update', templateId: 'meta_1', name: 'diwali', language: 'en', event, value: {} });
const channel = { id: 'ch_b', organizationId: 'org_b', externalStoreId: 'waba_1' };

describe('templates', () => {
    it('a reinstated template is approved again at once', async () => {
        const { service, updates } = setup();
        await service.applyWebhook(channel, statusEvent('REINSTATED'));
        expect(updates[0].data).toEqual({ status: 'APPROVED', statusReason: null });
    });

    it('a flagged template keeps its status: Meta still sends it', async () => {
        const { service, updates } = setup();
        await service.applyWebhook(channel, statusEvent('FLAGGED'));
        expect(updates).toHaveLength(0);
    });

    it('a pause is stored as it comes', async () => {
        const { service, updates } = setup();
        await service.applyWebhook(channel, statusEvent('PAUSED'));
        expect(updates[0].data).toMatchObject({ status: 'PAUSED' });
    });

    it('sync drops rows another organization left on this WhatsApp account before taking its templates', async () => {
        const { service, prisma } = setup();
        await service.sync('org_b');
        expect(prisma.messageTemplate.deleteMany.mock.calls[0][0]).toEqual({ where: { wabaId: 'waba_1', organizationId: { not: 'org_b' } } });
        expect(prisma.messageTemplate.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(prisma.messageTemplate.upsert.mock.invocationCallOrder[0]);
    });

    it('lists only the connected account’s templates, and none without one', async () => {
        const { service, prisma } = setup();
        await service.approved('org_b');
        expect(prisma.messageTemplate.findMany.mock.calls[0][0].where).toEqual({ organizationId: 'org_b', wabaId: 'waba_1', status: 'APPROVED' });
        prisma.channel.findFirst.mockResolvedValueOnce(null as any);
        await expect(service.list('org_b')).resolves.toEqual([]);
    });

    it('cannot be deleted while a broadcast is sending it', async () => {
        const { service, prisma, metaGraph } = setup();
        prisma.broadcast.findFirst.mockResolvedValueOnce({ name: 'Diwali', status: BroadcastStatus.SENDING } as any);
        await expect(service.remove('org_b', 'tpl_1')).rejects.toThrow('The broadcast “Diwali” is sending this template.');
        expect(metaGraph.request).not.toHaveBeenCalled();
    });

    it('refuse a header sample stored under another organization', async () => {
        const { service, metaGraph } = setup();
        const draft = { name: 'menu', language: 'en', category: 'UTILITY', parameterFormat: 'POSITIONAL', header: { format: 'DOCUMENT', storageKey: 'org_a/menu.pdf', mime: 'application/pdf' }, body: { text: 'Our menu', examples: {} } };
        await expect(service.create('org_b', 'user_1', draft as any)).rejects.toThrow('Upload the header file again.');
        expect(metaGraph.request).not.toHaveBeenCalled();
    });
});
