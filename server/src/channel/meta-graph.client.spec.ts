import type { ConfigService } from '@nestjs/config';
import type { RateLimiterService } from '../rate-limit/rate-limiter.service';
import { MetaGraphClient } from './meta-graph.client';
import { MetaGraphError, metaScope } from './meta-graph.types';
import { Lease, MetaObservation, Priority, RateLimitScope, RateLimitedError } from '../rate-limit/rate-limit.types';

function json(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

type ReserveOpts = { priority: Priority; cost?: number; channelId?: string };
type BreakerOpts = { hintMs?: number; reason: string; channelId?: string };

function build() {
  const lease: Lease = { leaseIds: ['a', 'b', 'c'], costs: [0.5, 0.5, 1], scopes: [], priority: Priority.INTERACTIVE, noop: false };
  const limiter = {
    reserve: jest.fn<Promise<Lease>, [RateLimitScope[], ReserveOpts]>().mockResolvedValue(lease),
    settle: jest.fn<Promise<void>, [Lease, { actualCost?: number }?]>().mockResolvedValue(undefined),
    observe: jest.fn<Promise<void>, [RateLimitScope, MetaObservation]>().mockResolvedValue(undefined),
    openBreaker: jest.fn<Promise<number>, [RateLimitScope, BreakerOpts]>().mockResolvedValue(Date.now() + 30_000),
    recordThrottled: jest.fn<Promise<void>, [RateLimitScope, Record<string, unknown>]>().mockResolvedValue(undefined),
  };
  const table: Record<string, string> = { 'meta.appId': 'app1', 'meta.graphVersion': 'v21.0' };
  const config = { get: (k: string) => table[k] } as unknown as ConfigService;
  const client = new MetaGraphClient(config, limiter as unknown as RateLimiterService);
  const fetchMock = jest.fn<Promise<Response>, [URL, RequestInit]>();
  global.fetch = fetchMock as unknown as typeof fetch;
  const scopes = [metaScope.app('app1'), metaScope.buc('waba1'), metaScope.phone('919')];
  return { client, limiter, fetchMock, scopes };
}

describe('MetaGraphClient', () => {
  it('reserves every scope, sends the token as a Bearer header, observes usage headers, settles', async () => {
    const { client, limiter, fetchMock, scopes } = build();
    fetchMock.mockResolvedValueOnce(
      json(
        { messages: [{ id: 'wamid.1' }] },
        {
          headers: {
            'x-app-usage': '{"call_count":28,"total_cputime":25,"total_time":25}',
            'x-business-use-case-usage':
              '{"waba1":[{"type":"whatsapp","call_count":46,"total_cputime":1,"total_time":1,"estimated_time_to_regain_access":0}]}',
          },
        },
      ),
    );

    const res = await client.request<{ messages: { id: string }[] }>({
      method: 'POST',
      path: '/919/messages',
      accessToken: 'tok',
      body: { to: '+91' },
      scopes,
      priority: Priority.INTERACTIVE,
      channelId: 'ch1',
    });

    expect(res.data.messages[0].id).toBe('wamid.1');
    expect(limiter.reserve).toHaveBeenCalledWith(scopes, { priority: Priority.INTERACTIVE, cost: 1, channelId: 'ch1' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://graph.facebook.com/v21.0/919/messages');
    expect(String(url)).not.toContain('access_token');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(limiter.observe).toHaveBeenCalledTimes(2);
    expect(limiter.observe.mock.calls[0][0]).toEqual(metaScope.app('app1'));
    expect(limiter.observe.mock.calls[0][1]).toMatchObject({ pct: 28 });
    expect(limiter.observe.mock.calls[1][0]).toEqual(metaScope.buc('waba1'));
    expect(limiter.settle).toHaveBeenCalledTimes(1);
    expect(limiter.settle.mock.calls[0][1]).toEqual({});
  });

  it('throttle code 4 records it, opens a breaker on the app wallet and throws RateLimitedError', async () => {
    const { client, limiter, fetchMock, scopes } = build();
    fetchMock.mockResolvedValueOnce(
      json({ error: { message: 'Application request limit reached', code: 4 } }, {
        status: 400,
        headers: { 'x-app-usage': '{"call_count":100,"total_cputime":10,"total_time":10}' },
      }),
    );
    const err: unknown = await client.request({ method: 'GET', path: '/me', accessToken: 't', scopes }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect((err as RateLimitedError).scope).toEqual(metaScope.app('app1'));
    expect(limiter.recordThrottled).toHaveBeenCalled();
    expect(limiter.openBreaker.mock.calls[0][0]).toEqual(metaScope.app('app1'));
    expect(limiter.openBreaker.mock.calls[0][1]).toMatchObject({ reason: 'META_4' });
  });

  it('a WhatsApp throughput subcode opens the breaker on the most specific scope, honouring regain time', async () => {
    const { client, limiter, fetchMock, scopes } = build();
    fetchMock.mockResolvedValueOnce(
      json({ error: { message: 'Rate limit hit', code: 130429, error_subcode: 130429 } }, {
        status: 400,
        headers: {
          'x-business-use-case-usage':
            '{"waba1":[{"type":"whatsapp","call_count":100,"total_cputime":1,"total_time":1,"estimated_time_to_regain_access":7}]}',
        },
      }),
    );
    await expect(
      client.request({ method: 'POST', path: '/919/messages', accessToken: 't', scopes, body: {} }),
    ).rejects.toBeInstanceOf(RateLimitedError);
    expect(limiter.openBreaker.mock.calls[0][0]).toEqual(metaScope.buc('waba1'));
    expect(limiter.openBreaker.mock.calls[0][1]).toMatchObject({ hintMs: 7 * 60_000 });
  });

  it('190 is a dead token, not a rate limit', async () => {
    const { client, limiter, fetchMock, scopes } = build();
    fetchMock.mockResolvedValueOnce(json({ error: { message: 'Invalid OAuth access token', code: 190 } }, { status: 401 }));
    const err: unknown = await client.request({ method: 'GET', path: '/me', accessToken: 't', scopes }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MetaGraphError);
    expect(err).toMatchObject({ code: 'AUTH_FAILED', metaCode: 190 });
    expect(limiter.openBreaker).not.toHaveBeenCalled();
  });

  it('code 2 is retried with a fresh reservation, then succeeds', async () => {
    const { client, limiter, fetchMock, scopes } = build();
    fetchMock
      .mockResolvedValueOnce(json({ error: { message: 'Temporary', code: 2 } }, { status: 500 }))
      .mockResolvedValueOnce(json({ id: '1' }));
    const res = await client.request({ method: 'GET', path: '/me', accessToken: 't', scopes });
    expect(res.data).toEqual({ id: '1' });
    expect(limiter.reserve).toHaveBeenCalledTimes(2);
    expect(limiter.settle).toHaveBeenCalledTimes(2);
  });

  it('other API errors surface with Meta code and subcode', async () => {
    const { client, fetchMock, scopes } = build();
    fetchMock.mockResolvedValueOnce(
      json({ error: { message: 'Template name does not exist', code: 132, error_subcode: 2494040 } }, { status: 400 }),
    );
    const err: unknown = await client
      .request({ method: 'POST', path: '/919/messages', accessToken: 't', scopes, body: {} })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MetaGraphError);
    expect(err).toMatchObject({ code: 'API_ERROR', metaCode: 132, subcode: 2494040, httpStatus: 400 });
  });

  it('accepts an absolute url (paging.next) and merges query parameters', async () => {
    const { client, fetchMock, scopes } = build();
    fetchMock.mockResolvedValueOnce(json({ data: [] }));
    await client.request({
      method: 'GET',
      url: 'https://graph.facebook.com/v21.0/me/accounts?limit=100',
      query: { fields: 'id' },
      accessToken: 't',
      scopes,
    });
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.get('limit')).toBe('100');
    expect(url.searchParams.get('fields')).toBe('id');
  });
});
