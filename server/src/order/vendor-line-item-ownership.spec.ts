import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ChannelPlatform, UserRole } from '@prisma/client';
import { OrderService } from './order.service';
import { OrderController } from './order.controller';
import { VendorAccessGuard } from '../auth/guards/vendor-access.guard';

/**
 * A vendor may act on their OWN line items and nobody else's. Orders are
 * routinely mixed — 5 of the 9 orders in the dev org carry two vendors — and
 * every vendor write path takes a caller-supplied line-item id, so that id is
 * attacker-controlled. These tests pin that each path refuses a foreign line,
 * and that it refuses BEFORE writing anything.
 */

const ORG = 'org_1';
const ORDER = 'order_1';
const ME = 'collabo-test';
const THEM = 'Hydrogen Vendor';

const MY_LINE = { id: 'li_mine', vendor: ME, externalId: 'e1', fulfillmentStatus: null };
const THEIR_LINE = { id: 'li_theirs', vendor: THEM, externalId: 'e2', fulfillmentStatus: null };
const ORPHAN_LINE = { id: 'li_orphan', vendor: null, externalId: 'e3', fulfillmentStatus: null };

const LINES = [MY_LINE, THEIR_LINE, ORPHAN_LINE];

function build() {
  const tx = {
    orderLineItem: {
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    orderFulfillment: { update: jest.fn().mockResolvedValue({}) },
    orderTimelineEvent: { create: jest.fn().mockResolvedValue({}) },
    order: { update: jest.fn().mockResolvedValue({}) },
    $executeRaw: jest.fn().mockResolvedValue(1),
  };
  const prisma = {
    order: {
      findFirst: jest.fn().mockResolvedValue({
        id: ORDER,
        externalId: '999',
        organizationId: ORG,
        // MANUAL, so no unit test can ever reach out to Shopify.
        channel: { id: 'ch_1', platform: ChannelPlatform.MANUAL },
      }),
    },
    orderLineItem: {
      // Mirrors Prisma: returns only rows whose id was actually asked for.
      findMany: jest.fn((args: any) => {
        const ids: string[] = args?.where?.id?.in ?? LINES.map((l) => l.id);
        return Promise.resolve(LINES.filter((l) => ids.includes(l.id)));
      }),
      findFirst: jest.fn((args: any) =>
        Promise.resolve(LINES.find((l) => l.id === args.where.id) ?? null),
      ),
    },
    orderFulfillment: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    $transaction: jest.fn(async (cb: any) => (typeof cb === 'function' ? cb(tx) : undefined)),
  };
  const service = new OrderService(
    prisma as any, {} as any, {} as any, {} as any, {} as any, {} as any,
    {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
    {} as any,
  );
  return { service, prisma, tx };
}

/** Authorisation failures must leave the database untouched. */
function expectNoWrite(prisma: any, tx: any) {
  expect(prisma.$transaction).not.toHaveBeenCalled();
  expect(tx.orderLineItem.update).not.toHaveBeenCalled();
  expect(tx.orderLineItem.updateMany).not.toHaveBeenCalled();
  expect(tx.orderTimelineEvent.create).not.toHaveBeenCalled();
}

describe('setVendorItemsStatus — bulk status change', () => {
  it('lets a vendor change their own line', async () => {
    const { service, tx } = build();

    await service.setVendorItemsStatus(ORDER, ORG, 'u1', 'in_progress', [MY_LINE.id], ME);

    expect(tx.orderLineItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: [MY_LINE.id] }, orderId: ORDER },
        data: { fulfillmentStatus: 'in_progress' },
      }),
    );
  });

  it('refuses a line belonging to another vendor, and writes nothing', async () => {
    const { service, prisma, tx } = build();

    await expect(
      service.setVendorItemsStatus(ORDER, ORG, 'u1', 'on_hold', [THEIR_LINE.id], ME),
    ).rejects.toThrow(ForbiddenException);

    expectNoWrite(prisma, tx);
  });

  it('refuses a batch that smuggles a foreign line in beside their own', async () => {
    const { service, prisma, tx } = build();

    // The realistic attack: ids come from the fulfillable-line-items endpoint,
    // which hands a vendor every vendor's lines on the order.
    await expect(
      service.setVendorItemsStatus(
        ORDER,
        ORG,
        'u1',
        'in_progress',
        [MY_LINE.id, THEIR_LINE.id],
        ME,
      ),
    ).rejects.toThrow('You can only act on your own line items.');

    expectNoWrite(prisma, tx);
  });

  it('refuses an unassigned (null-vendor) line', async () => {
    const { service, prisma, tx } = build();

    await expect(
      service.setVendorItemsStatus(ORDER, ORG, 'u1', 'in_progress', [ORPHAN_LINE.id], ME),
    ).rejects.toThrow(ForbiddenException);

    expectNoWrite(prisma, tx);
  });

  it('refuses an id that is not on this order at all', async () => {
    const { service, prisma, tx } = build();

    await expect(
      service.setVendorItemsStatus(ORDER, ORG, 'u1', 'in_progress', ['li_nonexistent'], ME),
    ).rejects.toThrow(ForbiddenException);

    expectNoWrite(prisma, tx);
  });

  it('leaves a non-vendor role unrestricted', async () => {
    const { service, tx } = build();

    // vendorScope undefined = OWNER/ADMIN, so the assert is skipped entirely.
    await service.setVendorItemsStatus(
      ORDER,
      ORG,
      'u1',
      'in_progress',
      [THEIR_LINE.id],
      undefined,
    );

    expect(tx.orderLineItem.updateMany).toHaveBeenCalled();
  });
});

