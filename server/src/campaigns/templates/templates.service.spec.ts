import { BroadcastStatus } from '@prisma/client';
import { MetaGraphError } from '../../channel/meta-graph.types';
import { Priority } from '../../rate-limit/rate-limit.types';
import { TemplatesService } from './templates.service';

function setup() {
    const updates: any[] = [];
    const prisma = {
        channel: { findFirst: jest.fn(async () => ({ id: 'ch_b', externalStoreId: 'waba_1', metadata: null, status: 'CONNECTED' })) },
        messageTemplate: {
            findFirst: jest.fn(async (): Promise<any> => ({ id: 'tpl_1', organizationId: 'org_b', wabaId: 'waba_1', status: 'PAUSED', category: 'MARKETING', requestedCategory: null, packSlot: null, statusUpdatedAt: null, rejectionInfo: null })),
            findUnique: jest.fn(async () => null),
            findMany: jest.fn(async (_args: any): Promise<any[]> => []),
            update: jest.fn(async (args: any) => {
                updates.push(args);
                return { id: args.where.id, ...args.data };
            }),
            upsert: jest.fn(async (_args: any): Promise<any> => ({})),
            deleteMany: jest.fn(async (_args: any) => ({ count: 0 })),
            delete: jest.fn(),
        },
        templatePack: { updateMany: jest.fn(async () => ({ count: 1 })) },
        broadcast: { findFirst: jest.fn(async () => null) },
        $executeRaw: jest.fn(async () => 1),
    };
    const metaGraph = {
        request: jest.fn(async (_req: any): Promise<any> => ({ data: { data: [{ id: 'meta_1', name: 'diwali', language: 'en', status: 'APPROVED', category: 'MARKETING' }] } })),
        baseScopes: () => [],
    };
    const accounts = { load: jest.fn(async () => ({ token: 't', creds: { wabaId: 'waba_1' } })), scopes: jest.fn(() => ({})) };
    const locks: string[] = [];
    const redis = {
        runScript: jest.fn(async (name: string, _lua: string, _n: number, keys: string[]) => {
            if (name === 'lockAcquire') locks.push(keys[0]);
            return 'OK';
        }),
    };
    const packJobs = { sync: jest.fn(), reconcile: jest.fn(), managedSync: jest.fn() };
    const service = new TemplatesService(prisma as any, metaGraph as any, accounts as any, {} as any, { get: () => 'app_1' } as any, redis as any, packJobs as any);
    return { service, prisma, metaGraph, updates, locks, packJobs };
}

const statusEvent = (event: string, extra: Record<string, unknown> = {}, at?: Date) =>
    ({ field: 'message_template_status_update', templateId: 'meta_1', name: 'diwali', language: 'en', event, value: extra, at });
const channel = { id: 'ch_b', organizationId: 'org_b', externalStoreId: 'waba_1' };
const ref = { id: 'ch_b', wabaId: 'waba_1' };

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

