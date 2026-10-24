import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AutomationRunStatus, AutomationStatus, ChannelPlatform, ConversationStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AutomationEventService } from '../../messaging/automation-event.service';
import { AutomationJobs } from '../../messaging/automation-jobs';
import { InboxEventsService } from '../../messaging/inbox-events.service';
import { MessagingSendService } from '../../messaging/send/messaging-send.service';
import { OutboundPayload, replyWindow } from '../../messaging/outbound';
import { contactName } from '../../messaging/contact-name';
import { InboxRulesService } from '../../inbox/inbox-rules.service';
import { InboxSettingsService } from '../../inbox/inbox-settings.service';
import { ASSIGNABLE_ROLES } from '../../inbox/inbox-team.service';
import { StoreActionsService } from '../../commerce/store-actions.service';
import { PaymentLinksService } from '../../payments/payment-links.service';
import { ReviewsService } from '../../reviews/reviews.service';
import type { ReviewerNameFormat } from '../../reviews/judgeme.client';
import { paymentVars } from '../../payments/payment-link.util';
import { WhatsAppPayService } from '../../payments/whatsapp-pay.service';
import { isCashOnDelivery } from '../../commerce/order-vars';
import { ParamValue, renderTemplate, sendComponents, templateParams } from '../../campaigns/templates/template-components';
import { SendMessageConfigT, StepDef, parseDefinition } from '../blocks/definition.schema';
import { Flow, FlowStep, FlowVariables, interpolate, toMinutes } from './flow';
import { HttpRequestError, guardedRequest } from './http-request';
import { RunContext, RunFacts, conditionMatches, flattenResponse, parseRunContext, variablesFor } from './run-context';

type Outcome =
    | { kind: 'next'; output?: Record<string, unknown>; messageId?: string }
    | { kind: 'branch'; branch: string; output?: Record<string, unknown> }
    | { kind: 'wait'; resumeAt: Date; forReply: boolean; output?: Record<string, unknown> }
    | { kind: 'fail'; error: string; output?: Record<string, unknown> };

/** A run stuck in RUNNING this long lost its worker; the sweeper hands it to another. */
export const STALE_RUN_MS = 5 * 60_000;
const MAX_HOPS = 60;

const runInclude = {
    version: { select: { definition: true } },
    automation: { select: { id: true, status: true, ownerUserId: true } },
} satisfies Prisma.AutomationRunInclude;
type LoadedRun = Prisma.AutomationRunGetPayload<{ include: typeof runInclude }>;

const contactInclude = { customer: { select: { firstName: true, lastName: true, ordersCount: true, tags: true } } } satisfies Prisma.ChannelContactInclude;
type RunContact = Prisma.ChannelContactGetPayload<{ include: typeof contactInclude }>;

interface StepState {
    run: LoadedRun;
    ctx: RunContext;
    contact: RunContact;
    conversation: { id: string; assignedUserId: string | null; platform: string; lastInboundAt: Date | null } | null;
    facts: RunFacts;
    vars: FlowVariables;
}

const fail = (error: string): Outcome => ({ kind: 'fail', error });

/**
 * Executes runs, one block at a time, against the version they were started
 * with. Every executed block leaves an AutomationRunStep row; waits park the
 * run and queue its wake-up.
 */
@Injectable()
export class AutomationRunner {
    private readonly logger = new Logger(AutomationRunner.name);
    private readonly allowPrivate: boolean;

    constructor(
        private readonly prisma: PrismaService,
        private readonly sender: MessagingSendService,
        private readonly jobs: AutomationJobs,
        private readonly automationEvents: AutomationEventService,
        private readonly inboxEvents: InboxEventsService,
        private readonly rules: InboxRulesService,
        private readonly inboxSettings: InboxSettingsService,
        private readonly store: StoreActionsService,
        private readonly paymentLinks: PaymentLinksService,
        private readonly whatsAppPay: WhatsAppPayService,
        private readonly reviews: ReviewsService,
        config: ConfigService,
    ) {
        this.allowPrivate = config.get<string>('AUTOMATION_HTTP_ALLOW_PRIVATE') === 'true';
    }

