import { ChannelPlatform, ChannelStatus } from '@prisma/client';
import { WhatsAppOAuthService } from './whatsapp-oauth.service';
import { WhatsAppAccountService } from './whatsapp-account.service';

/**
 * Embedded Signup callback: the business token exchange, the session-info
 * shortcut, and the two onboarding paths — a WhatsApp Business app number
 * (coexistence: no registration, history sync queued) and a Cloud API number
 * (registered with a PIN we keep).
 */
describe('WhatsAppOAuthService.handleSignupCallback', () => {
    const state = 'state-1';

    function build(opts: { isOnBizApp?: boolean; subscribeFails?: boolean; pack?: Record<string, unknown>; rows?: Array<Record<string, unknown>> } = {}) {
        const created: Array<Record<string, unknown>> = [];
        const prisma = {
            templatePack: {
                findUnique: jest.fn().mockResolvedValue(opts.pack ?? null),
                create: jest.fn().mockResolvedValue({ id: 'pack_1' }),
                update: jest.fn().mockResolvedValue({ id: 'pack_1' }),
            },
            channel: {
                findMany: jest.fn().mockResolvedValue(opts.rows ?? []),
                findUnique: jest.fn().mockResolvedValue(null),
                create: jest.fn().mockImplementation(({ data }) => {
                    created.push(data);
                    return Promise.resolve({ id: 'ch_new' });
                }),
                update: jest.fn().mockResolvedValue({ id: 'ch_new' }),
            },
            $executeRaw: jest.fn().mockResolvedValue(1),
        };
        const redis = {
            get: jest.fn().mockResolvedValue({ userId: 'u1', orgId: 'org1' }),
            del: jest.fn().mockResolvedValue(undefined),
        };
        const config = {
            get: jest.fn((key: string) =>
                ({
                    'whatsapp.appId': 'app',
                    'whatsapp.appSecret': 'secret',
                    'whatsapp.configId': 'cfg',
                    'whatsapp.graphVersion': 'v25.0',
                    frontendUrl: 'https://app.example',
                })[key],
            ),
        };
        const encryption = { encrypt: (v: string) => `enc(${v})`, decrypt: (v: string) => v.replace(/^enc\((.*)\)$/, '$1') };
        const metaGraph = {
            request: jest.fn().mockImplementation(({ path }: { path: string }) => {
                if (path === '/oauth/access_token') return Promise.resolve({ data: { access_token: 'BISU_TOKEN' } });
                if (path === '/1029') return Promise.resolve({ data: { id: '1029', name: 'Acme WABA', owner_business_info: { id: 'biz9' } } });
                throw new Error(`unexpected ${path}`);
            }),
            baseScopes: () => [],
        };
        const account = {
            firstNumberId: jest.fn().mockResolvedValue('pn_first'),
            fetchNumber: jest.fn().mockResolvedValue({
                id: 'pn1',
                display_phone_number: '+91 98450 00000',
                verified_name: 'Acme',
                quality_rating: 'GREEN',
                is_on_biz_app: opts.isOnBizApp ?? false,
            }),
            subscribeApp: opts.subscribeFails
                ? jest.fn().mockRejectedValue(new Error('(#200) Permissions error'))
                : jest.fn().mockResolvedValue(undefined),
            registerNumber: jest.fn().mockResolvedValue(undefined),
        };
        const queue = { add: jest.fn().mockResolvedValue({ id: 'job' }) };
        const packQueue = { getJob: jest.fn().mockResolvedValue(undefined), add: jest.fn().mockResolvedValue({ id: 'pack' }) };
        const service = new WhatsAppOAuthService(
            prisma as never,
            config as never,
            encryption as never,
            redis as never,
            metaGraph as never,
            account as never,
            queue as never,
            packQueue as never,
        );
        return { service, prisma, account, queue, packQueue, metaGraph, created };
    }
    const settle = () => new Promise((r) => setImmediate(r));

    it('uses the business token directly, with no long-lived exchange', async () => {
        const { service, metaGraph } = build();
        await service.handleSignupCallback('code', state, 'org1', 'u1', { wabaId: '1029', phoneNumberId: 'pn1' });
        const paths = metaGraph.request.mock.calls.map((c) => c[0].path);
        expect(paths).toEqual(['/oauth/access_token', '/1029']);
        const exchange = metaGraph.request.mock.calls[0][0];
        expect(exchange.query).toEqual({ client_id: 'app', client_secret: 'secret', code: 'code' });
    });

    it('registers a Cloud API number with a PIN it keeps, and subscribes the app', async () => {
        const { service, account, queue, created } = build({ isOnBizApp: false });
        const result = await service.handleSignupCallback('code', state, 'org1', 'u1', { wabaId: '1029', phoneNumberId: 'pn1' });

        expect(account.subscribeApp).toHaveBeenCalledWith('1029', 'BISU_TOKEN');
        expect(account.registerNumber).toHaveBeenCalledTimes(1);
        const pin = account.registerNumber.mock.calls[0][3];
        expect(pin).toMatch(/^\d{6}$/);
        const creds = created[0].credentials as Record<string, unknown>;
        expect(creds).toMatchObject({
            wabaId: '1029',
            phoneNumberId: 'pn1',
            isOnBizApp: false,
            accessToken: 'enc(BISU_TOKEN)',
            registrationPin: `enc(${pin})`,
            tokenExpiresAt: null,
        });
        expect(created[0]).toMatchObject({ platform: ChannelPlatform.WHATSAPP, status: ChannelStatus.CONNECTED, externalStoreId: '1029' });
        expect(queue.add).not.toHaveBeenCalled();
        expect(result).toMatchObject({ isOnBizApp: false, setup: { webhooks: 'ok', registration: 'ok' } });
    });

    it('onboards a WhatsApp Business app number without registering it, and queues the history sync', async () => {
        const { service, account, queue, created } = build({ isOnBizApp: true });
        const result = await service.handleSignupCallback('code', state, 'org1', 'u1', {
            wabaId: '1029',
            phoneNumberId: 'pn1',
            isOnBizApp: true,
        });

        expect(account.registerNumber).not.toHaveBeenCalled();
        expect(account.subscribeApp).toHaveBeenCalled();
        expect(queue.add).toHaveBeenCalledWith(
            'coexistence-sync',
            { channelId: 'ch_new' },
            expect.objectContaining({ jobId: 'coexistence-sync-ch_new', attempts: 9 }),
        );
        const meta = created[0].metadata as Record<string, any>;
        expect(meta.historySync.status).toBe('pending');
        expect(meta.coexistence).toMatchObject({ state: 'connected', sendsPaused: false });
        expect((created[0].credentials as Record<string, unknown>).registrationPin).toBeNull();
        expect(result).toMatchObject({ isOnBizApp: true, setup: { registration: 'not_needed' } });
    });

    it('falls back to the first number on the account when session info names none', async () => {
        const { service, account } = build();
        await service.handleSignupCallback('code', state, 'org1', 'u1', { wabaId: '1029' });
        expect(account.firstNumberId).toHaveBeenCalledWith('1029', 'BISU_TOKEN');
        expect(account.fetchNumber).toHaveBeenCalledWith('1029', 'pn_first', 'BISU_TOKEN');
    });

    it('keeps the channel and reports a failed webhook subscription instead of losing the signup', async () => {
        const { service, prisma } = build({ subscribeFails: true });
        const result = await service.handleSignupCallback('code', state, 'org1', 'u1', { wabaId: '1029', phoneNumberId: 'pn1' });
        expect(result.setup.webhooks).toBe('failed');
        expect(prisma.channel.create).toHaveBeenCalled();
        const lastErrorWrite = prisma.channel.update.mock.calls.map((c) => c[0].data.lastError).find(Boolean);
        expect(lastErrorWrite).toMatch(/could not subscribe.*Retry setup/);
    });

    it("starts Collabo's recommended templates on a new account, going live by themselves once approved", async () => {
        const { service, prisma, packQueue } = build();
        await service.handleSignupCallback('code', state, 'org1', 'u1', { wabaId: '1029', phoneNumberId: 'pn1' });
        await settle();

        expect(prisma.templatePack.create).toHaveBeenCalledWith({
            data: { organizationId: 'org1', channelId: 'ch_new', wabaId: '1029', autoActivate: true, origin: 'connect' },
        });
        expect(packQueue.add).toHaveBeenCalledWith(
            'ensure',
            { organizationId: 'org1', wabaId: '1029', reason: 'connect' },
            expect.objectContaining({ jobId: 'pack-ensure-org1' }),
        );
    });

    it('starts a reconnected channel row’s templates with its automations waiting for the merchant', async () => {
        const { service, prisma, packQueue } = build({ rows: [{ id: 'ch_new', platform: ChannelPlatform.WHATSAPP, status: ChannelStatus.CONNECTED, externalStoreId: '1029', metadata: {} }] });
        await service.handleSignupCallback('code', state, 'org1', 'u1', { wabaId: '1029', phoneNumberId: 'pn1' });
        await settle();

        expect(prisma.channel.update).toHaveBeenCalled();
        expect(prisma.channel.create).not.toHaveBeenCalled();
        expect(prisma.templatePack.create).toHaveBeenCalledWith({
            data: { organizationId: 'org1', channelId: 'ch_new', wabaId: '1029', autoActivate: false, origin: 'connect' },
        });
        expect(packQueue.add).toHaveBeenCalledWith('ensure', expect.objectContaining({ reason: 'connect' }), expect.anything());
    });

    it('keeps the pack of an account connected before, so its automations stay as they were', async () => {
        const { service, prisma, packQueue } = build({
            pack: { id: 'pack_1', organizationId: 'org1', channelId: 'ch_new', wabaId: '1029', autoActivate: false, origin: 'backfill' },
        });
        await service.handleSignupCallback('code', state, 'org1', 'u1', { wabaId: '1029', phoneNumberId: 'pn1' });
        await settle();

        expect(prisma.templatePack.create).not.toHaveBeenCalled();
        expect(prisma.templatePack.update).not.toHaveBeenCalled();
        expect(packQueue.add).toHaveBeenCalledWith('ensure', expect.objectContaining({ reason: 'connect' }), expect.anything());
    });

    it('connects even when the templates cannot be started', async () => {
        const { service, prisma, packQueue } = build();
        prisma.templatePack.findUnique.mockRejectedValue(new Error('database busy'));
        jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);

        const result = await service.handleSignupCallback('code', state, 'org1', 'u1', { wabaId: '1029', phoneNumberId: 'pn1' });
        await settle();

        expect(result).toMatchObject({ channelId: 'ch_new', setup: { webhooks: 'ok' } });
        expect(packQueue.add).not.toHaveBeenCalled();
    });

    it('refuses a state issued to someone else', async () => {
        const { service } = build();
        await expect(
            service.handleSignupCallback('code', state, 'org1', 'intruder', { wabaId: '1029' }),
        ).rejects.toThrow('Invalid or expired state parameter');
    });
});

describe('WhatsAppAccountService.newPin', () => {
    it('is always six digits', () => {
        for (let i = 0; i < 200; i++) expect(WhatsAppAccountService.newPin()).toMatch(/^\d{6}$/);
    });
});
