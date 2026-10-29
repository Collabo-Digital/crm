import { ConflictException } from '@nestjs/common';
import { ChannelPlatform } from '@prisma/client';
import { InstagramOAuthService } from './instagram-oauth.service';
import { classifyMetaCallbackError } from './channel-connection.util';

/**
 * Instagram Login connect: an account another workspace holds is refused by
 * the service itself, not only by the database's unique index, which a
 * database with older duplicate claims does not have.
 */
describe('InstagramOAuthService: an account held by another workspace', () => {
    function build(holder: { organizationId: string; organization: { name: string } } | null) {
        const prisma = {
            channel: {
                findMany: jest.fn(() => Promise.resolve([])),
                findFirst: jest.fn(() => Promise.resolve(holder)),
                create: jest.fn(() => Promise.resolve({ id: 'ch_new' })),
                update: jest.fn(() => Promise.resolve({ id: 'ch_new' })),
            },
        };
        const metaGraph = { baseScopes: () => [], request: jest.fn(() => Promise.resolve({ data: { success: true } })) };
        const service = new InstagramOAuthService(
            prisma as never,
            { get: () => undefined } as never,
            { encrypt: (v: string) => v, decrypt: (v: string) => v } as never,
            {} as never,
            metaGraph as never,
        );
        return { service, prisma, metaGraph };
    }
    const candidate = {
        igUserId: '17841400000000001',
        scopedId: null,
        username: 'priya.makes',
        name: 'Priya',
        profilePictureUrl: null,
        accountType: 'MEDIA_CREATOR',
        accessToken: 'IG_TOKEN',
        tokenIssuedAt: '2026-10-28T00:00:00.000Z',
        tokenExpiresAt: '2026-12-27T00:00:00.000Z',
        scopes: ['instagram_business_basic', 'instagram_business_manage_messages'],
    };

    it('refuses it before subscribing or writing anything, as account_taken', async () => {
        const { service, prisma, metaGraph } = build({ organizationId: 'org_brand', organization: { name: 'Brand Co' } });

        const attempt = service['connectCandidate']('org_mine', candidate, undefined, 'u_influencer');
        await expect(attempt).rejects.toBeInstanceOf(ConflictException);
        const error = await attempt.catch((e: unknown) => e);

        expect(prisma.channel.findFirst.mock.calls[0]).toEqual([
            expect.objectContaining({
                where: { platform: ChannelPlatform.INSTAGRAM, externalStoreId: '17841400000000001', organizationId: { not: 'org_mine' } },
            }),
        ]);
        expect(classifyMetaCallbackError({}, error)).toBe('account_taken');
        expect(metaGraph.request).not.toHaveBeenCalled();
        expect(prisma.channel.create).not.toHaveBeenCalled();
        expect(prisma.channel.update).not.toHaveBeenCalled();
    });

    it('connects it when no other workspace holds it', async () => {
        const { service, prisma } = build(null);

        await expect(service['connectCandidate']('org_mine', candidate, undefined, 'u_influencer')).resolves.toMatchObject({ channelId: 'ch_new' });
        expect(prisma.channel.create).toHaveBeenCalledTimes(1);
    });
});