    /** Start (or pick up) a run from its current step. */
    async run(runId: string): Promise<void> {
        const { count } = await this.prisma.automationRun.updateMany({
            where: {
                id: runId,
                OR: [
                    { status: AutomationRunStatus.PENDING },
                    { status: AutomationRunStatus.RUNNING, updatedAt: { lt: new Date(Date.now() - STALE_RUN_MS) } },
                ],
            },
            data: { status: AutomationRunStatus.RUNNING },
        });
        if (!count) return;
        const run = await this.load(runId);
        if (!run.startedAt) await this.prisma.automationRun.update({ where: { id: run.id }, data: { startedAt: new Date() } });
        if (!(await this.stillLive(run))) return;
        const flow = new Flow(parseDefinition(run.version.definition));
        const start = run.currentStepKey ? flow.step(run.currentStepKey) : flow.first();
        await this.execute(run, flow, start, parseRunContext(run.context));
    }

    /**
     * Wake a waiting run. A timer fires only if the run still waits for that
     * time; a reply only after the dispatcher handed it over. Whichever comes
     * first wins, and the other finds nothing to do.
     */
    async resume(runId: string, reason: 'timer' | 'reply'): Promise<void> {
        const { count } = await this.prisma.automationRun.updateMany({
            where:
                reason === 'timer'
                    ? { id: runId, status: AutomationRunStatus.WAITING, resumeAt: { lte: new Date(Date.now() + 2_000) } }
                    : { id: runId, status: AutomationRunStatus.WAITING, resumeAt: null },
            data: { status: AutomationRunStatus.RUNNING, resumeAt: null, waitingForReply: false },
        });
        if (!count) return;
        const run = await this.load(runId);
        if (!(await this.stillLive(run))) return;
        const flow = new Flow(parseDefinition(run.version.definition));
        const ctx = parseRunContext(run.context);
        const waiting = run.currentStepKey ? flow.step(run.currentStepKey) : null;
        if (!waiting) return this.finish(run.id, ctx);

        let next: FlowStep | null;
        let output: Record<string, unknown>;
        if (waiting.type === 'wait_for_reply') {
            const branch = ctx.replied ? 'replied' : 'timeout';
            delete ctx.replied;
            next = flow.enter(waiting.id, branch);
            output = { branch, ...(branch === 'replied' ? { reply: ctx.vars.last_reply ?? '' } : {}) };
        } else {
            next = flow.next(waiting.id);
            output = { wokeAt: new Date().toISOString() };
        }
        await this.prisma.automationRunStep.updateMany({
            where: { runId: run.id, stepKey: waiting.id, attempt: 1 },
            data: { status: AutomationRunStatus.COMPLETED, output: output as Prisma.InputJsonValue, finishedAt: new Date() },
        });
        await this.execute(run, flow, next, ctx);
    }

    // ─── Execution ────────────────────────────────────────────────────

    private async execute(run: LoadedRun, flow: Flow, start: FlowStep | null, ctx: RunContext): Promise<void> {
        let step = start;
        let hops = 0;
        while (step) {
            if (++hops > MAX_HOPS) return this.failRun(run, ctx, step, 'The automation took too many steps.');
            await this.prisma.automationRun.update({
                where: { id: run.id },
                data: { currentStepKey: step.id, context: ctx as unknown as Prisma.InputJsonValue },
            });
            const startedAt = new Date();
            let outcome: Outcome;
            try {
                outcome = await this.block(run, step, ctx);
            } catch (err) {
                this.logger.warn(`Run ${run.id} step ${step.id} (${step.type}) threw: ${err instanceof Error ? err.stack : err}`);
                outcome = fail(err instanceof Error ? err.message : 'Something went wrong.');
            }
            await this.recordStep(run, step, outcome, startedAt);

            switch (outcome.kind) {
                case 'next':
                    step = flow.next(step.id);
                    break;
                case 'branch':
                    step = flow.enter(step.id, outcome.branch);
                    break;
                case 'wait':
                    await this.prisma.automationRun.update({
                        where: { id: run.id },
                        data: {
                            status: AutomationRunStatus.WAITING,
                            resumeAt: outcome.resumeAt,
                            waitingForReply: outcome.forReply,
                            context: ctx as unknown as Prisma.InputJsonValue,
                        },
                    });
                    await this.jobs.resume(run.id, 'timer', outcome.resumeAt);
                    return;
                case 'fail':
                    return this.failRun(run, ctx, step, outcome.error);
            }
        }
        await this.finish(run.id, ctx);
    }

