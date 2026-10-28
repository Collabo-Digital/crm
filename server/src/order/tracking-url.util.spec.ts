import { BadRequestException } from '@nestjs/common';
import { normalizeTrackingUrl } from './tracking-url.util';
import { isKnownCourierUrl } from './known-couriers';

describe('normalizeTrackingUrl', () => {
  it('treats blank as no URL', () => {
    expect(normalizeTrackingUrl(undefined)).toBeNull();
    expect(normalizeTrackingUrl(null)).toBeNull();
    expect(normalizeTrackingUrl('   ')).toBeNull();
  });

  it('keeps a full https URL as typed (trimmed)', () => {
    expect(normalizeTrackingUrl(' https://www.delhivery.com/track/package/123 ')).toBe(
      'https://www.delhivery.com/track/package/123',
    );
    expect(normalizeTrackingUrl('https://track.example.in/?awb=9')).toBe('https://track.example.in/?awb=9');
  });

  it('adds https:// when the scheme is missing', () => {
    expect(normalizeTrackingUrl('track.courier.in/123')).toBe('https://track.courier.in/123');
  });

  it.each(['d', 'not a url', 'ftp://files.example.com/x', 'https://localhost', 'https://'])(
    'rejects %p with a 400',
    (input) => {
      expect(() => normalizeTrackingUrl(input)).toThrow(BadRequestException);
    },
  );

  it('names the bad value in the message', () => {
    expect(() => normalizeTrackingUrl('d')).toThrow(/Tracking URL "d" is not a valid link/);
  });

  it('refuses a plain http link, which anyone on the way could change', () => {
    expect(() => normalizeTrackingUrl('http://track.example.in/?awb=9')).toThrow(/not secure. Use the courier's https:\/\/ link/);
  });

  it.each([
    'https://127.0.0.1/track',
    'https://10.0.0.5/track',
    'https://169.254.169.254/latest/meta-data',
    'https://2130706433/track',
    'https://0x7f.1/track',
    'https://[::1]/track',
    '192.168.1.10/track',
    'https://printer.local/track',
    'https://admin.internal/track',
    'https://app.localhost/track',
    'https://printer.local./track',
  ])('refuses an IP address or internal name: %p', (input) => {
    expect(() => normalizeTrackingUrl(input)).toThrow(BadRequestException);
  });

  it('refuses a user@ part that dresses one site up as another', () => {
    expect(() => normalizeTrackingUrl('https://www.delhivery.com@pay-cod-fee.example/x')).toThrow(BadRequestException);
    expect(() => normalizeTrackingUrl('https://user:pass@track.example.in/x')).toThrow(BadRequestException);
  });

  it('refuses an address longer than any tracking link', () => {
    expect(() => normalizeTrackingUrl(`https://track.example.in/${'a'.repeat(2048)}`)).toThrow(/too long/);
  });
});

describe('isKnownCourierUrl', () => {
  it.each([
    'https://www.delhivery.com/track/package/123',
    'https://delhivery.com/track/package/123',
    'https://shiprocket.co/tracking/123',
    'https://www.bluedart.com/trackdartresult?awb=1',
    'https://www.indiapost.gov.in/_layouts/15/dop.portal.tracking/trackconsignment.aspx',
    'https://WWW.FEDEX.COM/fedextrack/?trknbr=1',
  ])('knows %p', (url) => {
    expect(isKnownCourierUrl(url)).toBe(true);
  });

  it.each([
    null,
    '',
    'not a url',
    'http://www.delhivery.com/track/package/123',
    'https://delhivery.com.pay-cod-fee.example/x',
    'https://notdelhivery.com/x',
    'https://www.delhivery.com@pay-cod-fee.example/x',
    'https://pay-cod-fee.example/?next=https://www.delhivery.com',
  ])('does not know %p', (url) => {
    expect(isKnownCourierUrl(url)).toBe(false);
  });
});
