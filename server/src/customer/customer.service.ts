import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LoyaltyService } from '../loyalty/loyalty.service';
import { QueryCustomersDto } from './dto/query-customers.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';

@Injectable()
export class CustomerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly loyalty: LoyaltyService,
  ) { }

  async findAll(orgId: string, query: QueryCustomersDto) {
    const where: Prisma.CustomerWhereInput = { organizationId: orgId, deletedAt: null };
    if (query.vipLevel) where.vipLevel = query.vipLevel;
    if (query.channelId) where.channelId = query.channelId;
    if (query.tag) where.tags = { has: query.tag };
    if (query.segment) where.segments = { has: query.segment };
    if (query.search) {
      where.OR = [
        { firstName: { contains: query.search, mode: 'insensitive' } },
        { lastName: { contains: query.search, mode: 'insensitive' } },
        { email: { contains: query.search, mode: 'insensitive' } },
        { phone: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const [data, total] = await Promise.all([
      this.prisma.customer.findMany({
        where,
        include: {
          channel: { select: { id: true, name: true, platform: true } },
          _count: { select: { orders: true } },
        },
        orderBy: { [query.sortBy ?? 'createdAt']: query.sortOrder ?? 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.customer.count({ where }),
    ]);

    return {
      data: data.map((c) => ({
        id: c.id, firstName: c.firstName, lastName: c.lastName,
        email: c.email, phone: c.phone, vipLevel: c.vipLevel,
        totalSpent: c.totalSpent, ordersCount: c.ordersCount,
        tags: c.tags, segments: c.segments, state: c.state,
        channel: c.channel, orderCount: c._count.orders,
        gstin: c.gstin, billingStateCode: c.billingStateCode, billingStateName: c.billingStateName,
        createdAt: c.externalCreatedAt || c.createdAt,
      })),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async findOne(id: string, orgId: string) {
    const customer = await this.prisma.customer.findFirst({
      where: { id, organizationId: orgId, deletedAt: null },
      include: {
        channel: { select: { id: true, name: true, platform: true } },
        orders: {
          orderBy: { externalCreatedAt: 'desc' }, take: 10,
          select: {
            id: true, orderNumber: true, name: true, totalPrice: true,
            financialStatus: true, fulfillmentStatus: true, currency: true, externalCreatedAt: true
          },
        },
        activityLogs: { orderBy: { createdAt: 'desc' }, take: 20 },
      },
    });
    if (!customer) throw new NotFoundException('Customer not found');
    return customer;
  }

  async update(id: string, orgId: string, userId: string, dto: UpdateCustomerDto) {
    const customer = await this.prisma.customer.findFirst({
      where: { id, organizationId: orgId, deletedAt: null },
    });
    if (!customer) throw new NotFoundException('Customer not found');

    if (dto.vipLevel && dto.vipLevel !== customer.vipLevel) {
      await this.prisma.customerActivityLog.create({
        data: {
          customerId: id, actorId: userId, action: 'vip_changed',
          description: `VIP level changed from ${customer.vipLevel} to ${dto.vipLevel}`,
          oldValue: customer.vipLevel, newValue: dto.vipLevel,
        },
      });
    }

    const updated = await this.prisma.customer.update({ where: { id }, data: dto });

    // Defensive: if a future change to UpdateCustomerDto exposes ordersCount
    // or totalSpent, the tier needs to stay in sync. Cheap to call and a no-op
    // when the computed tier matches the current value.
    const touchedMetricField =
      (dto as any).ordersCount !== undefined || (dto as any).totalSpent !== undefined;
    if (touchedMetricField) {
      await this.loyalty.recomputeForCustomer(id, orgId).catch(() => undefined);
    }

    return updated;
  }

  async getTags(orgId: string) {
    const customers = await this.prisma.customer.findMany({
      where: { organizationId: orgId, deletedAt: null }, select: { tags: true },
    });
    const allTags = new Set<string>();
    customers.forEach((c) => c.tags.forEach((t) => allTags.add(t)));
    return [...allTags].sort();
  }

  async getSegments(orgId: string) {
    const customers = await this.prisma.customer.findMany({
      where: { organizationId: orgId, deletedAt: null }, select: { segments: true },
    });
    const allSegments = new Set<string>();
    customers.forEach((c) => c.segments.forEach((s) => allSegments.add(s)));
    return [...allSegments].sort();
  }

  async getStats(orgId: string, channelId?: string) {
    const baseWhere: Prisma.CustomerWhereInput = {
      organizationId: orgId,
      deletedAt: null,
      ...(channelId && { channelId }),
    };

    const now = new Date();
    const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const previousMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const previousMonthEnd = new Date(currentMonthStart.getTime() - 1);

    const [
      totalCustomers,
      newCustomersThisMonth,
      newCustomersLastMonth,
      activeCustomers,
      customersByVip,
      totalRevenue,
      averageOrderValue,
    ] = await Promise.all([
      // Total customers
      this.prisma.customer.count({ where: baseWhere }),

      // New customers this month
      this.prisma.customer.count({
        where: { ...baseWhere, externalCreatedAt: { gte: currentMonthStart } },
      }),

      // New customers last month
      this.prisma.customer.count({
        where: { ...baseWhere, externalCreatedAt: { gte: previousMonthStart, lte: previousMonthEnd } },
      }),

      // Active customers — have placed at least 1 order
      this.prisma.customer.count({
        where: { ...baseWhere, ordersCount: { gt: 0 } },
      }),

      // Customers by VIP level
      this.prisma.customer.groupBy({
        by: ['vipLevel'],
        where: baseWhere,
        _count: true,
      }),

      // Total customer revenue (sum of totalSpent)
      this.prisma.customer.aggregate({
        where: baseWhere,
        _sum: { totalSpent: true },
        _avg: { totalSpent: true },
      }),

      // Average order value (from orders, not customers), in the org's own
      // currency. Raw SQL because Prisma's `_avg` can only average a column,
      // never a column times a rate — averaging `total_price` alone mixed
      // dollars into rupees and produced "₹1,359.47" from a set that was
      // mostly USD. Orders with no resolved rate are excluded rather than
      // averaged in at parity.
      this.prisma.$queryRaw<{ avg: string | null }[]>`
        SELECT AVG(o."total_price" * o."exchange_rate") AS avg
        FROM "orders" o
        WHERE o."organization_id" = ${orgId}
          AND o."deleted_at" IS NULL
          AND o."exchange_rate" IS NOT NULL
          AND o."financial_status"::text IN ('PAID', 'PARTIALLY_PAID')
          ${channelId ? Prisma.sql`AND o."channel_id" = ${channelId}` : Prisma.empty}
      `,
    ]);

    // Calculate new customers change
    const newCustomersChange = this.calcChange(newCustomersThisMonth, newCustomersLastMonth);

    // Format VIP breakdown
    const vipBreakdown: Record<string, number> = {};
    for (const group of customersByVip) {
      vipBreakdown[group.vipLevel] = group._count;
    }

    return {
      totalCustomers,
      activeCustomers,
      inactiveCustomers: totalCustomers - activeCustomers,

      newCustomers: {
        current: newCustomersThisMonth,
        previous: newCustomersLastMonth,
        change: newCustomersChange,
      },

      totalRevenue: totalRevenue._sum.totalSpent ?? 0,
      averageCustomerValue: totalRevenue._avg.totalSpent ?? 0,
      averageOrderValue: Number(averageOrderValue[0]?.avg ?? 0),

      vipBreakdown: {
        none: vipBreakdown['NONE'] ?? 0,
        bronze: vipBreakdown['BRONZE'] ?? 0,
        silver: vipBreakdown['SILVER'] ?? 0,
        gold: vipBreakdown['GOLD'] ?? 0,
        platinum: vipBreakdown['PLATINUM'] ?? 0,
      },
    };
  }

  private calcChange(current: number, previous: number): { percentage: number; direction: 'up' | 'down' | 'same' } {
    if (previous === 0 && current === 0) return { percentage: 0, direction: 'same' };
    if (previous === 0) return { percentage: 100, direction: 'up' };
    const pct = Math.round(((current - previous) / previous) * 100);
    return { percentage: Math.abs(pct), direction: pct > 0 ? 'up' : pct < 0 ? 'down' : 'same' };
  }
}