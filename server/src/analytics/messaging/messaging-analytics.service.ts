import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { resolveReportingTimeZone, zonedDayStartDaysAgo } from '../../common/utils/zoned-date.util';
import { ASSIGNABLE_ROLES } from '../../inbox/inbox-team.service';
import { attributeOrders, csvLine, estimateCost, percentile, type Touch } from './messaging-metrics';

/** Orders within this long after a broadcast or automation message are attributed to it. */
export const ATTRIBUTION_WINDOW_DAYS = 7;
const DAY_MS = 24 * 3600_000;
/** Messages that are not part of the back-and-forth: notices, reactions, public comments. */
const NOT_CHAT = Prisma.sql`('SYSTEM', 'REACTION', 'COMMENT', 'UNSUPPORTED')`;

export interface Period {
    from: Date;
    to: Date;
    timeZone: string;
    days: number;
    channelId: string | null;
}

interface Wait {
    conversation_id: string;
    asked_at: Date;
    person_at: Date | null;
    person_user: string | null;
    first_source: string | null;
}

/**
 * The messaging dashboard: how much is coming in and going out, how fast
 * people get answers, how each teammate is doing, how broadcasts and
 * automations convert, the store revenue that follows them, and what Meta
 * charges. Every figure comes from one query over stored rows.
 */
@Injectable()
export class MessagingAnalyticsService {
    constructor(private readonly prisma: PrismaService) { }

