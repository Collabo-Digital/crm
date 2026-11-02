import {
  InvoiceSettingsSchema,
  parseInvoiceSettings,
  UpdateInvoiceSettingsSchema,
} from './invoice-settings.schema';

describe('InvoiceSettings', () => {
  it('defaults to the Modern look in ink, with the computer-generated note and no extras', () => {
    expect(parseInvoiceSettings(null)).toEqual({
      theme: 'modern',
      classicForB2b: true,
      brandColor: null,
      showPan: true,
      businessIds: [],
      registeredOffice: '',
      showSupportContact: true,
      terms: '',
      returnPolicy: '',
      returnPolicyUrl: '',
      footerNote: 'Thank you for shopping with us.',
      signatureMode: 'computer',
      signature: null,
      signatoryName: '',
      signatoryDesignation: '',
      showSku: true,
      amountInWords: true,
      taxSummary: 'auto',
      customerContact: 'hide',
      receiptCustomerContact: 'mask',
      upiQr: 'unpaid',
      receiptQr: 'ebill',
    });
  });

  it('degrades a corrupt stored blob to the defaults instead of failing every PDF', () => {
    expect(parseInvoiceSettings({ theme: 'neon' })).toEqual(InvoiceSettingsSchema.parse({}));
  });

  it('patches only what was sent: no default can reset a saved value', () => {
    expect(UpdateInvoiceSettingsSchema.parse({ theme: 'classic' })).toEqual({ theme: 'classic' });
    expect(UpdateInvoiceSettingsSchema.parse({})).toEqual({});
  });

  it('takes a brand colour as #RRGGBB, upper-cased, and null to go back to ink', () => {
    expect(UpdateInvoiceSettingsSchema.parse({ brandColor: '#1f6f5c' })).toEqual({ brandColor: '#1F6F5C' });
    expect(UpdateInvoiceSettingsSchema.parse({ brandColor: null })).toEqual({ brandColor: null });
    expect(UpdateInvoiceSettingsSchema.safeParse({ brandColor: 'teal' }).success).toBe(false);
  });

  it('holds business IDs to six, each with a value, and a label on custom ones', () => {
    const cin = { type: 'CIN', value: 'U18101KA2021PTC000000' };
    expect(UpdateInvoiceSettingsSchema.parse({ businessIds: [cin] })).toEqual({
      businessIds: [{ ...cin, label: '', onA4: true, onReceipt: false }],
    });
    expect(UpdateInvoiceSettingsSchema.safeParse({ businessIds: Array(7).fill(cin) }).success).toBe(false);
    expect(UpdateInvoiceSettingsSchema.safeParse({ businessIds: [{ type: 'CIN', value: ' ' }] }).success).toBe(false);
    expect(UpdateInvoiceSettingsSchema.safeParse({ businessIds: [{ type: 'CUSTOM', value: '123' }] }).success).toBe(false);
    expect(UpdateInvoiceSettingsSchema.safeParse({ businessIds: [{ type: 'CUSTOM', label: 'Drug lic.', value: '123' }] }).success).toBe(true);
  });

  it('never takes the signature image from a PATCH: only its upload sets it', () => {
    expect(UpdateInvoiceSettingsSchema.parse({ signature: { storageKey: 'x', url: 'y' } })).toEqual({});
  });

  it('accepts a blank or full return-policy URL and nothing else', () => {
    expect(UpdateInvoiceSettingsSchema.parse({ returnPolicyUrl: '' })).toEqual({ returnPolicyUrl: '' });
    expect(UpdateInvoiceSettingsSchema.safeParse({ returnPolicyUrl: 'brand.in/returns' }).success).toBe(false);
    expect(UpdateInvoiceSettingsSchema.parse({ returnPolicyUrl: 'https://brand.in/returns' })).toEqual({ returnPolicyUrl: 'https://brand.in/returns' });
  });
});
