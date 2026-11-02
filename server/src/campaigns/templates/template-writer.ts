import { z } from 'zod';
import { TemplateDraftError, toMetaComponents, variablesIn, type DraftButton, type TemplateDraft } from './template-components';
import { STOP_BUTTON } from './template-starters';

/**
 * The AI template writer's half of the conversation: what Claude is told,
 * the shape it answers in, and turning the answer into an editor draft that
 * passes Meta's rules. Pure.
 *
 * The rules in the prompt are Meta's (templates/components,
 * templates/template-review, templates/template-categorization). A
 * TemplateDraftError from draftFromOutput goes back to Claude to fix.
 */

export const WRITER_SYSTEM_PROMPT = `You write WhatsApp message templates for online stores that use Collabo, a customer messaging app. A template is a message a store sends its customers through the WhatsApp Business Platform. Meta reviews every template before it can be sent and rejects ones that break its rules, so the template must follow the rules below exactly. The store owner reads your draft in an editor, changes what they like and submits it.

Write one template for the store and purpose you are given, in the language you are given. Write the way a helpful shop assistant writes on WhatsApp: short, warm and specific; two to five short sentences; plain words; no ALL CAPS; at most two emojis, and only where they add something. Do not invent facts the request does not give, such as prices, dates, discount sizes or policies: use a variable for anything that differs from customer to customer, and leave out anything else you do not know.

Category
- UTILITY: a non-promotional message about something specific to this customer, such as their order, payment, delivery, booking, account or a request they made. It cannot contain any offer, discount, product suggestion or persuasive wording.
- MARKETING: everything else, such as offers, new products, cart reminders, win-back messages, greetings and announcements. A message that mixes an order update with an offer is marketing.
When the request fixes the category, write content that fits it; for a utility template, leave out anything promotional and say in the notes what you left out.

Variables
- Variables are the parts that change for each customer, written as {{name}} with lower-case letters and underscores only, such as {{first_name}}, {{order_number}} or {{delivery_date}}. No digits, spaces or other characters inside the braces.
- List every variable of the body in variables, with a realistic example value in the template's language and the store's currency.
- The body cannot start or end with a variable: put words before the first variable and after the last one, even if only a full stop.
- Use variables sparingly and never put two side by side; Meta rejects a short message with many variables.
- The header, footer and button labels cannot contain variables.

Parts
- header: an optional title shown in bold above the message, at most 60 characters, plain text with no emojis and no formatting characters such as * _ ~ or \`. null for none.
- body: the message itself, at most 1024 characters. *Bold* is allowed, sparingly.
- footer: an optional line of small grey text under the message, at most 60 characters, plain text. null for none.
- buttons: usually none to three; with more than three, WhatsApp shows two and hides the rest behind "See all options".
  - QUICK_REPLY: a reply the customer taps; the label is sent back as their message. Label at most 25 characters.
  - URL: opens a page. Label at most 25 characters. url is a full https:// address on the store's website and may end with one variable, written {{1}}, for the part that differs per customer (for example https://shop.example/orders/{{1}}); then url_example is an example of that part. At most two URL buttons.
  - PHONE_NUMBER: calls the store. Label at most 25 characters; phone_number with the country code. Only when the request gives the number. At most one.
  - COPY_CODE: copies a coupon code; marketing only, and only when the request names the code; the code goes in code, at most 20 characters. At most one. WhatsApp sets its label, so text is ignored.
  Put quick-reply buttons after all other buttons.
- Every marketing template ends with a quick-reply button labelled exactly "Stop promotions", in English whatever the template's language: Collabo reads that reply as the customer opting out of promotions.
- name: a short identifier for the template in lower-case letters, digits and underscores that says what it is for, such as order_shipped_tracking or diwali_sale_early_access.
- notes: one or two sentences for the store owner, saying which category you chose and why, and anything they must check or replace before submitting, such as a link.

Fields that do not apply are null; lists with nothing in them are empty.`;

const ButtonOutput = z.object({
    type: z.enum(['QUICK_REPLY', 'URL', 'PHONE_NUMBER', 'COPY_CODE']),
    text: z.string().describe('The button label'),
    url: z.string().nullable(),
    url_example: z.string().nullable(),
    phone_number: z.string().nullable(),
    code: z.string().nullable(),
});

/** What Claude answers with (structured output: every field present, null when unused). */
export const WriterOutputSchema = z.object({
    name: z.string(),
    category: z.enum(['MARKETING', 'UTILITY']),
    header: z.string().nullable(),
    body: z.string(),
    variables: z.array(z.object({ name: z.string().describe('The variable name without braces'), example: z.string() })),
    footer: z.string().nullable(),
    buttons: z.array(ButtonOutput),
    notes: z.string(),
});
export type WriterOutput = z.infer<typeof WriterOutputSchema>;