describe('markVendorItemDelivered — single line', () => {
  it('lets a vendor mark their own line delivered', async () => {
    const { service, tx } = build();

    const res = await service.markVendorItemDelivered(ORDER, ORG, 'u1', MY_LINE.id, ME);

    expect(res).toEqual({ id: MY_LINE.id, status: 'delivered' });
    expect(tx.orderLineItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: MY_LINE.id },
        data: { fulfillmentStatus: 'delivered' },
      }),
    );
  });

  it('refuses a line belonging to another vendor, and writes nothing', async () => {
    const { service, prisma, tx } = build();

    await expect(
      service.markVendorItemDelivered(ORDER, ORG, 'u1', THEIR_LINE.id, ME),
    ).rejects.toThrow('You can only update your own items.');

    expectNoWrite(prisma, tx);
  });

  it('404s on a line that does not exist', async () => {
    const { service } = build();

    await expect(
      service.markVendorItemDelivered(ORDER, ORG, 'u1', 'nope', ME),
    ).rejects.toThrow(NotFoundException);
  });
});

describe('unfulfillVendorItem — single line', () => {
  it('refuses a line belonging to another vendor, and writes nothing', async () => {
    const { service, prisma, tx } = build();

    await expect(
      service.unfulfillVendorItem(ORDER, ORG, 'u1', THEIR_LINE.id, ME),
    ).rejects.toThrow('You can only update your own items.');

    expectNoWrite(prisma, tx);
  });
});

describe('createFulfillment — the path that actually ships goods', () => {
  it('refuses to ship a line belonging to another vendor, and writes nothing', async () => {
    const { service, prisma, tx } = build();

    await expect(
      service.createFulfillment(
        ORDER,
        ORG,
        'u1',
        { lineItems: [{ lineItemId: THEIR_LINE.id, quantity: 1 }] } as any,
        ME,
      ),
    ).rejects.toThrow('You can only act on your own line items.');

    expectNoWrite(prisma, tx);
  });

  it('refuses a mixed batch even though one line is genuinely theirs', async () => {
    const { service, prisma, tx } = build();

    await expect(
      service.createFulfillment(
        ORDER,
        ORG,
        'u1',
        {
          lineItems: [
            { lineItemId: MY_LINE.id, quantity: 1 },
            { lineItemId: THEIR_LINE.id, quantity: 1 },
          ],
        } as any,
        ME,
      ),
    ).rejects.toThrow(ForbiddenException);

    expectNoWrite(prisma, tx);
  });
});

describe('listFulfillableLineItems — the read behind the fulfil dialog', () => {
  // This route returns every line on the order, so it would hand one vendor
  // another vendor's titles, SKUs and quantities. It is kept away from vendors
  // by VendorAccessGuard (no @AllowVendor()), and the scope below is the second
  // layer in case that decorator is ever added.
  it('stays closed to vendors', () => {
    const guard = new VendorAccessGuard(new Reflector());
    const ctx = {
      switchToHttp: () => ({
        getRequest: () => ({
          user: { role: UserRole.VENDOR, vendorScope: ME, sub: 'u1', orgId: ORG },
        }),
      }),
      getHandler: () => OrderController.prototype.fulfillableLineItems,
      getClass: () => OrderController,
    } as any;

    expect(() => guard.canActivate(ctx)).toThrow(
      'Vendors cannot access this resource.',
    );
  });

  it('returns only the scoped vendor lines when a scope is supplied', async () => {
    const { service, prisma } = build();

    await service.listFulfillableLineItems(ORDER, ORG, ME);

    expect(prisma.orderLineItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { orderId: ORDER, vendor: ME } }),
    );
  });

  it('stays unfiltered for an owner', async () => {
    const { service, prisma } = build();

    await service.listFulfillableLineItems(ORDER, ORG, undefined);

    expect(prisma.orderLineItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { orderId: ORDER } }),
    );
  });
});
