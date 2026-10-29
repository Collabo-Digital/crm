import { readFileSync } from 'fs';
import { join } from 'path';
import { ChannelPlatform, ChannelStatus } from '@prisma/client';
import { MessengerWebhookHandler } from './messenger-webhook.handler';

const fixture = (name: string): unknown =>
    JSON.parse(readFileSync(join(__dirname, '../../../../test/fixtures/meta', name), 'utf8'));

/**
 * A Page or Instagram webhook names its account, not a workspace, so the
 * account's channel row decides where the messages go.
 */
describe('MessengerWebhookHandler: which workspace', () => {
    it('records the messages of a Page several rows claim in one workspace only: the connected row connected first', async () => {
        const claim = (id: string, organizationId: string, status: ChannelStatus, connectedAt: string) => ({
            id, organizationId, platform: ChannelPlatform.FACEBOOK, status, connectedAt: new Date(connectedAt),
        });
        const prisma = {
            channel: {
                findMany: jest.fn(() => Promise.resolve([
                    claim('ch_later', 'org_2', ChannelStatus.CONNECTED, '2026-10-01T00:00:00Z'),
                    claim('ch_errored', 'org_3', ChannelStatus.ERROR, '2025-01-01T00:00:00Z'),
                    claim('ch_first', 'org_1', ChannelStatus.CONNECTED, '2026-01-01T00:00:00Z'),
                ])),
            },
        };
        const ingest = { recordInbound: jest.fn((_: { channel: { id: string; organizationId: string } }) => Promise.resolve(null)) };
        const handler = new MessengerWebhookHandler(prisma as never, ingest as never, {} as never, { get: () => 'app' } as never);
        jest.spyOn(handler['logger'], 'warn').mockImplementation(() => undefined);

        await handler.handle(fixture('fb-message.json'));

        expect(prisma.channel.findMany.mock.calls[0]).toEqual([
            expect.objectContaining({
                where: { platform: ChannelPlatform.FACEBOOK, externalStoreId: '682498302938465', status: { not: ChannelStatus.DISCONNECTED } },
            }),
        ]);
        const channels = ingest.recordInbound.mock.calls.map(([arg]) => `${arg.channel.id}@${arg.channel.organizationId}`);
        expect(channels).toEqual(['ch_first@org_1', 'ch_first@org_1', 'ch_first@org_1']);
    });
});