// Zod's JSON Schema keeps the enums and closes every object, as structured
// outputs need (the SDK's own helper turns enums into descriptions).
const outputSchema: Record<string, unknown> = { ...z.toJSONSchema(WriterOutputSchema) };
delete outputSchema.$schema;
export const WRITER_OUTPUT_FORMAT = { type: 'json_schema' as const, schema: outputSchema };

export type WriterCategory = 'MARKETING' | 'UTILITY';

export interface WriterRequest {
    brief: string;
    language: string;
    category: WriterCategory | null;
    store: { name: string; industry: string | null; website: string | null; currency: string };
}

export function writerRequestMessage(r: WriterRequest): string {
    return [
        `Store: ${r.store.name}`,
        ...(r.store.industry ? [`What they sell: ${r.store.industry}`] : []),
        r.store.website
            ? `Website: ${r.store.website}`
            : 'Website: none on file. Use https://example.com in links and ask the owner in the notes to replace it.',
        `Currency: ${r.store.currency}`,
        `Language: the one whose Meta template code is ${r.language}. Write every word of the template in it, including button labels (except Stop promotions) and example values.`,
        r.category ? `Category: ${r.category}` : 'Category: choose the right one.',
        '',
        'What the template is for, in the owner’s words:',
        '<request>',
        r.brief.trim(),
        '</request>',
    ].join('\n');
}

export function writerRetryMessage(problem: string): string {
    return `Meta would reject that template: ${problem} Write the whole template again with that fixed.`;
}

/** A free template name: Meta's characters, and not one the account already has in this language. */
export function writerTemplateName(raw: string, taken: ReadonlySet<string>): string {
    const base = raw.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 60) || 'ai_template';
    let name = base;
    for (let n = 2; taken.has(name); n++) name = `${base}_${n}`;
    return name;
}

function toButton(b: WriterOutput['buttons'][number]): DraftButton {
    switch (b.type) {
        case 'QUICK_REPLY':
            return { type: 'QUICK_REPLY', text: b.text.trim() };
        case 'URL':
            return { type: 'URL', text: b.text.trim(), url: (b.url ?? '').trim(), ...(b.url_example?.trim() ? { example: b.url_example.trim() } : {}) };
        case 'PHONE_NUMBER':
            return { type: 'PHONE_NUMBER', text: b.text.trim(), phoneNumber: (b.phone_number ?? '').trim() };
        case 'COPY_CODE':
            return { type: 'COPY_CODE', example: (b.code ?? '').trim() };
    }
}

const isStop = (b: DraftButton) => b.type === 'QUICK_REPLY' && b.text.toLowerCase() === STOP_BUTTON.text.toLowerCase();

/** The editor draft for Claude's answer, or a TemplateDraftError naming what Meta would refuse. */
export function draftFromOutput(
    out: WriterOutput,
    ctx: { language: string; category: WriterCategory | null; takenNames: ReadonlySet<string> },
): TemplateDraft {
    const category = ctx.category ?? out.category;
    const header = out.header?.trim();
    if (header && /[*_~`]/.test(header)) throw new TemplateDraftError('The header cannot use formatting characters such as * _ ~ or `.');
    const body = out.body.trim();
    if (/^\{\{[^}]*\}\}/.test(body) || /\{\{[^}]*\}\}$/.test(body)) {
        throw new TemplateDraftError('The body cannot start or end with a variable; put words before the first variable and after the last one.');
    }
    const given = new Map(out.variables.map((v) => [v.name.replace(/[{}\s]/g, ''), v.example.trim()]));
    const examples = Object.fromEntries(variablesIn(body).filter((v) => given.has(v)).map((v) => [v, given.get(v)!]));

    const buttons = out.buttons.map(toButton);
    if (category === 'UTILITY' && buttons.some((b) => b.type === 'COPY_CODE')) {
        throw new TemplateDraftError('Coupon code buttons are for marketing templates.');
    }
    if (category === 'MARKETING' && !buttons.some(isStop)) buttons.push({ ...STOP_BUTTON });
    // Meta: quick replies form their own group when mixed with other buttons.
    const ordered = [...buttons.filter((b) => b.type !== 'QUICK_REPLY'), ...buttons.filter((b) => b.type === 'QUICK_REPLY')];

    const draft: TemplateDraft = {
        name: writerTemplateName(out.name, ctx.takenNames),
        language: ctx.language,
        category,
        parameterFormat: 'NAMED',
        ...(header ? { header: { format: 'TEXT' as const, text: header } } : {}),
        body: { text: body, examples },
        ...(out.footer?.trim() ? { footer: out.footer.trim() } : {}),
        ...(ordered.length ? { buttons: ordered } : {}),
    };
    toMetaComponents(draft);
    return draft;
}
