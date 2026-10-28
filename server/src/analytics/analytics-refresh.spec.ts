import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { RolesGuard } from '../auth/roles.guard';
import { AnalyticsController } from './analytics.controller';
import { CartEventsAggregator } from './cart-events-aggregator.service';
import { PixelEventsAggregator } from './pixel-events-aggregator.service';

/** The where clause each aggregator reads raw storefront events with. */
function aggregators() {
  const findMany = jest.fn((_args: { where: Record<string, unknown> }) => Promise.resolve([]));
  const prisma = { rawAnalyticsEvent: { findMany } };
  return {
    cart: new CartEventsAggregator(prisma as never),
    pixel: new PixelEventsAggregator(prisma as never),
    wheres: () => findMany.mock.calls.map(([args]) => args.where),
  };
}

describe('Analytics › Refresh', () => {
  it("rolls up only the caller's workspace", async () => {
    const { cart, pixel, wheres } = aggregators();
    const prisma = { channel: { findMany: jest.fn(() => Promise.resolve([])) } };
    const controller = new AnalyticsController({} as never, {} as never, {} as never, cart, pixel, prisma as never);

    await controller.refresh('org_a', {});

    expect(wheres()).toHaveLength(2);
    for (const where of wheres()) expect(where).toMatchObject({ organizationId: 'org_a' });
    expect(prisma.channel.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ organizationId: 'org_a' }) as object }));
  });

  it('leaves the hourly roll-ups across every workspace', async () => {
    const { cart, pixel, wheres } = aggregators();

    await cart.runHourly();
    await pixel.runHourly();

    for (const where of wheres()) expect(where).not.toHaveProperty('organizationId');
  });

  it('is refused to viewers, who only read', () => {
    const guard = new RolesGuard(new Reflector());
    const can = (role: UserRole) =>
      guard.canActivate({
        getHandler: () => AnalyticsController.prototype.refresh,
        getClass: () => AnalyticsController,
        switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
      } as unknown as ExecutionContext);

    expect(can(UserRole.VIEWER)).toBe(false);
    for (const role of [UserRole.OWNER, UserRole.ADMIN, UserRole.MANAGER, UserRole.AGENT]) expect(can(role)).toBe(true);
  });
});
