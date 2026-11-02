import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PLACED_AT } from '../../common/utils/order-window.util';
import {
  resolveReportingTimeZone,
  zonedDateString,
  zonedDayEndExclusive,
  zonedDayStart,
} from '../../common/utils/zoned-date.util';
import { QueryPosActivityDto, QueryPosSummaryDto } from './dto/query-pos-reports.dto';
import {
  calendarDays,
  summarizePosSales,
  toTopProducts,
  type PosOrderRow,
  type PosPaymentRow,
  type PosProductRow,
} from './pos-sales-summary.util';

/** Longest period one report covers; the daily chart has a bar per day. */
export const MAX_REPORT_DAYS = 366;

interface PosWindow {
  /** `YYYY-MM-DD`, both included. */
  fromDay: string;
  toDay: string;
  from: Date;
  /** Exclusive: 00:00 on the day after `toDay`. */
  to: Date;
  timezone: string;
  /** The org's reporting currency, which every money figure is converted into. */
  currency: string;
}

/**
 * Store reports over POS sales: orders with `posSale` set, which stays true
 * through a Shopify push and rebadge, so the channel is never consulted.
 *
 * "Sales" are the totals of the period's POS bills — paid, part-paid or not yet
 * paid — less cancelled and deleted ones. Money is converted into the org's
 * currency at each order's stored rate under the same rules as the dashboard.
 */
@Injectable()
export class PosReportsService {
  constructor(private readonly prisma: PrismaService) { }

  async getSummary(orgId: string, query: QueryPosSummaryDto) {
    const window = await this.resolveWindow(orgId, query.from, query.to);
    const scope = this.scope(orgId, window, query.storeId);
    const fx = Prisma.sql`CASE
      WHEN o."exchange_rate" IS NOT NULL AND UPPER(o."base_currency") = ${window.currency}
      THEN o."exchange_rate"
    END`;

    const [orders, payments, products] = await Promise.all([
      this.prisma.$queryRaw<PosOrderRow[]>`
        SELECT
          o."id",
          to_char(${PLACED_AT} AT TIME ZONE 'UTC' AT TIME ZONE ${window.timezone}, 'YYYY-MM-DD') AS day,
          o."dispatch_warehouse_id" AS store_id,
          o."pos_staff_id"          AS staff_id,
          o."financial_status"::text AS financial_status,
          (${fx})::float8              AS fx,
          o."total_price"::float8      AS total,
          o."total_discounts"::float8  AS discounts,
          o."total_tax"::float8        AS tax,
          CASE WHEN jsonb_typeof(o."metadata"->'pos'->'roundOff') = 'number'
               THEN (o."metadata"->'pos'->>'roundOff')::float8
               ELSE 0 END AS round_off,
          COALESCE(
            (SELECT SUM(li."quantity") FROM "order_line_items" li WHERE li."order_id" = o."id"),
            0
          )::int AS items
        FROM "orders" o
        WHERE ${scope}`,
      this.prisma.$queryRaw<PosPaymentRow[]>`
        SELECT p."order_id", p."method"::text AS method, p."amount"::float8 AS amount
        FROM "order_payments" p
        JOIN "orders" o ON o."id" = p."order_id"
        WHERE ${scope}`,
      // Grouped here rather than in Node: a month of bills is tens of
      // thousands of lines, and the answer is ten rows.
      this.prisma.$queryRaw<PosProductRow[]>`
        SELECT
          li."variant_id",
          -- The name it was last sold under.
          (ARRAY_AGG(li."title" ORDER BY li."created_at" DESC))[1]         AS title,
          (ARRAY_AGG(li."variant_title" ORDER BY li."created_at" DESC))[1] AS variant_title,
          SUM(li."quantity")::int AS quantity,
          SUM((li."price" * li."quantity" - li."total_discount") * o."exchange_rate")::float8 AS sales
        FROM "orders" o
        JOIN "order_line_items" li ON li."order_id" = o."id"
        WHERE ${scope}
          AND o."exchange_rate" IS NOT NULL
          AND UPPER(o."base_currency") = ${window.currency}
        -- A line typed in at the counter has no variant; it groups by its name.
        GROUP BY li."variant_id", CASE WHEN li."variant_id" IS NULL THEN li."title" END
        ORDER BY quantity DESC, sales DESC
        LIMIT 10`,
    ]);

    const storeIds = distinct(orders.map((o) => o.store_id));
    const staffIds = distinct(orders.map((o) => o.staff_id));
    const none: Array<{ id: string; name: string }> = [];
    const [stores, staff] = await Promise.all([
      storeIds.length
        ? this.prisma.warehouse.findMany({
          where: { organizationId: orgId, id: { in: storeIds } },
          select: { id: true, name: true },
        })
        : none,
      staffIds.length
        ? this.prisma.posStaff.findMany({
          where: { organizationId: orgId, id: { in: staffIds } },
          select: { id: true, name: true },
        })
        : none,
    ]);

    return {
      period: { from: window.fromDay, to: window.toDay, timezone: window.timezone },
      currency: window.currency,
      ...summarizePosSales({
        orders,
        payments,
        days: calendarDays(window.fromDay, window.toDay),
        storeNames: new Map(stores.map((s) => [s.id, s.name] as const)),
        staffNames: new Map(staff.map((s) => [s.id, s.name] as const)),
      }),
      topProducts: toTopProducts(products),
    };
  }