    private async block(run: LoadedRun, step: FlowStep, ctx: RunContext): Promise<Outcome> {
        const s = await this.state(run, ctx);
        if (!s) return fail('The contact for this run no longer exists.');
        const c = step.config;
        switch (step.type) {
            case 'send_message':
                return this.sendMessage(s, step as StepDef);
            case 'reply_comment': {
                const commentId = ctx.trigger.commentId;
                if (!commentId) return fail('This run did not start from a comment.');
                const text = interpolate(String(c.message ?? ''), s.vars);
                const payload: OutboundPayload = c.mode === 'public' ? { type: 'comment_reply', commentId, text } : { type: 'private_reply', commentId, text };
                return this.deliver(s, step, payload);
            }
            case 'send_invoice':
                return this.sendInvoice(s, step);
            case 'send_payment_link':
                return this.sendPaymentLink(s, step);
            case 'wait': {
                const resumeAt = new Date(Date.now() + toMinutes(Number(c.amount), c.unit as 'minutes') * 60_000);
                return { kind: 'wait', resumeAt, forReply: false, output: { resumeAt: resumeAt.toISOString() } };
            }
            case 'wait_for_reply': {
                const resumeAt = new Date(Date.now() + toMinutes(Number(c.amount), c.unit as 'minutes') * 60_000);
                return { kind: 'wait', resumeAt, forReply: true, output: { timeoutAt: resumeAt.toISOString() } };
            }
            case 'condition': {
                const yes = conditionMatches(c as Parameters<typeof conditionMatches>[0], s.facts);
                return { kind: 'branch', branch: yes ? 'yes' : 'no', output: { result: yes } };
            }
            case 'add_tag':
                return this.addTags(s, c.tags as string[]);
            case 'remove_tag': {
                const remove = new Set((c.tags as string[]).map((t) => t.toLowerCase()));
                const tags = s.contact.tags.filter((t) => !remove.has(t.toLowerCase()));
                await this.prisma.channelContact.update({ where: { id: s.contact.id }, data: { tags } });
                this.publish(s);
                return { kind: 'next', output: { removed: s.contact.tags.length - tags.length } };
            }
            case 'set_attribute': {
                const value = interpolate(String(c.value ?? ''), s.vars);
                const attributes = { ...((s.contact.attributes as Record<string, unknown>) ?? {}), [String(c.key)]: value };
                await this.prisma.channelContact.update({ where: { id: s.contact.id }, data: { attributes: attributes as Prisma.InputJsonValue } });
                this.publish(s);
                return { kind: 'next', output: { key: c.key, value } };
            }
            case 'assign':
                return this.assign(s, c as { mode: string; userId: string; teamId: string });
            case 'set_status':
                return this.setStatus(s, c as { status: string; hours: number });
            case 'add_note': {
                const conversationId = await this.conversationId(s);
                const note = await this.prisma.conversationNote.create({
                    data: { organizationId: run.organizationId, conversationId, source: 'automation', body: `${interpolate(String(c.text ?? ''), s.vars)}`.slice(0, 2000) },
                });
                this.inboxEvents.publish(run.organizationId, { type: 'note.created', conversationId, noteId: note.id });
                return { kind: 'next', output: { noteId: note.id } };
            }
            case 'http_request':
                return this.httpRequest(s, c as { method: 'GET' | 'POST'; url: string; body: string; saveAs: string });
            case 'store_action':
                return this.storeAction(s, c as { action: string; value: string });
            case 'post_review':
                return this.postReview(s, c as { rating: string; text: string; products: 'first' | 'each'; nameFormat: ReviewerNameFormat });
            default:
                return fail(`Unknown block "${step.type}".`);
        }
    }

    // ─── Blocks ───────────────────────────────────────────────────────

