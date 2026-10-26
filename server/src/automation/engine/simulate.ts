import type { SendMessageConfigT, StepDef } from '../blocks/definition.schema';
import { Flow, interpolate } from './flow';
import { RunFacts, conditionMatches, variablesFor } from './run-context';
import { parseRating } from '../../reviews/review-rating';
import { packSlot } from '../../campaigns/templates/pack/template-pack';

export interface TraceStep {
    stepId: string;
    type: string;
    /** done · waits · error (the real run would stop here). */
    status: 'done' | 'waits' | 'error';
    detail: string;
    branch?: string;
}

const MAX_TRACE = 60;
const unitLabel = (amount: number, unit: string) => `${amount} ${amount === 1 ? unit.replace(/s$/, '') : unit}`;

/**
 * What a run would do for this person, without doing it: messages are
 * rendered, conditions evaluated, waits skipped, nothing sent or saved.
 * `reply` stands in for the person's answer at each wait-for-reply; null
 * takes the timeout branch.
 */
export function simulate(
    steps: StepDef[],
    facts: RunFacts,
    opts: { reply: string | null; templateNames?: Record<string, string> },
): TraceStep[] {
    const flow = new Flow(steps);
    const trace: TraceStep[] = [];
    // The simulation changes its own copy of the facts as tags and attributes are set.
    const f: RunFacts = {
        ...facts,
        contact: { ...facts.contact, tags: [...facts.contact.tags], attributes: { ...facts.contact.attributes } },
        context: { ...facts.context, vars: { ...facts.context.vars } },
    };
    let step = flow.first();
    while (step && trace.length < MAX_TRACE) {
        const c = step.config;
        const vars = variablesFor(f);
        const push = (status: TraceStep['status'], detail: string, branch?: string) =>
            trace.push({ stepId: step!.id, type: step!.type, status, detail, ...(branch ? { branch } : {}) });
        let branch: string | null = null;

        switch (step.type) {
            case 'send_message': {
                const m = c as SendMessageConfigT;
                if (m.kind === 'template' && m.templateSlot && !m.templateId) {
                    push('done', `Sends the recommended template "${packSlot('', m.templateSlot)?.title ?? m.templateSlot}".`);
                } else if (m.kind === 'template') {
                    push('done', `Sends the template "${opts.templateNames?.[m.templateId ?? ''] ?? 'not chosen'}".`);
                } else {
                    const options = m.options.filter((o) => o.trim());
                    const text = interpolate(m.message, vars);
                    push('done', `Sends: ${text || '(the file)'}${options.length ? ` [${options.join(' · ')}]` : ''}`);
                }
                break;
            }
            case 'reply_comment':
                push('done', `${c.mode === 'public' ? 'Replies under the comment' : 'Replies privately'}: ${interpolate(String(c.message ?? ''), vars)}`);
                break;
            case 'send_invoice':
                push('done', `Sends the order's GST invoice as a PDF with the template "${opts.templateNames?.[String(c.templateId ?? '')] ?? 'not chosen'}".`);
                break;
            case 'send_payment_link':
                push('done', c.method === 'whatsapp_pay' ? 'Sends a WhatsApp Pay bill to review and pay in the chat.' : c.kind === 'text'
                    ? `Sends a Razorpay payment link: ${interpolate(String(c.message ?? ''), { ...vars, 'payment.link': 'https://rzp.io/rzp/example' })}`
                    : `Sends a Razorpay payment link with the template "${opts.templateNames?.[String(c.templateId ?? '')] ?? 'not chosen'}".`);
                break;
            case 'wait':
                push('waits', `Waits ${unitLabel(Number(c.amount), String(c.unit))}.`);
                break;
            case 'wait_for_reply':
                if (opts.reply !== null) {
                    f.context.vars.last_reply = opts.reply;
                    if (c.saveAs) f.contact.attributes[String(c.saveAs)] = opts.reply;
                    branch = 'replied';
                    push('waits', `Waits for a reply; they answer "${opts.reply}".`, branch);
                } else {
                    branch = 'timeout';
                    push('waits', `Waits for a reply; none comes within ${unitLabel(Number(c.amount), String(c.unit))}.`, branch);
                }
                break;
            case 'condition': {
                const yes = conditionMatches(c as Parameters<typeof conditionMatches>[0], f);
                branch = yes ? 'yes' : 'no';
                push('done', yes ? 'The condition is met.' : 'The condition is not met.', branch);
                break;
            }
            case 'add_tag': {
                const tags = (c.tags as string[]).filter((t) => !f.contact.tags.some((x) => x.toLowerCase() === t.toLowerCase()));
                f.contact.tags.push(...tags);
                push('done', tags.length ? `Adds the tag${tags.length > 1 ? 's' : ''} ${tags.join(', ')}.` : 'Already has these tags.');
                break;
            }
            case 'remove_tag': {
                const remove = new Set((c.tags as string[]).map((t) => t.toLowerCase()));
                f.contact.tags = f.contact.tags.filter((t) => !remove.has(t.toLowerCase()));
                push('done', `Removes ${(c.tags as string[]).join(', ')}.`);
                break;
            }
            case 'set_attribute': {
                const value = interpolate(String(c.value ?? ''), vars);
                f.contact.attributes[String(c.key)] = value;
                push('done', `Saves ${c.key} = "${value}".`);
                break;
            }
            case 'assign':
                push('done', c.mode === 'unassign' ? 'Unassigns the conversation.' : c.mode === 'round_robin' ? 'Assigns the next available agent.' : c.mode === 'team' ? 'Queues the conversation for the team.' : 'Assigns the chosen team member.');
                break;
            case 'set_status':
                push('done', c.status === 'snoozed' ? `Snoozes the conversation for ${c.hours} hours.` : `Marks the conversation ${c.status}.`);
                break;
            case 'add_note':
                push('done', `Adds a note: ${interpolate(String(c.text ?? ''), vars)}`);
                break;
            case 'http_request':
                push('done', `Calls ${c.method} ${interpolate(String(c.url ?? ''), vars)} (not called in a test).`);
                break;
            case 'store_action': {
                const value = interpolate(String(c.value ?? ''), vars);
                const said: Record<string, string> = {
                    tag_order: `Tags the order “${value}”.`,
                    note_order: `Adds to the order’s note: ${value}`,
                    cancel_order: 'Cancels the order in the store.',
                    tag_customer: `Tags the store customer “${value}”.`,
                    create_draft_order: 'Creates a draft order from the cart, with its checkout link as {{draft.checkout_url}}.',
                };
                if (c.action === 'create_draft_order') f.context.vars['draft.checkout_url'] = 'https://your-store.example/checkout/…';
                push('done', said[String(c.action)] ?? 'Runs a store action.');
                break;
            }
            case 'sheet_add_row':
                push('done', `Adds a row to the sheet: ${((c.values as string[]) ?? []).map((v) => interpolate(v, vars)).join(' | ')} (not added in a test).`);
                break;
            case 'post_review': {
                const given = interpolate(String(c.rating ?? ''), vars);
                const rating = parseRating(given);
                if (rating === null) {
                    push('error', `No rating from 1 to 5 in “${given}”.`);
                    return trace;
                }
                push('done', `Publishes a ${rating}★ review of the order to Judge.me (not published in a test).`);
                break;
            }
            default:
                push('error', `Unknown block "${step.type}".`);
                return trace;
        }
        step = branch ? flow.enter(step.id, branch) : flow.next(step.id);
    }
    return trace;
}
