import { ConflictException } from '@nestjs/common';
import { ChannelPlatform, OrderFulfillmentStatus } from '@prisma/client';
import { OrderService } from './order.service';

/**
 * Manual (non-Shopify) shipments. The CRM's own rows are the only record of
 * how many units went out, so two things must hold:
 *   - shipments on one order are recorded one at a time (two packers finishing
 *     the same order must not overwrite each other's counts), and
 *   - cancelling a shipment takes back only the units that shipment carried.
 *
 * The fake below keeps rows in memory and makes `SELECT … FOR UPDATE` a real
 * mutex held until the transaction callback ends, so concurrency is exercised
 * rather than assumed.
 */

const ORG = 'org_1';
const ORDER = 'order_1';
const LINE = 'line_1';

type Line = {
  id: string; orderId: string; title: string; vendor: string;
  quantity: number; fulfilledQuantity: number; fulfillmentStatus: string | null;
};
type Shipment = {
  id: string; orderId: string; externalId: string; status: string;
  metadata: { lineItemIds: string[]; lineItemQuantities?: Record<string, number> };
};

function build() {
  const lines = new Map<string, Line>([
    [LINE, {
      id: LINE, orderId: ORDER, title: 'Shirt', vendor: 'mine',
      quantity: 5, fulfilledQuantity: 0, fulfillmentStatus: null,
    }],
  ]);
  const shipments: Shipment[] = [];
  const order = {
    id: ORDER, externalId: 'manual_x', organizationId: ORG, cancelledAt: null as Date | null,
    fulfillmentStatus: OrderFulfillmentStatus.UNFULFILLED as OrderFulfillmentStatus,
    channel: { id: 'ch_manual', platform: ChannelPlatform.MANUAL },
  };
  const operations: string[] = [];
  const copy = <T>(row: T): T => JSON.parse(JSON.stringify(row)) as T;

  // One order-row lock, released when the holding transaction finishes.
  let tail: Promise<void> = Promise.resolve();
  const acquire = () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const previous = tail;
    tail = previous.then(() => held);
    return previous.then(() => release);
  };

  const pickLines = (where: any) => [...lines.values()].filter(
    (l) => l.orderId === where.orderId && (!where.id?.in || where.id.in.includes(l.id)),
  );

  const makeTx = (lock: () => Promise<void>) => ({
    $queryRaw: jest.fn(async () => {
      await lock();
      operations.push('lock');
      return [{ id: order.id, cancelledAt: order.cancelledAt }];
    }),
    orderLineItem: {
      findMany: jest.fn(async ({ where }: any) => {
        operations.push('read-lines');
        return pickLines(where).map(copy);
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const line = lines.get(where.id)!;
        Object.assign(line, data);
        return copy(line);
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const hit = pickLines(where);
        hit.forEach((l) => Object.assign(l, data));
        return { count: hit.length };
      }),
    },
    orderFulfillment: {
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `shipment_${shipments.length + 1}`, ...copy(data) } as Shipment;
        shipments.push(row);
        return copy(row);
      }),
      findFirst: jest.fn(async ({ where }: any) => {
        const row = shipments.find((s) => s.id === where.id && s.orderId === where.orderId);
        return row ? copy(row) : null;
      }),
      findMany: jest.fn(async ({ where }: any) => shipments
        .filter((s) => s.orderId === where.orderId && s.id !== where.id?.not && s.status !== 'cancelled')
        .map(copy)),
      update: jest.fn(async ({ where, data }: any) => {
        const row = shipments.find((s) => s.id === where.id)!;
        Object.assign(row, data);
        return copy(row);
      }),
    },
    order: {
      update: jest.fn(async ({ data }: any) => {
        Object.assign(order, data);
        return { ...order };
      }),
    },
    orderTimelineEvent: { create: jest.fn().mockResolvedValue({}) },
  });

  const txs: Array<ReturnType<typeof makeTx>> = [];
  const prisma = {
    $transaction: jest.fn(async (fn: (tx: any) => Promise<unknown>) => {
      let release: (() => void) | null = null;
      const tx = makeTx(async () => {
        release = await acquire();
      });
      txs.push(tx);
      try {
        return await fn(tx);
      } finally {
        (release as (() => void) | null)?.();
      }
    }),
    order: { findFirst: jest.fn(async () => ({ ...order })) },
    orderLineItem: {
      findFirst: jest.fn(async ({ where }: any) => {
        const line = lines.get(where.id);
        return line && line.orderId === where.orderId ? copy(line) : null;
      }),
      findMany: jest.fn(async ({ where }: any) => pickLines(where).map(copy)),
      count: jest.fn().mockResolvedValue(0),
    },
    orderFulfillment: {
      findFirst: jest.fn(async ({ where }: any) => {
        const row = shipments.find((s) => s.id === where.id && s.orderId === where.orderId);
        return row ? copy(row) : null;
      }),
      findMany: jest.fn(async ({ where }: any) => shipments
        .filter((s) => s.orderId === where.orderId && s.status !== 'cancelled')
        .map(copy)),
    },
  };
  const invoices = { autoInvoiceForShippedCodOrder: jest.fn().mockResolvedValue(undefined) };
  const service = new OrderService(
    prisma as any, {} as any, {} as any, invoices as any, {} as any, {} as any,
    {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
    {} as any, { order: jest.fn() } as any /* commerceEvents */,
  );

  const ship = async (quantity?: number) => {
    const created = await service.createFulfillment(
      ORDER, ORG, 'user_1', { lineItems: [{ lineItemId: LINE, quantity }] } as any,
    );
    return shipments.find((s) => s.id === (created as { id: string }).id)!;
  };
  const cancel = (id: string) => service.cancelFulfillment(ORDER, id, ORG, 'user_1');
  const line = () => lines.get(LINE)!;

  return { service, prisma, txs, order, shipments, operations, ship, cancel, line };
}