    private async sendMessage(s: StepState, step: StepDef): Promise<Outcome> {
        const m = step.config as SendMessageConfigT;
        const text = interpolate(m.message, s.vars);
        const options = m.options.map((o) => o.trim()).filter(Boolean);
        let payload: OutboundPayload;
        // A tapped option names its run as well as its step, so with two runs waiting the tap answers its own.
        const optionId = (i: number) => `${s.run.id}.${step.id}_${i}`;
        switch (m.kind) {
            case 'media':
                if (!m.media) return fail('This step has no file to send.');
                payload = { type: 'media', mediaKind: m.media.kind, storageKey: m.media.storageKey, mime: m.media.mime, filename: m.media.filename, ...(text ? { caption: text } : {}) };
                break;
            case 'buttons':
                payload = { type: 'buttons', text, buttons: options.map((title, i) => ({ id: optionId(i), title })) };
                break;
            case 'list':
                payload = { type: 'list', text, buttonText: m.listButton, sections: [{ rows: options.map((title, i) => ({ id: optionId(i), title })) }] };
                break;
            case 'quick_replies':
                payload = { type: 'quick_replies', text, replies: options.map((title, i) => ({ title, payload: optionId(i) })) };
                break;
            case 'template': {
                const built = await this.templatePayload(s, m);
                if (typeof built === 'string') return fail(built);
                payload = built;
                break;
            }
            default:
                payload = { type: 'text', text };
        }
        return this.deliver(s, step, payload);
    }

    private async templatePayload(s: StepState, m: SendMessageConfigT): Promise<OutboundPayload | string> {
        const template = m.templateId
            ? await this.prisma.messageTemplate.findFirst({ where: { id: m.templateId, organizationId: s.run.organizationId } })
            : null;
        if (!template) return 'The template for this step was deleted.';
        if (template.status !== 'APPROVED') return `The template "${template.name}" is not approved (${template.status.toLowerCase()}).`;
        const format = template.parameterFormat === 'NAMED' ? 'NAMED' : 'POSITIONAL';
        const components = template.components as Record<string, unknown>[];
        const values: Record<string, ParamValue> = {};
        let headerMedia: { storageKey: string; mime: string; kind: 'image' | 'video' | 'document'; filename?: string } | undefined;
        for (const p of templateParams(components, format)) {
            if (p.component === 'header' && p.kind !== 'text') {
                if (p.kind === 'location' || !m.media || m.media.kind === 'audio') return 'Add the header image, video or document to this step.';
                headerMedia = { storageKey: m.media.storageKey, mime: m.media.mime, kind: m.media.kind, filename: m.media.filename };
                // Replaced with the uploaded file's id at delivery.
                values.header = { mediaId: 'pending-upload' };
                continue;
            }
            const value = interpolate(m.templateValues[p.key] ?? '', s.vars).trim();
            if (!value) return `The template value "${p.name}" is empty for this person.`;
            values[p.key] = value;
        }
        return {
            type: 'template',
            name: template.name,
            language: template.language,
            category: template.category,
            components: sendComponents(components, format, values),
            previewText: renderTemplate(components, values).body,
            ...(headerMedia ? { headerMedia } : {}),
        };
    }

    /** The order's GST invoice as a PDF, in the document header of an approved template. */
    private async sendInvoice(s: StepState, step: FlowStep): Promise<Outcome> {
        const orderId = s.run.orderId;
        if (!orderId) return fail('This run is not about an order.');
        const c = step.config as { templateId?: string; templateValues?: Record<string, string> };
        const template = c.templateId
            ? await this.prisma.messageTemplate.findFirst({ where: { id: c.templateId, organizationId: s.run.organizationId }, select: { components: true } })
            : null;
        const header = ((template?.components ?? []) as Array<{ type?: string; format?: string }>).find((x) => String(x.type).toUpperCase() === 'HEADER');
        if (template && String(header?.format).toUpperCase() !== 'DOCUMENT') return fail('The template has no document header for the invoice PDF.');
        const doc = await this.store.invoiceDocument(s.run.organizationId, orderId);
        if (!doc) return fail('This order has no invoice yet.');
        // {{invoice.*}} for this message and the steps after it.
        Object.assign(s.ctx.vars, doc.vars);
        Object.assign(s.vars, doc.vars);
        const payload = await this.templatePayload(s, {
            kind: 'template',
            templateId: c.templateId,
            templateValues: c.templateValues ?? {},
            media: { storageKey: doc.storageKey, mime: 'application/pdf', kind: 'document', filename: doc.filename },
        } as SendMessageConfigT);
        if (typeof payload === 'string') return fail(payload);
        return this.deliver(s, step, payload);
    }

