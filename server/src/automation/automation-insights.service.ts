import { Injectable, NotFoundException } from '@nestjs/common';
import { AutomationRunStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { contactName } from '../messaging/contact-name';
import { replyWindow } from '../messaging/outbound';
import { collectIssues, parseDefinition } from './blocks/definition.schema';
import { RunFacts } from './engine/run-context';
import { simulate } from './engine/simulate';

/** How an automation is doing, what each run did, and dry runs from the builder. */
@Injectable()
export class AutomationInsightsService {
    constructor(private readonly prisma: PrismaService) { }

    async stats(automation: { id: string }) {
        const where = { automationId: automation.id, isTest: false };
        const [byStatus, skipped, steps, messages, daily] = await Promise.all([
            this.prisma.automationRun.groupBy({ by: ['status'], where, _count: { _all: true } }),
            this.prisma.automationRun.groupBy({ by: ['skipReason'], where: { ...where, status: AutomationRunStatus.SKIPPED }, _count: { _all: true } }),
            this.prisma.automationRunStep.groupBy({ by: ['stepKey', 'status'], where: { automationId: automation.id }, _count: { _all: true } }),
            this.prisma.message.groupBy({ by: ['status'], where: { automationId: automation.id }, _count: { _all: true } }),
            this.prisma.$queryRaw<Array<{ day: Date; runs: bigint; completed: bigint }>>(Prisma.sql`
                SELECT date_trunc('day', created_at) AS day,
                       count(*) AS runs,
                       count(*) FILTER (WHERE status = 'COMPLETED') AS completed
                FROM automation_runs
                WHERE automation_id = ${automation.id} AND is_test = false AND created_at > now() - interval '14 days'
                GROUP BY 1 ORDER BY 1`),
        ]);
        const runs = Object.fromEntries(Object.values(AutomationRunStatus).map((s) => [s, 0])) as Record<AutomationRunStatus, number>;
        for (const r of byStatus) runs[r.status] = r._count._all;
        const perStep: Record<string, Record<string, number>> = {};
        for (const s of steps) (perStep[s.stepKey] ??= {})[s.status] = s._count._all;
        const sent = Object.fromEntries(messages.map((m) => [m.status, m._count._all]));
        return {
            runs,
            total: Object.values(runs).reduce((a, b) => a + b, 0),
            skipReasons: Object.fromEntries(skipped.map((s) => [s.skipReason ?? 'other', s._count._all])),
            steps: perStep,
            messages: {
                sent: (sent.SENT ?? 0) + (sent.DELIVERED ?? 0) + (sent.READ ?? 0),
                delivered: (sent.DELIVERED ?? 0) + (sent.READ ?? 0),
                read: sent.READ ?? 0,
                failed: sent.FAILED ?? 0,
                queued: sent.QUEUED ?? 0,
            },
            daily: daily.map((d) => ({ day: d.day, runs: Number(d.runs), completed: Number(d.completed) })),
        };
    }

    async runs(automation: { id: string }, q: { page?: number; status?: AutomationRunStatus }) {
        const page = Math.max(1, q.page ?? 1);
        const limit = 25;
        const where: Prisma.AutomationRunWhereInput = { automationId: automation.id, isTest: false, ...(q.status ? { status: q.status } : {}) };
        const [rows, total] = await Promise.all([
            this.prisma.automationRun.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                skip: (page - 1) * limit,
                take: limit,
                include: {
                    contact: { select: { id: true, displayName: true, addressBookName: true, username: true, phone: true, externalId: true, platform: true } },
                    version: { select: { version: true } },
                    steps: { orderBy: { startedAt: 'asc' }, select: { stepKey: true, blockType: true, status: true, error: true, output: true, startedAt: true, finishedAt: true } },
                },
            }),
            this.prisma.automationRun.count({ where }),
        ]);
        const conversations = await this.prisma.conversation.findMany({
            where: { contactId: { in: rows.map((r) => r.contactId).filter((x): x is string => !!x) } },
            select: { id: true, contactId: true },
        });
        const conversationOf = new Map(conversations.map((c) => [c.contactId, c.id]));
        return {
            data: rows.map((r) => ({
                id: r.id,
                status: r.status,
                skipReason: r.skipReason,
                error: r.error,
                version: r.version.version,
                currentStepKey: r.currentStepKey,
                resumeAt: r.resumeAt,
                waitingForReply: r.waitingForReply,
                createdAt: r.createdAt,
                completedAt: r.completedAt,
                contact: r.contact ? { id: r.contact.id, name: contactName(r.contact), platform: r.contact.platform } : null,
                conversationId: r.contactId ? (conversationOf.get(r.contactId) ?? null) : null,
                steps: r.steps,
            })),
            meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
        };
    }

    /** Walk the draft for a contact (or a sample person) without sending anything. */
    async test(
        orgId: string,
        automation: { definition: Prisma.JsonValue; platform: string | null; channelId: string | null },
        input: { contactId?: string; text?: string; reply?: string | null },
    ) {
        const steps = parseDefinition(automation.definition);
        const issues = collectIssues(steps, { platform: automation.platform, knownMediaIds: null });
        const contact = input.contactId
            ? await this.prisma.channelContact.findFirst({
                // A contact of the automation's own account: an influencer sees no one else's.
                where: { id: input.contactId, organizationId: orgId, ...(automation.channelId ? { channelId: automation.channelId } : {}) },
                include: { customer: { select: { firstName: true, lastName: true, ordersCount: true, tags: true } } },
            })
            : null;
        if (input.contactId && !contact) throw new NotFoundException('Contact not found');
        const conversation = contact
            ? await this.prisma.conversation.findUnique({
                where: { channelId_contactId: { channelId: contact.channelId, contactId: contact.id } },
                select: { assignedUserId: true, platform: true, lastInboundAt: true },
            })
            : null;
        const facts: RunFacts = {
            contact: contact
                ? {
                    name: contactName(contact),
                    username: contact.username,
                    phone: contact.phone,
                    tags: contact.tags,
                    attributes: (contact.attributes as Record<string, unknown>) ?? {},
                    optedIn: !!contact.optInAt && !contact.optedOutAt,
                    optedOut: !!contact.optedOutAt,
                }
                : { name: 'Asha Verma', username: 'asha.verma', phone: '+919800000000', tags: [], attributes: {}, optedIn: true, optedOut: false },
            customer: contact?.customer ?? null,
            conversation: conversation
                ? { assignedUserId: conversation.assignedUserId, windowOpen: replyWindow(conversation.platform, conversation.lastInboundAt).open }
                : { assignedUserId: null, windowOpen: true },
            context: { vars: { trigger_text: input.text ?? '' }, trigger: { eventType: 'test', commentId: 'test', postId: null }, depth: 0 },
        };
        const templateIds = steps.flatMap((s) => collectTemplateIds(s));
        const templates = templateIds.length
            ? await this.prisma.messageTemplate.findMany({ where: { id: { in: templateIds }, organizationId: orgId }, select: { id: true, name: true } })
            : [];
        return {
            contact: { id: contact?.id ?? null, name: facts.contact.name },
            issues,
            steps: simulate(steps, facts, { reply: input.reply ?? null, templateNames: Object.fromEntries(templates.map((t) => [t.id, t.name])) }),
        };
    }
}

function collectTemplateIds(step: { config: Record<string, unknown>; branches?: Record<string, Array<{ config: Record<string, unknown> }>> }): string[] {
    const own = typeof step.config.templateId === 'string' && step.config.templateId ? [step.config.templateId] : [];
    return [...own, ...Object.values(step.branches ?? {}).flatMap((list) => list.flatMap((s) => collectTemplateIds(s)))];
}
