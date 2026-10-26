import { PaymentAccountsService } from './payment-accounts.service';

/**
 * Connecting Razorpay adds the payment templates to Collabo's recommended
 * WhatsApp templates, but only for an organization that has them: one
 * without a pack (the test workspace, for one) gets no templates from it.
 */
describe('PaymentAccountsService.connect and the recommended WhatsApp templates', () => {
    function build(opts: { wabaId?: string; packOrg?: string } = {}) {
        const prisma = {
            paymentAccount: {
                findUnique: jest.fn().mockResolvedValue(null),
                create: jest.fn().mockResolvedValue({ id: 'pa_1' }),
                update: jest.fn(),
            },
            channel: { findFirst: jest.fn().mockResolvedValue(opts.wabaId ? { externalStoreId: opts.wabaId } : null) },
            templatePack: { findUnique: jest.fn().mockResolvedValue(opts.packOrg ? { organizationId: opts.packOrg } : null) },
        };
        const encryption = { encrypt: (v: string) => `enc(${v})`, decrypt: (v: string) => v.replace(/^enc\((.*)\)$/, '$1') };
        const razorpay = { keysWork: jest.fn().mockResolvedValue(true) };
        const packQueue = { getJob: jest.fn().mockResolvedValue(undefined), add: jest.fn().mockResolvedValue({ id: 'pack' }) };
        const service = new PaymentAccountsService(prisma as never, encryption as never, razorpay as never, packQueue as never);
        return { service, packQueue };
    }
    const keys = { keyId: 'rzp_test_LOCAL1234', keySecret: 'local_secret_5678' };
    const settle = () => new Promise((r) => setImmediate(r));

    it('queues the pack for an organization that has one', async () => {
        const { service, packQueue } = build({ wabaId: '1029', packOrg: 'org_1' });
        await service.connect('org_1', 'u_1', keys);
        await settle();
        expect(packQueue.add).toHaveBeenCalledWith(
            'ensure',
            { organizationId: 'org_1', wabaId: '1029', reason: 'razorpay' },
            expect.objectContaining({ jobId: 'pack-ensure-org_1' }),
        );
    });

    it('queues nothing without a pack, without WhatsApp, or for a pack another organization left', async () => {
        for (const opts of [{ wabaId: '1029' }, {}, { wabaId: '1029', packOrg: 'org_2' }]) {
            const { service, packQueue } = build(opts);
            await service.connect('org_1', 'u_1', keys);
            await settle();
            expect(packQueue.add).not.toHaveBeenCalled();
        }
    });

    it('connects even when the pack cannot be queued', async () => {
        const { service, packQueue } = build({ wabaId: '1029', packOrg: 'org_1' });
        packQueue.add.mockRejectedValue(new Error('redis down'));
        jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);
        await expect(service.connect('org_1', 'u_1', keys)).resolves.toMatchObject({ webhookSecret: expect.any(String) });
        await settle();
    });
});