    /**
     * A payment link for the run's order, or for the draft an earlier step
     * made from a cart. A retried step finds the link it made the first time.
     */
    private async sendPaymentLink(s: StepState, step: FlowStep): Promise<Outcome> {
        const c = step.config as { method?: string; kind?: string; message?: string; templateId?: string; templateValues?: Record<string, string>; expiresInHours?: number; tagOnPaid?: string };
        if (c.method === 'whatsapp_pay') return this.sendWhatsAppPay(s, step, c);
        const opts = {
            contactId: s.contact.id,
            conversationId: await this.conversationId(s),
            automationRunId: s.run.id,
            userId: s.run.automation?.ownerUserId ?? null,
            expiresInHours: c.expiresInHours,
            tagOnPaid: c.tagOnPaid ? interpolate(c.tagOnPaid, s.vars) : null,
        };
        let link;
        try {
            if (s.run.orderId) link = await this.paymentLinks.forOrder(s.run.organizationId, s.run.orderId, opts);
            else if (s.ctx.draftId) link = await this.paymentLinks.forDraft(s.run.organizationId, s.ctx.draftId, opts);
            else return fail('This run has no order or draft order to collect payment for.');
        } catch (err) {
            return fail(err instanceof Error ? err.message : String(err));
        }
        const vars = paymentVars({ shortUrl: link.shortUrl, amount: link.amount, currency: link.currency, expiresAt: new Date(link.expiresAt) });
        Object.assign(s.ctx.vars, vars);
        Object.assign(s.vars, vars);
        if (c.kind === 'text') return this.deliver(s, step, { type: 'text', text: interpolate(c.message ?? '', s.vars) });
        const payload = await this.templatePayload(s, { kind: 'template', templateId: c.templateId, templateValues: c.templateValues ?? {} } as SendMessageConfigT);
        if (typeof payload === 'string') return fail(payload);
        return this.deliver(s, step, payload);
    }

    /** A WhatsApp Pay bill for the run's order or cart draft; WhatsAppPayService sends it. */
    private async sendWhatsAppPay(s: StepState, step: FlowStep, c: { message?: string; expiresInHours?: number; tagOnPaid?: string }): Promise<Outcome> {
        const target = s.run.orderId ? { orderId: s.run.orderId } : s.ctx.draftId ? { draftOrderId: s.ctx.draftId } : null;
        if (!target) return fail('This run has no order or draft order to collect payment for.');
        try {
            const { link, outcome } = await this.whatsAppPay.request(s.run.organizationId, target, {
                conversationId: await this.conversationId(s),
                contactId: s.contact.id,
                userId: s.run.automation?.ownerUserId ?? null,
                automationRunId: s.run.id,
                automation: { automationId: s.run.automationId, runId: s.run.id, stepKey: step.id },
                origin: 'automation',
                text: c.message ? interpolate(c.message, s.vars) : undefined,
                expiresInHours: c.expiresInHours,
                tagOnPaid: c.tagOnPaid ? interpolate(c.tagOnPaid, s.vars) : null,
            });
            const vars = { 'payment.amount': paymentVars({ shortUrl: '', amount: link.amount, currency: link.currency, expiresAt: new Date(link.expiresAt) })['payment.amount'] };
            Object.assign(s.ctx.vars, vars);
            Object.assign(s.vars, vars);
            return { kind: 'next', ...(outcome.ok && outcome.messageId ? { messageId: outcome.messageId } : {}), output: { paymentRequestId: link.id } };
        } catch (err) {
            return fail(err instanceof Error ? err.message : String(err));
        }
    }

    private async deliver(s: StepState, step: FlowStep, payload: OutboundPayload): Promise<Outcome> {
        const conversationId = await this.conversationId(s);
        const outcome = await this.sender.send({
            organizationId: s.run.organizationId,
            conversationId,
            payload,
            origin: 'automation',
            automation: { automationId: s.run.automationId, runId: s.run.id, stepKey: step.id },
            // A retried run never sends the same step twice.
            idempotencyKey: `auto:${s.run.id}:${step.id}`,
        });
        if (!outcome.ok) return { kind: 'fail', error: outcome.message, output: { refusal: outcome.code } };
        return { kind: 'next', messageId: outcome.messageId, output: { messageId: outcome.messageId } };
    }

    private async addTags(s: StepState, tags: string[]): Promise<Outcome> {
        const added = [...new Set(tags.map((t) => t.trim()).filter(Boolean))].filter(
            (t) => !s.contact.tags.some((x) => x.toLowerCase() === t.toLowerCase()),
        );
        if (!added.length) return { kind: 'next', output: { added: [] } };
        const eventIds = await this.prisma.$transaction(async (tx) => {
            await tx.channelContact.update({ where: { id: s.contact.id }, data: { tags: [...s.contact.tags, ...added] } });
            return this.automationEvents.recordTagsAdded(tx, s.contact, added, s.ctx.depth + 1);
        });
        for (const id of eventIds) await this.jobs.event(id);
        this.publish(s);
        return { kind: 'next', output: { added } };
    }

