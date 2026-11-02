import { TemplateDraftError } from './template-components';
import {
    WRITER_OUTPUT_FORMAT,
    WriterOutputSchema,
    draftFromOutput,
    writerRequestMessage,
    writerTemplateName,
    type WriterOutput,
} from './template-writer';

const button = (b: Partial<WriterOutput['buttons'][number]> & Pick<WriterOutput['buttons'][number], 'type'>) => ({
    text: '', url: null, url_example: null, phone_number: null, code: null, ...b,
});

const sale: WriterOutput = {
    name: 'Diwali Sale – early access!',
    category: 'MARKETING',
    header: 'Early access starts today',
    body: 'Hi {{first_name}}, our Diwali sale opens for you a day early. Use code {{code_hint}} at checkout.',
    variables: [{ name: '{{first_name}}', example: 'Ananya' }, { name: 'code_hint', example: 'the one on your card' }, { name: 'unused', example: 'x' }],
    footer: null,
    buttons: [
        button({ type: 'QUICK_REPLY', text: 'Remind me later' }),
        button({ type: 'COPY_CODE', text: 'ignored', code: 'DIWALI20' }),
        button({ type: 'URL', text: 'Shop the sale', url: 'https://shop.example/sale' }),
    ],
    notes: 'Marketing, because it promotes a sale.',
};
const ctx = { language: 'en', category: null, takenNames: new Set<string>() };

describe('draftFromOutput', () => {
    it('makes a named-variable draft that passes Meta’s rules', () => {
        const draft = draftFromOutput(sale, ctx);
        expect(draft).toMatchObject({
            name: 'diwali_sale_early_access',
            language: 'en',
            category: 'MARKETING',
            parameterFormat: 'NAMED',
            header: { format: 'TEXT', text: 'Early access starts today' },
            body: { examples: { first_name: 'Ananya', code_hint: 'the one on your card' } },
        });
        expect(draft.footer).toBeUndefined();
    });

    it('groups quick replies after the other buttons and adds Stop promotions to marketing', () => {
        expect(draftFromOutput(sale, ctx).buttons).toEqual([
            { type: 'COPY_CODE', example: 'DIWALI20' },
            { type: 'URL', text: 'Shop the sale', url: 'https://shop.example/sale' },
            { type: 'QUICK_REPLY', text: 'Remind me later' },
            { type: 'QUICK_REPLY', text: 'Stop promotions' },
        ]);
        const own = draftFromOutput({ ...sale, buttons: [button({ type: 'QUICK_REPLY', text: 'stop promotions' })] }, ctx);
        expect(own.buttons).toEqual([{ type: 'QUICK_REPLY', text: 'stop promotions' }]);
    });

    it('keeps the merchant’s category over the model’s', () => {
        const shipped: WriterOutput = {
            ...sale,
            category: 'MARKETING',
            header: null,
            body: 'Hi {{first_name}}, order {{order_number}} is on its way.',
            variables: [{ name: 'first_name', example: 'Ananya' }, { name: 'order_number', example: '#1042' }],
            buttons: [],
        };
        const draft = draftFromOutput(shipped, { ...ctx, category: 'UTILITY' });
        expect(draft.category).toBe('UTILITY');
        expect(draft.buttons).toBeUndefined();
    });

    it('refuses what Meta would reject, with a reason the model can act on', () => {
        const bad = (patch: Partial<WriterOutput>, category: 'MARKETING' | 'UTILITY' | null = null) => () =>
            draftFromOutput({ ...sale, ...patch }, { ...ctx, category });
        expect(bad({ body: '{{first_name}}, the sale is open.' })).toThrow(/cannot start or end with a variable/);
        expect(bad({ body: 'The sale is open, {{first_name}}' })).toThrow(/cannot start or end with a variable/);
        expect(bad({ header: '*Early* access' })).toThrow(/formatting characters/);
        expect(bad({}, 'UTILITY')).toThrow(/Coupon code buttons are for marketing/);
        expect(bad({ body: 'Hi {{1}}, the sale is open.' })).toThrow(/lower-case letters and underscores/);
        expect(bad({ variables: [] })).toThrow(/example value for \{\{first_name\}\}/);
        expect(bad({ buttons: [button({ type: 'URL', text: 'Track', url: 'https://shop.example/t/{{1}}' })] })).toThrow(/example for \{\{1\}\}/);
        expect(bad({ buttons: [button({ type: 'QUICK_REPLY', text: 'A label that is far too long' })] })).toThrow(TemplateDraftError);
    });
});

describe('writerTemplateName', () => {
    it('uses Meta’s characters and avoids names the account has', () => {
        expect(writerTemplateName('Order Shipped (tracking)', new Set())).toBe('order_shipped_tracking');
        expect(writerTemplateName('order_shipped', new Set(['order_shipped', 'order_shipped_2']))).toBe('order_shipped_3');
        expect(writerTemplateName('दिवाली', new Set())).toBe('ai_template');
    });
});

describe('the request', () => {
    it('gives the store, language and category, with the brief fenced off', () => {
        const text = writerRequestMessage({
            brief: '  Tell customers their order shipped  ',
            language: 'hi',
            category: null,
            store: { name: 'Meera Studio', industry: null, website: null, currency: 'INR' },
        });
        expect(text).toContain('Store: Meera Studio');
        expect(text).not.toContain('What they sell');
        expect(text).toContain('https://example.com');
        expect(text).toContain('Meta template code is hi');
        expect(text).toContain('Category: choose the right one.');
        expect(text).toContain('<request>\nTell customers their order shipped\n</request>');
    });

    it('asks for a schema structured outputs accept: closed objects, every field required, enums kept', () => {
        const schema = WRITER_OUTPUT_FORMAT.schema as Record<string, any>;
        expect(schema.$schema).toBeUndefined();
        const objects: Array<Record<string, any>> = [];
        const walk = (node: unknown) => {
            if (!node || typeof node !== 'object') return;
            const n = node as Record<string, any>;
            if (n.type === 'object') objects.push(n);
            Object.values(n).forEach(walk);
        };
        walk(schema);
        expect(objects).toHaveLength(3);
        for (const o of objects) {
            expect(o.additionalProperties).toBe(false);
            expect([...o.required].sort()).toEqual(Object.keys(o.properties).sort());
        }
        expect(schema.properties.category.enum).toEqual(['MARKETING', 'UTILITY']);
        expect(WriterOutputSchema.safeParse(sale).success).toBe(true);
    });
});
