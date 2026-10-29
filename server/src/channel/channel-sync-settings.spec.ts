import { ChannelPlatform } from '@prisma/client';
import { ChannelService } from './channel.service';

/**
 * The settings the merchant sees must match what runSync does: pull is on
 * unless switched off, push is off until switched on. A push creates real
 * products and orders in the live store, so it is never the default.
 */
describe('ChannelService.getSyncSettings', () => {
  function build(rows: Array<{ direction: string; entityType: string; enabled: boolean }>) {
    const prisma = {
      channel: {
        findFirst: jest.fn(async ({ where }: any) =>
          where.platform === ChannelPlatform.MANUAL
            ? { id: 'ch_manual' }
            : { id: 'ch_1', platform: ChannelPlatform.SHOPIFY },
        ),
      },
      channelSyncState: {
        findMany: jest.fn().mockResolvedValue(
          rows.map((r) => ({ ...r, watermark: null, backfillDone: false })),
        ),
      },
      $queryRaw: jest.fn().mockResolvedValue([{ count: BigInt(4) }]),
    };
    const service = new ChannelService(prisma as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    return { service, prisma };
  }

  it('shows pull on and push off for a newly connected store', async () => {
    const { service } = build([]);

    const settings = await service.getSyncSettings('ch_1', 'org_1');

    expect(settings.pull.every((r) => r.enabled)).toBe(true);
    expect(settings.push.every((r) => !r.enabled)).toBe(true);
  });

  it('shows a push the merchant switched on', async () => {
    const { service } = build([{ direction: 'push', entityType: 'orders', enabled: true }]);

    const settings = await service.getSyncSettings('ch_1', 'org_1');

    expect(settings.push.find((r) => r.entityType === 'orders')?.enabled).toBe(true);
    expect(settings.push.find((r) => r.entityType === 'products')?.enabled).toBe(false);
  });

  it('does not count cancelled, refunded or voided sales as waiting to be pushed', async () => {
    const { service, prisma } = build([]);

    await service.getSyncSettings('ch_1', 'org_1');

    const ordersQuery = prisma.$queryRaw.mock.calls
      .map((c: any[]) => JSON.stringify(c))
      .find((s: string) => s.includes('cancelled_at'));
    expect(ordersQuery).toBeDefined();
    expect(ordersQuery).toContain('REFUNDED');
  });
});