  /** The counter log, newest first: sales, approvals, wrong PINs, unlocks. */
  async getActivity(orgId: string, query: QueryPosActivityDto) {
    const limit = query.limit ?? 50;
    const window =
      query.from || query.to ? await this.resolveWindow(orgId, query.from, query.to) : null;

    // One extra row says whether there is more than the page shows.
    const rows = await this.prisma.posActivity.findMany({
      where: {
        organizationId: orgId,
        ...(query.type && { type: query.type }),
        ...(window && { createdAt: { gte: window.from, lt: window.to } }),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: {
        id: true,
        type: true,
        details: true,
        createdAt: true,
        deviceUserId: true,
        posStaff: { select: { id: true, name: true } },
        approvedBy: { select: { id: true, name: true } },
        order: { select: { id: true, name: true } },
      },
    });
    const items = rows.slice(0, limit);

    // A wrong PIN has no staff member; the device's signed-in member is the
    // only way to tell which counter it came from.
    const userIds = distinct(items.map((a) => a.deviceUserId));
    const members = userIds.length
      ? await this.prisma.organizationMember.findMany({
        where: { organizationId: orgId, userId: { in: userIds } },
        select: { userId: true, user: { select: { firstName: true, lastName: true } } },
      })
      : [];
    const memberNames = new Map(
      members.map((m) => [m.userId, `${m.user.firstName} ${m.user.lastName}`.trim()]),
    );

    return {
      items: items.map(({ posStaff, deviceUserId, ...activity }) => ({
        ...activity,
        staff: posStaff,
        deviceUser:
          deviceUserId && memberNames.has(deviceUserId)
            ? { id: deviceUserId, name: memberNames.get(deviceUserId)! }
            : null,
      })),
      hasMore: rows.length > limit,
    };
  }

  /** POS bills in the window, less cancelled and deleted ones. Shared by every query. */
  private scope(orgId: string, window: PosWindow, storeId?: string): Prisma.Sql {
    const storeFilter = storeId
      ? Prisma.sql`AND o."dispatch_warehouse_id" = ${storeId}`
      : Prisma.empty;
    return Prisma.sql`o."organization_id" = ${orgId}
      AND o."pos_sale" = true
      AND o."deleted_at"   IS NULL
      AND o."cancelled_at" IS NULL
      AND ${PLACED_AT} >= ${window.from}::timestamptz AT TIME ZONE 'UTC'
      AND ${PLACED_AT} <  ${window.to}::timestamptz AT TIME ZONE 'UTC'
      ${storeFilter}`;
  }

  /**
   * Calendar days in the org's reporting timezone — the same zone, and the
   * same reading of an untouched "UTC", as the dashboard. No dates is today.
   */
  private async resolveWindow(orgId: string, fromDay?: string, toDay?: string): Promise<PosWindow> {
    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
      select: { timezone: true, currency: true },
    });
    const timezone = resolveReportingTimeZone(org ?? {});
    const last = toDay ?? zonedDateString(new Date(), timezone);
    const first = fromDay ?? last;

    if (first > last) {
      throw new BadRequestException('The start date must be on or before the end date.');
    }
    if ((Date.parse(last) - Date.parse(first)) / 86_400_000 + 1 > MAX_REPORT_DAYS) {
      throw new BadRequestException(`Pick a period of ${MAX_REPORT_DAYS} days or fewer.`);
    }

    return {
      fromDay: first,
      toDay: last,
      from: zonedDayStart(first, timezone),
      to: zonedDayEndExclusive(last, timezone),
      timezone,
      currency: (org?.currency || 'USD').toUpperCase(),
    };
  }
}

function distinct(ids: Array<string | null>): string[] {
  return [...new Set(ids.filter((id): id is string => !!id))];
}
