import { StoreProfileSettingsSchema } from '../../organization-settings/schemas/store-profile-settings.schema';
import { InvoiceSettingsSchema } from '../../organization-settings/schemas/invoice-settings.schema';
import { addressLine, addressLines, currentBrand, currentSnapshot, docDate, docDateTime, latest, maskEmail, stateLabel, upiPayUri } from './build-parts';

describe('document wording', () => {
    it('dates read "27 Oct 2026" in the organization’s time zone, September included', () => {
        expect(docDate(new Date('2026-10-26T20:00:00Z'), 'Asia/Kolkata')).toBe('27 Oct 2026');
        expect(docDate(new Date('2026-10-26T20:00:00Z'), 'UTC')).toBe('26 Oct 2026');
        expect(docDate(new Date('2026-09-05T06:00:00Z'), 'Asia/Kolkata')).toBe('5 Sep 2026');
        expect(docDateTime(new Date('2026-10-25T13:12:00Z'), 'Asia/Kolkata')).toBe('25 Oct 2026, 18:42');
        expect(docDateTime(new Date('2026-10-25T18:40:00Z'), 'Asia/Kolkata')).toBe('26 Oct 2026, 00:10');
    });

    it('states read "Kerala (32)", by name or code', () => {
        expect(stateLabel('32', 'Kerala')).toBe('Kerala (32)');
        expect(stateLabel('32', '')).toBe('Kerala (32)');
        expect(stateLabel('96')).toBe('Other Country (96)');
        expect(stateLabel(null)).toBeNull();
    });

    it('addresses from Shopify or Collabo, as lines or on one line', () => {
        expect(addressLines({ company: 'Kavya Retail LLP', address_1: '45, Commercial St', address2: '', city: 'Bengaluru', province_code: 'KA', zip: '560001', country: 'India' })).toEqual([
            'Kavya Retail LLP',
            '45, Commercial St',
            'Bengaluru 560001, KA',
            'India',
        ]);
        expect(addressLines(null)).toEqual([]);
        expect(addressLine({ address1: '12 MG Road', city: 'Kochi', province: 'Kerala', zip: '682016' })).toBe('12 MG Road, Kochi, Kerala 682016');
        expect(addressLine({})).toBeNull();
    });

    it('masks an email to its first letter and domain', () => {
        expect(maskEmail('asha.menon@gmail.com')).toBe('a•••@gmail.com');
        expect(maskEmail('not-an-email')).toBe('•••');
    });

    it('builds the UPI link the till builds', () => {
        expect(upiPayUri(' saanjh@okaxis ', 'Saanjh Apparel', 1500, 'INV-26-27/000125')).toBe(
            'upi://pay?pa=saanjh@okaxis&pn=Saanjh%20Apparel&am=1500.00&cu=INR&tn=INV-26-27%2F000125',
        );
    });

    it('the latest of some instants', () => {
        expect(latest([null, new Date('2026-10-01'), undefined, new Date('2026-10-03'), new Date('2026-10-02')])).toEqual(new Date('2026-10-03'));
        expect(latest([])).toBeNull();
    });
});

describe('a document without a snapshot', () => {
    it('takes the brand from the current settings, as an invoice issued now would keep it', () => {
        const profile = StoreProfileSettingsSchema.parse({ storeName: '  ', whatsappPhone: '+91 90000 00000', logoStorageKey: 'org_1/logo.png' });
        expect(currentBrand({ name: 'Saanjh', website: 'https://saanjh.example' }, profile, 'saanjh@okaxis')).toEqual({
            tradeName: 'Saanjh',
            logoStorageKey: 'org_1/logo.png',
            supportPhone: '',
            whatsappPhone: '+91 90000 00000',
            supportEmail: '',
            website: 'https://saanjh.example',
            upiId: 'saanjh@okaxis',
        });
        const own = StoreProfileSettingsSchema.parse({ storeName: 'Saanjh Studio', website: 'https://studio.example' });
        expect(currentBrand({ name: 'Saanjh', website: null }, own, null)).toMatchObject({ tradeName: 'Saanjh Studio', website: 'https://studio.example', logoStorageKey: null });
    });

    it('is an ordinary tax invoice: not composition, no declaration', () => {
        const design = InvoiceSettingsSchema.parse({});
        const brand = currentBrand({ name: 'Saanjh', website: null }, StoreProfileSettingsSchema.parse({}), null);
        expect(currentSnapshot(design, brand)).toEqual({ v: 1, documentType: 'TAX_INVOICE', composition: false, eInvoiceDeclaration: false, design, brand });
    });
});
