import { ChannelPlatform, ChannelStatus, Prisma } from '@prisma/client';
import { ChannelService } from './channel.service';

/**
 * An influencer's Instagram is their own account. When they leave a
 * workspace (removed, or closing their account), what they connected there
 * is disconnected: Meta stops sending its messages, the token is cleared and
 * the account is free to connect elsewhere.
 */
describe('ChannelService.disconnectOwnedBy', () => {
    const instagram = {
        id: 'ch_ig',
        organizationId: 'org_brand',
        platform: ChannelPlatform.INSTAGRAM,
        status: ChannelStatus.CONNECTED,
        externalStoreId: '17841400000000001',
        credentials: { authFlow: 'instagram_login', accessToken: 'enc(IG_TOKEN)', instagramUsername: 'priya.makes' },
        metadata: { webhookSubscription: { ok: true } },
        ownerUserId: 'u_influencer',
    };

    function build(rows: unknown[]) {
        const prisma = {
            channel: {
                findMany: jest.fn(() => Promise.resolve(rows)),
                update: jest.fn(() => Promise.resolve({})),
            },
        };
        const instagramOAuth = { revokeWebhookSubscription: jest.fn(() => Promise.resolve()) };
        const service = new ChannelService(prisma as never, {} as never, instagramOAuth as never, {} as never, {} as never, {} as never);
        return { service, prisma, instagramOAuth };
    }

    it("disconnects the departing influencer's live channels in those workspaces only", async () => {
        const { service, prisma, instagramOAuth } = build([instagram]);

        await service.disconnectOwnedBy(['org_brand'], 'u_influencer');

        expect(prisma.channel.findMany.mock.calls[0]).toEqual([
            {
                where: {
                    organizationId: { in: ['org_brand'] },
                    ownerUserId: 'u_influencer',
                    platform: { not: ChannelPlatform.MANUAL },
                    status: { not: ChannelStatus.DISCONNECTED },
                },
            },
        ]);
        expect(instagramOAuth.revokeWebhookSubscription).toHaveBeenCalledWith(instagram);
        expect(prisma.channel.update.mock.calls[0]).toEqual([
            {
                where: { id: 'ch_ig' },
                data: expect.objectContaining({
                    status: ChannelStatus.DISCONNECTED,
                    credentials: Prisma.JsonNull,
                    externalStoreId: null,
                    metadata: expect.objectContaining({ externalAccountId: '17841400000000001' }),
                }),
            },
        ]);
    });

    it('does nothing for someone who is an influencer nowhere', async () => {
        const { service, prisma } = build([]);

        await service.disconnectOwnedBy([], 'u_member');

        expect(prisma.channel.findMany).not.toHaveBeenCalled();
    });
});
