import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AutomationRunStatus, AutomationStatus, ChannelPlatform, ChannelStatus, ConversationStatus, MessageDirection, MessageTemplate, Prisma } from '@prisma/client';
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
import { GoogleService } from '../../integrations/google/google.service';
import type { ReviewerNameFormat } from '../../reviews/judgeme.client';
import { paymentVars } from '../../payments/payment-link.util';
import { WhatsAppPayService } from '../../payments/whatsapp-pay.service';
import { isCashOnDelivery, isPosOrder } from '../../commerce/order-vars';
import { ParamValue, renderTemplate, sendComponents, templateParams } from '../../campaigns/templates/template-components';
import { PACK_LANGUAGE, packSlot, packVariantOf, type PackSlot, type PackVariant } from '../../campaigns/templates/pack/template-pack';
import { latestPackTemplate, pickPackTemplate } from '../../campaigns/templates/pack/pick-pack-template';
import { resolveReportingTimeZone } from '../../common/utils/zoned-date.util';
import { parseStoreProfileSettings } from '../../organization-settings/schemas/store-profile-settings.schema';
import { CART_TRIGGERS, SendMessageConfigT, StepDef, parseDefinition } from '../blocks/definition.schema';
import { readCartDiscount } from '../pack/cart-discount';
import { Flow, FlowStep, FlowVariables, interpolate, toMinutes } from './flow';
import { HttpRequestError, guardedRequest } from './http-request';
import { quietHoursEnd } from './quiet-hours';
import { HoldReason, RunContext, RunFacts, conditionMatches, flattenResponse, parseRunContext, variablesFor } from './run-context';

type Outcome =
    | { kind: 'next'; output?: Record<string, unknown>; messageId?: string }
    | { kind: 'branch'; branch: string; output?: Record<string, unknown> }
    | { kind: 'wait'; resumeAt: Date; forReply: boolean; output?: Record<string, unknown> }
    /** Not sent yet: park the run and run this step again at `resumeAt`. */
    | { kind: 'hold'; resumeAt: Date; reason: HoldReason; output?: Record<string, unknown> }
    /** Not sent, and not to be: the run carries on with the next step. */
    | { kind: 'skip'; reason: string; output?: Record<string, unknown> }
    | { kind: 'fail'; error: string; output?: Record<string, unknown> };

/** What stops a send short of the message: a step outcome instead of a payload. */
type Halt = Extract<Outcome, { kind: 'fail' | 'hold' | 'skip' }>;

/** A pack slot resolved to the account's template for it, and the pack's values for that template. */
interface ResolvedSlot {
    slot: PackSlot;
    template: MessageTemplate;
    variant: PackVariant;
}

/** A run stuck in RUNNING this long lost its worker; the sweeper hands it to another. */
export const STALE_RUN_MS = 5 * 60_000;
const MAX_HOPS = 60;
/** A pack template Meta paused is tried again this often, until this long after the run started; then the step is skipped. */
const PAUSED_RETRY_MS = 30 * 60_000;
const PAUSED_HOLD_MS = 12 * 3600_000;

/** Why a run's stop conditions ended it. */
type StopReason = 'order_placed' | 'replied' | 'opted_out';

/** What every step of one execution reads: the store's name and time zone, and on cart runs the pack's discount. */
interface RunEnv {
    vars: Record<string, string>;
    timeZone: string;
}

const runInclude = {
    version: { select: { definition: true } },
    automation: { select: { id: true, status: true, ownerUserId: true, packKey: true } },
} satisfies Prisma.AutomationRunInclude;
type LoadedRun = Prisma.AutomationRunGetPayload<{ include: typeof runInclude }>;

const contactInclude = { customer: { select: { firstName: true, lastName: true, ordersCount: true, tags: true } } } satisfies Prisma.ChannelContactInclude;
type RunContact = Prisma.ChannelContactGetPayload<{ include: typeof contactInclude }>;

interface StepState {
    run: LoadedRun;
    ctx: RunContext;
    env: RunEnv;
    contact: RunContact;
    conversation: { id: string; assignedUserId: string | null; platform: string; lastInboundAt: Date | null } | null;
    facts: RunFacts;
    vars: FlowVariables;
}

