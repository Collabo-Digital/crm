import { BadRequestException } from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import { ROLES_KEY } from '../../auth/decorators/roles.decorator';
import { REQUIRE_SECTION_KEY } from '../../auth/decorators/require-section.decorator';
import { ALLOW_VENDOR_KEY } from '../../auth/decorators/allow-vendor.decorator';
import { zonedDateString } from '../../common/utils/zoned-date.util';
import { PosReportsController } from './pos-reports.controller';
import { PosReportsService } from './pos-reports.service';
import type { PosOrderRow } from './pos-sales-summary.util';

/**
 * `$queryRaw` is a tagged template, so a mocked call receives the static SQL
 * as its first argument and the bind values after it. The shared scope is a
 * nested fragment, so each call is composed back into one statement before
 * asserting on it — enough to check the scoping without a database. The
 * arithmetic is covered against plain rows in pos-sales-summary.util.spec.ts.
 */

const ORG = 'org_1';

const composed = (call: any[]) => Prisma.sql(call[0], ...call.slice(1));
const sqlOf = (call: any[]) => composed(call).sql;
const bindsOf = (call: any[]) => composed(call).values;
const datesOf = (call: any[]) => bindsOf(call).filter((v): v is Date => v instanceof Date);

function orderRow(over: Partial<PosOrderRow> & { id: string }): PosOrderRow {
  return {
    day: '2026-10-25',
    store_id: 'wh_1',
    staff_id: 'st_1',
    financial_status: 'PAID',
    fx: 1,
    total: 1000,
    discounts: 0,
    tax: 0,
    round_off: 0,
    items: 2,
    ...over,
  };
}

/** `getSummary` issues three raw queries in a fixed order: bills, payments, top products. */
function build(opts: {
  orders?: PosOrderRow[];
  payments?: unknown[];
  products?: unknown[];
  timezone?: string;
  currency?: string;
} = {}) {
  const $queryRaw = jest
    .fn()
    .mockResolvedValueOnce(opts.orders ?? [])
    .mockResolvedValueOnce(opts.payments ?? [])
    .mockResolvedValueOnce(opts.products ?? []);
  const prisma = {
    $queryRaw,
    organization: {
      findUnique: jest.fn().mockResolvedValue({
        timezone: opts.timezone ?? 'UTC',
        currency: opts.currency ?? 'INR',
      }),
    },
    warehouse: { findMany: jest.fn().mockResolvedValue([{ id: 'wh_1', name: 'MG Road' }]) },
    posStaff: { findMany: jest.fn().mockResolvedValue([{ id: 'st_1', name: 'Asha' }]) },
    posActivity: { findMany: jest.fn().mockResolvedValue([]) },
    organizationMember: { findMany: jest.fn().mockResolvedValue([]) },
  };
  return { prisma, $queryRaw, service: new PosReportsService(prisma as any) };
}

