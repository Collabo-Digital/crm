import {
    TemplateDraftError,
    fromMetaComponents,
    renderTemplate,
    sendComponents,
    templateParams,
    toMetaComponents,
    type TemplateDraft,
} from './template-components';
import { templateStarters } from './template-starters';

const sale: TemplateDraft = {
    name: 'sale_announcement',
    language: 'en',
    category: 'MARKETING',
    parameterFormat: 'POSITIONAL',
    header: { format: 'TEXT', text: 'Our {{1}} is live', example: 'Festive Sale' },
    body: { text: 'Hi {{1}}, enjoy {{2}} off.', examples: { 1: 'Ananya', 2: '20%' } },
    footer: 'Tap Stop promotions to opt out',
    buttons: [
        { type: 'COPY_CODE', example: 'FESTIVE20' },
        { type: 'URL', text: 'Shop', url: 'https://example.com/s/{{1}}', example: 'fest' },
        { type: 'QUICK_REPLY', text: 'Stop promotions' },
    ],
};

describe('toMetaComponents', () => {
    it('builds the creation components with examples for every variable', () => {
        const c = toMetaComponents(sale);
        expect(c[0]).toEqual({ type: 'HEADER', format: 'TEXT', text: 'Our {{1}} is live', example: { header_text: ['Festive Sale'] } });
        expect(c[1]).toEqual({ type: 'BODY', text: 'Hi {{1}}, enjoy {{2}} off.', example: { body_text: [['Ananya', '20%']] } });
        expect(c[2]).toEqual({ type: 'FOOTER', text: 'Tap Stop promotions to opt out' });
        expect(c[3].buttons).toEqual([
            { type: 'COPY_CODE', example: 'FESTIVE20' },
            { type: 'URL', text: 'Shop', url: 'https://example.com/s/{{1}}', example: ['fest'] },
            { type: 'QUICK_REPLY', text: 'Stop promotions' },
        ]);
    });

    it('declares named parameters with body_text_named_params', () => {
        const c = toMetaComponents({
            ...sale,
            parameterFormat: 'NAMED',
            header: undefined,
            body: { text: 'Hi {{first_name}}, welcome back.', examples: { first_name: 'Pablo' } },
        });
        expect(c[0].example).toEqual({ body_text_named_params: [{ param_name: 'first_name', example: 'Pablo' }] });
    });

    it('needs the uploaded handle for a media header', () => {
        expect(() => toMetaComponents({ ...sale, header: { format: 'IMAGE' } })).toThrow(TemplateDraftError);
        expect(toMetaComponents({ ...sale, header: { format: 'IMAGE' } }, '4::aW1n')[0]).toEqual({
            type: 'HEADER',
            format: 'IMAGE',
            example: { header_handle: ['4::aW1n'] },
        });
    });

    it('enforces Meta’s limits in the editor’s words', () => {
        const bad = (patch: Partial<TemplateDraft>) => () => toMetaComponents({ ...sale, ...patch });
        expect(bad({ name: 'Sale Now' })).toThrow('lower-case');
        expect(bad({ body: { text: 'Hi {{2}}, welcome.', examples: { 2: 'x' } } })).toThrow('in order');
        expect(bad({ body: { text: 'Hi {{1}}, welcome.', examples: {} } })).toThrow('example');
        expect(bad({ body: { text: '{{1}}, welcome.', examples: { 1: 'x' } } })).toThrow('start or end');
        expect(bad({ body: { text: 'Welcome {{1}}.', examples: { 1: 'x' } } })).toThrow('start or end');
        expect(bad({ footer: 'x'.repeat(61) })).toThrow('60');
        expect(bad({ buttons: [{ type: 'URL', text: 'Go', url: 'https://x.com/{{1}}/y', example: 'a' }] })).toThrow('very end');
        expect(bad({ buttons: [{ type: 'COPY_CODE', example: 'A' }, { type: 'COPY_CODE', example: 'B' }] })).toThrow('copy-code');
        expect(bad({ category: 'AUTHENTICATION' })).toThrow('library');
    });

    it('turns every starter into valid components', () => {
        for (const starter of templateStarters('https://app.example.com')) {
            expect(() => toMetaComponents({ ...starter.draft, language: 'en' }, 'handle')).not.toThrow();
        }
    });
});

