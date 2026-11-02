import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { PackingService, PACKING_OUT_OF_SCOPE } from './packing.service';

/**
 * A packer limited to some locations (auth/location-scope.util) packs orders
 * going out from those locations, and orders with no location yet: the queue
 * and lookups show those only, other tasks read as not found, and changing
 * them is refused with a 403.
 */

const ORG = 'org_1';
const SCOPE = ['wh_back', 'st_ko'];

function build(dispatchWarehouseId: string | null) {
  const order = {
    id: 'order_1', name: '#1001', cancelledAt: null, closedAt: null, financialStatus: 'PAID', fulfillmentStatus: 'UNFULFILLED',
    posSale: false, sourceName: 'web', paymentGateways: [], tags: [], shippingAddress: null, customer: null, dispatchWarehouseId,
    lineItems: [{ id: 'oli1', quantity: 1, fulfilledQuantity: 0, requiresShipping: true, externalId: '1' }],
  };
  const prisma = {
    $queryRaw: jest.fn(() => Promise.resolve([])),
    $transaction: jest.fn(),
    order: { findFirst: jest.fn(() => Promise.resolve(order)) },
    pickTask: {
      findFirst: jest.fn(() => Promise.resolve({ id: 'task_1', orderId: 'order_1', status: 'PACKING' })),
      findMany: jest.fn(() => Promise.resolve([])),
    },
    pickTaskEvent: { groupBy: jest.fn(() => Promise.resolve([])), findUnique: jest.fn(() => Promise.resolve(null)) },
    organization: { findUnique: jest.fn(() => Promise.resolve({ timezone: 'Asia/Kolkata' })) },
    user: { findMany: jest.fn(() => Promise.resolve([])) },
  };
  const service = new PackingService(prisma as never);
  jest.spyOn(service as any, 'view').mockResolvedValue({ id: 'task_1' });
  jest.spyOn(service as any, 'reconcile').mockResolvedValue(undefined);
  return { service, prisma };
}

/** The SQL text of a raw query, nested fragments spelled out, and every value bound to it. */
function sqlOf(call: unknown[]) {
  const [strings, ...values] = call as [string[], ...Array<{ sql?: string; values?: unknown[] }>];
  const text = strings.map((s, i) => s + (i < values.length ? (typeof values[i]?.sql === 'string' ? values[i].sql : '?') : '')).join('');
  const bound = values.flatMap((v) => (typeof v?.sql === 'string' ? v.values ?? [] : [v]));
  return { text, bound };
}

describe('the packing queue for a store-limited packer', () => {
  it('lists orders going out from their locations and orders with none yet', async () => {
    const { service, prisma } = build(null);
    await service.queue(ORG, { bucket: 'to_pack', page: 1, limit: 25 }, SCOPE);
    for (const call of prisma.$queryRaw.mock.calls as unknown[][]) {
      const { text, bound } = sqlOf(call);
      expect(text).toContain('(o."dispatch_warehouse_id" IS NULL OR o."dispatch_warehouse_id" = ANY(?::text[]))');
      expect(bound).toContainEqual(SCOPE);
    }
  });

  it('lists nothing at a location outside their list', async () => {
    const { service, prisma } = build(null);
    await service.queue(ORG, { bucket: 'to_pack', warehouseId: 'st_mg', page: 1, limit: 25 }, SCOPE);
    const { text, bound } = sqlOf((prisma.$queryRaw.mock.calls as unknown[][])[0]);
    // Both conditions apply, so no order can meet them.
    expect(text).toContain('o."dispatch_warehouse_id" = ? AND (o."dispatch_warehouse_id" IS NULL OR');
    expect(bound).toEqual(expect.arrayContaining(['st_mg', SCOPE]));
  });

  it('lists every order for everyone else', async () => {
    const { service, prisma } = build(null);
    await service.queue(ORG, { bucket: 'to_pack', page: 1, limit: 25 });
    expect(sqlOf((prisma.$queryRaw.mock.calls as unknown[][])[0]).text).not.toContain('ANY(');
  });

  it("does not find another location's order by its packing slip", async () => {
    const { service } = build('st_mg');
    await expect(service.lookup(ORG, 'order_1', SCOPE)).rejects.toBeInstanceOf(NotFoundException);
    expect(await build('st_ko').service.lookup(ORG, 'order_1', SCOPE)).toEqual({ orderId: 'order_1' });
    expect(await build(null).service.lookup(ORG, 'order_1', SCOPE)).toEqual({ orderId: 'order_1' });
  });

  it('keeps the accuracy report to their locations and orders with none', async () => {
    const { service, prisma } = build(null);
    await service.accuracy(ORG, {}, SCOPE);
    expect(prisma.pickTaskEvent.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ pickTask: { OR: [{ warehouseId: null }, { warehouseId: { in: SCOPE } }] } }),
      }),
    );
  });
});

describe("packing another location's order", () => {
  it('refuses to start it with a 403', async () => {
    const { service, prisma } = build('st_mg');
    await expect(service.start(ORG, 'u1', 'order_1', SCOPE)).rejects.toThrow(new ForbiddenException(PACKING_OUT_OF_SCOPE));
    expect(prisma.pickTask.findFirst).not.toHaveBeenCalled();
  });

  it('reads its task as not found', async () => {
    const { service } = build('st_mg');
    await expect(service.getTask(ORG, 'task_1', SCOPE)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses every change to its task, before any is made', async () => {
    const { service, prisma } = build('st_mg');
    const attempts = [
      service.scan(ORG, 'u1', 'task_1', { code: '890', clientScanId: 's1' }, SCOPE),
      service.confirm(ORG, 'u1', 'task_1', 'l1', { qty: 1, clientScanId: 's2' }, SCOPE),
      service.count(ORG, 'u1', 'task_1', 'l1', { packed: 5, clientScanId: 's3' }, SCOPE),
      service.undo(ORG, 'u1', 'task_1', 'l1', { clientScanId: 's4' }, SCOPE),
      service.setProblem(ORG, 'u1', 'task_1', 'l1', { reason: 'missing', qty: 1 }, SCOPE),
      service.clearProblem(ORG, 'u1', 'task_1', 'l1', SCOPE),
      service.hold(ORG, 'u1', 'task_1', { reason: 'other' }, SCOPE),
      service.resume(ORG, 'u1', 'task_1', SCOPE),
      service.finish(ORG, 'u1', 'task_1', { mode: 'all' }, SCOPE),
      service.cancel(ORG, 'u1', 'task_1', SCOPE),
    ];
    for (const attempt of attempts) await expect(attempt).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('starts an order of their own location, or one with no location yet', async () => {
    for (const at of ['st_ko', null]) {
      const { service } = build(at);
      // An open task exists, so start hands it back.
      await expect(service.start(ORG, 'u1', 'order_1', SCOPE)).resolves.toEqual({ id: 'task_1' });
    }
  });
});