describe('PosReportsService.getSummary', () => {
  describe('scoping', () => {
    it('reads only POS bills of the organization, never cancelled or deleted ones', async () => {
      const { service, $queryRaw } = build();
      await service.getSummary(ORG, { from: '2026-10-01', to: '2026-10-07' });

      expect($queryRaw).toHaveBeenCalledTimes(3);
      for (const call of $queryRaw.mock.calls) {
        const sql = sqlOf(call);
        expect(sql).toContain('o."pos_sale" = true');
        expect(sql).toContain('o."cancelled_at" IS NULL');
        expect(sql).toContain('o."deleted_at"   IS NULL');
        expect(bindsOf(call)).toContain(ORG);
      }
    });

    it('windows on when the bill was placed, the dashboard\'s own clock', async () => {
      const { service, $queryRaw } = build();
      await service.getSummary(ORG, { from: '2026-10-01', to: '2026-10-07' });

      expect(sqlOf($queryRaw.mock.calls[0])).toContain('COALESCE(o."external_created_at", o."created_at")');
    });

    it('cuts the days in the org timezone, reading the untouched UTC default as IST', async () => {
      const { service, $queryRaw } = build({ timezone: 'UTC' });
      const { period } = await service.getSummary(ORG, { from: '2026-10-01', to: '2026-10-03' });

      // 00:00 IST on 1 Oct to 00:00 IST on 4 Oct (the last day is included).
      expect(datesOf($queryRaw.mock.calls[0]).map((d) => d.toISOString())).toEqual([
        '2026-09-30T18:30:00.000Z',
        '2026-10-03T18:30:00.000Z',
      ]);
      // The bills are put on days in the same zone.
      expect(bindsOf($queryRaw.mock.calls[0])).toContain('Asia/Kolkata');
      expect(period).toEqual({ from: '2026-10-01', to: '2026-10-03', timezone: 'Asia/Kolkata' });
    });

    it('keeps an explicitly set timezone', async () => {
      const { service, $queryRaw } = build({ timezone: 'America/New_York' });
      await service.getSummary(ORG, { from: '2026-10-01', to: '2026-10-01' });

      expect(datesOf($queryRaw.mock.calls[0]).map((d) => d.toISOString())).toEqual([
        '2026-10-01T04:00:00.000Z',
        '2026-10-02T04:00:00.000Z',
      ]);
    });

    it('defaults to today in the org timezone', async () => {
      const { service } = build({ timezone: 'UTC' });
      const today = zonedDateString(new Date(), 'Asia/Kolkata');
      const { period, byDay } = await service.getSummary(ORG, {});

      expect(period.from).toBe(today);
      expect(period.to).toBe(today);
      expect(byDay).toEqual([{ date: today, sales: 0, orders: 0 }]);
    });

    it('narrows to one store only when asked', async () => {
      const all = build();
      await all.service.getSummary(ORG, { from: '2026-10-01', to: '2026-10-01' });
      expect(sqlOf(all.$queryRaw.mock.calls[0])).not.toContain('dispatch_warehouse_id" =');

      const one = build();
      await one.service.getSummary(ORG, { from: '2026-10-01', to: '2026-10-01', storeId: 'wh_1' });
      for (const call of one.$queryRaw.mock.calls) {
        expect(sqlOf(call)).toContain('o."dispatch_warehouse_id" =');
        expect(bindsOf(call)).toContain('wh_1');
      }
    });

    it('converts into the org currency under the dashboard\'s rules', async () => {
      const { service, $queryRaw } = build({ currency: 'inr' });
      const { currency } = await service.getSummary(ORG, { from: '2026-10-01', to: '2026-10-01' });

      expect(currency).toBe('INR');
      expect(sqlOf($queryRaw.mock.calls[0])).toContain('UPPER(o."base_currency") =');
      expect(bindsOf($queryRaw.mock.calls[0])).toContain('INR');
      expect(sqlOf($queryRaw.mock.calls[2])).toContain('o."exchange_rate" IS NOT NULL');
    });

    it('refuses a period that ends before it starts, or runs past a year', async () => {
      const { service } = build();
      await expect(service.getSummary(ORG, { from: '2026-10-05', to: '2026-10-01' })).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.getSummary(ORG, { from: '2025-01-01', to: '2026-10-01' })).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('the report', () => {
    it('names stores and staff from the organization\'s own records', async () => {
      const { service, prisma } = build({
        orders: [orderRow({ id: 'o1' }), orderRow({ id: 'o2', staff_id: null, total: 400 })],
      });
      const report = await service.getSummary(ORG, { from: '2026-10-25', to: '2026-10-25' });

      expect(prisma.warehouse.findMany.mock.calls[0][0].where).toEqual({
        organizationId: ORG,
        id: { in: ['wh_1'] },
      });
      expect(prisma.posStaff.findMany.mock.calls[0][0].where).toEqual({
        organizationId: ORG,
        id: { in: ['st_1'] },
      });
      expect(report.byStore).toEqual([{ storeId: 'wh_1', storeName: 'MG Road', sales: 1400, orders: 2 }]);
      expect(report.byStaff.map((s) => s.name)).toEqual(['Asha', 'No staff PIN']);
    });

    it('returns a zeroed report for an empty period without looking anything else up', async () => {
      const { service, prisma } = build();
      const report = await service.getSummary(ORG, { from: '2026-10-24', to: '2026-10-25' });

      expect(report.totals.sales).toBe(0);
      expect(report.totals.orders).toBe(0);
      expect(report.byDay).toHaveLength(2);
      expect(report.topProducts).toEqual([]);
      expect(prisma.warehouse.findMany).not.toHaveBeenCalled();
      expect(prisma.posStaff.findMany).not.toHaveBeenCalled();
    });

    it('maps the top products the database ranked', async () => {
      const { service, $queryRaw } = build({
        products: [{ variant_id: 'v1', title: 'Kurta', variant_title: 'M', quantity: 3, sales: 2997 }],
      });
      const { topProducts } = await service.getSummary(ORG, { from: '2026-10-25', to: '2026-10-25' });

      expect(sqlOf($queryRaw.mock.calls[2])).toMatch(/ORDER BY quantity DESC, sales DESC\s+LIMIT 10/);
      expect(topProducts).toEqual([{ variantId: 'v1', title: 'Kurta — M', quantity: 3, sales: 2997 }]);
    });
  });
});

describe('PosReportsService.getActivity', () => {
  const activity = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    type: 'approval',
    details: { reason: 'Discount over 10%' },
    createdAt: new Date('2026-10-25T10:00:00Z'),
    deviceUserId: 'u_1',
    posStaff: { id: 'st_1', name: 'Asha' },
    approvedBy: { id: 'st_2', name: 'Meera' },
    order: { id: 'o1', name: '#M1001' },
    ...over,
  });

  it('lists the newest entries of one type, with the staff, approver, order and device names', async () => {
    const { service, prisma } = build();
    prisma.posActivity.findMany.mockResolvedValue([activity('a1'), activity('a2', { deviceUserId: null })]);
    prisma.organizationMember.findMany.mockResolvedValue([
      { userId: 'u_1', user: { firstName: 'Test', lastName: 'Owner' } },
    ]);

    const { items, hasMore } = await service.getActivity(ORG, { type: 'approval', limit: 50 });

    const args = prisma.posActivity.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ organizationId: ORG, type: 'approval' });
    expect(args.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    expect(prisma.organizationMember.findMany.mock.calls[0][0].where).toEqual({
      organizationId: ORG,
      userId: { in: ['u_1'] },
    });
    expect(items[0]).toEqual({
      id: 'a1',
      type: 'approval',
      details: { reason: 'Discount over 10%' },
      createdAt: new Date('2026-10-25T10:00:00Z'),
      staff: { id: 'st_1', name: 'Asha' },
      approvedBy: { id: 'st_2', name: 'Meera' },
      order: { id: 'o1', name: '#M1001' },
      deviceUser: { id: 'u_1', name: 'Test Owner' },
    });
    expect(items[1].deviceUser).toBeNull();
    expect(hasMore).toBe(false);
  });

  it('says when there is more than the page holds', async () => {
    const { service, prisma } = build();
    prisma.posActivity.findMany.mockResolvedValue([activity('a1'), activity('a2'), activity('a3')]);

    const { items, hasMore } = await service.getActivity(ORG, { limit: 2 });

    expect(prisma.posActivity.findMany.mock.calls[0][0].take).toBe(3);
    expect(items.map((a) => a.id)).toEqual(['a1', 'a2']);
    expect(hasMore).toBe(true);
  });

  it('windows on calendar days in the org timezone when dates are given', async () => {
    const { service, prisma } = build({ timezone: 'Asia/Kolkata' });
    await service.getActivity(ORG, { from: '2026-10-25', to: '2026-10-25' });

    expect(prisma.posActivity.findMany.mock.calls[0][0].where.createdAt).toEqual({
      gte: new Date('2026-10-24T18:30:00.000Z'),
      lt: new Date('2026-10-25T18:30:00.000Z'),
    });
  });
});

describe('PosReportsController access', () => {
  it('is for owners, admins and managers in the Orders section, and never vendors', () => {
    const roles: UserRole[] = Reflect.getMetadata(ROLES_KEY, PosReportsController);
    expect(roles).toEqual([UserRole.OWNER, UserRole.ADMIN, UserRole.MANAGER]);
    expect(Reflect.getMetadata(REQUIRE_SECTION_KEY, PosReportsController)).toEqual(['section.orders']);

    for (const handler of ['getSummary', 'getActivity'] as const) {
      const fn = PosReportsController.prototype[handler];
      expect(Reflect.getMetadata(ROLES_KEY, fn)).toBeUndefined();
      expect(Reflect.getMetadata(ALLOW_VENDOR_KEY, fn)).toBeUndefined();
    }
    expect(Reflect.getMetadata(ALLOW_VENDOR_KEY, PosReportsController)).toBeUndefined();
  });
});
