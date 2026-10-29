import { BadRequestException, ConflictException } from '@nestjs/common';
import { ChannelPlatform } from '@prisma/client';
import { OrderService } from './order.service';

/**
 * Shipment state changes that reach Shopify or flip the order header:
 *   - a vendor's unfulfil must prove the shipment is theirs alone BEFORE it
 *     cancels anything on Shopify, and must not reset local lines when
 *     Shopify refuses;
 *   - a cancelled shipment, or a line that never shipped, must not be marked
 *     delivered (a delivered line reads as fully shipped, so the order would
 *     flip to FULFILLED).
 */

const ORG = 'org_1';
const ORDER = 'order_1';
const ME = 'mine';

function build(platform: ChannelPlatform = ChannelPlatform.SHOPIFY) {
  const line = {
    id: 'line_1', externalId: '101', vendor: ME,
    fulfillmentStatus: 'fulfilled' as string | null, fulfilledQuantity: 1,
  };
  const shipment = {
    id: 'shipment_1', orderId: ORDER, externalId: '201', status: 'fulfilled',
    trackingNumber: null, metadata: { lineItemIds: ['line_1', 'line_2'] },
  };
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: ORDER, cancelledAt: null }]),
    orderLineItem: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    orderFulfillment: {
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    order: { update: jest.fn().mockResolvedValue({}) },
    orderTimelineEvent: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    order: {
      findFirst: jest.fn().mockResolvedValue({
        id: ORDER, externalId: '999', organizationId: ORG,
        channel: { id: 'ch_1', platform },
      }),
    },
    orderLineItem: {
      findFirst: jest.fn(async () => ({ ...line })),
      findMany: jest.fn().mockResolvedValue([
        { id: 'line_1', vendor: ME },
        { id: 'line_2', vendor: ME },
      ]),
      count: jest.fn().mockResolvedValue(0),
    },
    orderFulfillment: {
      findFirst: jest.fn(async () => ({ ...shipment })),
      // resolveFulfillmentForLine finds the live shipment locally, so it never
      // has to ask Shopify which shipment covers the line.
      findMany: jest.fn(async () => (shipment.status === 'cancelled' ? [] : [{ ...shipment }])),
    },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  };
  const graphql = {
    request: jest.fn().mockResolvedValue({ fulfillmentCancel: { fulfillment: null, userErrors: [] } }),
  };
  const oauth = {
    getAccessToken: jest.fn().mockResolvedValue({ token: 'test-only', shopDomain: 'example.myshopify.com' }),
  };
  const service = new OrderService(
    prisma as any, {} as any, {} as any, {} as any, {} as any, {} as any,
    graphql as any, oauth as any, {} as any, {} as any, {} as any, {} as any,
    {} as any, { order: jest.fn() } as any /* commerceEvents */,
  );
  return { service, prisma, tx, graphql, line, shipment };
}

