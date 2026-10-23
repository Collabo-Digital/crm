import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { Flow, toMinutes, variablesUsed } from '../engine/flow';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface StepDef {
    id: string;
    type: string;
    config: Record<string, unknown>;
    /** Condition: yes / no. Wait for reply: replied / timeout. */
    branches?: Record<string, StepDef[]>;
}

export interface Issue {
    stepId: string;
    code: string;
    title: string;
    body: string;
}

export interface IssueContext {
    /** Platform of the automation (INSTAGRAM | WHATSAPP | FACEBOOK). */
    platform: string | null;
    /**
     * Instagram media ids known for this channel, or null when the cache is
     * empty: until the post picker fills channel_media we cannot tell a real
     * post from a typo, so we do not raise post_not_found.
     */
    knownMediaIds: Set<string> | null;
    /**
     * The templates the steps chose, with the values a send needs. Absent
     * when not loaded (the test route): those checks are then skipped.
     */
    templates?: Map<string, { name: string; params: Array<{ key: string; name: string; kind: string }> }>;
    /** Whether the organization has its own Razorpay account connected. Absent when not loaded. */
    paymentsConnected?: boolean;
}

const StepId = z.string().min(1).max(64);
const Channel = z.enum(['instagram', 'whatsapp', 'facebook']);
const Unit = z.enum(['minutes', 'hours', 'days']);

const TriggerConfig = z.object({
    channel: Channel,
    /**
     * comment — on a post (Instagram, Facebook) · message — any message, or one
     * with a keyword · mention — an Instagram story mention · postback — an ice
     * breaker, menu item or button tap · tag_added — a contact got a tag ·
     * webhook — another system called this automation's URL · order_* — a
     * store order was placed, paid, shipped, delivered or cancelled ·
     * checkout_abandoned — a store checkout was left unfinished · cart — a
     * WhatsApp cart sent from the catalog · invoice_issued — a GST invoice was
     * issued for an order · payment_received — a payment link was paid.
     */
    event: z.enum([
        'comment', 'message', 'mention', 'postback', 'tag_added', 'webhook',
        'order_created', 'order_paid', 'order_fulfilled', 'order_delivered', 'order_cancelled', 'checkout_abandoned', 'cart',
        'invoice_issued', 'payment_received',
    ]),
    /** Comment: the post or reel id; empty for every post. */
    post: z.string().max(64).default(''),
    match: z.enum(['contains', 'exact', 'any']).default('contains'),
    /** Comment and message: comma-separated keywords. Postback: payloads. */
    keyword: z.string().max(500).default(''),
    /** Message: only the first message of a new or reopened conversation. */
    newConversationOnly: z.boolean().default(false),
    /** Tag added: which tag. */
    tag: z.string().max(60).default(''),
    /** Webhook: the secret part of the URL, issued on publish. */
    token: z.string().max(64).default(''),
    /** Webhook: the JSON field holding the person's phone number. */
    phoneField: z.string().max(60).default('phone'),
});

const MediaRef = z.object({
    storageKey: z.string().min(1).max(200),
    mime: z.string().min(1).max(100),
    kind: z.enum(['image', 'video', 'audio', 'document']),
    filename: z.string().max(200).optional(),
});

const SendMessageConfig = z.object({
    channel: Channel.optional(),
    kind: z.enum(['text', 'media', 'buttons', 'list', 'quick_replies', 'template']).default('text'),
    message: z.string().max(4096).default(''),
    /** Buttons, quick replies, or list rows. */
    options: z.array(z.string().max(24)).max(13).default([]),
    /** List: the button that opens it. */
    listButton: z.string().max(20).default('Choose'),
    media: MediaRef.optional(),
    /** Template: an approved template and a value for each of its parameters. */
    templateId: z.string().max(40).optional(),
    templateValues: z.record(z.string(), z.string().max(1024)).default({}),
    // Kept from the first builder; the product card arrives with commerce.
    product: z.string().max(64).optional().default(''),
    link: z.string().max(500).optional().default(''),
    discount: z.string().max(64).optional().default(''),
    tracking: z.enum(['on', 'off']).optional().default('on'),
});