describe('manual shipments — concurrent creation', () => {
  it('counts both of two simultaneous one-unit shipments', async () => {
    const { ship, line, shipments } = build();

    await Promise.all([ship(1), ship(1)]);

    expect(shipments).toHaveLength(2);
    expect(line().fulfilledQuantity).toBe(2);
    expect(line().fulfillmentStatus).toBe('partial');
  });

  it('locks the organisation-scoped order row before reading shipped counts', async () => {
    const { ship, txs, operations } = build();

    await ship(2);

    expect(operations[0]).toBe('lock');
    const [strings, ...values] = txs[0].$queryRaw.mock.calls[0] as unknown as [string[], ...unknown[]];
    const sql = strings.join('?');
    expect(sql).toContain('FOR UPDATE');
    expect(sql).toContain('"organization_id"');
    expect(sql).toContain('"deleted_at" IS NULL');
    expect(values).toEqual([ORDER, ORG]);
  });

  it('refuses to ship an order that was cancelled while it waited for the lock', async () => {
    const { ship, order, txs } = build();
    order.cancelledAt = new Date();

    await expect(ship(1)).rejects.toThrow('Cannot fulfil a cancelled order.');
    expect(txs[0].orderFulfillment.create).not.toHaveBeenCalled();
    expect(txs[0].orderLineItem.update).not.toHaveBeenCalled();
  });

  it('records how many units each shipment carried', async () => {
    const { ship } = build();

    const first = await ship(2);
    const rest = await ship();

    expect(first.metadata.lineItemQuantities).toEqual({ [LINE]: 2 });
    expect(rest.metadata.lineItemQuantities).toEqual({ [LINE]: 3 });
  });
});

describe('manual shipments — cancelling one', () => {
  it('takes back only that shipment\'s units when a line shipped in two parts', async () => {
    const { ship, cancel, line, shipments, order } = build();
    const first = await ship(2);
    await ship(3);
    expect(line().fulfilledQuantity).toBe(5);

    await cancel(first.id);

    expect(line().fulfilledQuantity).toBe(3);
    expect(line().fulfillmentStatus).toBe('partial');
    expect(shipments[0].status).toBe('cancelled');
    expect(shipments[1].status).toBe('fulfilled');
    expect(order.fulfillmentStatus).toBe(OrderFulfillmentStatus.PARTIAL);
    // The freed units can ship again, and no more than that.
    await expect(ship(3)).rejects.toThrow('only 2 of 5 remain');
    await ship();
    expect(line().fulfilledQuantity).toBe(5);
  });

  it('does not take units back twice when two cancels of one shipment race', async () => {
    const { ship, cancel, line } = build();
    const first = await ship(2);
    await ship(3);

    const results = await Promise.allSettled([cancel(first.id), cancel(first.id)]);

    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const failure = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(String(failure.reason)).toContain('already cancelled');
    expect(line().fulfilledQuantity).toBe(3);
  });

  it('still reverses an older shipment without recorded quantities when nothing else shares its lines', async () => {
    const { ship, cancel, line } = build();
    const legacy = await ship();
    delete legacy.metadata.lineItemQuantities;

    await cancel(legacy.id);

    expect(line().fulfilledQuantity).toBe(0);
    expect(line().fulfillmentStatus).toBeNull();
  });

  it('refuses (409) to guess when an older shipment without quantities shares a line with another', async () => {
    const { ship, cancel, line, shipments } = build();
    const legacy = await ship(2);
    delete legacy.metadata.lineItemQuantities;
    await ship(3);

    await expect(cancel(legacy.id)).rejects.toThrow(ConflictException);

    expect(line().fulfilledQuantity).toBe(5);
    expect(shipments[0].status).toBe('fulfilled');
  });
});

describe('vendor unfulfil on a manual order', () => {
  it('goes through the same cancel, so the other shipment\'s units survive', async () => {
    const { service, ship, line, shipments } = build();
    await ship(2);
    await ship(3);

    const res = await service.unfulfillVendorItem(ORDER, ORG, 'user_1', LINE, 'mine');

    expect(shipments[0].status).toBe('cancelled');
    expect(shipments[1].status).toBe('fulfilled');
    expect(line().fulfilledQuantity).toBe(3);
    expect(res).toEqual({ id: LINE, status: 'partial' });
  });
});
