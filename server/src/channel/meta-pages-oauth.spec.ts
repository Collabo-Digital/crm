import { ChannelPlatform, ChannelStatus } from '@prisma/client';
import { FACEBOOK_LOGIN_FLOW, MetaPagesOAuthService, PAGE_SUBSCRIBED_FIELDS } from './meta-pages-oauth.service';

/**
 * One Facebook Login for Business popup connects every Page the business
 * shared, plus the Instagram account linked to each, and subscribes each Page
 * once (that subscription carries both Messenger and Instagram webhooks).
 */
describe('MetaPagesOAuthService.handleCallback', () => {
    function build(opts: { pages: unknown[]; userToken?: boolean; subscribeFails?: boolean }) {
        const created: Array<Record<string, any>> = [];
        const prisma = {
            channel: {
                findMany: jest.fn().mockResolvedValue([]),
                findFirst: jest.fn().mockResolvedValue(null),
                create: jest.fn().mockImplementation(({ data }) => {
                    created.push(data);
                    return Promise.resolve({ id: `ch_${created.length}` });
                }),
                update: jest.fn(),
            },
        };
        const redis = {
            get: jest.fn().mockResolvedValue({ userId: 'u1', orgId: 'org1' }),
            del: jest.fn(),
        };
        const config = {
            get: (key: string) =>
                ({ 'meta.appId': 'app', 'meta.appSecret': 'secret', 'messenger.configId': 'cfg-pages' })[key],
        };
        const metaGraph = {
            baseScopes: () => [],
            request: jest.fn().mockImplementation((req: { method: string; path: string; query?: Record<string, string> }) => {
                if (req.path === '/oauth/access_token' && req.query?.code) {
                    return Promise.resolve({ data: opts.userToken ? { access_token: 'SHORT', expires_in: 3600 } : { access_token: 'BISU' } });
                }
                if (req.path === '/oauth/access_token') return Promise.resolve({ data: { access_token: 'LONG' } });
                if (req.path === '/me/accounts') return Promise.resolve({ data: { data: opts.pages } });
                if (req.path.endsWith('/subscribed_apps')) {
                    return opts.subscribeFails ? Promise.reject(new Error('(#200) missing permission')) : Promise.resolve({ data: { success: true } });
                }
                return Promise.reject(new Error(`unexpected ${req.method} ${req.path}`));
            }),
        };
        const service = new MetaPagesOAuthService(
            prisma as never,
            config as never,
            { encrypt: (v: string) => `enc(${v})`, decrypt: (v: string) => v } as never,
            redis as never,
            metaGraph as never,
        );
        return { service, created, metaGraph, prisma };
    }

    const page = {
        id: 'page1',
        name: 'Acme Store',
        access_token: 'PAGE_TOKEN',
        tasks: ['MANAGE', 'MESSAGING'],
        instagram_business_account: { id: 'ig1', username: 'acme', name: 'Acme', profile_picture_url: 'https://pic' },
    };

    it('connects the Page and its Instagram account, subscribing the Page once', async () => {
        const { service, created, metaGraph } = build({ pages: [page] });
        const result = await service.handleCallback('code', 'st', 'org1', 'u1');

        expect(result.connected.map((c) => c.platform)).toEqual([ChannelPlatform.FACEBOOK, ChannelPlatform.INSTAGRAM]);
        expect(created[0]).toMatchObject({
            platform: ChannelPlatform.FACEBOOK,
            externalStoreId: 'page1',
            status: ChannelStatus.CONNECTED,
            credentials: { authFlow: FACEBOOK_LOGIN_FLOW, pageId: 'page1', pageAccessToken: 'enc(PAGE_TOKEN)' },
        });
        expect(created[1]).toMatchObject({
            platform: ChannelPlatform.INSTAGRAM,
            externalStoreId: 'ig1',
            credentials: { authFlow: FACEBOOK_LOGIN_FLOW, instagramUserId: 'ig1', instagramUsername: 'acme', pageId: 'page1' },
        });
        const subscribes = metaGraph.request.mock.calls.filter((c) => c[0].path === '/page1/subscribed_apps');
        expect(subscribes).toHaveLength(1);
        expect(subscribes[0][0]).toMatchObject({ method: 'POST', query: { subscribed_fields: PAGE_SUBSCRIBED_FIELDS }, accessToken: 'PAGE_TOKEN' });
    });

    it('swaps a short-lived user token for a long-lived one before reading Pages', async () => {
        const { service, metaGraph } = build({ pages: [page], userToken: true });
        await service.handleCallback('code', 'st', 'org1', 'u1');
        const accounts = metaGraph.request.mock.calls.find((c) => c[0].path === '/me/accounts')![0];
        expect(accounts.accessToken).toBe('LONG');
    });

    it('skips a Page Meta returned without a token, and keeps the others', async () => {
        const { service, created } = build({ pages: [{ id: 'p0', name: 'No access' }, { ...page, instagram_business_account: undefined }] });
        const result = await service.handleCallback('code', 'st', 'org1', 'u1');
        expect(result.skipped).toEqual([{ name: 'No access', reason: expect.stringMatching(/full control/) }]);
        expect(created).toHaveLength(1);
    });

    it('records a failed Page subscription on the row instead of failing the connect', async () => {
        const { service, created } = build({ pages: [page], subscribeFails: true });
        const result = await service.handleCallback('code', 'st', 'org1', 'u1');
        expect(result.connected[0].webhooks).toBe('failed');
        expect(created[0].lastError).toMatch(/could not subscribe/);
        expect(created[0].metadata.webhookSubscription.ok).toBe(false);
    });

    it('skips a Page or Instagram account another organization holds, whether or not the database has the unique index', async () => {
        const { service, created, prisma } = build({ pages: [page] });
        prisma.channel.findFirst.mockImplementation(({ where }: { where: { externalStoreId: string } }) =>
            Promise.resolve(where.externalStoreId === 'ig1' ? { id: 'ch_elsewhere' } : null),
        );

        const result = await service.handleCallback('code', 'st', 'org1', 'u1');

        expect(prisma.channel.findFirst).toHaveBeenCalledWith({
            where: { platform: ChannelPlatform.INSTAGRAM, externalStoreId: 'ig1', organizationId: { not: 'org1' } },
            select: { id: true },
        });
        expect(result.connected.map((c) => c.platform)).toEqual([ChannelPlatform.FACEBOOK]);
        expect(result.skipped).toEqual([{ name: 'acme', reason: expect.stringMatching(/another organization/) }]);
        expect(created.map((c) => c.platform)).toEqual([ChannelPlatform.FACEBOOK]);
    });

    it('refuses when no Page was shared', async () => {
        const { service } = build({ pages: [] });
        await expect(service.handleCallback('code', 'st', 'org1', 'u1')).rejects.toThrow(/No Facebook Page/);
    });
});