const ReplyCommentConfig = z.object({
    /** private — a DM to the commenter (once per comment) · public — a reply under the comment. */
    mode: z.enum(['private', 'public']).default('private'),
    message: z.string().max(2000).default(''),
});

const StoreActionConfig = z.object({
    /**
     * tag_order / note_order / cancel_order — the order the trigger is about ·
     * tag_customer — the contact's store customer · create_draft_order — a
     * draft order from the cart, with Shopify's checkout link as {{draft.checkout_url}}.
     */
    action: z.enum(['tag_order', 'note_order', 'cancel_order', 'tag_customer', 'create_draft_order']).default('tag_order'),
    value: z.string().max(500).default(''),
});

/** The order's GST invoice as a PDF, in the document header of an approved WhatsApp template. */
const SendInvoiceConfig = z.object({
    templateId: z.string().max(64).optional(),
    templateValues: z.record(z.string(), z.string().max(1024)).default({}),
});

/**
 * A payment link from the organization's own Razorpay account, for the order
 * the trigger is about or the draft an earlier step made from a cart, sent as
 * a template (whose URL button is https://rzp.io/{{1}}) or as text.
 */
const SendPaymentLinkConfig = z.object({
    kind: z.enum(['template', 'text']).default('template'),
    message: z.string().max(4096).default(''),
    templateId: z.string().max(64).optional(),
    templateValues: z.record(z.string(), z.string().max(1024)).default({}),
    expiresInHours: z.coerce.number().int().min(1).max(720).default(48),
    /** Added to the order once it is paid, e.g. "cod-to-prepaid". */
    tagOnPaid: z.string().max(60).default(''),
});

const WaitConfig = z.object({
    amount: z.coerce.number().int().min(1).max(10_000),
    unit: Unit,
});

const WaitForReplyConfig = z.object({
    /** Give up after this long and take the timeout branch. */
    amount: z.coerce.number().int().min(1).max(10_000).default(24),
    unit: Unit.default('hours'),
    /** Keep the reply as this attribute on the contact. */
    saveAs: z.string().regex(/^[a-z0-9_]{0,40}$/).default(''),
});

const ConditionRule = z.object({
    field: z.enum(['last_reply', 'trigger_text', 'tag', 'attribute', 'consent', 'customer', 'orders_count', 'window', 'assigned', 'order_payment', 'order_total']),
    op: z.enum(['contains', 'equals', 'is_any_of', 'has', 'not_has', 'exists', 'not_exists', 'gte', 'lte', 'is', 'is_not']),
    /** The attribute name, for `attribute`. */
    key: z.string().max(60).default(''),
    value: z.string().max(500).default(''),
});

const ConditionConfig = z.object({
    match: z.enum(['all', 'any']).default('all'),
    rules: z.array(ConditionRule).max(10).default([]),
});

const TagsConfig = z.object({ tags: z.array(z.string().min(1).max(60)).max(10).default([]) });

const SetAttributeConfig = z.object({
    key: z.string().regex(/^[a-z0-9_]{0,40}$/).default(''),
    value: z.string().max(500).default(''),
});

const AssignConfig = z.object({
    mode: z.enum(['user', 'team', 'round_robin', 'unassign']).default('round_robin'),
    userId: z.string().max(40).default(''),
    teamId: z.string().max(40).default(''),
});

const SetStatusConfig = z.object({
    status: z.enum(['open', 'closed', 'snoozed']).default('closed'),
    hours: z.coerce.number().int().min(1).max(720).default(24),
});

const AddNoteConfig = z.object({ text: z.string().max(2000).default('') });

const HttpRequestConfig = z.object({
    method: z.enum(['GET', 'POST']).default('POST'),
    url: z.string().max(1000).default(''),
    /** JSON body, with {{variables}}. */
    body: z.string().max(5000).default(''),
    /** Keep the response's JSON as {{saveAs.field}} variables. */
    saveAs: z.string().regex(/^[a-z0-9_]{0,40}$/).default(''),
});

