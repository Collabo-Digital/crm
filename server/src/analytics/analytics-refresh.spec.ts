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

describe('Analytics › hourly roll-ups', () => {
  // 40 shoppers add to cart between 10:00 and 22:00 UTC on 20 Oct and 2 more at 23:30.
  const shoppers = [
    ...Array.from({ length: 40 }, (_, i) => ({ id: `s${i}`, occurredAt: new Date(Date.UTC(2026, 9, 20, 10, i * 18)) })),
    { id: 's40', occurredAt: new Date(Date.UTC(2026, 9, 20, 23, 30)) },
    { id: 's41', occurredAt: new Date(Date.UTC(2026, 9, 20, 23, 30)) },
  ];

  /** Raw events filtered the way the database filters them, and the day as the last run stored it. */
  function store(events: Array<{ occurredAt: Date }>, stored: Record<string, unknown>) {
    const prisma = {
      rawAnalyticsEvent: {
        findMany: jest.fn((args: { where: { occurredAt: { gte: Date } } }) =>
          Promise.resolve(events.filter((e) => e.occurredAt >= args.where.occurredAt.gte)),
        ),
      },
      analyticsSnapshot: {
        findUnique: jest.fn(() => Promise.resolve({ source: 'shopify_pixel', metrics: stored })),
        upsert: jest.fn((args: { update: { metrics: Record<string, unknown> } }) => Promise.resolve(args)),
      },
    };
    return { prisma, written: () => prisma.analyticsSnapshot.upsert.mock.calls.map(([args]) => args.update.metrics) };
  }

  beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 9, 21)));
  afterEach(() => jest.restoreAllMocks());

  it("keeps the whole day's pixel add-to-cart visitors after the midnight run", async () => {
    const { prisma, written } = store(
      shoppers.map((s) => ({
        organizationId: 'org_a',
        channelId: 'ch_1',
        occurredAt: s.occurredAt,
        eventName: 'product_added_to_cart',
        visitorId: s.id,
        payload: { productTitle: 'Tee' },
      })),
      { pixelAddToCartSessions: 40, byProduct: [{ productTitle: 'Tee', addToCarts: 40 }] },
    );

    await new PixelEventsAggregator(prisma as never).runHourly();

    expect(written()).toHaveLength(1);
    expect(written()[0]).toMatchObject({ pixelAddToCartSessions: 42, byProduct: [{ productTitle: 'Tee', addToCarts: 42 }] });
  });

  it("keeps the whole day's webhook carts after the midnight run", async () => {
    const { prisma, written } = store(
      shoppers.map((s) => ({
        organizationId: 'org_a',
        channelId: 'ch_1',
        occurredAt: s.occurredAt,
        eventName: 'carts_create',
        sessionId: s.id,
        payload: { line_items: [{ title: 'Tee', product_id: 1 }] },
      })),
      { cartsCreatedFromWebhook: 40, byProduct: [{ productTitle: 'Tee', addToCarts: 40 }] },
    );

    await new CartEventsAggregator(prisma as never).runHourly();

    expect(written()).toHaveLength(1);
    expect(written()[0]).toMatchObject({ cartsCreatedFromWebhook: 42, byProduct: [{ productTitle: 'Tee', addToCarts: 42 }] });
  });
});
