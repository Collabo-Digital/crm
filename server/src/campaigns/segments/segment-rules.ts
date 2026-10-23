import { BadRequestException } from '@nestjs/common';
import { Prisma, VipLevel } from '@prisma/client';
import { z } from 'zod';

export const RFM_GROUPS = ['champions', 'loyal', 'new', 'needs_attention', 'at_risk', 'hibernating', 'lost'] as const;
export type RfmGroup = (typeof RFM_GROUPS)[number];

const days = z.number().int().min(1).max(3650);

/**
 * One condition on a contact. Contact fields, its linked store customer
 * (orders, spend, VIP level, RFM group) and its broadcast history.
 */
export const SegmentRuleSchema = z.discriminatedUnion('field', [
    z.object({ field: z.literal('tag'), op: z.enum(['has', 'not_has']), value: z.string().min(1).max(60) }),
    z.object({ field: z.literal('channel'), op: z.enum(['is', 'is_not']), value: z.string().min(1).max(40) }),
    z.object({
        field: z.literal('attribute'),
        key: z.string().min(1).max(60),
        op: z.enum(['equals', 'not_equals', 'contains', 'exists', 'not_exists']),
        value: z.string().max(200).optional(),
    }),
    z.object({ field: z.literal('consent'), op: z.literal('is'), value: z.enum(['opted_in', 'not_opted_out', 'opted_out']) }),
    z.object({ field: z.literal('last_message'), op: z.enum(['within_days', 'before_days', 'never']), value: days.optional() }),
    z.object({ field: z.literal('first_seen'), op: z.enum(['within_days', 'before_days']), value: days }),
    z.object({ field: z.literal('customer'), op: z.enum(['linked', 'not_linked']) }),
    z.object({ field: z.literal('orders_count'), op: z.enum(['gte', 'lte', 'eq']), value: z.number().int().min(0).max(100000) }),
    z.object({ field: z.literal('total_spent'), op: z.enum(['gte', 'lte']), value: z.number().min(0) }),
    z.object({ field: z.literal('last_order'), op: z.enum(['within_days', 'before_days']), value: days }),
    z.object({ field: z.literal('vip'), op: z.literal('in'), value: z.array(z.enum(VipLevel)).min(1) }),
    z.object({ field: z.literal('rfm'), op: z.literal('in'), value: z.array(z.enum(RFM_GROUPS)).min(1) }),
    /** A customer segment from the Shopify admin, linked under Segments → Shopify segments. */
    z.object({ field: z.literal('shopify_segment'), op: z.enum(['in', 'not_in']), value: z.string().min(1).max(40) }),
    z.object({
        field: z.literal('broadcast'),
        op: z.enum(['received', 'read', 'replied', 'clicked', 'not_read', 'failed']),
        value: z.string().min(1).max(40),
    }),
]);

export const SegmentDefinitionSchema = z.object({
    match: z.enum(['all', 'any']),
    rules: z.array(SegmentRuleSchema).min(1).max(30),
});

export type SegmentRule = z.infer<typeof SegmentRuleSchema>;
export type SegmentDefinition = z.infer<typeof SegmentDefinitionSchema>;

export function parseDefinition(raw: unknown): SegmentDefinition {
    const parsed = SegmentDefinitionSchema.safeParse(raw);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new BadRequestException(`Invalid segment: ${issue.path.join('.') || 'rules'} — ${issue.message}`);
    }
    return parsed.data;
}

const ago = (n: number, now: Date) => new Date(now.getTime() - n * 24 * 3600_000);