describe('sync and the recommended pack', () => {
    it('holds the account lock, so the pack never creates while a sync reads the list', async () => {
        const { service, locks } = setup();
        await service.sync('org_b');
        expect(locks).toEqual(['templates:waba:waba_1']);
    });

    it('never deletes a row created after the sync started reading Meta’s list', async () => {
        const { service, prisma } = setup();
        const before = Date.now();
        await service.sync('org_b');
        const where = prisma.messageTemplate.deleteMany.mock.calls[1][0].where;
        expect(where).toMatchObject({ organizationId: 'org_b', wabaId: 'waba_1', externalId: { notIn: ['meta_1'] } });
        expect(where.createdAt.lt.getTime()).toBeGreaterThanOrEqual(before);
        expect(where.createdAt.lt.getTime()).toBeLessThanOrEqual(Date.now());
    });

    it('the pack’s sync adopts a collabo_<slot>_v<n> template, from Meta’s library name when it has one, and never clears pack fields', async () => {
        const { service, prisma, metaGraph, packJobs } = setup();
        metaGraph.request.mockResolvedValueOnce({
            data: { data: [
                { id: 'm1', name: 'collabo_order_confirmed_v1', language: 'en', status: 'APPROVED', category: 'UTILITY', library_template_name: 'order_confirmed' },
                { id: 'm2', name: 'collabo_cod_confirm_v2', language: 'en', status: 'PENDING', category: 'UTILITY' },
                { id: 'm3', name: 'collabo_not_a_slot_v1', language: 'en', status: 'APPROVED', category: 'UTILITY' },
                { id: 'm4', name: 'collabo_cod_confirm_v1', language: 'hi', status: 'APPROVED', category: 'UTILITY' },
            ] },
        });
        prisma.messageTemplate.upsert.mockImplementation(async (args: any) => ({ id: args.where.wabaId_name_language.name, ...args.create }));
        await service.pull('org_b', ref, { adopt: true });
        expect(metaGraph.request.mock.calls[0][0].query.fields).toMatch(/,library_template_name$/);
        const creates = prisma.messageTemplate.upsert.mock.calls.map((c: any) => c[0]);
        expect(creates[0].create).toMatchObject({ packSlot: 'order_confirmed', packVersion: 1, packSource: 'library', libraryTemplateName: 'order_confirmed' });
        expect(creates[1].create).toMatchObject({ packSlot: 'cod_confirm', packVersion: 2, packSource: 'collabo', libraryTemplateName: null });
        expect(creates[2].create.packSlot).toBeUndefined();
        expect(creates[3].create.packSlot).toBeUndefined();
        for (const c of creates) expect(Object.keys(c.update).filter((k) => k.startsWith('pack') || k === 'libraryTemplateName')).toEqual([]);
        // A pack template changed (it is new here): its automations follow.
        expect(packJobs.reconcile).toHaveBeenCalledWith('org_b', 'waba_1');
        expect(packJobs.managedSync).toHaveBeenCalledWith('org_b');
    });

    it('adopts an existing row that has no pack fields yet, and leaves one that has them', async () => {
        const { service, prisma, metaGraph, updates } = setup();
        metaGraph.request.mockResolvedValueOnce({ data: { data: [
            { id: 'm1', name: 'collabo_store_bill_v1', language: 'en', status: 'APPROVED', category: 'UTILITY' },
            { id: 'm2', name: 'collabo_order_shipped_v2', language: 'en', status: 'APPROVED', category: 'UTILITY' },
        ] } });
        prisma.messageTemplate.upsert
            .mockResolvedValueOnce({ id: 'row_1', packSlot: null, status: 'APPROVED', category: 'UTILITY' })
            .mockResolvedValueOnce({ id: 'row_2', packSlot: 'order_shipped', packSource: 'library', status: 'APPROVED', category: 'UTILITY' });
        await service.pull('org_b', ref, { adopt: true });
        expect(updates).toEqual([{ where: { id: 'row_1' }, data: { packSlot: 'store_bill', packVersion: 1, packSource: 'collabo', libraryTemplateName: null } }]);
    });

    it('a merchant’s or the cron’s sync asks Meta for nothing new and adopts nothing', async () => {
        const { service, prisma, metaGraph, updates } = setup();
        metaGraph.request.mockResolvedValueOnce({ data: { data: [{ id: 'm1', name: 'collabo_store_bill_v1', language: 'en', status: 'APPROVED', category: 'UTILITY' }] } });
        prisma.messageTemplate.upsert.mockImplementation(async (args: any) => ({ id: 'row_1', ...args.create }));
        await service.sync('org_b');
        expect(metaGraph.request.mock.calls[0][0].query.fields).toBe('id,name,language,status,category,components,quality_score,rejected_reason,parameter_format');
        expect(prisma.messageTemplate.upsert.mock.calls[0][0].create.packSlot).toBeUndefined();
        expect(updates).toEqual([]);
    });

    it('queues nothing for the pack when no pack template changed', async () => {
        const { service, packJobs } = setup();
        await service.sync('org_b');
        expect(packJobs.reconcile).not.toHaveBeenCalled();
        expect(packJobs.managedSync).not.toHaveBeenCalled();
    });
});

