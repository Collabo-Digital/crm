import type { ConditionRuleT } from '../blocks/definition.schema';
import { FlowVariables, keywordMatches } from './flow';

/**
 * What a run carries between steps, stored as AutomationRun.context. `vars`
 * are the {{variables}} the trigger and earlier steps produced; contact
 * fields are read fresh at each step instead, so a tag or attribute set
 * by a step is seen by the next one.
 */
export interface RunContext {
    vars: Record<string, string>;
    trigger: {
        eventType: string;
        /** The comment the run started from, for comment replies. */
        commentId: string | null;
        postId: string | null;
    };
    /** How many tag_added hops led to this run. */
    depth: number;
    /** Set when a reply arrived for a wait-for-reply step; the runner takes the replied branch. */
    replied?: boolean;
    /** The event of the last reply this run took, so a retried event never gives it to a second run. */
    replyEventId?: string;
    /** A WhatsApp cart: catalog item ids (our variant ids) and quantities. */
    cart?: Array<{ retailerId: string; quantity: number; price: number | null; currency: string | null }>;
}

export function parseRunContext(raw: unknown): RunContext {
    const c = (raw ?? {}) as Partial<RunContext>;
    return {
        vars: { ...(c.vars ?? {}) },
        trigger: { eventType: c.trigger?.eventType ?? '', commentId: c.trigger?.commentId ?? null, postId: c.trigger?.postId ?? null },
        depth: c.depth ?? 0,
        ...(c.replied ? { replied: true } : {}),
        ...(c.replyEventId ? { replyEventId: c.replyEventId } : {}),
        ...(c.cart ? { cart: c.cart } : {}),
    };
}

/** The facts conditions and messages read, gathered fresh for each step. */
export interface RunFacts {
    contact: {
        name: string | null;
        username: string | null;
        phone: string | null;
        tags: string[];
        attributes: Record<string, unknown>;
        optedIn: boolean;
        optedOut: boolean;
    };
    customer: { firstName: string | null; lastName: string | null; ordersCount: number; tags: string[] } | null;
    conversation: { assignedUserId: string | null; windowOpen: boolean } | null;
    /** The order a store event is about. */
    order?: { isCod: boolean; total: number } | null;
    context: RunContext;
}

const text = (v: unknown): string | null =>
    typeof v === 'string' ? v.trim() || null : typeof v === 'number' || typeof v === 'boolean' ? String(v) : null;

/** Every {{variable}} a message in this run can use. */
export function variablesFor(facts: RunFacts): FlowVariables {
    const { contact, customer } = facts;
    const displayName = contact.name?.replace(/^@/, '') ?? null;
    const firstWord = displayName?.split(/\s+/)[0] ?? null;
    const vars: FlowVariables = {
        first_name: text(customer?.firstName) ?? (firstWord && /\p{L}/u.test(firstWord) ? firstWord : null),
        name: text([customer?.firstName, customer?.lastName].filter(Boolean).join(' ')) ?? displayName,
        phone: contact.phone,
        username: contact.username,
    };
    for (const [key, value] of Object.entries(contact.attributes)) vars[`attr.${key}`] = text(value);
    return { ...vars, ...facts.context.vars };
}

const norm = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const list = (value: string) => value.split(',').map((v) => v.trim()).filter(Boolean);

function compareText(actual: string | null, op: ConditionRuleT['op'], value: string): boolean {
    switch (op) {
        case 'exists':
            return !!actual;
        case 'not_exists':
            return !actual;
        case 'contains':
            return keywordMatches(actual, list(value), 'contains');
        case 'equals':
        case 'is_any_of':
        case 'is':
            return !!actual && list(value).some((v) => norm(v) === norm(actual));
        case 'is_not':
            return !actual || !list(value).some((v) => norm(v) === norm(actual));
        case 'gte':
        case 'lte': {
            const a = Number(actual);
            const b = Number(value);
            if (!actual || Number.isNaN(a) || Number.isNaN(b)) return false;
            return op === 'gte' ? a >= b : a <= b;
        }
        default:
            return false;
    }
}

/** One condition rule against the run's facts. */
export function ruleMatches(rule: ConditionRuleT, facts: RunFacts): boolean {
    const vars = facts.context.vars;
    switch (rule.field) {
        case 'last_reply':
            return compareText(vars.last_reply ?? null, rule.op, rule.value);
        case 'trigger_text':
            return compareText(vars.trigger_text ?? null, rule.op, rule.value);
        case 'tag': {
            const has = facts.contact.tags.some((t) => norm(t) === norm(rule.value));
            return rule.op === 'not_has' || rule.op === 'is_not' ? !has : has;
        }
        case 'attribute':
            return compareText(text(facts.contact.attributes[rule.key]), rule.op, rule.value);
        case 'consent': {
            const state = facts.contact.optedOut ? 'opted_out' : facts.contact.optedIn ? 'opted_in' : 'unknown';
            return rule.op === 'is_not' ? state !== rule.value : state === rule.value;
        }
        case 'customer':
            return rule.op === 'not_exists' ? !facts.customer : !!facts.customer;
        case 'orders_count':
            return compareText(String(facts.customer?.ordersCount ?? 0), rule.op === 'equals' ? 'is' : rule.op, rule.value);
        case 'window': {
            const open = !!facts.conversation?.windowOpen;
            const wanted = rule.value !== 'closed';
            return rule.op === 'is_not' ? open !== wanted : open === wanted;
        }
        case 'order_payment': {
            if (!facts.order) return false;
            const kind = facts.order.isCod ? 'cod' : 'prepaid';
            return rule.op === 'is_not' ? kind !== rule.value : kind === rule.value;
        }
        case 'order_total':
            return facts.order ? compareText(String(facts.order.total), rule.op, rule.value) : false;
        case 'assigned': {
            const assignee = facts.conversation?.assignedUserId ?? null;
            if (rule.op === 'exists') return !!assignee;
            if (rule.op === 'not_exists') return !assignee;
            return rule.op === 'is_not' ? assignee !== rule.value : assignee === rule.value;
        }
        default:
            return false;
    }
}

export function conditionMatches(config: { match: 'all' | 'any'; rules: ConditionRuleT[] }, facts: RunFacts): boolean {
    if (config.rules.length === 0) return false;
    return config.match === 'any' ? config.rules.some((r) => ruleMatches(r, facts)) : config.rules.every((r) => ruleMatches(r, facts));
}

/**
 * A JSON response kept as {{saveAs.field}} variables: top-level values and
 * one level of nesting, as text, capped so a large response cannot bloat
 * the run.
 */
export function flattenResponse(saveAs: string, body: unknown, status: number): Record<string, string> {
    const out: Record<string, string> = { [`${saveAs}.status_code`]: String(status) };
    if (!body || typeof body !== 'object' || Array.isArray(body)) return out;
    let count = 0;
    const put = (key: string, value: unknown) => {
        const v = text(value);
        if (v !== null && count++ < 50) out[`${saveAs}.${key}`] = v.slice(0, 500);
    };
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
        if (v && typeof v === 'object' && !Array.isArray(v)) {
            for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) put(`${k}.${k2}`, v2);
        } else {
            put(k, v);
        }
    }
    return out;
}
