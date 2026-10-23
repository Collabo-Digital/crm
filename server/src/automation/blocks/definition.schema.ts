import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface StepDef {
    id: string;
    type: string;
    config: Record<string, unknown>;
}

export interface Issue {
    stepId: string;
    code: string;
    title: string;
    body: string;
}

export interface IssueContext {
    /** Platform of the automation (INSTAGRAM | WHATSAPP). */
    platform: string | null;
    /**
     * Instagram media ids known for this channel, or null when the cache is
     * empty (the post picker is a later step; until it fills channel_media we
     * cannot tell a real post from a typo, so we do not raise post_not_found).
     */
    knownMediaIds: Set<string> | null;
}

const StepId = z.string().min(1).max(64);

const TriggerConfig = z.object({
    channel: z.enum(['instagram', 'whatsapp']),
    /** Only comment triggers are live in this cut. */
    event: z.literal('comment', {
        error: 'Only "comment" triggers are available yet.',
    }),
    post: z.string().max(64).default(''),
    match: z.enum(['contains', 'exact', 'any']).default('contains'),
    keyword: z.string().max(120).default(''),
});

const SendMessageConfig = z.object({
    channel: z.enum(['instagram', 'whatsapp']),
    message: z.string().max(4000).default(''),
    product: z.string().max(64).optional().default(''),
    link: z.string().max(500).optional().default(''),
    discount: z.string().max(64).optional().default(''),
    tracking: z.enum(['on', 'off']).optional().default('on'),
});

const SendInvoiceConfig = z.object({
    template: z.string().max(64).default('gst_invoice'),
    delivery: z.enum(['whatsapp']).default('whatsapp'),
});

const WaitConfig = z.object({
    amount: z.coerce.number().int().min(1).max(10_000),
    unit: z.enum(['minutes', 'hours', 'days']),
});

const BLOCK_SCHEMAS = {
    trigger: TriggerConfig,
    send_message: SendMessageConfig,
    send_invoice: SendInvoiceConfig,
    wait: WaitConfig,
} as const;

type BlockType = keyof typeof BLOCK_SCHEMAS;

const MAX_STEPS = 20;
const IG_MESSAGE_MAX_BYTES = 1000;
const DEFERRED_TYPES = new Set(['wait_reply', 'condition', 'split', 'update_contact', 'add_segment']);
const ALLOWED_VARIABLES = new Set(['first_name', 'product_name', 'order_number']);



// ─── Defaults ──────────────────────────────────────────────────────────────

export function defaultTriggerStep(platform: string | null): StepDef {
    return {
        id: newStepId(),
        type: 'trigger',
        config: {
            channel: platform === 'WHATSAPP' ? 'whatsapp' : 'instagram',
            event: 'comment',
            post: '',
            match: 'contains',
            keyword: '',
        },
    };
}

export function newStepId(): string {
    return 's_' + Math.random().toString(36).slice(2, 8);
}

// ─── Parse (runs on every save) ────────────────────────────────────────────

const RawStep = z.object({
    id: StepId,
    type: z.string(),
    config: z.record(z.string(), z.unknown()).default({}),
    branches: z.unknown().optional(),
}).strict();

const RawDefinition = z.object({
    steps: z.array(RawStep).min(1).max(MAX_STEPS),
}).strict();

/**
 * Shape validation: returns the normalised step list or throws a 400 that
 * names the offending step. A draft may be INCOMPLETE (empty keyword, no
 * post); completeness is the job of collectIssues at publish time.
 */
export function parseDefinition(input: unknown): StepDef[] {
    const parsed = RawDefinition.safeParse(input);
    if (!parsed.success) {
        throw new BadRequestException(`Invalid definition: ${firstZodMessage(parsed.error)}`);
    }

    const seen = new Set<string>();
    const steps: StepDef[] = [];

    parsed.data.steps.forEach((raw, index) => {
        if (seen.has(raw.id)) {
            throw new BadRequestException(`Duplicate step id "${raw.id}"`);
        }
        seen.add(raw.id);

        if (raw.branches !== undefined) {
            throw new BadRequestException(`Step "${raw.id}": branching blocks are not available yet`);
        }
        if (DEFERRED_TYPES.has(raw.type)) {
            throw new BadRequestException(`Step "${raw.id}": block "${raw.type}" is not available yet`);
        }
        const schema = BLOCK_SCHEMAS[raw.type as BlockType];
        if (!schema) {
            throw new BadRequestException(`Step "${raw.id}": unknown block type "${raw.type}"`);
        }
        if (raw.type === 'trigger' && index !== 0) {
            throw new BadRequestException(`Step "${raw.id}": the trigger must be the first step`);
        }
        if (index === 0 && raw.type !== 'trigger') {
            throw new BadRequestException('The first step must be the trigger');
        }

        const config = schema.safeParse(raw.config);
        if (!config.success) {
            throw new BadRequestException(`Step "${raw.id}": ${firstZodMessage(config.error)}`);
        }
        steps.push({ id: raw.id, type: raw.type, config: config.data as Record<string, unknown> });
    });

    return steps;
}

