import { InvoiceSettingsSchema } from '../../organization-settings/schemas/invoice-settings.schema';
import { TaxSettingsSchema } from '../../organization-settings/schemas/tax-settings.schema';
import type { PreviewContext } from './build-loader';
import { round2 } from './build-parts';
import type { DocumentModel } from './document-model';
import { PREVIEW_SAMPLES, previewDocument } from './sample-documents';

/** The preview's samples: real builders, the organization's own seller and settings, sample buyers and goods. */

const NOW = new Date('2026-10-27T06:30:00Z');

function context(over: { registration?: PreviewContext['registration']; design?: Record<string, unknown>; tax?: Record<string, unknown> } = {}): PreviewContext {
    return {
        settings: {
            orgName: 'Saanjh',
            gstEnabled: true,
            currency: 'INR',
            timeZone: 'Asia/Kolkata',
            design: InvoiceSettingsSchema.parse({}),
            brand: {
                tradeName: 'Saanjh',
                logoStorageKey: null,
                supportPhone: '+91 80 4000 0000',
                whatsappPhone: '',
                supportEmail: 'care@saanjh.example',
                website: '',
                upiId: 'saanjh@okaxis',
            },
            tax: TaxSettingsSchema.parse(over.tax ?? {}),
            storeAddress: '80 Feet Road, Koramangala, Bengaluru, Karnataka 560034',
        },
        design: InvoiceSettingsSchema.parse(over.design ?? {}),
        registration:
            over.registration === undefined
                ? {
                      gstin: '32AAACS1234K1Z9',
                      legalName: 'Saanjh Apparel Private Limited',
                      address: { address1: 'MG Road', city: 'Kochi', zip: '682016', province: 'Kerala' },
                      stateCode: '32',
                      stateName: 'Kerala',
                  }
                : over.registration,
        logo: null,
        signature: null,
    };
}

/** The ladder and the table agree with the grand total, to the paisa. */
function expectItAddsUp(doc: DocumentModel) {
    const t = doc.totals;
    expect(round2(t.itemValue - t.discount)).toBe(t.taxable);
    expect(round2(doc.lines.reduce((s, l) => s + l.amount, 0))).toBe(t.grandTotal);
    expect(round2(t.taxable + t.cgst + t.sgst + t.igst + t.charges.reduce((s, c) => s + c.amount, 0) + t.roundOff)).toBe(t.grandTotal);
}

