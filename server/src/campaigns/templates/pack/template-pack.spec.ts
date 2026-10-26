import { templateParams, toMetaComponents, variablesIn } from '../template-components';
import { hasBillDocument, isBillTemplate } from '../../../pos/pos-bill-template';
import { billLinkPrefix } from '../template-starters';
import { CollaboVariant, LibraryVariant, PACK_LANGUAGE, TEMPLATE_PACK_VERSION, packTemplateName, packVariantOf, slotVersion, templatePack } from './template-pack';

const APP = 'https://app.example.com';
const pack = templatePack(APP);
const collabo = pack.flatMap((slot) =>
    slot.variants.filter((v): v is CollaboVariant => v.source === 'collabo').map((variant) => ({ slot, variant })));
const library = pack.flatMap((slot) =>
    slot.variants.filter((v): v is LibraryVariant => v.source === 'library').map((variant) => ({ slot, variant })));

const draftOf = ({ slot, variant }: (typeof collabo)[number]) => ({
    ...variant.draft,
    name: packTemplateName(slot.key, TEMPLATE_PACK_VERSION),
    language: PACK_LANGUAGE,
    category: slot.category,
});

describe('the recommended template pack', () => {
    it('has one slot per key, each with at least one variant, under names no starter uses', () => {
        const keys = pack.map((s) => s.key);
        expect(new Set(keys).size).toBe(keys.length);
        for (const slot of pack) {
            expect(slot.variants.length).toBeGreaterThan(0);
            expect(packTemplateName(slot.key, 1)).toMatch(/^collabo_[a-z0-9_]+_v1$/);
        }
    });

    it('turns every one of its own templates into valid components', () => {
        for (const entry of collabo) {
            expect(() => toMetaComponents(draftOf(entry), 'handle')).not.toThrow();
        }
    });

    it('keeps two variables apart and gives each one at least five fixed words', () => {
        // Meta rejects templates with variables side by side or with too little text around them.
        for (const { slot, variant } of collabo) {
            const text = variant.draft.body.text;
            expect([slot.key, /\}\}\s*\{\{/.test(text)]).toEqual([slot.key, false]);
            const words = text.replace(/\{\{[^}]+\}\}/g, ' ').split(/\s+/).filter(Boolean).length;
            expect([slot.key, words >= 5 * variablesIn(text).length]).toEqual([slot.key, true]);
        }
    });

    it('keeps utility wording plain: no offers and no exclamation marks', () => {
        for (const { slot, variant } of collabo.filter((e) => e.slot.category === 'UTILITY')) {
            const text = [variant.draft.body.text, variant.draft.footer ?? '', variant.draft.header && 'text' in variant.draft.header ? variant.draft.header.text : ''].join(' ');
            expect([slot.key, /!|\b(offer|discount|sale|free|hurry|limited|deal|save)\b|% off/i.test(text)]).toEqual([slot.key, false]);
        }
    });

    it('fills every parameter of its own templates, and nothing else', () => {
        for (const entry of collabo) {
            if (entry.slot.key === 'store_bill') continue; // the till fills the bill by name
            const draft = draftOf(entry);
            const keys = templateParams(toMetaComponents(draft, 'handle'), draft.parameterFormat)
                .filter((p) => p.component !== 'header' || p.kind === 'text')
                .map((p) => p.key)
                .sort();
            expect([entry.slot.key, keys]).toEqual([entry.slot.key, Object.keys(entry.variant.values).sort()]);
        }
    });

    it("fills every one of a library template's numbered parameters and its link", () => {
        for (const { slot, variant } of library) {
            const numbered = variablesIn(variant.preview.body).map((n) => `body.${n}`);
            const buttons = (variant.buttonInputs ?? []).map((_, i) => `button.${i}`);
            expect([slot.key, Object.keys(variant.values).sort()]).toEqual([slot.key, [...numbered, ...buttons].sort()]);
            expect(slot.category).toBe('UTILITY'); // the library only creates utility templates
        }
    });

    it('opens order and cart links on the app, and payment links on Razorpay', () => {
        for (const { slot, variant } of collabo) {
            for (const b of variant.draft.buttons ?? []) {
                if (b.type !== 'URL') continue;
                const ok = b.url.startsWith(`${APP}/t/`) || b.url.startsWith(`${APP}/c/`) || b.url.startsWith(`${APP}/b/`) || b.url === 'https://rzp.io/{{1}}';
                expect([slot.key, b.url, ok]).toEqual([slot.key, b.url, true]);
            }
        }
        for (const { variant } of library) {
            for (const input of variant.buttonInputs ?? []) expect(input.url.base_url).toBe(`${APP}/t/{{1}}`);
        }
    });

    it('pins quick-reply payloads to quick-reply buttons', () => {
        for (const { slot, variant } of collabo) {
            for (const index of Object.keys(variant.quickReplyPayloads ?? {})) {
                expect([slot.key, variant.draft.buttons?.[Number(index)]?.type]).toEqual([slot.key, 'QUICK_REPLY']);
            }
        }
    });

    it('makes a store bill template the till recognises, with the bill’s PDF in a document header, at version 2', () => {
        const entry = collabo.find((e) => e.slot.key === 'store_bill')!;
        const draft = draftOf(entry);
        expect(draft.header).toEqual({ format: 'DOCUMENT' });
        const t = { category: draft.category, parameterFormat: draft.parameterFormat, components: toMetaComponents(draft, 'handle') };
        expect(isBillTemplate(t, billLinkPrefix(APP))).toBe(true);
        expect(hasBillDocument(t)).toBe(true);
        // Filled by the till, never by the automations' GST invoice.
        expect(entry.slot).toMatchObject({ version: 2, tillDocument: true });
        expect(entry.slot.invoiceDocument).toBeUndefined();
        // Version 1, still approved on accounts set up before, had the same template without the header.
        const v1 = { ...t, components: toMetaComponents({ ...draft, header: undefined }) };
        expect(isBillTemplate(v1, billLinkPrefix(APP))).toBe(true);
        expect(hasBillDocument(v1)).toBe(false);
    });

    it('keeps every slot at version 1 but the till’s bill', () => {
        expect(pack.filter((s) => slotVersion(s) !== 1).map((s) => [s.key, slotVersion(s)])).toEqual([['store_bill', 2]]);
        expect(TEMPLATE_PACK_VERSION).toBe(2);
    });

    it('finds the variant a template was made from', () => {
        const shipped = pack.find((s) => s.key === 'order_shipped')!;
        expect(packVariantOf(shipped, { packSource: 'library', libraryTemplateName: 'order_shipped' })?.source).toBe('library');
        expect(packVariantOf(shipped, { packSource: 'collabo', libraryTemplateName: null })?.source).toBe('collabo');
        expect(packVariantOf(shipped, { packSource: 'library', libraryTemplateName: 'nope' })).toBeUndefined();
    });
});
