import { Injectable, Logger } from '@nestjs/common';
import { AutomationEvent, AutomationRunStatus, AutomationStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AutomationJobs } from '../../messaging/automation-jobs';
import { InboxRulesService } from '../../inbox/inbox-rules.service';
import { Flow, keywordMatches } from './flow';
import { RunContext, parseRunContext } from './run-context';
import { parseDefinition } from '../blocks/definition.schema';
import { WebhooksService } from '../../developer/webhooks.service';

/** Inbound messages: what a waiting flow takes as a reply. Comments are public and never count. */
const REPLY_EVENTS = new Set(['whatsapp.message', 'instagram.message', 'facebook.message', 'instagram.postback', 'facebook.postback']);
/** Events where only the best-matching automation starts, so one message never gets several answers. */
const ONE_WINNER = new Set(['whatsapp.message', 'whatsapp.cart', 'instagram.message', 'facebook.message', 'instagram.comment', 'facebook.comment', 'instagram.postback', 'facebook.postback', 'instagram.mention']);
const DAY = 24 * 3600_000;
/**
 * Store events, each about one order, invoice, payment, cart or checkout and
 * raised once for it. "Once" on these means once for that thing, which the
 * event's own uniqueness ensures: a returning buyer's next order still runs.
 */
const ONE_PER_SUBJECT = (eventType: string) =>
    eventType.startsWith('crm.order.') || ['crm.invoice.issued', 'crm.payment.received', 'crm.checkout.abandoned', 'whatsapp.cart'].includes(eventType);

interface EventPayload {
    mediaExternalId?: string | null;
    raw?: {
        newConversation?: boolean;
        postId?: string;
        postbackPayload?: string;
        quickReplyPayload?: string;
        tag?: string;
        depth?: number;
        automationId?: string;
        fields?: Record<string, string>;
        /** Store events: {{order.*}} / {{checkout.*}} values. */
        vars?: Record<string, string>;
        /** A WhatsApp cart message. */
        order?: { product_items?: Array<{ product_retailer_id?: string; quantity?: number; item_price?: number; currency?: string }> };
    };
}

const triggerInclude = {
    automation: { select: { id: true, status: true, publishedVersionId: true, publishedAt: true, settings: true } },
} satisfies Prisma.AutomationTriggerInclude;
type CandidateTrigger = Prisma.AutomationTriggerGetPayload<{ include: typeof triggerInclude }>;

/**
 * Turns one stored event into work: a reply goes to the flow waiting for
 * it; otherwise matching automations start. Inbox rules (routing, welcome
 * and away messages, spam) run either way.
 */
@Injectable()
export class AutomationDispatcher {
    private readonly logger = new Logger(AutomationDispatcher.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly jobs: AutomationJobs,
        private readonly rules: InboxRulesService,
        private readonly webhooks: WebhooksService,
    ) { }

    async handle(eventId: string): Promise<void> {
        const event = await this.prisma.automationEvent.findUnique({ where: { id: eventId } });
        if (!event || event.processedAt) return;
        const payload = (event.payload ?? {}) as EventPayload;
        // Outgoing webhooks see every message, tag, sign-up and ad chat; each is sent once per endpoint.
        await this.webhooks.fromAutomationEvent(event);

        try {
            const replied = REPLY_EVENTS.has(event.eventType) ? await this.handOffReply(event, payload) : 0;
            const runIds = replied ? [] : await this.start(event, payload);

            const ruleEvent = {
                id: event.id,
                organizationId: event.organizationId,
                channelId: event.channelId,
                contactId: event.contactId,
                eventType: event.eventType,
                text: event.text,
                newConversation: payload.raw?.newConversation === true,
            };
            if (event.eventType === 'crm.contact.tag_added') await this.rules.onTagAdded({ ...ruleEvent, tag: payload.raw?.tag ?? event.text ?? '' });
            else await this.rules.onEvent(ruleEvent, { automated: replied > 0 || runIds.length > 0 });

            await this.prisma.automationEvent.update({
                where: { id: event.id },
                data: { processedAt: new Date(), matchedRuns: runIds.length, error: null },
            });
            for (const id of runIds) await this.jobs.run(id);
        } catch (err) {
            await this.prisma.automationEvent
                .update({ where: { id: event.id }, data: { error: (err instanceof Error ? err.message : String(err)).slice(0, 500) } })
                .catch(() => undefined);
            throw err;
        }
    }