describe('sending', () => {
    const components = toMetaComponents(sale);

    it('lists the values a send needs', () => {
        expect(templateParams(components, 'POSITIONAL').map((p) => p.key)).toEqual(['header', 'body.1', 'body.2', 'coupon.0', 'button.1']);
    });

    it('fills them in the send shape', () => {
        const out = sendComponents(components, 'POSITIONAL', {
            header: 'Diwali Sale',
            'body.1': 'Riya',
            'body.2': '30%',
            'coupon.0': 'DIWALI30',
            'button.1': 'diwali',
        });
        expect(out).toEqual([
            { type: 'header', parameters: [{ type: 'text', text: 'Diwali Sale' }] },
            { type: 'body', parameters: [{ type: 'text', text: 'Riya' }, { type: 'text', text: '30%' }] },
            { type: 'button', sub_type: 'copy_code', index: 0, parameters: [{ type: 'coupon_code', coupon_code: 'DIWALI30' }] },
            { type: 'button', sub_type: 'url', index: '1', parameters: [{ type: 'text', text: 'diwali' }] },
        ]);
    });

    it('names parameters for named templates and sends media headers by id', () => {
        const named = toMetaComponents(
            { ...sale, parameterFormat: 'NAMED', header: { format: 'IMAGE' }, body: { text: 'Hi {{first_name}}, welcome back.', examples: { first_name: 'P' } }, buttons: [] },
            'h',
        );
        expect(sendComponents(named, 'NAMED', { header: { mediaId: '1339522734477770' }, 'body.first_name': 'Jessica' })).toEqual([
            { type: 'header', parameters: [{ type: 'image', image: { id: '1339522734477770' } }] },
            { type: 'body', parameters: [{ type: 'text', parameter_name: 'first_name', text: 'Jessica' }] },
        ]);
    });

    it('gives quick replies payloads of their own when asked, in button order', () => {
        const cod = toMetaComponents({
            name: 'cod_check',
            language: 'en',
            category: 'UTILITY',
            parameterFormat: 'NAMED',
            body: { text: 'Hi {{first_name}}, please confirm your order.', examples: { first_name: 'A' } },
            buttons: [{ type: 'QUICK_REPLY', text: 'Confirm order' }, { type: 'QUICK_REPLY', text: 'Cancel order' }],
        });
        expect(sendComponents(cod, 'NAMED', { 'body.first_name': 'Riya' }, { 0: 'cod_yes', 1: 'cod_no' })).toEqual([
            { type: 'body', parameters: [{ type: 'text', parameter_name: 'first_name', text: 'Riya' }] },
            { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: 'cod_yes' }] },
            { type: 'button', sub_type: 'quick_reply', index: '1', parameters: [{ type: 'payload', payload: 'cod_no' }] },
        ]);
        // Without payloads, quick replies send nothing, as before; one for a link or code button is ignored.
        expect(sendComponents(cod, 'NAMED', { 'body.first_name': 'Riya' })).toHaveLength(1);
        const values = { header: 'x', 'body.1': 'R', 'body.2': '5%', 'coupon.0': 'C', 'button.1': 'p' };
        const mixed = sendComponents(components, 'POSITIONAL', values, { 1: 'ignored', 2: 'stop_payload' });
        expect(mixed.slice(2).map((c) => [c.sub_type, c.index])).toEqual([['copy_code', 0], ['url', '1'], ['quick_reply', '2']]);
    });

    it('refuses a send with a value missing', () => {
        expect(() => sendComponents(components, 'POSITIONAL', { header: 'x' })).toThrow('Missing template values: body.1');
    });

    it('renders a preview and round-trips through the editor shape', () => {
        expect(renderTemplate(components, { 'body.1': 'Riya' }).body).toBe('Hi Riya, enjoy {{2}} off.');
        const back = fromMetaComponents({ name: sale.name, language: 'en', category: 'MARKETING', parameterFormat: 'POSITIONAL' }, components);
        expect(toMetaComponents(back)).toEqual(components);
    });
});