describe('vendor unfulfil on a Shopify shipment', () => {
  it('refuses a shipment shared with another vendor before touching Shopify', async () => {
    const { service, prisma, graphql } = build();
    prisma.orderLineItem.count.mockResolvedValue(1);

    await expect(
      service.unfulfillVendorItem(ORDER, ORG, 'u1', 'line_1', ME),
    ).rejects.toThrow('another supplier');

    expect(graphql.request).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('reports a Shopify refusal and leaves local lines as they were', async () => {
    const { service, prisma, graphql } = build();
    graphql.request.mockResolvedValue({
      fulfillmentCancel: {
        fulfillment: null,
        userErrors: [{ field: ['id'], message: 'Fulfillment cannot be cancelled.' }],
      },
    });

    const attempt = service.unfulfillVendorItem(ORDER, ORG, 'u1', 'line_1', ME);

    await expect(attempt).rejects.toThrow(BadRequestException);
    await expect(attempt).rejects.toThrow('Fulfillment cannot be cancelled.');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('does not reset local lines when the Shopify call itself fails', async () => {
    const { service, prisma, graphql } = build();
    graphql.request.mockRejectedValue(new Error('socket hang up'));

    await expect(
      service.unfulfillVendorItem(ORDER, ORG, 'u1', 'line_1', ME),
    ).rejects.toThrow('socket hang up');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('resets the lines under the order lock once Shopify has cancelled', async () => {
    const { service, tx, graphql } = build();

    await service.unfulfillVendorItem(ORDER, ORG, 'u1', 'line_1', ME);

    expect(graphql.request).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw).toHaveBeenCalled();
    expect(tx.orderLineItem.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['line_1', 'line_2'] }, orderId: ORDER },
      data: { fulfillmentStatus: null, fulfilledQuantity: 0 },
    });
  });
});

describe('marking a shipment delivered', () => {
  it('refuses (409) a shipment that is already cancelled, writing nothing', async () => {
    const { service, prisma, graphql, shipment } = build();
    shipment.status = 'cancelled';

    await expect(
      service.markFulfillmentDelivered(ORDER, ORG, 'u1', shipment.id),
    ).rejects.toThrow(ConflictException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(graphql.request).not.toHaveBeenCalled();
  });

  it('refuses (409) when a cancel commits between the read and the write', async () => {
    const { service, tx, graphql, shipment } = build();
    tx.orderFulfillment.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.markFulfillmentDelivered(ORDER, ORG, 'u1', shipment.id),
    ).rejects.toThrow(ConflictException);
    expect(tx.orderFulfillment.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: shipment.id, orderId: ORDER, status: { not: 'cancelled' } },
    }));
    expect(tx.orderLineItem.updateMany).not.toHaveBeenCalled();
    expect(tx.order.update).not.toHaveBeenCalled();
    expect(graphql.request).not.toHaveBeenCalled();
  });

  it('marks only the shipment\'s lines that actually shipped', async () => {
    const { service, tx, shipment } = build();

    await service.markFulfillmentDelivered(ORDER, ORG, 'u1', shipment.id);

    // The order row is locked before any line is touched, as on every
    // shipment path, so these cannot deadlock against a concurrent cancel.
    expect(tx.$queryRaw).toHaveBeenCalled();
    expect(tx.orderLineItem.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['line_1', 'line_2'] },
        orderId: ORDER,
        OR: [
          { fulfilledQuantity: { gt: 0 } },
          { fulfillmentStatus: { in: ['fulfilled', 'partial', 'delivered'] } },
        ],
      },
      data: { fulfillmentStatus: 'delivered' },
    });
  });
});

describe('marking one item delivered', () => {
  it('refuses a line that has not shipped, before any write', async () => {
    const { service, prisma, line } = build();
    line.fulfillmentStatus = null;
    line.fulfilledQuantity = 0;

    await expect(
      service.markVendorItemDelivered(ORDER, ORG, 'u1', line.id, ME),
    ).rejects.toThrow('Fulfil this item before marking it delivered.');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses a line that is only in progress', async () => {
    const { service, prisma, line } = build();
    line.fulfillmentStatus = 'in_progress';
    line.fulfilledQuantity = 0;

    await expect(
      service.markVendorItemDelivered(ORDER, ORG, 'u1', line.id, ME),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('accepts a partly shipped line', async () => {
    const { service, tx, line } = build();
    line.fulfillmentStatus = 'partial';

    const res = await service.markVendorItemDelivered(ORDER, ORG, 'u1', line.id, ME);

    expect(res).toEqual({ id: line.id, status: 'delivered' });
    expect(tx.orderFulfillment.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'shipment_1', orderId: ORDER, status: { not: 'cancelled' } },
    }));
  });

  it('refuses (409) when the line was unfulfilled between the read and the write', async () => {
    const { service, tx, line } = build();
    tx.orderLineItem.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.markVendorItemDelivered(ORDER, ORG, 'u1', line.id, ME),
    ).rejects.toThrow(ConflictException);
    expect(tx.order.update).not.toHaveBeenCalled();
  });
});
