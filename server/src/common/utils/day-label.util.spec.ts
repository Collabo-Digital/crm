import { dayMonthLabel } from './day-label.util';

describe('dayMonthLabel', () => {
  it('writes the day before the month', () => {
    expect(dayMonthLabel(new Date('2026-10-21T00:00:00Z'))).toBe('21 Oct');
  });

  it('never reads as a month-first date early in the month', () => {
    expect(dayMonthLabel(new Date('2026-11-05T00:00:00Z'))).toBe('5 Nov');
  });

  it('reads the day in UTC, like the bucket keys', () => {
    expect(dayMonthLabel(new Date('2026-12-31T23:30:00Z'))).toBe('31 Dec');
  });
});