describe('status webhooks', () => {
    it('ignores an event older than the last one applied: Meta can deliver them out of order', async () => {
        const { service, prisma, updates } = setup();
        prisma.messageTemplate.findFirst.mockResolvedValueOnce({ id: 'tpl_1', status: 'APPROVED', category: 'UTILITY', statusUpdatedAt: new Date('2026-10-26T10:00:05Z'), packSlot: null });
        await service.applyWebhook(channel, statusEvent('PAUSED', {}, new Date('2026-10-26T10:00:00Z')));
        expect(updates).toHaveLength(0);
    });

    it('records when the event happened, so a later one is applied', async () => {
        const { service, prisma, updates } = setup();
        const at = new Date('2026-10-26T10:00:09Z');
        prisma.messageTemplate.findFirst.mockResolvedValueOnce({ id: 'tpl_1', status: 'PAUSED', category: 'UTILITY', statusUpdatedAt: new Date('2026-10-26T10:00:05Z'), packSlot: null });
        await service.applyWebhook(channel, statusEvent('APPROVED', {}, at));
        expect(updates[0].data).toMatchObject({ status: 'APPROVED', statusUpdatedAt: at });
    });

    it('keeps Meta’s rejection reason and recommendation', async () => {
        const { service, updates } = setup();
        await service.applyWebhook(channel, statusEvent('REJECTED', {
            reason: 'INVALID_FORMAT',
            rejection_info: { reason: 'Variables are next to each other.', recommendation: 'Add words between them.' },
        }));
        expect(updates[0].data).toMatchObject({
            status: 'REJECTED',
            statusReason: 'INVALID_FORMAT',
            rejectionInfo: { reason: 'Variables are next to each other.', recommendation: 'Add words between them.' },
        });
    });

    it('takes the category from the status webhook, keeping the one asked for', async () => {
        const { service, prisma, updates } = setup();
        prisma.messageTemplate.findFirst.mockResolvedValueOnce({ id: 'tpl_1', status: 'PENDING', category: 'UTILITY', requestedCategory: null, packSlot: null });
        await service.applyWebhook(channel, statusEvent('APPROVED', { message_template_category: 'MARKETING' }));
        expect(updates[0].data).toMatchObject({ status: 'APPROVED', category: 'MARKETING', requestedCategory: 'UTILITY' });
    });

    it('a pack template’s change reconciles the pack and lets its automations follow', async () => {
        const { service, prisma, packJobs } = setup();
        prisma.messageTemplate.findFirst.mockResolvedValueOnce({ id: 'tpl_1', wabaId: 'waba_1', status: 'PENDING', category: 'UTILITY', packSlot: 'order_shipped' });
        await service.applyWebhook(channel, statusEvent('APPROVED'));
        expect(packJobs.reconcile).toHaveBeenCalledWith('org_b', 'waba_1');
        expect(packJobs.managedSync).toHaveBeenCalledWith('org_b');
    });

    it('an unknown template is fetched by one sync job per account, not inline', async () => {
        const { service, prisma, metaGraph, packJobs } = setup();
        prisma.messageTemplate.findFirst.mockResolvedValueOnce(null);
        await service.applyWebhook(channel, statusEvent('APPROVED'));
        expect(packJobs.sync).toHaveBeenCalledWith('org_b');
        expect(metaGraph.request).not.toHaveBeenCalled();
    });

    it("stops the account's pack when Meta reports its template limit", async () => {
        const { service, prisma } = setup();
        await service.applyWebhook(channel, statusEvent('LIMIT_EXCEEDED'));
        expect(prisma.templatePack.updateMany).toHaveBeenCalledWith({
            where: { wabaId: 'waba_1', organizationId: 'org_b' },
            data: { status: 'stopped', stoppedReason: expect.stringMatching(/limit on message templates/) },
        });
    });
});