const BLOCK_SCHEMAS = {
    trigger: TriggerConfig,
    send_message: SendMessageConfig,
    reply_comment: ReplyCommentConfig,
    send_invoice: SendInvoiceConfig,
    send_payment_link: SendPaymentLinkConfig,
    wait: WaitConfig,
    wait_for_reply: WaitForReplyConfig,
    condition: ConditionConfig,
    add_tag: TagsConfig,
    remove_tag: TagsConfig,
    set_attribute: SetAttributeConfig,
    assign: AssignConfig,
    set_status: SetStatusConfig,
    add_note: AddNoteConfig,
    http_request: HttpRequestConfig,
    store_action: StoreActionConfig,
} as const;

/** Each branching block and the branches it has. */
export const BRANCHES: Partial<Record<keyof typeof BLOCK_SCHEMAS, readonly string[]>> = {
    condition: ['yes', 'no'],
    wait_for_reply: ['replied', 'timeout'],
};

export type BlockType = keyof typeof BLOCK_SCHEMAS;
export type TriggerConfigT = z.infer<typeof TriggerConfig>;
export type SendMessageConfigT = z.infer<typeof SendMessageConfig>;
export type ConditionRuleT = z.infer<typeof ConditionRule>;

const MAX_STEPS = 40;
const MAX_DEPTH = 4;
const IG_MESSAGE_MAX_BYTES = 1000;
/** Variables every run has. `attr.<key>` and saved values are allowed on top. */
export const BASE_VARIABLES = new Set(['first_name', 'name', 'phone', 'username', 'trigger_text', 'last_reply', 'product_name', 'order_number', 'link', 'discount']);

// ─── Defaults ──────────────────────────────────────────────────────────────

export function defaultTriggerStep(platform: string | null): StepDef {
    const channel = platform === 'WHATSAPP' ? 'whatsapp' : platform === 'FACEBOOK' ? 'facebook' : 'instagram';
    return {
        id: newStepId(),
        type: 'trigger',
        config: TriggerConfig.parse({ channel, event: channel === 'whatsapp' ? 'message' : 'comment' }),
    };
}

export function newStepId(): string {
    return 's_' + Math.random().toString(36).slice(2, 8);
}

// ─── Parse (runs on every save) ────────────────────────────────────────────

interface RawStepT {
    id: string;
    type: string;
    config: Record<string, unknown>;
    branches?: Record<string, RawStepT[]>;
}

const RawStep: z.ZodType<RawStepT> = z.lazy(() =>
    z
        .object({
            id: StepId,
            type: z.string(),
            config: z.record(z.string(), z.unknown()).default({}),
            branches: z.record(z.string(), z.array(RawStep)).optional(),
        })
        .strict(),
);

const RawDefinition = z.object({ steps: z.array(RawStep).min(1).max(MAX_STEPS) }).strict();

/**
 * Shape validation: returns the normalised step tree or throws a 400 that
 * names the offending step. A draft may be INCOMPLETE (an empty keyword, no
 * message yet); completeness is collectIssues' job at publish time.
 */
export function parseDefinition(input: unknown): StepDef[] {
    const parsed = RawDefinition.safeParse(input);
    if (!parsed.success) throw new BadRequestException(`Invalid definition: ${firstZodMessage(parsed.error)}`);

    const seen = new Set<string>();
    let count = 0;
    const parseList = (list: RawStepT[], depth: number, top: boolean): StepDef[] =>
        list.map((raw, index) => {
            if (++count > MAX_STEPS) throw new BadRequestException(`An automation can have at most ${MAX_STEPS} steps`);
            if (seen.has(raw.id)) throw new BadRequestException(`Duplicate step id "${raw.id}"`);
            seen.add(raw.id);
            const schema = BLOCK_SCHEMAS[raw.type as BlockType];
            if (!schema) throw new BadRequestException(`Step "${raw.id}": unknown block type "${raw.type}"`);
            if (raw.type === 'trigger' && !(top && index === 0)) throw new BadRequestException(`Step "${raw.id}": the trigger must be the first step`);
            if (top && index === 0 && raw.type !== 'trigger') throw new BadRequestException('The first step must be the trigger');

            const config = schema.safeParse(raw.config);
            if (!config.success) throw new BadRequestException(`Step "${raw.id}": ${firstZodMessage(config.error)}`);

            const allowed = BRANCHES[raw.type as BlockType];
            if (raw.branches && !allowed) throw new BadRequestException(`Step "${raw.id}": a ${raw.type} block has no branches`);
            let branches: Record<string, StepDef[]> | undefined;
            if (allowed) {
                if (depth >= MAX_DEPTH) throw new BadRequestException(`Step "${raw.id}": branches can nest at most ${MAX_DEPTH} deep`);
                branches = {};
                for (const name of allowed) branches[name] = parseList(raw.branches?.[name] ?? [], depth + 1, false);
                const extra = Object.keys(raw.branches ?? {}).find((k) => !allowed.includes(k));
                if (extra) throw new BadRequestException(`Step "${raw.id}": unknown branch "${extra}"`);
            }
            return { id: raw.id, type: raw.type, config: config.data as Record<string, unknown>, ...(branches ? { branches } : {}) };
        });

    return parseList(parsed.data.steps, 0, true);
}