    private async assign(s: StepState, c: { mode: string; userId: string; teamId: string }): Promise<Outcome> {
        const orgId = s.run.organizationId;
        const conversationId = await this.conversationId(s);
        const data: Prisma.ConversationUncheckedUpdateInput = {};
        if (c.mode === 'unassign') {
            data.assignedUserId = null;
        } else if (c.mode === 'user') {
            const member = await this.prisma.organizationMember.findFirst({
                where: { organizationId: orgId, userId: c.userId, isActive: true, role: { in: ASSIGNABLE_ROLES } },
                select: { userId: true },
            });
            if (!member) return fail('That team member can no longer be assigned conversations.');
            data.assignedUserId = c.userId;
        } else {
            const team = c.teamId ? await this.prisma.inboxTeam.findFirst({ where: { id: c.teamId, organizationId: orgId }, select: { id: true } }) : null;
            if (c.teamId && !team) return fail('That team was deleted.');
            if (team) data.teamId = team.id;
            if (c.mode === 'round_robin') {
                const { settings } = await this.inboxSettings.get(orgId);
                const userId = await this.rules.pickAgent(orgId, team?.id ?? null, settings.roundRobin.maxOpenPerAgent);
                if (userId) data.assignedUserId = userId;
            }
        }
        await this.prisma.conversation.update({ where: { id: conversationId }, data });
        this.inboxEvents.publish(orgId, { type: 'conversation.updated', conversationId });
        return { kind: 'next', output: { assignedUserId: data.assignedUserId ?? null, teamId: data.teamId ?? null } };
    }

    private async setStatus(s: StepState, c: { status: string; hours: number }): Promise<Outcome> {
        const conversationId = await this.conversationId(s);
        const now = new Date();
        const prior = await this.prisma.conversation.findUnique({ where: { id: conversationId }, select: { status: true } });
        const data: Prisma.ConversationUncheckedUpdateInput =
            c.status === 'closed'
                ? { status: ConversationStatus.CLOSED, closedAt: now, closedById: null, snoozedUntil: null }
                : c.status === 'snoozed'
                    ? { status: ConversationStatus.SNOOZED, snoozedUntil: new Date(now.getTime() + c.hours * 3600_000) }
                    : { status: ConversationStatus.OPEN, closedAt: null, closedById: null, snoozedUntil: null, ...(prior?.status === ConversationStatus.CLOSED ? { openedAt: now } : {}) };
        await this.prisma.conversation.update({ where: { id: conversationId }, data });
        this.inboxEvents.publish(s.run.organizationId, { type: 'conversation.updated', conversationId });
        return { kind: 'next', output: { status: c.status } };
    }

    private async httpRequest(s: StepState, c: { method: 'GET' | 'POST'; url: string; body: string; saveAs: string }): Promise<Outcome> {
        // Values are escaped for where they land: the URL, or a JSON string.
        const encoded = Object.fromEntries(Object.entries(s.vars).map(([k, v]) => [k, v === null || v === undefined ? v : encodeURIComponent(String(v))]));
        const jsonSafe = Object.fromEntries(Object.entries(s.vars).map(([k, v]) => [k, v === null || v === undefined ? v : JSON.stringify(String(v)).slice(1, -1)]));
        const url = interpolate(c.url, encoded);
        let body: string | undefined;
        if (c.method === 'POST') {
            body = c.body.trim() ? interpolate(c.body, jsonSafe) : '{}';
            try {
                JSON.parse(body);
            } catch {
                return fail('The request body is not valid JSON once the variables are filled in.');
            }
        }
        try {
            const res = await guardedRequest({ method: c.method, url, body, allowPrivate: this.allowPrivate });
            if (res.status >= 400 || res.status === 0) return { kind: 'fail', error: `The server answered ${res.status}.`, output: { status: res.status } };
            if (c.saveAs) Object.assign(s.ctx.vars, flattenResponse(c.saveAs, res.body, res.status));
            return { kind: 'next', output: { status: res.status } };
        } catch (err) {
            if (err instanceof HttpRequestError) return fail(err.message);
            throw err;
        }
    }