const fail = (error: string): Halt => ({ kind: 'fail', error });
/** Neither a payload nor a resolved slot has a `kind`; every step outcome has. */
const halted = <T extends object>(built: T | Halt): built is Halt => 'kind' in built;

/**
 * Executes runs, one block at a time, against the version they were started
 * with. Every executed block leaves an AutomationRunStep row; waits park the
 * run and queue its wake-up.
 */
/** Step names as the editor shows them, for the automation's "last stop" line. */
const STEP_NAME: Record<string, string> = {
    send_message: 'Send a message',
    reply_comment: 'Reply to the comment',
    send_invoice: 'Send the invoice',
    send_payment_link: 'Send a payment link',
    wait: 'Wait',
    wait_for_reply: 'Wait for a reply',
    condition: 'Check a condition',
    add_tag: 'Add tags',
    remove_tag: 'Remove tags',
    set_attribute: 'Save a field',
    assign: 'Assign',
    set_status: 'Open, close or snooze',
    add_note: 'Add a note',
    http_request: 'Call a URL',
    store_action: 'Store action',
    post_review: 'Publish a review',
    sheet_add_row: 'Add a row to a sheet',
};

@Injectable()
export class AutomationRunner {
    private readonly logger = new Logger(AutomationRunner.name);
    private readonly allowPrivate: boolean;
    private readonly frontendUrl: string;

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
        private readonly google: GoogleService,
        config: ConfigService,
    ) {
        this.allowPrivate = config.get<string>('AUTOMATION_HTTP_ALLOW_PRIVATE') === 'true';
        this.frontendUrl = config.get<string>('frontendUrl') ?? '';
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
        const flow = await this.flowOf(run);
        if (!flow) return;
        const start = run.currentStepKey ? flow.step(run.currentStepKey) : flow.first();
        const ctx = parseRunContext(run.context);
        // Before the first send as well as at every wake-up: the shopper may have ordered before the run began.
        const stopped = start ? await this.stopReason(run, flow.trigger.config, ctx, 'timer') : null;
        if (stopped) return this.stop(run, start!, ctx, stopped);
        // A held send whose wake-up was cut short (its worker died) runs again.
        if (ctx.hold?.stepId === start?.id) delete ctx.hold;
        await this.execute(run, flow, start, ctx);
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
        const flow = await this.flowOf(run);
        if (!flow) return;
        const ctx = parseRunContext(run.context);
        const waiting = run.currentStepKey ? flow.step(run.currentStepKey) : null;
        if (!waiting) return this.finish(run.id, ctx);

        const stopped = await this.stopReason(run, flow.trigger.config, ctx, reason);
        if (stopped) return this.stop(run, waiting, ctx, stopped);

        // A send held back (quiet hours, a paused template) runs again, not the step after it.
        const held = ctx.hold?.stepId === waiting.id;
        delete ctx.hold;
        if (held) return this.execute(run, flow, waiting, ctx);

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
        const env = await this.env(run, flow);
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
                outcome = await this.block(run, step, ctx, env);
            } catch (err) {
                this.logger.warn(`Run ${run.id} step ${step.id} (${step.type}) threw: ${err instanceof Error ? err.stack : err}`);
                outcome = fail(err instanceof Error ? err.message : 'Something went wrong.');
            }
            await this.recordStep(run, step, outcome, startedAt);

            switch (outcome.kind) {
                case 'next':
                case 'skip':
                    step = flow.next(step.id);
                    break;
                case 'branch':
                    step = flow.enter(step.id, outcome.branch);
                    break;
                case 'wait':
                case 'hold':
                    if (outcome.kind === 'hold') ctx.hold = { stepId: step.id, reason: outcome.reason };
                    await this.prisma.automationRun.update({
                        where: { id: run.id },
                        data: {
                            status: AutomationRunStatus.WAITING,
                            resumeAt: outcome.resumeAt,
                            waitingForReply: outcome.kind === 'wait' && outcome.forReply,
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

    /** Read once per execution, not per step: store events can have several sends. */
    private async env(run: LoadedRun, flow: Flow): Promise<RunEnv> {
        const org = await this.prisma.organization.findUnique({
            where: { id: run.organizationId },
            select: { name: true, timezone: true, settings: { select: { storeProfileSettings: true } } },
        });
        const timeZone = resolveReportingTimeZone(org ?? {});
        const vars: Record<string, string> = {
            'store.name': parseStoreProfileSettings(org?.settings?.storeProfileSettings).storeName.trim() || org?.name || '',
        };
        if (CART_TRIGGERS.includes(String(flow.trigger.config.event))) {
            const discount = await this.cartDiscount(run.organizationId);
            if (discount) {
                Object.assign(vars, {
                    'cart.discount_code': discount.code,
                    'cart.discount_text': discount.text,
                    'cart.discount_expiry': new Date(Date.now() + discount.validDays * 86_400_000).toLocaleDateString('en-IN', {
                        day: 'numeric',
                        month: 'short',
                        year: 'numeric',
                        timeZone,
                    }),
                });
            }
        }
        return { vars, timeZone };
    }

    /** The organization's WhatsApp account now: its pack templates and settings are on it. */
    private async currentWaba(orgId: string): Promise<string | null> {
        const channel = await this.prisma.channel.findFirst({
            where: { organizationId: orgId, platform: ChannelPlatform.WHATSAPP, status: { not: ChannelStatus.DISCONNECTED } },
            select: { externalStoreId: true },
        });
        return channel?.externalStoreId ?? null;
    }

    private async cartDiscount(orgId: string) {
        const wabaId = await this.currentWaba(orgId);
        const pack = wabaId ? await this.prisma.templatePack.findUnique({ where: { wabaId }, select: { organizationId: true, settings: true } }) : null;
        return pack?.organizationId === orgId ? readCartDiscount(pack.settings) : null;
    }

    private async block(run: LoadedRun, step: FlowStep, ctx: RunContext, env: RunEnv): Promise<Outcome> {
        const s = await this.state(run, ctx, env);
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
            case 'sheet_add_row': {
                const values = ((c.values as string[]) ?? []).map((v) => interpolate(v, s.vars));
                await this.google.appendRow(run.organizationId, String(c.sheetId), values);
                return { kind: 'next', output: { values } };
            }
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
                // A chosen template wins over the pack's slot: that is the merchant's own choice.
                if (m.templateSlot && !m.templateId) return this.sendSlot(s, step, m.templateSlot);
                const built = await this.templatePayload(s, m);
                if (halted(built)) return built;
                payload = built;
                break;
            }
            default:
                payload = { type: 'text', text };
        }
        return this.deliver(s, step, payload);
    }

    /** A send step that names a pack slot: resolve it, fill it, send it. */
    private async sendSlot(s: StepState, step: FlowStep, key: string, opts: { invoice?: boolean } = {}): Promise<Outcome> {
        const resolved = await this.resolveSlot(s, key, opts);
        if (halted(resolved)) return resolved;
        const payload = await this.fillSlot(s, resolved);
        if (halted(payload)) return payload;
        return this.deliverSlot(s, step, payload);
    }

    /**
     * The send gate refuses marketing to someone who stopped promotions, which
     * a slot whose template Meta moved to marketing meets too: the step is
     * skipped rather than failing Collabo's automation.
     */
    private async deliverSlot(s: StepState, step: FlowStep, payload: OutboundPayload): Promise<Outcome> {
        const outcome = await this.deliver(s, step, payload);
        return outcome.kind === 'fail' && outcome.output?.refusal === 'opted_out' ? { kind: 'skip', reason: 'opted_out', output: { skipped: 'opted_out' } } : outcome;
    }

    private async templatePayload(s: StepState, m: SendMessageConfigT): Promise<OutboundPayload | Halt> {
        const template = m.templateId
            ? await this.prisma.messageTemplate.findFirst({ where: { id: m.templateId, organizationId: s.run.organizationId } })
            : null;
        if (!template) return fail('The template for this step was deleted.');
        if (template.status !== 'APPROVED') return fail(`The template "${template.name}" is not approved (${template.status.toLowerCase()}).`);
        const quiet = this.quietHold(s, template.category);
        if (quiet) return quiet;
        const format = template.parameterFormat === 'NAMED' ? 'NAMED' : 'POSITIONAL';
        const components = template.components as Record<string, unknown>[];
        const values: Record<string, ParamValue> = {};
        let headerMedia: { storageKey: string; mime: string; kind: 'image' | 'video' | 'document'; filename?: string } | undefined;
        for (const p of templateParams(components, format)) {
            if (p.component === 'header' && p.kind !== 'text') {
                if (p.kind === 'location' || !m.media || m.media.kind === 'audio') return fail('Add the header image, video or document to this step.');
                headerMedia = { storageKey: m.media.storageKey, mime: m.media.mime, kind: m.media.kind, filename: m.media.filename };
                // Replaced with the uploaded file's id at delivery.
                values.header = { mediaId: 'pending-upload' };
                continue;
            }
            const value = interpolate(m.templateValues[p.key] ?? '', s.vars).trim();
            if (!value) return fail(`The template value "${p.name}" is empty for this person.`);
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

    /**
     * A step that names a slot of the recommended pack: the account's approved
     * template for it now, or why nothing goes out. Nothing to send skips the
     * step, never fails the run: these automations are Collabo's, and one
     * template Meta has not approved must not stop the others. Checked before
     * anything is made for the send (an invoice PDF, a payment link).
     */
    private async resolveSlot(s: StepState, key: string, opts: { invoice?: boolean } = {}): Promise<ResolvedSlot | Halt> {
        const skip = (reason: string, extra: Record<string, unknown> = {}): Halt => ({ kind: 'skip', reason, output: { skipped: reason, slot: key, ...extra } });
        const slot = packSlot(this.frontendUrl, key);
        // "Send the invoice" sends the PDF: a slot without a document header has nowhere to put it.
        if (!slot || (opts.invoice && !slot.invoiceDocument)) return skip('template_unavailable');
        const wabaId = await this.currentWaba(s.run.organizationId);
        const rows = wabaId
            ? await this.prisma.messageTemplate.findMany({ where: { organizationId: s.run.organizationId, wabaId, packSlot: key } })
            : [];
        const template = pickPackTemplate(rows, key, slot.category, PACK_LANGUAGE);
        if (!template) {
            const latest = latestPackTemplate(rows, key, PACK_LANGUAGE);
            // Meta pauses a template for hours, then lifts it: wait for it while the message is still timely.
            const deadline = s.run.createdAt.getTime() + PAUSED_HOLD_MS;
            if (latest?.status === 'PAUSED' && Date.now() < deadline) {
                const resumeAt = new Date(Math.min(Date.now() + PAUSED_RETRY_MS, deadline));
                return { kind: 'hold', resumeAt, reason: 'template_paused', output: { heldUntil: resumeAt.toISOString(), reason: 'template_paused', template: latest.name } };
            }
            return skip('template_unavailable', latest ? { template: latest.name, status: latest.status } : {});
        }
        const variant = packVariantOf(slot, template);
        if (!variant) return skip('template_unavailable', { template: template.name });
        if (template.category === 'MARKETING' && s.facts.contact.optedOut) return skip('opted_out', { template: template.name });
        const quiet = this.quietHold(s, template.category);
        if (quiet) return quiet;
        return { slot, template, variant };
    }

    /** The resolved template filled with the pack's values, and the order's invoice PDF where the slot has one. */
    private async fillSlot(s: StepState, { slot, template, variant }: ResolvedSlot): Promise<OutboundPayload | Halt> {
        const skip = (reason: string, extra: Record<string, unknown> = {}): Halt => ({ kind: 'skip', reason, output: { skipped: reason, slot: slot.key, template: template.name, ...extra } });
        let headerMedia: { storageKey: string; mime: string; kind: 'document'; filename?: string } | undefined;
        if (slot.invoiceDocument) {
            const doc = s.run.orderId ? await this.store.invoiceDocument(s.run.organizationId, s.run.orderId) : null;
            if (!doc) return skip('invoice_missing');
            // {{invoice.*}} for this message and the steps after it.
            Object.assign(s.ctx.vars, doc.vars);
            Object.assign(s.vars, doc.vars);
            headerMedia = { storageKey: doc.storageKey, mime: 'application/pdf', kind: 'document', filename: doc.filename };
        }
        const format = template.parameterFormat === 'NAMED' ? 'NAMED' : 'POSITIONAL';
        const components = template.components as Record<string, unknown>[];
        const values: Record<string, ParamValue> = {};
        for (const p of templateParams(components, format)) {
            if (p.component === 'header' && p.kind !== 'text') {
                if (p.kind !== headerMedia?.kind) return skip('template_unavailable');
                // Replaced with the uploaded file's id at delivery.
                values.header = { mediaId: 'pending-upload' };
                continue;
            }
            const value = interpolate(variant.values[p.key] ?? '', s.vars).trim();
            if (!value) return skip('value_missing', { value: p.name });
            values[p.key] = value;
        }
        return {
            type: 'template',
            name: template.name,
            language: template.language,
            category: template.category,
            components: sendComponents(components, format, values, variant.source === 'collabo' ? variant.quickReplyPayloads : undefined),
            previewText: renderTemplate(components, values).body,
            ...(headerMedia ? { headerMedia } : {}),
        };
    }

    /**
     * Marketing from Collabo's recommended automations waits out the night in
     * the store's time zone (21:00 to 09:00): the run parks and sends at
     * 09:00. Never as a QUEUED message, which the outbound sweeper would fail
     * after six hours. The merchant's own automations send when they always did.
     */
    private quietHold(s: StepState, category: string | null | undefined): Halt | null {
        if (category !== 'MARKETING' || !s.run.automation.packKey) return null;
        const until = quietHoursEnd(new Date(), s.env.timeZone);
        return until ? { kind: 'hold', resumeAt: until, reason: 'quiet_hours', output: { heldUntil: until.toISOString(), reason: 'quiet_hours' } } : null;
    }

    /** The order's GST invoice as a PDF, in the document header of an approved template. */
    private async sendInvoice(s: StepState, step: FlowStep): Promise<Outcome> {
        const c = step.config as { templateId?: string; templateValues?: Record<string, string>; templateSlot?: string };
        if (c.templateSlot && !c.templateId) return this.sendSlot(s, step, c.templateSlot, { invoice: true });
        const orderId = s.run.orderId;
        if (!orderId) return fail('This run is not about an order.');
        const template = c.templateId
            ? await this.prisma.messageTemplate.findFirst({ where: { id: c.templateId, organizationId: s.run.organizationId }, select: { components: true, category: true } })
            : null;
        const header = ((template?.components ?? []) as Array<{ type?: string; format?: string }>).find((x) => String(x.type).toUpperCase() === 'HEADER');
        if (template && String(header?.format).toUpperCase() !== 'DOCUMENT') return fail('The template has no document header for the invoice PDF.');
        const quiet = this.quietHold(s, template?.category);
        if (quiet) return quiet;
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
        if (halted(payload)) return payload;
        return this.deliver(s, step, payload);
    }

    /**
     * A payment link for the run's order, or for the draft an earlier step
     * made from a cart. A retried step finds the link it made the first time.
     */
    private async sendPaymentLink(s: StepState, step: FlowStep): Promise<Outcome> {
        const c = step.config as { method?: string; kind?: string; message?: string; templateId?: string; templateValues?: Record<string, string>; templateSlot?: string; expiresInHours?: number; tagOnPaid?: string };
        if (c.method === 'whatsapp_pay') return this.sendWhatsAppPay(s, step, c);
        // Before the link is made: nothing is sent without a template, and a held link's expiry would run through the night.
        let slot: ResolvedSlot | null = null;
        if (c.kind !== 'text' && c.templateSlot && !c.templateId) {
            const resolved = await this.resolveSlot(s, c.templateSlot);
            if (halted(resolved)) return resolved;
            slot = resolved;
        } else if (c.kind !== 'text' && c.templateId) {
            const template = await this.prisma.messageTemplate.findFirst({ where: { id: c.templateId, organizationId: s.run.organizationId }, select: { category: true } });
            const quiet = this.quietHold(s, template?.category);
            if (quiet) return quiet;
        }
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
        if (slot) {
            const filled = await this.fillSlot(s, slot);
            return halted(filled) ? filled : this.deliverSlot(s, step, filled);
        }
        const payload = await this.templatePayload(s, { kind: 'template', templateId: c.templateId, templateValues: c.templateValues ?? {} } as SendMessageConfigT);
        if (halted(payload)) return payload;
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
            case 'cancel_order': {
                if (!orderId) return fail('This run is not about an order.');
                const refused = await this.store.cancelOrder(orgId, orderId, actor, value || 'Cancelled by an automation after the customer’s reply.');
                // The steps after it (a "cancelled" message) must not run for an order that was not cancelled.
                if (refused) return fail(refused);
                return { kind: 'next', output: { cancelled: true } };
            }
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

    /**
     * The run's version as a flow. A stored version that no longer parses
     * fails the run; left RUNNING, the sweeper would retry it for ever.
     */
    private async flowOf(run: LoadedRun): Promise<Flow | null> {
        try {
            return new Flow(parseDefinition(run.version.definition));
        } catch (err) {
            this.logger.warn(`Run ${run.id}: version ${run.automationVersionId} no longer parses: ${err instanceof Error ? err.message : err}`);
            const error = 'This published version can no longer run. Open the automation, check it and publish it again.';
            const now = new Date();
            await this.prisma.$transaction([
                this.prisma.automationRun.update({
                    where: { id: run.id },
                    data: { status: AutomationRunStatus.FAILED, error, completedAt: now, waitingForReply: false, resumeAt: null },
                }),
                this.prisma.automation.update({ where: { id: run.automationId }, data: { lastError: error, lastErrorAt: now } }),
            ]);
            return null;
        }
    }

    /**
     * The trigger's stop conditions, checked before the first step and
     * whenever the run wakes from a wait: the shopper placed an order (its
     * checkout completed, or an order of theirs came in since the checkout
     * went quiet), or wrote to the business or opted out since the run
     * started. A reply a wait-for-reply step was waiting for is no reason to
     * stop.
     */
    private async stopReason(run: LoadedRun, trigger: Record<string, unknown>, ctx: RunContext, reason: 'timer' | 'reply'): Promise<StopReason | null> {
        const when = (trigger.stopWhen ?? {}) as { orderPlaced?: boolean; replied?: boolean; optedOut?: boolean };
        if (!run.contactId || (!when.orderPlaced && !when.replied && !when.optedOut)) return null;
        const since = run.startedAt ?? run.createdAt;
        const contact = await this.prisma.channelContact.findUnique({ where: { id: run.contactId }, select: { optedOutAt: true, customerId: true } });
        if (when.optedOut && contact?.optedOutAt && contact.optedOutAt > since) return 'opted_out';
        if (when.replied && reason === 'timer') {
            // Not the replies this run's wait-for-reply steps took: those were what it waited for.
            const taken = ctx.replyEventIds?.length
                ? (await this.prisma.automationEvent.findMany({ where: { id: { in: ctx.replyEventIds } }, select: { messageId: true } })).flatMap((e) => (e.messageId ? [e.messageId] : []))
                : [];
            const wrote = await this.prisma.message.findFirst({
                where: {
                    contactId: run.contactId,
                    direction: MessageDirection.INBOUND,
                    imported: false,
                    createdAt: { gt: since },
                    ...(taken.length ? { id: { notIn: taken } } : {}),
                },
                select: { id: true },
            });
            if (wrote) return 'replied';
        }
        if (when.orderPlaced) {
            const event = run.eventId ? await this.prisma.automationEvent.findUnique({ where: { id: run.eventId }, select: { payload: true } }) : null;
            const raw = (event?.payload as { raw?: { checkoutId?: unknown; quietSince?: unknown } } | null)?.raw;
            const checkout = typeof raw?.checkoutId === 'string'
                ? await this.prisma.checkout.findUnique({ where: { id: raw.checkoutId }, select: { completedAt: true } })
                : null;
            if (checkout?.completedAt) return 'order_placed';
            // From when the checkout went quiet: an order placed through another checkout before the run began counts.
            const quiet = typeof raw?.quietSince === 'string' ? new Date(raw.quietSince) : null;
            const from = quiet && !Number.isNaN(quiet.getTime()) ? quiet : since;
            const customers = [...new Set([run.customerId, contact?.customerId].filter((c): c is string => !!c))];
            const ordered = customers.length
                ? await this.prisma.order.findFirst({
                    where: {
                        organizationId: run.organizationId,
                        customerId: { in: customers },
                        OR: [{ externalCreatedAt: { gt: from } }, { externalCreatedAt: null, createdAt: { gt: from } }],
                    },
                    select: { id: true },
                })
                : null;
            if (ordered) return 'order_placed';
        }
        return null;
    }

    /** A stopped run ends as completed, with why: nothing went wrong. */
    private async stop(run: LoadedRun, waiting: FlowStep, ctx: RunContext, reason: StopReason) {
        const now = new Date();
        // A held send never went out; a plain wait did finish.
        const held = ctx.hold?.stepId === waiting.id;
        delete ctx.hold;
        await this.prisma.automationRunStep.updateMany({
            where: { runId: run.id, stepKey: waiting.id, attempt: 1 },
            data: { status: held ? AutomationRunStatus.SKIPPED : AutomationRunStatus.COMPLETED, output: { stopped: reason }, finishedAt: now },
        });
        await this.prisma.automationRun.update({
            where: { id: run.id },
            data: { status: AutomationRunStatus.COMPLETED, completedAt: now, currentStepKey: null, skipReason: reason, context: ctx as unknown as Prisma.InputJsonValue },
        });
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

    private async state(run: LoadedRun, ctx: RunContext, env: RunEnv): Promise<StepState | null> {
        if (!run.contactId) return null;
        const contact = await this.prisma.channelContact.findUnique({ where: { id: run.contactId }, include: contactInclude });
        if (!contact) return null;
        const conversation = await this.prisma.conversation.findUnique({
            where: { channelId_contactId: { channelId: contact.channelId, contactId: contact.id } },
            select: { id: true, assignedUserId: true, platform: true, lastInboundAt: true },
        });
        const order = run.orderId
            ? await this.prisma.order.findUnique({ where: { id: run.orderId }, select: { paymentGateways: true, totalPrice: true, posSale: true, sourceName: true } })
            : null;
        const facts: RunFacts = {
            order: order ? { isCod: isCashOnDelivery(order.paymentGateways), total: Number(order.totalPrice), isPos: isPosOrder(order) } : null,
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
        // The run's own variables win: an event's or a step's value is about this run.
        return { run, ctx, env, contact, conversation, facts, vars: { ...env.vars, ...variablesFor(facts) } };
    }

    private async conversationId(s: StepState): Promise<string> {
        return s.conversation?.id ?? this.sender.conversationFor(s.contact.id);
    }

    private publish(s: StepState) {
        if (s.conversation) this.inboxEvents.publish(s.run.organizationId, { type: 'conversation.updated', conversationId: s.conversation.id });
    }

    private async recordStep(run: LoadedRun, step: FlowStep, outcome: Outcome, startedAt: Date) {
        const parked = outcome.kind === 'wait' || outcome.kind === 'hold';
        const status =
            outcome.kind === 'fail'
                ? AutomationRunStatus.FAILED
                : parked
                    ? AutomationRunStatus.WAITING
                    : outcome.kind === 'skip'
                        ? AutomationRunStatus.SKIPPED
                        : AutomationRunStatus.COMPLETED;
        const output = { ...(outcome.output ?? {}), ...(outcome.kind === 'branch' ? { branch: outcome.branch } : {}) };
        const data = {
            status,
            output: output as Prisma.InputJsonValue,
            messageId: outcome.kind === 'next' ? (outcome.messageId ?? null) : null,
            error: outcome.kind === 'fail' ? outcome.error.slice(0, 1000) : null,
            startedAt,
            finishedAt: parked ? null : new Date(),
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
                data: { lastError: `${STEP_NAME[step.type] ?? 'A step'}: ${error}`.slice(0, 500), lastErrorAt: now },
            }),
        ]);
    }
}