    /**
     * Give a reply to the one run waiting for it. A reply that answers an
     * automation's message (quotes it, as a tapped WhatsApp button does, or
     * taps one of its Instagram or Messenger buttons) belongs to that
     * message's run, and to nobody if that run is no longer waiting. Any
     * other reply goes to the live automation's run that started waiting
     * last. One "Cancel" must never answer two order confirmations, not even
     * when the event is retried. Returns 1 if a run took it.
     */
    private async handOffReply(event: AutomationEvent, payload: EventPayload): Promise<number> {
        if (!event.contactId) return 0;
        const handed = await this.prisma.automationRun.findFirst({
            where: { contactId: event.contactId, context: { path: ['replyEventIds'], array_contains: [event.id] } },
            select: { id: true },
        });
        if (handed) {
            // A retry of this event: the run already has the reply. Queue its resume again in case that was lost.
            await this.jobs.resume(handed.id, 'reply');
            return 1;
        }
        const answeredRunId = await this.answeredRun(event, payload);
        const run = await this.prisma.automationRun.findFirst({
            where: {
                contactId: event.contactId,
                waitingForReply: true,
                status: AutomationRunStatus.WAITING,
                isTest: false,
                // A paused or archived automation's run is cancelled when it wakes; it must not take the reply.
                automation: { status: AutomationStatus.ACTIVE },
                ...(answeredRunId ? { id: answeredRunId } : {}),
            },
            include: { version: { select: { definition: true } } },
            orderBy: { updatedAt: 'desc' },
        });
        if (!run) return 0;

        const reply = event.text ?? payload.raw?.postbackPayload ?? '';
        const ctx: RunContext = parseRunContext(run.context);
        ctx.vars.last_reply = reply;
        ctx.replied = true;
        ctx.replyEventIds = [...(ctx.replyEventIds ?? []), event.id];
        const step = run.currentStepKey ? new Flow(parseDefinition(run.version.definition)).step(run.currentStepKey) : null;
        const saveAs = typeof step?.config.saveAs === 'string' ? step.config.saveAs : '';

        // Only one of the reply and the timeout may wake the run: the flag decides.
        const { count } = await this.prisma.automationRun.updateMany({
            where: { id: run.id, status: AutomationRunStatus.WAITING, waitingForReply: true },
            data: { waitingForReply: false, resumeAt: null, context: ctx as unknown as Prisma.InputJsonValue },
        });
        if (!count) return 0;
        if (saveAs) {
            const contact = await this.prisma.channelContact.findUnique({ where: { id: event.contactId }, select: { attributes: true } });
            await this.prisma.channelContact.update({
                where: { id: event.contactId },
                data: { attributes: { ...((contact?.attributes as Record<string, unknown>) ?? {}), [saveAs]: reply.slice(0, 500) } as Prisma.InputJsonValue },
            });
        }
        await this.jobs.resume(run.id, 'reply');
        return 1;
    }

    /**
     * The run whose message this reply answers, if any: the message a
     * WhatsApp reply quotes, or the run named in a tapped Instagram or
     * Messenger button or quick reply (its payload is `<runId>.<stepKey>_<n>`).
     */
    private async answeredRun(event: AutomationEvent, payload: EventPayload): Promise<string | null> {
        const quotedId = event.messageId
            ? (await this.prisma.message.findUnique({ where: { id: event.messageId }, select: { replyToMessageId: true } }))?.replyToMessageId
            : null;
        if (quotedId) {
            return (await this.prisma.message.findUnique({ where: { id: quotedId }, select: { automationRunId: true } }))?.automationRunId ?? null;
        }
        return /^([a-z0-9]+)\..+_\d+$/.exec(payload.raw?.postbackPayload ?? payload.raw?.quickReplyPayload ?? '')?.[1] ?? null;
    }

    /** Start the automations this event triggers. Returns the runs to execute. */
    private async start(event: AutomationEvent, payload: EventPayload): Promise<string[]> {
        if (!event.contactId) return [];
        const crm = event.eventType.startsWith('crm.');
        const candidates = await this.prisma.automationTrigger.findMany({
            where: {
                organizationId: event.organizationId,
                triggerType: event.eventType,
                isActive: true,
                automation: { status: AutomationStatus.ACTIVE, publishedVersionId: { not: null } },
                ...(crm ? { OR: [{ channelId: event.channelId }, { channelId: null }] } : { channelId: event.channelId }),
            },
            include: triggerInclude,
        });
        let matched = candidates.filter((t) => this.matches(t, event, payload));
        if (ONE_WINNER.has(event.eventType) && matched.length > 1) {
            matched = [matched.sort((a, b) => score(b) - score(a) || (b.automation.publishedAt?.getTime() ?? 0) - (a.automation.publishedAt?.getTime() ?? 0))[0]];
        }

        const runIds: string[] = [];
        for (const trigger of matched) {
            const id = await this.createRun(trigger, event, payload);
            if (id) runIds.push(id);
        }
        return runIds;
    }