    private async storeAction(s: StepState, c: { action: string; value: string }): Promise<Outcome> {
        // Publish refuses these elsewhere; this also stops versions published before that check.
        if (s.contact.platform !== ChannelPlatform.WHATSAPP) return fail('Store actions run in WhatsApp automations only.');
        const orgId = s.run.organizationId;
        const actor = await this.store.actorFor(orgId, s.run.automation.ownerUserId);
        const value = interpolate(c.value ?? '', s.vars).trim();
        const orderId = s.run.orderId;
        switch (c.action) {
            case 'tag_order':
                if (!orderId) return fail('This run is not about an order.');
                return { kind: 'next', output: await this.store.tagOrder(orgId, orderId, value, actor) };
            case 'note_order':
                if (!orderId) return fail('This run is not about an order.');
                await this.store.noteOrder(orgId, orderId, value, actor);
                return { kind: 'next', output: { note: value } };
            case 'cancel_order':
                if (!orderId) return fail('This run is not about an order.');
                await this.store.cancelOrder(orgId, orderId, actor, value || 'Cancelled by an automation after the customer’s reply.');
                return { kind: 'next', output: { cancelled: true } };
            case 'tag_customer':
                if (!s.contact.customerId) return fail('This contact is not linked to a store customer.');
                return { kind: 'next', output: await this.store.tagCustomer(orgId, s.contact.customerId, value) };
            case 'create_draft_order': {
                if (!s.ctx.cart?.length) return fail('This run did not start from a cart.');
                const cartMessage = s.run.eventId
                    ? (await this.prisma.automationEvent.findUnique({ where: { id: s.run.eventId }, select: { messageId: true } }))?.messageId ?? null
                    : null;
                const draft = await this.store.draftFromCart(orgId, actor, {
                    lines: s.ctx.cart,
                    customerId: s.contact.customerId,
                    phone: s.contact.phone,
                    firstName: typeof s.vars.first_name === 'string' ? s.vars.first_name : null,
                    note: 'Cart sent on WhatsApp',
                    sourceMessageId: cartMessage,
                });
                // A later "Send payment link" collects for this draft.
                s.ctx.draftId = draft.draftId;
                Object.assign(s.ctx.vars, {
                    'draft.checkout_url': draft.checkoutUrl ?? '',
                    'draft.name': draft.name ?? '',
                    'draft.total': draft.total,
                });
                return { kind: 'next', output: { ...draft } };
            }
            default:
                return fail(`Unknown store action "${c.action}".`);
        }
    }

    private async postReview(s: StepState, c: { rating: string; text: string; products: 'first' | 'each'; nameFormat: ReviewerNameFormat }): Promise<Outcome> {
        // Publish refuses these elsewhere; this also stops versions published before that check.
        if (s.contact.platform !== ChannelPlatform.WHATSAPP) return fail('Reviews are collected in WhatsApp automations only.');
        if (!s.run.orderId) return fail('This run is not about an order.');
        const conversationId = await this.conversationId(s);
        const text = interpolate(c.text ?? '', s.vars);
        const { rating, reviews } = await this.reviews.publish({
            orgId: s.run.organizationId,
            orderId: s.run.orderId,
            contactId: s.contact.id,
            conversationId,
            runId: s.run.id,
            rating: interpolate(c.rating ?? '', s.vars),
            text,
            products: c.products,
            nameFormat: c.nameFormat,
            contactName: contactName(s.contact),
        });
        const note = await this.prisma.conversationNote.create({
            data: { organizationId: s.run.organizationId, conversationId, source: 'automation', body: this.reviews.noteFor(rating, text, reviews) },
        });
        this.inboxEvents.publish(s.run.organizationId, { type: 'note.created', conversationId, noteId: note.id });
        const output = { rating, reviews: reviews.map((r) => ({ id: r.id, product: r.productTitle, status: r.status, reason: r.reason })) };
        const failed = reviews.find((r) => r.status === 'FAILED');
        return failed ? { kind: 'fail', error: `Judge.me did not take the review: ${failed.reason}`, output } : { kind: 'next', output };
    }

    // ─── State ────────────────────────────────────────────────────────

    private load(runId: string) {
        return this.prisma.automationRun.findUniqueOrThrow({ where: { id: runId }, include: runInclude });
    }