describe('previewDocument', () => {
    it.each(PREVIEW_SAMPLES)('%s adds up', (sample) => {
        expectItAddsUp(previewDocument(sample, context(), NOW));
    });

    it('a paid home delivery at two rates with a discount, from the organization’s own registration', () => {
        const doc = previewDocument('tax_invoice', context(), NOW);
        expect(doc).toMatchObject({ kind: 'TAX_INVOICE', documentNumber: 'INV-26-27/000124', showDiscount: true });
        expect(doc.seller).toMatchObject({ legalName: 'Saanjh Apparel Private Limited', gstin: '32AAACS1234K1Z9', tradeName: 'Saanjh' });
        expect(doc.status.chip).toEqual({ text: 'PAID', tone: 'paid' });
        expect(new Set(doc.lines.map((l) => (l.igst ?? l.cgst)!.rate * (l.igst ? 1 : 2)))).toEqual(new Set([5, 18]));
        // A Kerala seller and a Kerala buyer: within the state.
        expect(doc.taxHeads).toBe('CGST_SGST');
        expect(doc.totals.grandTotal).toBe(5647);
    });

    it('an inter-state sale when the seller is elsewhere', () => {
        const doc = previewDocument('tax_invoice', context({ registration: null }), NOW);
        expect(doc.seller).toMatchObject({ legalName: 'Saanjh', gstin: '29ABCDE1234F1Z5', state: 'Karnataka (29)' });
        expect(doc.taxHeads).toBe('IGST');
        expect(doc.totals).toMatchObject({ taxable: 5063.43, igst: 583.57, grandTotal: 5647 });
    });

    it('a business order: eight lines, unpaid with a UPI QR, a different ship-to, Classic and the summary', () => {
        const doc = previewDocument('tax_invoice_b2b', context(), NOW);
        expect(doc.lines).toHaveLength(8);
        expect(doc.status.chip).toEqual({ text: 'UNPAID', tone: 'due' });
        expect(doc.payment).toMatchObject({ kind: 'due', upiId: 'saanjh@okaxis' });
        expect((doc.payment as { upiUri: string }).upiUri).toMatch(/^upi:\/\/pay\?pa=saanjh@okaxis&pn=Saanjh&am=\d+\.\d{2}&cu=INR&tn=INV-26-27%2F000125$/);
        expect(doc.parties.map((p) => p.heading)).toEqual(['BILL TO', 'SHIP TO']);
        expect(doc.parties[0].gstin).toBe('29AAAFK0000A1Z5');
        expect(doc.theme).toBe('classic');
        expect(doc.taxSummary?.rows.length).toBeGreaterThan(1);
        expect(doc.notes).toBe('Buyer PO: KR/PO/0412');
    });

    it('the same goods as a composition bill of supply, to a walk-in in the seller’s state', () => {
        const doc = previewDocument('bill_of_supply', context(), NOW);
        expect(doc).toMatchObject({ kind: 'BILL_OF_SUPPLY', title: 'BILL OF SUPPLY', taxHeads: null, taxSummary: null, documentNumber: 'INV-26-27/000126' });
        expect(doc.subtitle).toBe('Composition taxable person, not eligible to collect tax on supplies');
        expect(doc.parties[0]).toMatchObject({ name: 'Walk-in customer', state: 'Kerala (32)' });
        expect(doc.lines.map((l) => l.name)).toEqual(['Handblock Cotton Kurta', 'Linen Palazzo Pants', 'Pure Silk Dupatta']);
        expect(doc.totals).toMatchObject({ cgst: 0, sgst: 0, igst: 0, grandTotal: 5647 });
        expect(doc.payment).toEqual({ kind: 'received', lines: ['Cash · 27 Oct 2026, 12:00 · ₹5,647.00'] });
    });

    it('a partial credit note against the first, signed', () => {
        const doc = previewDocument('credit_note', context({ design: { signatoryName: 'Meera Rao' } }), NOW);
        expect(doc).toMatchObject({ kind: 'CREDIT_NOTE', documentNumber: 'CN-26-27/000009', status: { line: 'Against INV-26-27/000124', amount: 2999 } });
        expect(doc.reference).toEqual(['Against invoice INV-26-27/000124 dated 26 Oct 2026', 'Reason: Returned: Pure Silk Dupatta, Rust']);
        expect(doc.signatory).toMatchObject({ forName: 'For Saanjh Apparel Private Limited', name: 'Meera Rao' });
        expect(doc.totals).toMatchObject({ grandLabel: 'Amount credited', grandTotal: 2999 });
    });

    it('a till bill: the GSTIN only when the organization has one, the store’s own address', () => {
        const registered = previewDocument('bill', context(), NOW);
        expect(registered).toMatchObject({ kind: 'BILL', title: 'BILL', copyMark: null, taxHeads: null });
        expect(registered.seller).toMatchObject({ gstin: '32AAACS1234K1Z9', addressLines: ['80 Feet Road, Koramangala, Bengaluru, Karnataka 560034'] });
        const unregistered = previewDocument('bill', context({ registration: null }), NOW);
        expect(unregistered.seller).toMatchObject({ gstin: null, legalName: 'Saanjh', ids: [] });
        expect(unregistered.payment).toMatchObject({ kind: 'received' });
    });

    it('shows the settings being edited', () => {
        const doc = previewDocument(
            'tax_invoice',
            context({ design: { theme: 'classic', brandColor: '#0F766E', terms: 'Exchange within 15 days.', showSku: false, customerContact: 'mask' } }),
            NOW,
        );
        expect(doc).toMatchObject({ theme: 'classic', brandColor: '#0F766E', terms: ['Exchange within 15 days.'] });
        expect(doc.lines[0].detail).toBe('Indigo / M');
        expect(doc.parties[0].lines).toContain('+91 98••• ••345 · a•••@example.com');
    });

    it('numbers documents in the organization’s series, and declares Rule 46(s) when e-invoicing is on', () => {
        const doc = previewDocument('tax_invoice', context({ tax: { invoicePrefix: 'SJ', eInvoicing: true } }), NOW);
        expect(doc.documentNumber).toBe('SJ-26-27/000124');
        expect(doc.declaration).toMatch(/^I\/We hereby declare/);
        expect(previewDocument('tax_invoice_b2b', context({ tax: { eInvoicing: true } }), NOW).declaration).toBeNull();
    });
});