    private matches(t: CandidateTrigger, event: AutomationEvent, payload: EventPayload): boolean {
        const config = (t.config ?? {}) as { match?: 'contains' | 'exact' | 'any'; newConversationOnly?: boolean };
        const match = config.match ?? 'contains';
        switch (event.eventType) {
            case 'instagram.comment':
            case 'facebook.comment': {
                const post = payload.raw?.postId ?? payload.mediaExternalId ?? null;
                if (t.subjectId && t.subjectId !== post) return false;
                return keywordMatches(event.text, t.keywords, match);
            }
            case 'instagram.postback':
            case 'facebook.postback': {
                if (match === 'any' || !t.keywords.length) return true;
                const tapped = payload.raw?.postbackPayload ?? '';
                return t.keywords.includes(tapped);
            }
            case 'crm.contact.tag_added': {
                const tag = (payload.raw?.tag ?? event.text ?? '').toLowerCase();
                return t.keywords.some((k) => k.toLowerCase() === tag);
            }
            case 'crm.webhook':
                return t.automationId === payload.raw?.automationId;
            case 'crm.ad.referral':
                // Any ad, or the ads the trigger names.
                return !t.keywords.length || t.keywords.includes(event.text ?? '');
            case 'instagram.mention':
            case 'whatsapp.cart':
            case 'crm.checkout.abandoned':
                return true;
            default:
                if (event.eventType.startsWith('crm.order.')) return true;
                if (config.newConversationOnly && payload.raw?.newConversation !== true) return false;
                return keywordMatches(event.text, t.keywords, match);
        }
    }

    /** A run for this trigger, or a skipped one when the automation's limits say no. */
    private async createRun(trigger: CandidateTrigger, event: AutomationEvent, payload: EventPayload): Promise<string | null> {
        const a = trigger.automation;
        const settings = (a.settings ?? {}) as { oncePerContact?: 'ever' | 'perDay' | 'never' };
        const chosen = settings.oncePerContact ?? 'ever';
        const once = chosen === 'ever' && ONE_PER_SUBJECT(event.eventType) ? 'never' : chosen;
        const skip =
            once !== 'never' &&
            (await this.prisma.automationRun.findFirst({
                where: {
                    automationId: a.id,
                    contactId: event.contactId,
                    isTest: false,
                    status: { notIn: [AutomationRunStatus.SKIPPED, AutomationRunStatus.CANCELLED] },
                    ...(once === 'perDay' ? { createdAt: { gte: new Date(Date.now() - DAY) } } : {}),
                },
                select: { id: true },
            }));

        const isComment = event.eventType.endsWith('.comment');
        const ctx: RunContext = {
            vars: {
                trigger_text: event.text ?? '',
                ...Object.fromEntries(Object.entries(payload.raw?.fields ?? {}).map(([k, v]) => [`webhook.${k}`, String(v)])),
                ...(payload.raw?.vars ?? {}),
            },
            trigger: {
                eventType: event.eventType,
                commentId: isComment ? event.externalId : null,
                postId: payload.raw?.postId ?? payload.mediaExternalId ?? null,
            },
            depth: payload.raw?.depth ?? 0,
            ...(event.eventType === 'whatsapp.cart'
                ? {
                    cart: (payload.raw?.order?.product_items ?? [])
                        .filter((i) => i.product_retailer_id)
                        .map((i) => ({ retailerId: String(i.product_retailer_id), quantity: Number(i.quantity) || 1, price: i.item_price ?? null, currency: i.currency ?? null })),
                }
                : {}),
        };
        const contact = await this.prisma.channelContact.findUnique({ where: { id: event.contactId! }, select: { customerId: true } });
        try {
            const run = await this.prisma.automationRun.create({
                data: {
                    organizationId: event.organizationId,
                    automationId: a.id,
                    automationVersionId: a.publishedVersionId!,
                    triggerId: trigger.id,
                    eventId: event.id,
                    contactId: event.contactId,
                    customerId: event.customerId ?? contact?.customerId ?? null,
                    orderId: event.orderId,
                    status: skip ? AutomationRunStatus.SKIPPED : AutomationRunStatus.PENDING,
                    skipReason: skip ? (once === 'perDay' ? 'once_per_day' : 'once_per_contact') : null,
                    completedAt: skip ? new Date() : null,
                    context: ctx as unknown as Prisma.InputJsonValue,
                },
                select: { id: true },
            });
            if (skip) return null;
            await this.prisma.automation.update({
                where: { id: a.id },
                data: { triggeredCount: { increment: 1 }, lastTriggeredAt: new Date() },
            });
            return run.id;
        } catch (err) {
            // This event already started this automation (a retried job).
            if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
            const existing = await this.prisma.automationRun.findUnique({
                where: { automationId_eventId: { automationId: a.id, eventId: event.id } },
                select: { id: true, status: true },
            });
            return existing?.status === AutomationRunStatus.PENDING ? existing.id : null;
        }
    }
}

/** Specific beats general: a chosen post, then exact words, then any keyword, then "any message". */
function score(t: CandidateTrigger): number {
    const match = ((t.config ?? {}) as { match?: string }).match ?? 'contains';
    return (t.subjectId ? 4 : 0) + (match === 'exact' ? 2 : match === 'contains' && t.keywords.length ? 1 : 0);
}