describe('creating pack templates', () => {
    const pack = { packSlot: 'order_cancelled', packVersion: 1, packSource: 'library' as const, libraryTemplateName: 'order_canceled_3' };
    const inputs = [{ type: 'URL' as const, url: { base_url: 'https://app.example/t/{{1}}', url_suffix_example: 'https://app.example/t/x.y' } }];
    const libraryRead = { name: 'collabo_order_cancelled_v1', language: 'en', status: 'APPROVED', category: 'UTILITY', parameter_format: 'POSITIONAL', components: [{ type: 'BODY', text: 'Hi, this is to confirm we have successfully canceled your recent order {{1}}.' }] };

    it('creates a library template with its button inputs as an array, never repeated blindly, and reads back its components', async () => {
        const { service, prisma, metaGraph } = setup();
        metaGraph.request.mockImplementation(async (req: any) =>
            req.method === 'POST' ? { data: { id: '991', status: 'APPROVED', category: 'UTILITY' } } : { data: libraryRead });
        await service.createFromLibrary('org_b', ref, { name: 'collabo_order_cancelled_v1', libraryTemplateName: 'order_canceled_3', buttonInputs: inputs }, pack, Priority.NORMAL);
        const post = metaGraph.request.mock.calls[0][0];
        expect(post.body).toEqual({ name: 'collabo_order_cancelled_v1', category: 'UTILITY', language: 'en', library_template_name: 'order_canceled_3', library_template_button_inputs: inputs });
        expect(post).toMatchObject({ idempotent: false, priority: Priority.NORMAL });
        expect(metaGraph.request.mock.calls[1][0]).toMatchObject({ method: 'GET', path: '/991', query: { fields: 'name,language,status,category,components,parameter_format,library_template_name' } });
        const upsert = prisma.messageTemplate.upsert.mock.calls[0][0];
        expect(upsert.create).toMatchObject({ externalId: '991', status: 'APPROVED', category: 'UTILITY', components: libraryRead.components, ...pack, starterKey: null, createdById: null });
    });

    it('retries once with the inputs as a JSON string when Meta refuses the array', async () => {
        const { service, metaGraph } = setup();
        metaGraph.request
            .mockRejectedValueOnce(new MetaGraphError('(#100) Invalid parameter', 'API_ERROR', 100, undefined, 400, { message: '(#100) Param library_template_button_inputs must be a valid JSON string' }))
            .mockResolvedValueOnce({ data: { id: '992', status: 'APPROVED', category: 'UTILITY' } })
            .mockResolvedValueOnce({ data: libraryRead });
        await service.createFromLibrary('org_b', ref, { name: 'collabo_order_cancelled_v1', libraryTemplateName: 'order_canceled_3', buttonInputs: inputs }, pack, Priority.NORMAL);
        expect(metaGraph.request.mock.calls[1][0].body.library_template_button_inputs).toBe(JSON.stringify(inputs));
    });

    it('does not retry another refusal', async () => {
        const { service, metaGraph } = setup();
        metaGraph.request.mockRejectedValueOnce(new MetaGraphError('Template not found in library', 'API_ERROR', 100, undefined, 400, { message: 'Template not found in library' }));
        await expect(service.createFromLibrary('org_b', ref, { name: 'n', libraryTemplateName: 'x', buttonInputs: inputs }, pack, Priority.NORMAL)).rejects.toThrow('Template not found');
        expect(metaGraph.request).toHaveBeenCalledTimes(1);
    });

    it('upserts the row, keeping the status a webhook already gave it, when Meta approved it before the save', async () => {
        const { service, prisma, metaGraph } = setup();
        metaGraph.request.mockResolvedValueOnce({ data: { id: '993', status: 'PENDING', category: 'UTILITY' } });
        prisma.messageTemplate.upsert.mockResolvedValueOnce({ id: 'row', status: 'APPROVED', category: 'UTILITY', requestedCategory: null });
        const draft = { name: 'collabo_out_for_delivery_v1', language: 'en', category: 'UTILITY', parameterFormat: 'NAMED', body: { text: 'Hi {{first_name}}, your order is out for delivery today with our courier.', examples: { first_name: 'A' } } };
        const row = await service.submit('org_b', ref, draft as any, { createdById: null, starterKey: null, priority: Priority.NORMAL, pack: { ...pack, packSlot: 'out_for_delivery', packSource: 'collabo', libraryTemplateName: null } });
        const args = prisma.messageTemplate.upsert.mock.calls[0][0];
        expect(args.where).toEqual({ wabaId_name_language: { wabaId: 'waba_1', name: 'collabo_out_for_delivery_v1', language: 'en' } });
        expect(args.update).not.toHaveProperty('status');
        expect(args.update).toMatchObject({ externalId: '993', packSlot: 'out_for_delivery', createdById: null });
        expect(row.status).toBe('APPROVED');
        expect(metaGraph.request.mock.calls[0][0]).toMatchObject({ idempotent: false, priority: Priority.NORMAL });
    });

    it('the editor’s own create keeps its interactive priority and Meta’s retries', async () => {
        const { service, prisma, metaGraph } = setup();
        metaGraph.request.mockResolvedValueOnce({ data: { id: '994', status: 'PENDING', category: 'MARKETING' } });
        prisma.messageTemplate.upsert.mockImplementationOnce(async (args: any) => ({ id: 'row', ...args.create }));
        const draft = { name: 'utility_but_sale', language: 'en', category: 'UTILITY', parameterFormat: 'POSITIONAL', body: { text: 'Big sale: 50% off everything today.', examples: {} } };
        const view = await service.create('org_b', 'user_1', draft as any);
        expect(metaGraph.request.mock.calls[0][0]).toMatchObject({ priority: Priority.INTERACTIVE });
        expect(metaGraph.request.mock.calls[0][0]).not.toHaveProperty('idempotent');
        expect(view).toMatchObject({ category: 'MARKETING', requestedCategory: 'UTILITY', status: 'PENDING', packSlot: undefined });
    });
});