// ─── Issues (publish, and GET /issues) ─────────────────────────────────────

/** What a trigger can listen to on each channel. */
const ORDER_EVENTS = ['order_created', 'order_paid', 'order_fulfilled', 'order_delivered', 'order_cancelled'];
/** Events about one order: its actions and its invoice are available. A paid link is about its order, when it had one. */
const ORDER_CONTEXT = [...ORDER_EVENTS, 'invoice_issued', 'payment_received'];
/** Store events reach people who may not have written in 24 hours: WhatsApp templates only. */
const STORE_EVENTS = [...ORDER_CONTEXT, 'checkout_abandoned'];
const EVENTS_BY_CHANNEL: Record<z.infer<typeof Channel>, string[]> = {
    instagram: ['comment', 'message', 'mention', 'postback', 'tag_added', 'webhook'],
    facebook: ['comment', 'message', 'postback', 'tag_added', 'webhook'],
    whatsapp: ['message', 'tag_added', 'webhook', ...STORE_EVENTS, 'cart'],
};

export function collectIssues(steps: StepDef[], ctx: IssueContext): Issue[] {
    const issues: Issue[] = [];
    const push = (stepId: string, code: string, title: string, body: string) => issues.push({ stepId, code, title, body });
    const flow = new Flow(steps);
    const trigger = steps[0];
    const t = trigger.config as TriggerConfigT;
    // Platform names (INSTAGRAM, WHATSAPP, FACEBOOK) are the trigger channels in upper case.
    const platformChannel = ctx.platform?.toLowerCase() ?? null;

    if (platformChannel && t.channel !== platformChannel) {
        push(trigger.id, 'channel_mismatch', 'Trigger on another channel', `This automation runs on ${ctx.platform?.toLowerCase()}; set the trigger to the same channel.`);
    }
    if (!EVENTS_BY_CHANNEL[t.channel].includes(t.event)) {
        push(trigger.id, 'event_unavailable', 'Not available on this channel', `${t.channel === 'whatsapp' ? 'WhatsApp' : t.channel} has no ${t.event.replace('_', ' ')} trigger.`);
    }
    if (t.event === 'comment' && t.post && ctx.knownMediaIds && !ctx.knownMediaIds.has(t.post)) {
        push(trigger.id, 'post_not_found', 'Post not found', 'This post is not on the connected account. Pick it again or choose every post.');
    }
    if ((t.event === 'comment' || t.event === 'message') && t.match !== 'any' && !t.keyword.trim()) {
        push(trigger.id, 'keyword_missing', 'Keyword missing', 'Add the words to listen for, or choose any message.');
    }
    if (t.event === 'postback' && t.match !== 'any' && !t.keyword.trim()) {
        push(trigger.id, 'payload_missing', 'Button missing', 'Choose which ice breaker, menu item or button starts this, or choose any.');
    }
    if (t.event === 'tag_added' && !t.tag.trim()) push(trigger.id, 'tag_missing', 'Tag missing', 'Choose the tag that starts this automation.');

    const actions = flow.all().filter((s) => s.step.type !== 'trigger');
    if (actions.length === 0) push(trigger.id, 'no_action', 'Add at least one action', 'An automation needs a step after the trigger.');

    // Variables a step may use: the base set, contact attributes, and what earlier steps saved.
    const saved = new Set<string>();
    // A webhook's JSON fields arrive as {{webhook.<field>}}; store events bring their order or checkout.
    if (t.event === 'webhook') saved.add('webhook');
    if (ORDER_CONTEXT.includes(t.event)) saved.add('order');
    // {{invoice.*}} comes with the invoice event, and "Send the invoice" fills it on order events.
    if (ORDER_CONTEXT.includes(t.event)) saved.add('invoice');
    if (t.event === 'checkout_abandoned') saved.add('checkout');
    if (t.event === 'payment_received') saved.add('payment');
    let privateReplies = 0;
    for (const { step, path } of actions) {
        const c = step.config;
        const insideReply = path.some((p) => p === 'wait_for_reply:replied');
        const checkText = (text: string) => {
            for (const v of variablesUsed(text)) {
                const root = v.split('.')[0];
                if (!BASE_VARIABLES.has(v) && root !== 'attr' && !saved.has(root) && !saved.has(v)) {
                    push(step.id, 'unknown_variable', 'Unknown variable', `{{${v}}} is not available here. Use first_name, name, phone, last_reply, attr.<field> or a value saved by an earlier step.`);
                }
            }
        };

        switch (step.type) {
            case 'send_message': {
                const m = c as SendMessageConfigT;
                const channel = m.channel ?? t.channel;
                if (m.kind === 'template') {
                    if (channel !== 'whatsapp') push(step.id, 'template_needs_whatsapp', 'Templates are WhatsApp only', 'Send a text or buttons on this channel instead.');
                    if (!m.templateId) push(step.id, 'template_missing', 'Choose a template', 'Pick an approved WhatsApp template.');
                    // Every value the chosen template needs, or each run would stop at this step.
                    const chosen = m.templateId ? ctx.templates?.get(m.templateId) : undefined;
                    if (m.templateId && ctx.templates && !chosen) push(step.id, 'template_not_found', 'Template not found', 'The chosen template was deleted. Pick another one.');
                    for (const p of chosen?.params ?? []) {
                        if (p.kind === 'location') {
                            push(step.id, 'template_header_unsupported', 'Location headers are not supported', `Pick a template without a location header instead of “${chosen!.name}”.`);
                        } else if (p.kind !== 'text' && p.kind !== 'coupon_code') {
                            if (!m.media) push(step.id, 'template_media_missing', 'Add the header file', `“${chosen!.name}” needs a header image, video or document.`);
                        } else if (!(m.templateValues[p.key] ?? '').trim()) {
                            push(step.id, 'template_value_missing', 'Fill in the template', `“${p.name}” in “${chosen!.name}” has no value.`);
                        }
                    }
                    Object.values(m.templateValues).forEach(checkText);
                    break;
                }
                if (m.kind === 'media' && !m.media) push(step.id, 'media_missing', 'Add the file', 'Upload the image, video, audio or document to send.');
                if (m.kind !== 'media' && !m.message.trim()) push(step.id, 'message_missing', 'Message is incomplete', 'Write the message before publishing.');
                if ((m.kind === 'buttons' || m.kind === 'list' || m.kind === 'quick_replies') && m.options.filter((o) => o.trim()).length === 0) {
                    push(step.id, 'options_missing', 'Add the options', 'Add at least one button or option.');
                }
                if (m.kind === 'buttons' && m.options.length > 3) push(step.id, 'too_many_buttons', 'Too many buttons', 'Use at most three buttons; use a list for more choices.');
                if (m.kind === 'buttons' && m.options.some((o) => o.length > 20)) push(step.id, 'button_too_long', 'Button too long', 'Button labels are at most 20 characters.');
                if (m.kind === 'list' && channel !== 'whatsapp') push(step.id, 'list_needs_whatsapp', 'Lists are WhatsApp only', 'Use quick replies on Instagram and Messenger.');
                if (m.kind === 'quick_replies' && channel === 'whatsapp') push(step.id, 'quick_replies_not_whatsapp', 'Use buttons on WhatsApp', 'WhatsApp has reply buttons (up to 3) or lists instead of quick replies.');
                if (channel === 'instagram' && Buffer.byteLength(m.message, 'utf8') > IG_MESSAGE_MAX_BYTES) {
                    push(step.id, 'message_too_long', 'Message too long', `Instagram messages must be under ${IG_MESSAGE_MAX_BYTES} bytes.`);
                }
                if (m.product && !m.link) push(step.id, 'link_missing', 'Product link missing', 'Add the link customers should tap to buy this product.');
                if (STORE_EVENTS.includes(t.event) && channel === 'whatsapp' && !insideReply) {
                    push(step.id, 'template_needed', 'Use an approved template',
                        'A store message may reach someone who has not written in 24 hours, and WhatsApp then accepts templates only. Send a template, or put this after “Wait for a reply”.');
                }
                if (t.event === 'comment' && channel !== 'whatsapp' && !insideReply) {
                    push(step.id, 'needs_reply_first', 'Send a private reply first',
                        'Someone who only commented has not messaged you yet. Reply privately to the comment, then wait for their reply before sending more.');
                }
                checkText(m.message);
                break;
            }
            case 'reply_comment': {
                const r = c as z.infer<typeof ReplyCommentConfig>;
                if (t.event !== 'comment') push(step.id, 'reply_needs_comment', 'Only for comments', 'Comment replies work when the trigger is a comment.');
                if (!r.message.trim()) push(step.id, 'message_missing', 'Reply is incomplete', 'Write the reply before publishing.');
                if (r.mode === 'private' && ++privateReplies > 1) {
                    push(step.id, 'one_private_reply', 'One private reply per comment', 'Meta allows a single private reply to each comment.');
                }
                checkText(r.message);
                break;
            }
            case 'send_invoice': {
                const v = c as z.infer<typeof SendInvoiceConfig>;
                if (t.channel !== 'whatsapp') push(step.id, 'invoice_needs_whatsapp', 'Invoices go on WhatsApp', 'Use a WhatsApp automation to send invoices.');
                if (!ORDER_CONTEXT.includes(t.event)) push(step.id, 'invoice_needs_order', 'Needs an order', 'Sending the invoice works when the trigger is an order or invoice event.');
                if (!v.templateId) push(step.id, 'template_missing', 'Choose a template', 'Pick an approved WhatsApp template with a document header.');
                const chosen = v.templateId ? ctx.templates?.get(v.templateId) : undefined;
                if (v.templateId && ctx.templates && !chosen) push(step.id, 'template_not_found', 'Template not found', 'The chosen template was deleted. Pick another one.');
                if (chosen && !chosen.params.some((p) => p.key === 'header' && p.kind === 'document')) {
                    push(step.id, 'template_needs_document', 'Template needs a document header', `“${chosen.name}” has no document header for the invoice PDF. Pick a template that has one.`);
                }
                for (const p of chosen?.params ?? []) {
                    if (p.key !== 'header' && (p.kind === 'text' || p.kind === 'coupon_code') && !(v.templateValues[p.key] ?? '').trim()) {
                        push(step.id, 'template_value_missing', 'Fill in the template', `“${p.name}” in “${chosen!.name}” has no value.`);
                    }
                }
                Object.values(v.templateValues).forEach(checkText);
                break;
            }
            case 'send_payment_link': {
                const v = c as z.infer<typeof SendPaymentLinkConfig>;
                // {{payment.*}} is this step's own link, so its message may use it.
                saved.add('payment');
                if (t.channel !== 'whatsapp') push(step.id, 'payment_needs_whatsapp', 'Payment links go on WhatsApp', 'Use a WhatsApp automation to send payment links.');
                if (!ORDER_CONTEXT.includes(t.event) && !saved.has('draft')) {
                    push(step.id, 'payment_needs_order', 'Needs an order', 'A payment link is for the order the trigger is about, or the draft order an earlier “Create draft order” step made from a cart.');
                }
                if (t.event === 'payment_received') push(step.id, 'payment_already_paid', 'Already paid', 'This automation starts when a payment is made; there is nothing left to collect.');
                if (ctx.paymentsConnected === false) push(step.id, 'payments_not_connected', 'Connect Razorpay', 'Connect your Razorpay account in Settings → Orders → Payments first, so customers pay you directly.');
                const usesLink = (text: string) => /\{\{\s*payment\.link(_path)?\s*\}\}/.test(text);
                if (v.kind === 'template') {
                    if (!v.templateId) push(step.id, 'template_missing', 'Choose a template', 'Pick an approved WhatsApp template.');
                    const chosen = v.templateId ? ctx.templates?.get(v.templateId) : undefined;
                    if (v.templateId && ctx.templates && !chosen) push(step.id, 'template_not_found', 'Template not found', 'The chosen template was deleted. Pick another one.');
                    for (const p of chosen?.params ?? []) {
                        if (p.kind !== 'text' && p.kind !== 'coupon_code') {
                            push(step.id, 'template_header_unsupported', 'Pick a template without a media header', `“${chosen!.name}” needs a header file, which this step does not send.`);
                        } else if (!(v.templateValues[p.key] ?? '').trim()) {
                            push(step.id, 'template_value_missing', 'Fill in the template', `“${p.name}” in “${chosen!.name}” has no value.`);
                        }
                    }
                    if (chosen && !Object.values(v.templateValues).some(usesLink)) {
                        push(step.id, 'payment_link_unused', 'The link is not in the message', 'Put {{payment.link_path}} in the button of a template whose button URL is https://rzp.io/{{1}}, or {{payment.link}} in its text.');
                    }
                    Object.values(v.templateValues).forEach(checkText);
                } else {
                    if (!v.message.trim()) push(step.id, 'message_missing', 'Message is incomplete', 'Write the message before publishing.');
                    else if (!usesLink(v.message)) push(step.id, 'payment_link_unused', 'The link is not in the message', 'Put {{payment.link}} where the link should go.');
                    if (STORE_EVENTS.includes(t.event) && !insideReply) {
                        push(step.id, 'template_needed', 'Use an approved template',
                            'A store message may reach someone who has not written in 24 hours, and WhatsApp then accepts templates only. Send a template, or put this after “Wait for a reply”.');
                    }
                    checkText(v.message);
                }
                break;
            }
            case 'wait': {
                const w = c as z.infer<typeof WaitConfig>;
                if (toMinutes(w.amount, w.unit) > 30 * 1440) push(step.id, 'wait_too_long', 'Wait is too long', 'A wait step can be at most 30 days.');
                break;
            }
            case 'wait_for_reply': {
                const w = c as z.infer<typeof WaitForReplyConfig>;
                if (toMinutes(w.amount, w.unit) > 7 * 1440) push(step.id, 'wait_too_long', 'Wait is too long', 'Wait for a reply at most 7 days.');
                if (w.saveAs) saved.add(`attr.${w.saveAs}`);
                break;
            }
            case 'condition': {
                const k = c as z.infer<typeof ConditionConfig>;
                if (k.rules.length === 0) push(step.id, 'rules_missing', 'Add a rule', 'A condition needs at least one rule.');
                if (k.rules.some((r) => r.field === 'attribute' && !r.key)) push(step.id, 'attribute_missing', 'Attribute missing', 'Name the attribute the rule checks.');
                break;
            }
            case 'add_tag':
            case 'remove_tag':
                if ((c as z.infer<typeof TagsConfig>).tags.length === 0) push(step.id, 'tags_missing', 'Choose tags', 'Add at least one tag.');
                break;
            case 'set_attribute': {
                const s = c as z.infer<typeof SetAttributeConfig>;
                if (!s.key) push(step.id, 'attribute_missing', 'Attribute missing', 'Name the attribute to save.');
                checkText(s.value);
                if (s.key) saved.add(`attr.${s.key}`);
                break;
            }
            case 'assign': {
                const a = c as z.infer<typeof AssignConfig>;
                if (a.mode === 'user' && !a.userId) push(step.id, 'assignee_missing', 'Choose who', 'Pick the team member to assign.');
                if (a.mode === 'team' && !a.teamId) push(step.id, 'team_missing', 'Choose a team', 'Pick the team to queue the conversation for.');
                break;
            }
            case 'add_note':
                if (!(c as z.infer<typeof AddNoteConfig>).text.trim()) push(step.id, 'note_missing', 'Note is empty', 'Write the note.');
                checkText((c as z.infer<typeof AddNoteConfig>).text);
                break;
            case 'store_action': {
                const a = c as z.infer<typeof StoreActionConfig>;
                if (t.channel !== 'whatsapp') push(step.id, 'store_needs_whatsapp', 'Store actions are WhatsApp only', 'Use a WhatsApp automation to work with orders and customers.');
                if (['tag_order', 'note_order', 'cancel_order'].includes(a.action) && !ORDER_CONTEXT.includes(t.event)) {
                    push(step.id, 'needs_order', 'Needs an order', 'Order actions work when the trigger is an order event.');
                }
                if (a.action === 'create_draft_order' && t.event !== 'cart') {
                    push(step.id, 'needs_cart', 'Needs a cart', 'A draft order is made from a cart: use the “sends a cart” trigger.');
                }
                if (['tag_order', 'tag_customer', 'note_order'].includes(a.action) && !a.value.trim()) {
                    push(step.id, 'value_missing', a.action === 'note_order' ? 'Note is empty' : 'Tag missing', a.action === 'note_order' ? 'Write the note.' : 'Name the tag.');
                }
                checkText(a.value);
                if (a.action === 'create_draft_order') saved.add('draft');
                break;
            }
            case 'http_request': {
                const h = c as z.infer<typeof HttpRequestConfig>;
                if (!/^https?:\/\//i.test(h.url)) push(step.id, 'url_missing', 'Add the URL', 'Requests go to a full https:// address.');
                checkText(h.url);
                checkText(h.body);
                if (h.saveAs) saved.add(h.saveAs);
                break;
            }
        }
    }
    return issues;
}

// ─── Helpers used by the service ───────────────────────────────────────────

/** "Price, PRICE  " → ["price"]; empty when match is "any". Postback payloads keep their case. */
export function keywordsFor(trigger: StepDef): string[] {
    const c = trigger.config as TriggerConfigT;
    if (c.event === 'tag_added') return c.tag ? [c.tag] : [];
    if (c.match === 'any' || (c.event !== 'comment' && c.event !== 'message' && c.event !== 'postback')) return [];
    const parts = c.keyword.split(',').map((k) => k.trim()).filter(Boolean);
    return [...new Set(c.event === 'postback' ? parts : parts.map((k) => k.toLowerCase()))];
}

/** The event type the trigger row matches: "instagram.comment", "crm.contact.tag_added"… */
export function triggerTypeFor(trigger: StepDef): string {
    const c = trigger.config as TriggerConfigT;
    if (c.event === 'tag_added') return 'crm.contact.tag_added';
    if (c.event === 'webhook') return 'crm.webhook';
    if (c.event.startsWith('order_')) return `crm.order.${c.event.slice('order_'.length)}`;
    if (c.event === 'checkout_abandoned') return 'crm.checkout.abandoned';
    if (c.event === 'invoice_issued') return 'crm.invoice.issued';
    if (c.event === 'payment_received') return 'crm.payment.received';
    if (c.event === 'cart') return 'whatsapp.cart';
    if (c.event === 'mention') return 'instagram.mention';
    return `${c.channel}.${c.event}`;
}

/** The trigger row's subject: the post for comments, the token for webhooks. */
export function triggerPostFor(trigger: StepDef): string | null {
    const c = trigger.config as TriggerConfigT;
    if (c.event === 'webhook') return c.token || null;
    if (c.event === 'comment') return c.post || null;
    return null;
}

/** What the matcher needs beyond keywords, stored as AutomationTrigger.config. */
export function triggerConfigFor(trigger: StepDef): { match: string; newConversationOnly: boolean; phoneField: string } {
    const c = trigger.config as TriggerConfigT;
    return { match: c.match, newConversationOnly: c.newConversationOnly, phoneField: c.phoneField };
}

/** Fresh ids for Duplicate so two automations never share a step key. Recurses into branches. */
export function reidSteps(steps: StepDef[]): StepDef[] {
    return steps.map((s) => ({
        ...s,
        id: newStepId(),
        // A copied webhook trigger gets its own URL on publish.
        ...(s.type === 'trigger' ? { config: { ...s.config, token: '' } } : {}),
        ...(s.branches ? { branches: Object.fromEntries(Object.entries(s.branches).map(([k, list]) => [k, reidSteps(list)])) } : {}),
    }));
}

function firstZodMessage(err: z.ZodError): string {
    const i = err.issues[0];
    const path = i.path.length ? `${i.path.join('.')}: ` : '';
    return `${path}${i.message}`;
}
