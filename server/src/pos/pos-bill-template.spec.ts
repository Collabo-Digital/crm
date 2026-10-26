import { TemplateDraft, toMetaComponents } from '../campaigns/templates/template-components';
import { billLinkPrefix, templateStarters } from '../campaigns/templates/template-starters';
import { billTemplateValues, hasBillDocument, isBillTemplate } from './pos-bill-template';

/**
 * Which templates the till takes as the bill template, with its PDF in a
 * document header or without one, and what it fills each with.
 */

const APP = 'https://app.example.com';
const PREFIX = billLinkPrefix(APP);
const starter = templateStarters(APP).find((s) => s.key === 'store_bill')!.draft;
const VALUES = { firstName: 'Asha', storeName: 'Acme', billNumber: '#M1042', billTotal: '₹1,050.00', billDate: '26 Oct 2026' };

const template = (draft: Partial<TemplateDraft> = {}) => {
    const d = { ...starter, language: 'en', ...draft } as TemplateDraft;
    return { category: d.category, parameterFormat: d.parameterFormat, components: toMetaComponents(d, '4::handle') };
};

describe('isBillTemplate', () => {
    it('takes a utility template with the View bill link, with or without a document header for the PDF', () => {
        expect(isBillTemplate(template(), PREFIX)).toBe(true);
        expect(isBillTemplate(template({ header: { format: 'DOCUMENT' } }), PREFIX)).toBe(true);
        expect(isBillTemplate(template({ header: { format: 'TEXT', text: 'Your bill' } }), PREFIX)).toBe(true);
    });

    it('refuses a header the till has nothing for: a picture, a video, a text value or a location', () => {
        expect(isBillTemplate(template({ header: { format: 'IMAGE' } }), PREFIX)).toBe(false);
        expect(isBillTemplate(template({ header: { format: 'VIDEO' } }), PREFIX)).toBe(false);
        expect(isBillTemplate(template({ header: { format: 'LOCATION' } }), PREFIX)).toBe(false);
        const textValue = template({ parameterFormat: 'POSITIONAL', header: { format: 'TEXT', text: 'Bill {{1}}', example: '#M1' }, body: { text: 'Hi {{1}}, your bill is ready to view below.', examples: { 1: 'Asha' } } });
        expect(isBillTemplate(textValue, PREFIX)).toBe(false);
    });

    it('refuses a document header on a template without the link, or filed under marketing', () => {
        expect(isBillTemplate(template({ header: { format: 'DOCUMENT' }, buttons: [] }), PREFIX)).toBe(false);
        expect(isBillTemplate({ ...template({ header: { format: 'DOCUMENT' } }), category: 'MARKETING' }, PREFIX)).toBe(false);
    });
});

describe('hasBillDocument', () => {
    it('is the document header', () => {
        expect(hasBillDocument(template({ header: { format: 'DOCUMENT' } }))).toBe(true);
        expect(hasBillDocument(template())).toBe(false);
        expect(hasBillDocument(template({ header: { format: 'TEXT', text: 'Your bill' } }))).toBe(false);
    });
});

describe('billTemplateValues', () => {
    it('fills the bill’s values by name and its link’s token, and leaves the PDF for the upload at delivery', () => {
        expect(billTemplateValues(template({ header: { format: 'DOCUMENT' } }), VALUES, 'ord1.sig')).toEqual({
            header: { mediaId: 'pending-upload' },
            'body.first_name': 'Asha',
            'body.store_name': 'Acme',
            'body.bill_number': '#M1042',
            'body.bill_total': '₹1,050.00',
            'body.bill_date': '26 Oct 2026',
            'button.0': 'ord1.sig',
        });
    });

    it('fills a numbered copy in the starter’s order, with no header without one', () => {
        const numbered = template({
            parameterFormat: 'POSITIONAL',
            body: { text: 'Hi {{1}}, thanks for shopping at {{2}}. Bill {{3}} of {{4}} dated {{5}} is ready to view.', examples: { 1: 'A', 2: 'B', 3: 'C', 4: 'D', 5: 'E' } },
        });
        expect(billTemplateValues(numbered, VALUES, 'ord1.sig')).toEqual({
            'body.1': 'Asha', 'body.2': 'Acme', 'body.3': '#M1042', 'body.4': '₹1,050.00', 'body.5': '26 Oct 2026', 'button.0': 'ord1.sig',
        });
    });
});
