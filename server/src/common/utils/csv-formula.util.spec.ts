import { neutraliseCsvFormula } from './csv-formula.util';

describe('neutraliseCsvFormula', () => {
  it.each([
    '=HYPERLINK("https://evil.example","Click")',
    '+91 cmd',
    '-2+3',
    '@SUM(A1:A2)',
    '\t=1+1',
    '\r=1+1',
  ])('makes %j plain text', (value) => {
    expect(neutraliseCsvFormula(value)).toBe(`'${value}`);
  });

  it.each(['Asha Rao', '-180.00', '-5', '1180.00', '', 'INV-26-27/000001'])(
    'leaves %j as it is',
    (value) => {
      expect(neutraliseCsvFormula(value)).toBe(value);
    },
  );
});