    async period(orgId: string, days: number, channelId: string | null, now = new Date()): Promise<Period> {
        const org = await this.prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { timezone: true } });
        const timeZone = resolveReportingTimeZone(org);
        return { from: zonedDayStartDaysAgo(now, days - 1, timeZone), to: now, timeZone, days, channelId };
    }

    async overview(orgId: string, p: Period) {
        const [volume, responses, resolution, agents, broadcasts, automations, revenue, cost] = await Promise.all([
            this.volume(orgId, p),
            this.waits(orgId, p),
            this.resolution(orgId, p),
            this.agents(orgId, p),
            this.broadcasts(orgId, p),
            this.automations(orgId, p),
            this.revenue(orgId, p),
            this.cost(orgId, p),
        ]);
        const asked = responses.length;
        const personDelays = responses.filter((w) => w.person_at).map((w) => (w.person_at!.getTime() - w.asked_at.getTime()) / 1000);
        return {
            period: { from: p.from, to: p.to, timeZone: p.timeZone, days: p.days, channelId: p.channelId },
            volume,
            responses: {
                asked,
                answeredByPerson: personDelays.length,
                firstAnswerByAutomation: responses.filter((w) => w.first_source === 'AUTOMATION' || w.first_source === 'SYSTEM').length,
                unanswered: responses.filter((w) => !w.first_source).length,
                medianFirstReplySec: percentile(personDelays, 50),
                p90FirstReplySec: percentile(personDelays, 90),
                within1h: personDelays.filter((s) => s <= 3600).length,
            },
            resolution,
            agents: agents.rows,
            broadcasts,
            automations,
            revenue,
            cost,
        };
    }

    // ─── Volume ───────────────────────────────────────────────────────

    private async volume(orgId: string, p: Period) {
        const ch = this.channelSql(p);
        const rows = await this.prisma.$queryRaw<Array<{ direction: string; source: string; kind: string; platform: string; n: number }>>(Prisma.sql`
            SELECT direction, source, kind, platform, count(*)::int AS n
            FROM messages
            WHERE organization_id = ${orgId} AND imported = false AND created_at >= ${p.from} AND created_at < ${p.to} ${ch}
            GROUP BY 1, 2, 3, 4`);
        const daily = await this.prisma.$queryRaw<Array<{ day: string; inbound: number; outbound: number }>>(Prisma.sql`
            SELECT to_char(date_trunc('day', (created_at AT TIME ZONE 'UTC') AT TIME ZONE ${p.timeZone}), 'YYYY-MM-DD') AS day,
                   count(*) FILTER (WHERE direction = 'INBOUND' AND kind NOT IN ('SYSTEM', 'COMMENT'))::int AS inbound,
                   count(*) FILTER (WHERE direction = 'OUTBOUND' AND kind <> 'REACTION')::int AS outbound
            FROM messages
            WHERE organization_id = ${orgId} AND imported = false AND created_at >= ${p.from} AND created_at < ${p.to} ${ch}
            GROUP BY 1 ORDER BY 1`);
        const [people] = await this.prisma.$queryRaw<Array<{ active: number; new_people: number }>>(Prisma.sql`
            SELECT
              (SELECT count(DISTINCT conversation_id)::int FROM messages
                WHERE organization_id = ${orgId} AND imported = false AND direction = 'INBOUND' AND kind NOT IN ('SYSTEM')
                  AND created_at >= ${p.from} AND created_at < ${p.to} ${ch}) AS active,
              (SELECT count(*)::int FROM (
                 SELECT contact_id, min(created_at) AS first FROM messages
                 WHERE organization_id = ${orgId} AND imported = false AND direction = 'INBOUND' AND kind NOT IN ('SYSTEM') ${ch}
                 GROUP BY contact_id) t
               WHERE t.first >= ${p.from} AND t.first < ${p.to}) AS new_people`);

        const inbound = rows.filter((r) => r.direction === 'INBOUND' && r.kind !== 'SYSTEM' && r.kind !== 'COMMENT');
        const outbound = rows.filter((r) => r.direction === 'OUTBOUND' && r.kind !== 'REACTION');
        const sum = (list: typeof rows) => list.reduce((n, r) => n + r.n, 0);
        const bySource: Record<string, number> = {};
        for (const r of outbound) bySource[r.source] = (bySource[r.source] ?? 0) + r.n;
        const platforms = [...new Set(rows.map((r) => r.platform))].sort();
        return {
            inbound: sum(inbound),
            outbound: sum(outbound),
            outboundBySource: bySource,
            comments: sum(rows.filter((r) => r.direction === 'INBOUND' && r.kind === 'COMMENT')),
            activeConversations: people.active,
            newPeople: people.new_people,
            byPlatform: platforms.map((platform) => ({
                platform,
                inbound: sum(inbound.filter((r) => r.platform === platform)),
                outbound: sum(outbound.filter((r) => r.platform === platform)),
            })),
            daily: this.fillDays(p, daily),
        };
    }

    /** Every day of the period, with zeros where nothing happened. */
    private fillDays(p: Period, rows: Array<{ day: string; inbound: number; outbound: number }>) {
        const byDay = new Map(rows.map((r) => [r.day, r]));
        const out: Array<{ day: string; inbound: number; outbound: number }> = [];
        const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: p.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
        for (let t = p.from.getTime() + 12 * 3600_000; t < p.to.getTime() + DAY_MS; t += DAY_MS) {
            const day = fmt.format(new Date(t));
            if (out.some((d) => d.day === day)) continue;
            if (new Date(t) > p.to && day > fmt.format(p.to)) break;
            out.push(byDay.get(day) ?? { day, inbound: 0, outbound: 0 });
        }
        return out;
    }

    // ─── Responses ────────────────────────────────────────────────────

    /**
     * A customer is waiting from a message that follows a business message
     * (or opens the conversation) until the next reply. A person's reply is
     * from the inbox or the WhatsApp Business app; automations and auto-replies
     * are counted apart. Waits that start in the period count, whenever they
     * were answered.
     */
    private async waits(orgId: string, p: Period): Promise<Wait[]> {
        const ch = this.channelSql(p);
        return this.prisma.$queryRaw<Wait[]>(Prisma.sql`
            WITH m AS (
                SELECT id, conversation_id, direction, created_at,
                       lag(direction) OVER (PARTITION BY conversation_id ORDER BY created_at, id) AS prev_dir
                FROM messages
                WHERE organization_id = ${orgId} AND imported = false AND kind NOT IN ${NOT_CHAT}
                  AND created_at >= ${new Date(p.from.getTime() - 30 * DAY_MS)} AND created_at < ${p.to} ${ch}
            ), starts AS (
                SELECT conversation_id, created_at AS asked_at FROM m
                WHERE direction = 'INBOUND' AND (prev_dir IS NULL OR prev_dir = 'OUTBOUND') AND created_at >= ${p.from}
            )
            SELECT s.conversation_id, s.asked_at,
                   person.created_at AS person_at, person.sent_by_user_id AS person_user,
                   first_any.source::text AS first_source
            FROM starts s
            LEFT JOIN LATERAL (
                SELECT o.created_at, o.sent_by_user_id FROM messages o
                WHERE o.conversation_id = s.conversation_id AND o.direction = 'OUTBOUND' AND o.source IN ('AGENT', 'BUSINESS_APP')
                  AND o.kind NOT IN ${NOT_CHAT} AND o.created_at > s.asked_at
                ORDER BY o.created_at LIMIT 1
            ) person ON true
            LEFT JOIN LATERAL (
                SELECT o.source FROM messages o
                WHERE o.conversation_id = s.conversation_id AND o.direction = 'OUTBOUND' AND o.source IN ('AGENT', 'BUSINESS_APP', 'AUTOMATION', 'SYSTEM')
                  AND o.kind NOT IN ${NOT_CHAT} AND o.created_at > s.asked_at
                ORDER BY o.created_at LIMIT 1
            ) first_any ON true`);
    }

    private async resolution(orgId: string, p: Period) {
        const ch = this.channelSql(p);
        const rows = await this.prisma.$queryRaw<Array<{ closed_by_id: string | null; secs: number | null }>>(Prisma.sql`
            SELECT closed_by_id, CASE WHEN opened_at IS NOT NULL AND opened_at <= closed_at THEN extract(epoch FROM closed_at - opened_at)::float END AS secs
            FROM conversations
            WHERE organization_id = ${orgId} AND status = 'CLOSED' AND closed_at >= ${p.from} AND closed_at < ${p.to} ${ch}`);
        const timed = rows.map((r) => r.secs).filter((s): s is number => s !== null);
        return { closed: rows.length, timed: timed.length, medianSec: percentile(timed, 50), p90Sec: percentile(timed, 90) };
    }

    // ─── People ───────────────────────────────────────────────────────

    async agents(orgId: string, p: Period) {
        const ch = this.channelSql(p);
        const [members, replies, waits, closed, open] = await Promise.all([
            this.prisma.organizationMember.findMany({
                where: { organizationId: orgId, isActive: true, role: { in: ASSIGNABLE_ROLES } },
                select: { userId: true, role: true, user: { select: { firstName: true, lastName: true } } },
            }),
            this.prisma.$queryRaw<Array<{ user_id: string; replies: number; conversations: number }>>(Prisma.sql`
                SELECT sent_by_user_id AS user_id, count(*)::int AS replies, count(DISTINCT conversation_id)::int AS conversations
                FROM messages
                WHERE organization_id = ${orgId} AND direction = 'OUTBOUND' AND source = 'AGENT' AND sent_by_user_id IS NOT NULL
                  AND kind <> 'REACTION' AND created_at >= ${p.from} AND created_at < ${p.to} ${ch}
                GROUP BY 1`),
            this.waits(orgId, p),
            this.prisma.$queryRaw<Array<{ user_id: string; n: number }>>(Prisma.sql`
                SELECT closed_by_id AS user_id, count(*)::int AS n FROM conversations
                WHERE organization_id = ${orgId} AND status = 'CLOSED' AND closed_by_id IS NOT NULL AND closed_at >= ${p.from} AND closed_at < ${p.to} ${ch}
                GROUP BY 1`),
            this.prisma.$queryRaw<Array<{ user_id: string; n: number }>>(Prisma.sql`
                SELECT assigned_user_id AS user_id, count(*)::int AS n FROM conversations
                WHERE organization_id = ${orgId} AND status = 'OPEN' AND assigned_user_id IS NOT NULL ${ch}
                GROUP BY 1`),
        ]);
        const delays = new Map<string, number[]>();
        for (const w of waits) {
            if (!w.person_at || !w.person_user) continue;
            const list = delays.get(w.person_user) ?? [];
            list.push((w.person_at.getTime() - w.asked_at.getTime()) / 1000);
            delays.set(w.person_user, list);
        }
        const rows = members
            .map((m) => {
                const r = replies.find((x) => x.user_id === m.userId);
                const d = delays.get(m.userId) ?? [];
                return {
                    userId: m.userId,
                    name: `${m.user.firstName} ${m.user.lastName}`.trim(),
                    role: m.role,
                    replies: r?.replies ?? 0,
                    conversations: r?.conversations ?? 0,
                    firstReplies: d.length,
                    medianFirstReplySec: percentile(d, 50),
                    closed: closed.find((x) => x.user_id === m.userId)?.n ?? 0,
                    openNow: open.find((x) => x.user_id === m.userId)?.n ?? 0,
                };
            })
            .sort((a, b) => b.replies - a.replies || a.name.localeCompare(b.name));
        return { rows };
    }

    async agentsCsv(orgId: string, p: Period): Promise<string> {
        const { rows } = await this.agents(orgId, p);
        return [
            csvLine(['Team member', 'Role', 'Replies', 'Conversations replied to', 'First replies', 'Median first reply (minutes)', 'Closed', 'Open now']),
            ...rows.map((r) =>
                csvLine([r.name, r.role, r.replies, r.conversations, r.firstReplies, r.medianFirstReplySec === null ? '' : Math.round(r.medianFirstReplySec / 6) / 10, r.closed, r.openNow]),
            ),
        ].join('\n');
    }

    async dailyCsv(orgId: string, p: Period): Promise<string> {
        const v = await this.volume(orgId, p);
        return [csvLine(['Date', 'Messages in', 'Messages out']), ...v.daily.map((d) => csvLine([d.day, d.inbound, d.outbound]))].join('\n');
    }

    // ─── Campaigns ────────────────────────────────────────────────────

    private async broadcasts(orgId: string, p: Period) {
        const rows = await this.prisma.$queryRaw<
            Array<{ id: string; name: string; recipients: number; sent: number; delivered: number; read: number; replied: number; clicked: number; failed: number; skipped: number }>
        >(Prisma.sql`
            SELECT b.id, b.name,
                   count(r.id)::int AS recipients,
                   count(r.sent_at)::int AS sent,
                   count(r.delivered_at)::int AS delivered,
                   count(r.read_at)::int AS read,
                   count(r.replied_at)::int AS replied,
                   count(r.clicked_at)::int AS clicked,
                   count(*) FILTER (WHERE r.status = 'FAILED')::int AS failed,
                   count(*) FILTER (WHERE r.status = 'SKIPPED')::int AS skipped
            FROM broadcasts b LEFT JOIN broadcast_recipients r ON r.broadcast_id = b.id
            WHERE b.organization_id = ${orgId} AND b.started_at >= ${p.from} AND b.started_at < ${p.to}
              ${p.channelId ? Prisma.sql`AND b.channel_id = ${p.channelId}` : Prisma.empty}
            GROUP BY b.id, b.name ORDER BY max(b.started_at) DESC`);
        const total = (k: keyof (typeof rows)[number]) => rows.reduce((n, r) => n + (r[k] as number), 0);
        return {
            count: rows.length,
            recipients: total('recipients'),
            sent: total('sent'),
            delivered: total('delivered'),
            read: total('read'),
            replied: total('replied'),
            clicked: total('clicked'),
            failed: total('failed'),
            skipped: total('skipped'),
            items: rows.slice(0, 20),
        };
    }

    private async automations(orgId: string, p: Period) {
        const rows = await this.prisma.$queryRaw<Array<{ id: string; name: string; started: number; completed: number; failed: number; waiting: number; skipped: number }>>(Prisma.sql`
            SELECT a.id, a.name,
                   count(r.id) FILTER (WHERE r.status <> 'SKIPPED')::int AS started,
                   count(r.id) FILTER (WHERE r.status = 'COMPLETED')::int AS completed,
                   count(r.id) FILTER (WHERE r.status = 'FAILED')::int AS failed,
                   count(r.id) FILTER (WHERE r.status IN ('WAITING', 'PENDING', 'RUNNING'))::int AS waiting,
                   count(r.id) FILTER (WHERE r.status = 'SKIPPED')::int AS skipped
            FROM automations a JOIN automation_runs r ON r.automation_id = a.id AND r.is_test = false
            WHERE a.organization_id = ${orgId} AND r.created_at >= ${p.from} AND r.created_at < ${p.to}
              ${p.channelId ? Prisma.sql`AND a.channel_id = ${p.channelId}` : Prisma.empty}
            GROUP BY a.id, a.name ORDER BY started DESC, a.name`);
        const sent = await this.prisma.$queryRaw<Array<{ automation_id: string; sent: number; read: number }>>(Prisma.sql`
            SELECT automation_id, count(*) FILTER (WHERE status <> 'FAILED')::int AS sent, count(read_at)::int AS read
            FROM messages
            WHERE organization_id = ${orgId} AND source = 'AUTOMATION' AND automation_id IS NOT NULL AND created_at >= ${p.from} AND created_at < ${p.to} ${this.channelSql(p)}
            GROUP BY 1`);
        return rows.map((r) => ({ ...r, messagesSent: sent.find((s) => s.automation_id === r.id)?.sent ?? 0, messagesRead: sent.find((s) => s.automation_id === r.id)?.read ?? 0 }));
    }

    // ─── Money ────────────────────────────────────────────────────────

    /**
     * Store orders placed in the period by customers who got a broadcast or
     * automation message in the week before, each credited to the latest one.
     * Revenue is in the organization's currency, at each order's booked rate.
     */
    private async revenue(orgId: string, p: Period) {
        const windowMs = ATTRIBUTION_WINDOW_DAYS * DAY_MS;
        const org = await this.prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { currency: true } });
        const orders = await this.prisma.$queryRaw<Array<{ id: string; customer_id: string; at: Date; revenue: number }>>(Prisma.sql`
            SELECT id, customer_id, coalesce(external_created_at, created_at) AS at, (total_price * coalesce(exchange_rate, 1))::float AS revenue
            FROM orders
            WHERE organization_id = ${orgId} AND customer_id IS NOT NULL AND cancelled_at IS NULL
              AND coalesce(external_created_at, created_at) >= ${p.from} AND coalesce(external_created_at, created_at) < ${p.to}`);
        const touches = await this.prisma.$queryRaw<Array<{ customer_id: string; at: Date; source: string; broadcast_id: string | null; automation_id: string | null }>>(Prisma.sql`
            SELECT coalesce(m.customer_id, c.customer_id) AS customer_id, coalesce(m.sent_at, m.created_at) AS at, m.source::text AS source,
                   br.broadcast_id, m.automation_id
            FROM messages m
            JOIN channel_contacts c ON c.id = m.contact_id
            LEFT JOIN broadcast_recipients br ON br.message_id = m.id
            WHERE m.organization_id = ${orgId} AND m.direction = 'OUTBOUND' AND m.source IN ('BROADCAST', 'AUTOMATION') AND m.status <> 'FAILED'
              AND coalesce(m.customer_id, c.customer_id) IS NOT NULL
              AND coalesce(m.sent_at, m.created_at) >= ${new Date(p.from.getTime() - windowMs)} AND coalesce(m.sent_at, m.created_at) < ${p.to}
              ${p.channelId ? Prisma.sql`AND m.channel_id = ${p.channelId}` : Prisma.empty}`);
        const attributed = attributeOrders(
            orders.map((o) => ({ id: o.id, customerId: o.customer_id, at: o.at, revenue: Number(o.revenue) })),
            touches.map((t): Touch => ({
                customerId: t.customer_id,
                at: t.at,
                source: t.source === 'BROADCAST' ? 'broadcast' : 'automation',
                refId: t.source === 'BROADCAST' ? t.broadcast_id : t.automation_id,
            })),
            windowMs,
        );
        const refs = new Map<string, { source: string; refId: string | null; orders: number; revenue: number }>();
        for (const a of attributed) {
            const key = `${a.touch.source}:${a.touch.refId ?? ''}`;
            const entry = refs.get(key) ?? { source: a.touch.source, refId: a.touch.refId, orders: 0, revenue: 0 };
            entry.orders++;
            entry.revenue += a.order.revenue;
            refs.set(key, entry);
        }
        const names = await this.refNames([...refs.values()]);
        const pick = (source: string) => attributed.filter((a) => a.touch.source === source);
        const money = (n: number) => Math.round(n * 100) / 100;
        return {
            windowDays: ATTRIBUTION_WINDOW_DAYS,
            currency: org.currency,
            ordersInPeriod: orders.length,
            revenueInPeriod: money(orders.reduce((n, o) => n + Number(o.revenue), 0)),
            orders: attributed.length,
            revenue: money(attributed.reduce((n, a) => n + a.order.revenue, 0)),
            bySource: {
                broadcast: { orders: pick('broadcast').length, revenue: money(pick('broadcast').reduce((n, a) => n + a.order.revenue, 0)) },
                automation: { orders: pick('automation').length, revenue: money(pick('automation').reduce((n, a) => n + a.order.revenue, 0)) },
            },
            top: [...refs.values()]
                .sort((a, b) => b.revenue - a.revenue)
                .slice(0, 10)
                .map((r) => ({ ...r, revenue: money(r.revenue), name: (r.refId && names.get(r.refId)) || (r.source === 'broadcast' ? 'Broadcast' : 'Automation') })),
        };
    }

    private async refNames(refs: Array<{ source: string; refId: string | null }>) {
        const ids = (s: string) => refs.filter((r) => r.source === s && r.refId).map((r) => r.refId!);
        const [b, a] = await Promise.all([
            this.prisma.broadcast.findMany({ where: { id: { in: ids('broadcast') } }, select: { id: true, name: true } }),
            this.prisma.automation.findMany({ where: { id: { in: ids('automation') } }, select: { id: true, name: true } }),
        ]);
        return new Map([...b, ...a].map((r) => [r.id, r.name]));
    }

    /** Meta's own pricing on each delivered WhatsApp message, priced with the business's rate table. */
    private async cost(orgId: string, p: Period) {
        const rows = await this.prisma.$queryRaw<Array<{ category: string | null; billable: boolean | null; prefix: string | null; n: number }>>(Prisma.sql`
            SELECT lower(pricing->>'category') AS category,
                   (pricing->>'billable')::boolean AS billable,
                   CASE WHEN to_address ~ '^[0-9]+$' THEN left(to_address, 4) END AS prefix,
                   count(*)::int AS n
            FROM messages
            WHERE organization_id = ${orgId} AND platform = 'WHATSAPP' AND direction = 'OUTBOUND' AND pricing IS NOT NULL
              AND created_at >= ${p.from} AND created_at < ${p.to} ${this.channelSql(p)}
            GROUP BY 1, 2, 3`);
        const rates = await this.prisma.messageRate.findMany({ where: { organizationId: orgId } });
        return estimateCost(
            rows.map((r) => ({ category: r.category, billable: r.billable, toDigits: r.prefix, count: r.n })),
            rates.map((r) => ({
                countryPrefix: r.countryPrefix,
                currency: r.currency,
                marketing: r.marketing?.toNumber() ?? null,
                utility: r.utility?.toNumber() ?? null,
                authentication: r.authentication?.toNumber() ?? null,
            })),
        );
    }

    private channelSql(p: Period) {
        return p.channelId ? Prisma.sql`AND channel_id = ${p.channelId}` : Prisma.empty;
    }
}