// ─── Issues (runs on publish and on GET /issues) ───────────────────────────

export function collectIssues(steps: StepDef[], ctx: IssueContext): Issue[] {
    const issues: Issue[] = [];
    const push = (stepId: string, code: string, title: string, body: string) =>
        issues.push({ stepId, code, title, body });

    const trigger = steps[0];
    const t = trigger.config as z.infer<typeof TriggerConfig>;

    if (!t.post) {
        push(trigger.id, 'post_missing', 'Select a post', 'Select an Instagram post or reel before publishing this automation.');
    } else if (ctx.knownMediaIds && !ctx.knownMediaIds.has(t.post)) {
        push(trigger.id, 'post_not_found', 'Post not found', 'This post is not on the connected Instagram account.');
    }
    if (t.match !== 'any' && !t.keyword.trim()) {
        push(trigger.id, 'keyword_missing', 'Keyword missing', 'Add the word a comment must contain.');
    }

    const actions = steps.slice(1);
    if (actions.length === 0) {
        push(trigger.id, 'no_action', 'Add at least one action', 'An automation needs a step after the trigger.');
    }

    let messageCount = 0;
    for (const step of actions) {
        if (step.type === 'send_message') {
            messageCount += 1;
            const c = step.config as z.infer<typeof SendMessageConfig>;
            if (!c.message.trim()) {
                push(step.id, 'message_missing', 'Message is incomplete', 'Add a message before continuing.');
            } else if (Buffer.byteLength(c.message, 'utf8') > IG_MESSAGE_MAX_BYTES) {
                push(step.id, 'message_too_long', 'Message too long', `Instagram messages must be under ${IG_MESSAGE_MAX_BYTES} bytes.`);
            }
            for (const v of unknownVariables(c.message)) {
                push(step.id, 'unknown_variable', 'Unknown variable', `{{${v}}} is not available. Use first_name, product_name or order_number.`);
            }
            if (c.product && !c.link) {
                push(step.id, 'link_missing', 'Product link missing', 'Add the link customers should tap to buy this product.');
            }
            if (messageCount === 2 && ctx.platform === 'INSTAGRAM') {
                push(step.id, 'second_message_needs_reply', 'A second Instagram message needs a reply first',
                    'Instagram allows one private reply per comment. A follow-up DM can only go out after the person replies, which needs the Wait for reply block.');
            }
        }
        if (step.type === 'send_invoice' && ctx.platform === 'INSTAGRAM') {
            push(step.id, 'invoice_needs_whatsapp', 'Invoice delivery needs WhatsApp', 'Invoices can only be sent on a WhatsApp automation.');
        }
        if (step.type === 'wait') {
            const c = step.config as z.infer<typeof WaitConfig>;
            const minutes = c.amount * (c.unit === 'days' ? 1440 : c.unit === 'hours' ? 60 : 1);
            if (minutes > 30 * 1440) {
                push(step.id, 'wait_too_long', 'Wait is too long', 'A wait step can be at most 30 days.');
            }
        }
    }

    return issues;
}

// ─── Helpers used by the service ───────────────────────────────────────────

/** "Price, PRICE  " → ["price"]; empty when match is "any". */
export function keywordsFor(trigger: StepDef): string[] {
    const c = trigger.config as z.infer<typeof TriggerConfig>;
    if (c.match === 'any') return [];
    return Array.from(
        new Set(
            c.keyword
                .split(',')
                .map((k) => k.trim().toLowerCase())
                .filter(Boolean),
        ),
    );
}

export function triggerTypeFor(trigger: StepDef): string {
    const c = trigger.config as z.infer<typeof TriggerConfig>;
    return `${c.channel}.${c.event}`; // "instagram.comment"
}

export function triggerPostFor(trigger: StepDef): string | null {
    const c = trigger.config as z.infer<typeof TriggerConfig>;
    return c.post || null;
}

export function triggerMatchFor(trigger: StepDef): string {
    return (trigger.config as z.infer<typeof TriggerConfig>).match;
}

/** Fresh ids for Duplicate so two automations never share a step key. */
export function reidSteps(steps: StepDef[]): StepDef[] {
    return steps.map((s) => ({ ...s, id: newStepId() }));
}


function unknownVariables(text: string): string[] {
    const out: string[] = [];
    for (const m of text.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)) {
        if (!ALLOWED_VARIABLES.has(m[1])) out.push(m[1]);
    }
    return out;
}

function firstZodMessage(err: z.ZodError): string {
    const i = err.issues[0];
    const path = i.path.length ? `${i.path.join('.')}: ` : '';
    return `${path}${i.message}`;
}