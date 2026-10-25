import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LoyaltyService } from '../loyalty/loyalty.service';
import { QueryCustomersDto } from './dto/query-customers.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';
import { pickPrefillAddress } from './prefill-address.util';
import { contactName } from '../messaging/contact-name';
import {
  resolveReportingTimeZone,
  zonedMonthStartMonthsAgo,
} from '../common/utils/zoned-date.util';

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

    // What the order form fills in when this customer is picked: their saved
    // address, else where their last order went. CRM-made customers rarely
    // have a saved address, so without the order fallback most would never
    // fill.
    const addresses = Array.isArray(customer.addresses) ? customer.addresses : [];
    let prefillAddress = pickPrefillAddress([customer.defaultAddress, ...addresses], customer);
    if (!prefillAddress) {
      const lastOrder = await this.prisma.order.findFirst({
        where: {
          customerId: id,
          organizationId: orgId,
          deletedAt: null,
          OR: [
            { shippingAddress: { not: Prisma.AnyNull } },
            { billingAddress: { not: Prisma.AnyNull } },
          ],
        },
        orderBy: { createdAt: 'desc' },
        select: { shippingAddress: true, billingAddress: true },
      });
      if (lastOrder) {
        prefillAddress = pickPrefillAddress(
          [lastOrder.shippingAddress, lastOrder.billingAddress],
          customer,
        );
      }
    }

    return { ...customer, prefillAddress, chats: await this.chats(id, orgId) };
  }

  /**
   * Every WhatsApp number and Instagram or Messenger profile linked to this
   * customer, latest message first. Each is its own chat: the reply window
   * and opt-in belong to the number, so they are not merged.
   */
  private async chats(customerId: string, orgId: string) {
    const contacts = await this.prisma.channelContact.findMany({
      where: { customerId, organizationId: orgId },
      include: {
        channel: { select: { name: true } },
        conversations: { select: { id: true, lastMessageAt: true }, take: 1 },
      },
      take: 50,
    });
    return contacts
      .map((c) => ({
        contactId: c.id,
        platform: c.platform,
        channel: c.channel,
        name: contactName(c),
        phone: c.phone,
        username: c.username,
        conversationId: c.conversations[0]?.id ?? null,
        lastMessageAt: c.conversations[0]?.lastMessageAt ?? null,
      }))
      .sort((a, b) => (b.lastMessageAt?.getTime() ?? 0) - (a.lastMessageAt?.getTime() ?? 0));
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

    // Months in the org's reporting timezone, not the server's (UTC in
    // production), so an IST sign-up at 02:00 on the 1st counts in its own month.
    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
      select: { timezone: true },
    });
    const timeZone = resolveReportingTimeZone(org ?? {});
    const now = new Date();
    const currentMonthStart = zonedMonthStartMonthsAgo(now, 0, timeZone);
    const previousMonthStart = zonedMonthStartMonthsAgo(now, 1, timeZone);
    // A customer first seen in [from, to). `externalCreatedAt` is null for
    // customers created in the CRM (offline orders, drafts), so those count by
    // `createdAt` — the same rule as the dashboard's new-customer figure.
    const firstSeenBetween = (from: Date, to?: Date): Prisma.CustomerWhereInput => {
      const range = { gte: from, ...(to ? { lt: to } : {}) };
      return {
        OR: [
          { externalCreatedAt: range },
          { externalCreatedAt: null, createdAt: range },
        ],
      };
    };

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
        where: { ...baseWhere, ...firstSeenBetween(currentMonthStart) },
      }),

      // New customers last month
      this.prisma.customer.count({
        where: { ...baseWhere, ...firstSeenBetween(previousMonthStart, currentMonthStart) },
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