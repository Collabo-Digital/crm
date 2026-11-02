import {
  FIRST_SIGHTING_EVENT_WINDOW_MS,
  isOlderShopifyPayload,
  isWithinWindow,
} from './shopify-payload-age.util';

describe('isWithinWindow', () => {
  const now = Date.parse('2026-10-25T12:00:00Z');

  it('accepts an order created a few hours ago', () => {
    expect(isWithinWindow('2026-10-25T06:00:00+05:30', FIRST_SIGHTING_EVENT_WINDOW_MS, now)).toBe(true);
  });

  it('refuses a months-old order, so editing it does not message the customer', () => {
    expect(isWithinWindow('2026-04-02T10:00:00Z', FIRST_SIGHTING_EVENT_WINDOW_MS, now)).toBe(false);
  });

  it('treats a missing or unreadable time as not recent', () => {
    expect(isWithinWindow(undefined, FIRST_SIGHTING_EVENT_WINDOW_MS, now)).toBe(false);
    expect(isWithinWindow('', FIRST_SIGHTING_EVENT_WINDOW_MS, now)).toBe(false);
    expect(isWithinWindow('not a date', FIRST_SIGHTING_EVENT_WINDOW_MS, now)).toBe(false);
  });
});

describe('isOlderShopifyPayload', () => {
  const stored = new Date('2026-10-25T10:00:05Z');

  it('skips a late delivery carrying an older updated_at', () => {
    expect(isOlderShopifyPayload('2026-10-25T10:00:00Z', stored)).toBe(true);
    expect(isOlderShopifyPayload(new Date('2026-10-25T09:59:00Z'), stored)).toBe(true);
  });

  it('applies a newer payload and re-applies an identical redelivery', () => {
    expect(isOlderShopifyPayload('2026-10-25T10:01:00Z', stored)).toBe(false);
    expect(isOlderShopifyPayload('2026-10-25T10:00:05Z', stored)).toBe(false);
  });

  it('never skips when there is nothing to compare', () => {
    expect(isOlderShopifyPayload('2026-10-25T10:00:00Z', null)).toBe(false);
    expect(isOlderShopifyPayload(undefined, stored)).toBe(false);
    expect(isOlderShopifyPayload(null, stored)).toBe(false);
  });
});