    /** Runs of a paused or archived automation stop where they are. */
    private async stillLive(run: LoadedRun): Promise<boolean> {
        if (run.automation.status === AutomationStatus.ACTIVE) return true;
        await this.prisma.automationRun.update({
            where: { id: run.id },
            data: { status: AutomationRunStatus.CANCELLED, error: 'The automation was paused or archived.', completedAt: new Date(), waitingForReply: false },
        });
        return false;
    }

    private async state(run: LoadedRun, ctx: RunContext): Promise<StepState | null> {
        if (!run.contactId) return null;
        const contact = await this.prisma.channelContact.findUnique({ where: { id: run.contactId }, include: contactInclude });
        if (!contact) return null;
        const conversation = await this.prisma.conversation.findUnique({
            where: { channelId_contactId: { channelId: contact.channelId, contactId: contact.id } },
            select: { id: true, assignedUserId: true, platform: true, lastInboundAt: true },
        });
        const order = run.orderId
            ? await this.prisma.order.findUnique({ where: { id: run.orderId }, select: { paymentGateways: true, totalPrice: true } })
            : null;
        const facts: RunFacts = {
            order: order ? { isCod: isCashOnDelivery(order.paymentGateways), total: Number(order.totalPrice) } : null,
            contact: {
                name: contactName(contact),
                username: contact.username,
                phone: contact.phone,
                tags: contact.tags,
                attributes: (contact.attributes as Record<string, unknown>) ?? {},
                optedIn: !!contact.optInAt && !contact.optedOutAt,
                optedOut: !!contact.optedOutAt,
            },
            customer: contact.customer,
            conversation: conversation
                ? { assignedUserId: conversation.assignedUserId, windowOpen: replyWindow(conversation.platform, conversation.lastInboundAt).open }
                : null,
            context: ctx,
        };
        return { run, ctx, contact, conversation, facts, vars: variablesFor(facts) };
    }

    private async conversationId(s: StepState): Promise<string> {
        return s.conversation?.id ?? this.sender.conversationFor(s.contact.id);
    }

    private publish(s: StepState) {
        if (s.conversation) this.inboxEvents.publish(s.run.organizationId, { type: 'conversation.updated', conversationId: s.conversation.id });
    }

    private async recordStep(run: LoadedRun, step: FlowStep, outcome: Outcome, startedAt: Date) {
        const status =
            outcome.kind === 'fail' ? AutomationRunStatus.FAILED : outcome.kind === 'wait' ? AutomationRunStatus.WAITING : AutomationRunStatus.COMPLETED;
        const output = { ...(outcome.output ?? {}), ...(outcome.kind === 'branch' ? { branch: outcome.branch } : {}) };
        const data = {
            status,
            output: output as Prisma.InputJsonValue,
            messageId: outcome.kind === 'next' ? (outcome.messageId ?? null) : null,
            error: outcome.kind === 'fail' ? outcome.error.slice(0, 1000) : null,
            startedAt,
            finishedAt: outcome.kind === 'wait' ? null : new Date(),
        };
        await this.prisma.automationRunStep.upsert({
            where: { runId_stepKey_attempt: { runId: run.id, stepKey: step.id, attempt: 1 } },
            create: { organizationId: run.organizationId, runId: run.id, automationId: run.automationId, stepKey: step.id, blockType: step.type, ...data },
            update: data,
        });
    }

    private async finish(runId: string, ctx: RunContext) {
        await this.prisma.automationRun.update({
            where: { id: runId },
            data: { status: AutomationRunStatus.COMPLETED, completedAt: new Date(), currentStepKey: null, context: ctx as unknown as Prisma.InputJsonValue },
        });
    }

    private async failRun(run: LoadedRun, ctx: RunContext, step: FlowStep, error: string) {
        const now = new Date();
        await this.prisma.$transaction([
            this.prisma.automationRun.update({
                where: { id: run.id },
                data: { status: AutomationRunStatus.FAILED, error: error.slice(0, 1000), completedAt: now, context: ctx as unknown as Prisma.InputJsonValue },
            }),
            this.prisma.automation.update({
                where: { id: run.automationId },
                data: { lastError: `${step.type.replace(/_/g, ' ')}: ${error}`.slice(0, 500), lastErrorAt: now },
            }),
        ]);
    }
}
