import { InvoiceSettingsSchema } from '../../organization-settings/schemas/invoice-settings.schema';
import { readRenderSnapshot, RenderSnapshot } from './render-snapshot';

const snapshot: RenderSnapshot = {
    v: 1,
    documentType: 'BILL_OF_SUPPLY',
    composition: true,
    eInvoiceDeclaration: false,
    design: InvoiceSettingsSchema.parse({ theme: 'classic' }),
    brand: { tradeName: 'Saanjh', logoStorageKey: 'org_1/logo.png', supportPhone: '', whatsappPhone: '', supportEmail: '', website: '', upiId: null },
};

describe('readRenderSnapshot', () => {
    it('reads the snapshot an invoice was issued with', () => {
        expect(readRenderSnapshot({ render: snapshot, other: 1 })).toEqual(snapshot);
    });

    it('returns null for documents issued before snapshots, or with one that no longer parses', () => {
        expect(readRenderSnapshot(null)).toBeNull();
        expect(readRenderSnapshot({})).toBeNull();
        expect(readRenderSnapshot({ render: { ...snapshot, v: 2 } })).toBeNull();
    });
});
