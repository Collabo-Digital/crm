import { pulledBarcodePatch } from './pulled-barcode.util';

/**
 * The pull runs for every full sync AND every `products/update` webhook, so
 * whatever the push sends comes straight back through here seconds later.
 * The contract is about provenance as much as value: a code must not change
 * its source just because Shopify echoed it.
 */
describe('pulledBarcodePatch', () => {
  it('keeps a GENERATED code when Shopify has none', () => {
    expect(
      pulledBarcodePatch(null, {
        barcode: '000123',
        barcodeSource: 'GENERATED',
      }),
    ).toEqual({});
    expect(
      pulledBarcodePatch('', {
        barcode: '000123',
        barcodeSource: 'GENERATED',
      }),
    ).toEqual({});
  });

  it('clears a MANUAL, SHOPIFY or unclassified code when Shopify has none', () => {
    const cleared = { barcode: null, barcodeSource: null };
    expect(
      pulledBarcodePatch(null, {
        barcode: 'ABC',
        barcodeSource: 'MANUAL',
      }),
    ).toEqual(cleared);
    expect(
      pulledBarcodePatch(null, {
        barcode: 'ABC',
        barcodeSource: 'SHOPIFY',
      }),
    ).toEqual(cleared);
    expect(pulledBarcodePatch(null, { barcode: 'ABC', barcodeSource: null })).toEqual(cleared);
  });

  it('leaves provenance alone when Shopify echoes the code we pushed', () => {
    // The round trip after a push: GENERATED must stay GENERATED, MANUAL must
    // stay MANUAL, a legacy NULL source stays NULL.
    expect(
      pulledBarcodePatch('000123', {
        barcode: '000123',
        barcodeSource: 'GENERATED',
      }),
    ).toEqual({});
    expect(
      pulledBarcodePatch('890ABC', {
        barcode: '890ABC',
        barcodeSource: 'MANUAL',
      }),
    ).toEqual({});
    expect(
      pulledBarcodePatch('890ABC', {
        barcode: '890ABC',
        barcodeSource: null,
      }),
    ).toEqual({});
  });

  it('takes a different code from Shopify as SHOPIFY, whatever we held', () => {
    const taken = { barcode: '8901234567890', barcodeSource: 'SHOPIFY' };
    expect(
      pulledBarcodePatch('8901234567890', {
        barcode: '000123',
        barcodeSource: 'GENERATED',
      }),
    ).toEqual(taken);
    expect(
      pulledBarcodePatch('8901234567890', {
        barcode: 'ABC',
        barcodeSource: 'MANUAL',
      }),
    ).toEqual(taken);
    expect(
      pulledBarcodePatch('8901234567890', {
        barcode: null,
        barcodeSource: null,
      }),
    ).toEqual(taken);
  });

  it('treats a variant the CRM has never seen as Shopify-sourced', () => {
    expect(pulledBarcodePatch('8901234567890', undefined)).toEqual({
      barcode: '8901234567890',
      barcodeSource: 'SHOPIFY',
    });
    expect(pulledBarcodePatch(null, undefined)).toEqual({
      barcode: null,
      barcodeSource: null,
    });
  });
});
