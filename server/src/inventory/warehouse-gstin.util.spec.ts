import { warehouseGstinMismatch } from './warehouse-gstin.util';

const MH = { stateCode: '27', stateName: 'Maharashtra' };

/**
 * Guards the one rule that makes a warehouse-GSTIN link legally meaningful:
 * an additional place of business lives in the SAME state as the registration
 * it belongs to. Without this a merchant could file a Bengaluru godown's
 * dispatches under a Maharashtra GSTIN.
 */
describe('warehouseGstinMismatch', () => {
  it('allows an unlinked warehouse whatever its address says', () => {
    expect(warehouseGstinMismatch({ stateCode: '29' }, null)).toBeNull();
    expect(warehouseGstinMismatch({ stateCode: '29' }, undefined)).toBeNull();
  });

  it('allows an address with no resolvable state — partial input is not a mismatch', () => {
    expect(warehouseGstinMismatch({ city: 'Nashik' }, MH)).toBeNull();
    expect(warehouseGstinMismatch(null, MH)).toBeNull();
    expect(warehouseGstinMismatch({ provinceCode: 'ZZ' }, MH)).toBeNull();
  });

  it('allows a matching state in every address notation', () => {
    expect(warehouseGstinMismatch({ stateCode: '27' }, MH)).toBeNull();
    expect(warehouseGstinMismatch({ provinceCode: 'MH' }, MH)).toBeNull();
    expect(warehouseGstinMismatch({ province_code: 'MH' }, MH)).toBeNull();
  });

  it('reports a cross-state link and names both states', () => {
    expect(warehouseGstinMismatch({ provinceCode: 'KA' }, MH)).toBe(
      'This GSTIN is for Maharashtra but the location is in Karnataka.',
    );
  });
});
