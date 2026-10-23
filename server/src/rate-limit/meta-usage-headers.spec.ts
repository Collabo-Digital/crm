import { isMetaThrottleError, parseMetaUsageHeaders } from './meta-usage-headers';

describe('parseMetaUsageHeaders', () => {
  const ctx = { appId: 'app1' };

  it('reads the app-level header at the highest of the three metrics', () => {
    const h = new Headers({ 'x-app-usage': '{"call_count":28,"total_cputime":25,"total_time":61}' });
    expect(parseMetaUsageHeaders(h, ctx)).toEqual([
      { scope: { platform: 'meta', kind: 'app', id: 'app1' }, pct: 61 },
    ]);
  });

  it('reads business-use-case entries per object, with regain time and type', () => {
    const h = new Headers({
      'x-business-use-case-usage': JSON.stringify({
        waba_1: [{ type: 'whatsapp', call_count: 46, total_cputime: 10, total_time: 12, estimated_time_to_regain_access: 0 }],
        act_9: [{ type: 'ads_management', call_count: 100, total_cputime: 3, total_time: 3, estimated_time_to_regain_access: 7 }],
      }),
    });
    expect(parseMetaUsageHeaders(h, ctx)).toEqual([
      { scope: { platform: 'meta', kind: 'buc', id: 'waba_1' }, pct: 46, regainMinutes: undefined, type: 'whatsapp' },
      { scope: { platform: 'meta', kind: 'adacct', id: 'act_9' }, pct: 100, regainMinutes: 7, type: 'ads_management' },
    ]);
  });

  it('attributes page and ad-account headers to the ids the caller supplies', () => {
    const h = new Headers({
      'x-page-usage': '{"call_count":12,"total_cputime":1,"total_time":1}',
      'x-ad-account-usage': '{"acc_id_util_pct":9.67}',
    });
    expect(parseMetaUsageHeaders(h, { appId: 'app1', pageId: 'pg', adAccountId: 'act_1' })).toEqual([
      { scope: { platform: 'meta', kind: 'adacct', id: 'act_1' }, pct: 9.67, regainMinutes: undefined },
      { scope: { platform: 'meta', kind: 'page', id: 'pg' }, pct: 12 },
    ]);
  });

  it('skips headers it cannot attribute or parse', () => {
    const h = new Headers({ 'x-page-usage': '{"call_count":12}', 'x-app-usage': 'not json' });
    expect(parseMetaUsageHeaders(h, ctx)).toEqual([]);
    expect(parseMetaUsageHeaders(new Headers(), ctx)).toEqual([]);
  });

  it('accepts a plain record as well as a Headers object', () => {
    expect(parseMetaUsageHeaders({ 'x-app-usage': '{"call_count":5}' }, ctx)[0]?.pct).toBe(5);
  });

  it('clamps to 0..100', () => {
    expect(parseMetaUsageHeaders({ 'x-app-usage': '{"call_count":140}' }, ctx)[0]?.pct).toBe(100);
  });
});

describe('isMetaThrottleError', () => {
  it.each([4, 17, 32, 613])('code %s is a throttle', (code) => {
    expect(isMetaThrottleError(code)).toBe(true);
  });
  it.each([80004, 80007, 130429, 131048, 131056])('subcode %s is a throttle', (sub) => {
    expect(isMetaThrottleError(100, sub)).toBe(true);
    expect(isMetaThrottleError(sub)).toBe(true);
  });
  it('190 (dead token) and 100 (bad param) are not', () => {
    expect(isMetaThrottleError(190)).toBe(false);
    expect(isMetaThrottleError(100, 33)).toBe(false);
    expect(isMetaThrottleError()).toBe(false);
  });
});