/** The contacts one rule selects. */
export function ruleWhere(rule: SegmentRule, now: Date): Prisma.ChannelContactWhereInput {
    switch (rule.field) {
        case 'tag':
            return rule.op === 'has' ? { tags: { has: rule.value } } : { NOT: { tags: { has: rule.value } } };
        case 'channel':
            return rule.op === 'is' ? { channelId: rule.value } : { channelId: { not: rule.value } };
        case 'attribute': {
            const path = [rule.key];
            switch (rule.op) {
                case 'equals':
                    return { attributes: { path, equals: rule.value ?? '' } };
                case 'not_equals':
                    return { NOT: { attributes: { path, equals: rule.value ?? '' } } };
                case 'contains':
                    return { attributes: { path, string_contains: rule.value ?? '' } };
                case 'exists':
                    return { NOT: [{ attributes: { path, equals: Prisma.AnyNull } }, { attributes: { equals: Prisma.AnyNull } }] };
                case 'not_exists':
                    return { OR: [{ attributes: { path, equals: Prisma.AnyNull } }, { attributes: { equals: Prisma.AnyNull } }] };
            }
            break;
        }
        case 'consent':
            return rule.value === 'opted_in'
                ? { optInAt: { not: null }, optedOutAt: null }
                : rule.value === 'opted_out'
                    ? { optedOutAt: { not: null } }
                    : { optedOutAt: null };
        case 'last_message':
            return rule.op === 'never'
                ? { lastInboundMessageAt: null }
                : rule.op === 'within_days'
                    ? { lastInboundMessageAt: { gte: ago(rule.value ?? 30, now) } }
                    : { lastInboundMessageAt: { lt: ago(rule.value ?? 30, now) } };
        case 'first_seen':
            return rule.op === 'within_days' ? { createdAt: { gte: ago(rule.value, now) } } : { createdAt: { lt: ago(rule.value, now) } };
        case 'customer':
            return rule.op === 'linked' ? { customerId: { not: null } } : { customerId: null };
        case 'orders_count': {
            const cmp = rule.op === 'gte' ? { gte: rule.value } : rule.op === 'lte' ? { lte: rule.value } : { equals: rule.value };
            return { customer: { is: { ordersCount: cmp } } };
        }
        case 'total_spent':
            return { customer: { is: { totalSpent: rule.op === 'gte' ? { gte: rule.value } : { lte: rule.value } } } };
        case 'last_order': {
            // Placed date, as the Orders list reads it: the store's own timestamp, else when we synced it.
            const since = ago(rule.value, now);
            const placedSince: Prisma.OrderWhereInput = {
                deletedAt: null,
                OR: [{ externalCreatedAt: { gte: since } }, { externalCreatedAt: null, createdAt: { gte: since } }],
            };
            return rule.op === 'within_days'
                ? { customer: { is: { orders: { some: placedSince } } } }
                : { customer: { is: { orders: { some: { deletedAt: null }, none: placedSince } } } };
        }
        case 'vip':
            return { customer: { is: { vipLevel: { in: rule.value } } } };
        case 'rfm':
            return { customer: { is: { rfm: { is: { segment: { in: rule.value } } } } } };
        case 'shopify_segment': {
            const member: Prisma.ChannelContactWhereInput = { customer: { is: { shopifySegments: { some: { segmentId: rule.value } } } } };
            return rule.op === 'in' ? member : { NOT: member };
        }
        case 'broadcast': {
            const base = { broadcastId: rule.value };
            switch (rule.op) {
                case 'received':
                    return { broadcastRecipients: { some: { ...base, status: { in: ['SENT', 'DELIVERED', 'READ'] } } } };
                case 'read':
                    return { broadcastRecipients: { some: { ...base, readAt: { not: null } } } };
                case 'replied':
                    return { broadcastRecipients: { some: { ...base, repliedAt: { not: null } } } };
                case 'clicked':
                    return { broadcastRecipients: { some: { ...base, clickedAt: { not: null } } } };
                case 'not_read':
                    return { broadcastRecipients: { some: { ...base, status: { in: ['SENT', 'DELIVERED'] }, readAt: null } } };
                case 'failed':
                    return { broadcastRecipients: { some: { ...base, status: 'FAILED' } } };
            }
        }
    }
    return {};
}

/** The contacts a whole definition selects. */
export function definitionWhere(def: SegmentDefinition, now: Date): Prisma.ChannelContactWhereInput {
    const parts = def.rules.map((r) => ruleWhere(r, now));
    return def.match === 'all' ? { AND: parts } : { OR: parts };
}
