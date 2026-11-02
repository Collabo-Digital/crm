import { WhatsAppAccountService } from './whatsapp-account.service';

/**
 * The coexistence contacts + history sync may be requested once each, within
 * 24 hours of onboarding. A retried job must never ask twice, and a job that
 * runs too late must say so instead of calling Meta.
 */
describe('WhatsAppAccountService.runCoexistenceSync', () => {
    const onboardedAt = new Date('2026-10-23T08:00:00Z');

    function build(historySync: Record<string, unknown>, isOnBizApp = true) {
        const prisma = {
            channel: {
                findFirst: jest.fn().mockResolvedValue({
                    id: 'ch1',
                    organizationId: 'org1',
                    status: 'CONNECTED',
                    connectedAt: onboardedAt,
                    credentials: { wabaId: 'w1', phoneNumberId: 'pn1', accessToken: 'enc', isOnBizApp },
                    metadata: { historySync },
                }),
            },
            $executeRaw: jest.fn().mockResolvedValue(1),
        };
        const metaGraph = {
            request: jest.fn().mockResolvedValue({ data: { messaging_product: 'whatsapp', request_id: 'req-1' } }),
            baseScopes: () => [],
        };
        const service = new WhatsAppAccountService(prisma as never, { decrypt: () => 'token' } as never, metaGraph as never);
        const syncTypes = () => metaGraph.request.mock.calls.map((c) => c[0].body?.sync_type);
        return { service, metaGraph, prisma, syncTypes };
    }

    const inWindow = new Date('2026-10-23T09:00:00Z');

    it('requests contacts first, then history', async () => {
        const { service, metaGraph, syncTypes } = build({ status: 'pending', onboardedAt: onboardedAt.toISOString() });
        await expect(service.runCoexistenceSync('ch1', inWindow)).resolves.toBe('done');
        expect(syncTypes()).toEqual(['smb_app_state_sync', 'history']);
        expect(metaGraph.request.mock.calls[0][0]).toMatchObject({
            method: 'POST',
            path: '/pn1/smb_app_data',
            body: { messaging_product: 'whatsapp', sync_type: 'smb_app_state_sync' },
        });
    });

    it('skips a step a previous attempt already completed', async () => {
        const { service, syncTypes } = build({ contactsRequestId: 'req-0', onboardedAt: onboardedAt.toISOString() });
        await service.runCoexistenceSync('ch1', inWindow);
        expect(syncTypes()).toEqual(['history']);
    });

    it('does nothing once both were requested', async () => {
        const { service, metaGraph } = build({ contactsRequestId: 'a', historyRequestId: 'b', onboardedAt: onboardedAt.toISOString() });
        await service.runCoexistenceSync('ch1', inWindow);
        expect(metaGraph.request).not.toHaveBeenCalled();
    });

    it('reports an expired window instead of calling Meta after 24 hours', async () => {
        const { service, metaGraph, prisma } = build({ status: 'pending', onboardedAt: onboardedAt.toISOString() });
        await expect(service.runCoexistenceSync('ch1', new Date('2026-10-24T08:30:00Z'))).resolves.toBe('expired');
        expect(metaGraph.request).not.toHaveBeenCalled();
        expect(prisma.$executeRaw).toHaveBeenCalled();
    });

    it('skips numbers that are not on the WhatsApp Business app', async () => {
        const { service, metaGraph } = build({}, false);
        await expect(service.runCoexistenceSync('ch1', inWindow)).resolves.toBe('skipped');
        expect(metaGraph.request).not.toHaveBeenCalled();
    });
});
