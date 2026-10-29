import { createHash, createHmac } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { guardedRequest } from '../automation/engine/http-request';
import { ApiKeysService } from './api-keys.service';
import { PublicApiController } from './public-api.controller';
import { WebhooksService, webhookSignature } from './webhooks.service';

jest.mock('../automation/engine/http-request', () => ({ guardedRequest: jest.fn() }));
const request = guardedRequest as jest.MockedFunction<typeof guardedRequest>;

describe('webhook signatures', () => {
    it('sign the timestamp and the exact body with the endpoint’s secret', () => {
        const body = '{"event":"order.paid"}';
        const sig = webhookSignature('whsec_abc', body, 1761200000);
        expect(sig).toBe(`t=1761200000,v1=${createHmac('sha256', 'whsec_abc').update(`1761200000.${body}`).digest('hex')}`);
        expect(webhookSignature('whsec_other', body, 1761200000)).not.toBe(sig);
    });
});

describe('API keys', () => {
    function build() {
        const created: any[] = [];
        const prisma = {
            apiKey: {
                create: jest.fn(async ({ data }: any) => { created.push(data); return { id: 'k1', name: data.name, prefix: data.prefix, scopes: data.scopes, lastUsedAt: null, createdAt: new Date() }; }),
                findUnique: jest.fn(async ({ where }: any) => (created[0]?.hash === where.hash ? { id: 'k1', organizationId: 'org_1', scopes: created[0].scopes, revokedAt: null } : null)),
                updateMany: jest.fn(async () => ({ count: 1 })),
            },
        };
        return { service: new ApiKeysService(prisma as any), created };
    }

    it('are shown once and stored only as a hash', async () => {
        const { service, created } = build();
        const made = await service.create('org_1', 'u1', { name: 'Zapier', scopes: ['messages:send', 'contacts:write'] });
        expect(made.key).toMatch(/^ck_live_[\w-]{32}$/);
        expect(created[0].hash).toBe(createHash('sha256').update(made.key).digest('hex'));
        expect(JSON.stringify(created[0])).not.toContain(made.key);
        expect(made.prefix).toBe(made.key.slice(0, 12));
        await expect(service.authenticate(made.key)).resolves.toEqual({ keyId: 'k1', organizationId: 'org_1', scopes: ['messages:send', 'contacts:write'] });
        await expect(service.authenticate(`${made.key}x`)).resolves.toBeNull();
        await expect(service.authenticate('not-a-key')).resolves.toBeNull();
    });

    it('need known scopes', async () => {
        const { service } = build();
        await expect(service.create('org_1', 'u1', { name: 'x', scopes: ['everything'] })).rejects.toBeInstanceOf(BadRequestException);
        await expect(service.create('org_1', 'u1', { name: 'x', scopes: [] })).rejects.toBeInstanceOf(BadRequestException);
    });
});

describe('webhook delivery', () => {
    function build(over: { enabled?: boolean; failures?: number } = {}) {
        const updates: any[] = [];
        const endpointUpdates: any[] = [];
        const prisma = {
            webhookDelivery: {
                findUnique: jest.fn(async () => ({
                    id: 'd1', event: 'order.paid', status: 'PENDING', createdAt: new Date('2026-10-24T00:00:00Z'), payload: { order: { id: 'o1' } },
                    endpoint: { id: 'e1', url: 'https://hooks.example.com/collabo', secret: 'enc', enabled: over.enabled ?? true },
                })),
                update: jest.fn((args: any) => { updates.push(args); return Promise.resolve({}); }),
            },
            webhookEndpoint: {
                update: jest.fn((args: any) => { endpointUpdates.push(args); return Promise.resolve({ consecutiveFailures: over.failures ?? 1, enabled: true }); }),
            },
            $transaction: jest.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
        };
        const encryption = { decrypt: jest.fn(() => 'whsec_abc'), encrypt: jest.fn((v: string) => `enc:${v}`) };
        const service = new WebhooksService(prisma as any, encryption as any, { onOrder: jest.fn(), onPayment: jest.fn() } as any, { add: jest.fn() } as any, { get: () => undefined } as any);
        return { service, updates, endpointUpdates };
    }
    beforeEach(() => request.mockReset());

    it('posts the signed envelope and marks it sent', async () => {
        request.mockResolvedValue({ status: 204, body: null });
        const { service, updates, endpointUpdates } = build();
        await service.deliver('d1', 1, false);
        const call = request.mock.calls[0][0];
        const body = JSON.parse(call.body!);
        expect(body).toEqual({ id: 'd1', event: 'order.paid', created_at: '2026-10-24T00:00:00.000Z', data: { order: { id: 'o1' } } });
        const [t, v1] = call.headers!['collabo-signature'].split(',');
        expect(v1).toBe(`v1=${createHmac('sha256', 'whsec_abc').update(`${t.slice(2)}.${call.body}`).digest('hex')}`);
        expect(call.headers!['collabo-event']).toBe('order.paid');
        expect(call.allowPrivate).toBe(false);
        expect(updates[0].data.status).toBe('SENT');
        expect(endpointUpdates[0].data.consecutiveFailures).toBe(0);
    });

    it('throws so the queue retries, and on the last attempt marks it failed', async () => {
        request.mockResolvedValue({ status: 500, body: null });
        const { service, updates } = build();
        await expect(service.deliver('d1', 1, false)).rejects.toThrow(/answered 500/);
        expect(updates[0].data.status).toBeUndefined();
        const last = build();
        await expect(last.service.deliver('d1', 8, true)).resolves.toBeUndefined();
        expect(last.updates[0].data.status).toBe('FAILED');
        expect(last.endpointUpdates[0].data.consecutiveFailures).toEqual({ increment: 1 });
    });

    it('switches the endpoint off after 20 failed deliveries in a row', async () => {
        request.mockRejectedValue(new Error('connect ECONNREFUSED'));
        const { service, endpointUpdates } = build({ failures: 20 });
        await service.deliver('d1', 8, true);
        expect(endpointUpdates[1].data).toMatchObject({ enabled: false });
    });

    it('sends nothing for a switched-off endpoint', async () => {
        const { service, updates } = build({ enabled: false });
        await service.deliver('d1', 1, false);
        expect(request).not.toHaveBeenCalled();
        expect(updates[0].data.status).toBe('FAILED');
    });

    it('takes https URLs only, without credentials in them', async () => {
        const { service } = build();
        const create = (url: string) => service.create('org_1', { url, events: ['order.paid'] });
        await expect(create('http://hooks.example.com/x')).rejects.toBeInstanceOf(BadRequestException);
        await expect(create('https://user:pass@hooks.example.com/x')).rejects.toBeInstanceOf(BadRequestException);
        await expect(service.create('org_1', { url: 'https://hooks.example.com/x', events: ['everything'] })).rejects.toBeInstanceOf(BadRequestException);
    });
});

describe('webhook subscriptions through the public API', () => {
    const at = new Date('2026-10-24T00:00:00Z');
    const endpoint = (id: string, organizationId: string, apiKeyId: string | null) => ({
        id, organizationId, apiKeyId, url: `https://hooks.example.com/${id}?token=secret-${id}`, description: null, events: ['order.paid'],
        enabled: true, consecutiveFailures: 0, disabledReason: null, lastDeliveryAt: null, createdAt: at,
    });
    const rows = [
        endpoint('by_key_a', 'org_1', 'key_a'),
        endpoint('by_key_b', 'org_1', 'key_b'),
        endpoint('from_settings', 'org_1', null),
        endpoint('other_org', 'org_2', 'key_c'),
    ];
    function build() {
        const prisma = {
            webhookEndpoint: {
                findMany: jest.fn(({ where }: { where: { organizationId: string; apiKeyId?: string } }) =>
                    Promise.resolve(rows.filter((r) => r.organizationId === where.organizationId && (where.apiKeyId === undefined || r.apiKeyId === where.apiKeyId))),
                ),
            },
        };
        const webhooks = new WebhooksService(prisma as never, {} as never, { onOrder: jest.fn(), onPayment: jest.fn() } as never, {} as never, { get: () => undefined } as never);
        return { webhooks, api: new PublicApiController({} as never, webhooks) };
    }

    it('lists only the calling key’s own subscriptions, not other integrations’ receiving URLs', async () => {
        const { api } = build();
        const listed = await api.subscriptions({ keyId: 'key_a', organizationId: 'org_1', scopes: ['webhooks:manage'] });
        expect(listed.map((w) => w.id)).toEqual(['by_key_a']);
        expect(JSON.stringify(listed)).not.toContain('secret-by_key_b');
    });

    it('lists nothing for a key that made no subscriptions', async () => {
        const { api } = build();
        await expect(api.subscriptions({ keyId: 'key_new', organizationId: 'org_1', scopes: ['webhooks:manage'] })).resolves.toEqual([]);
    });

    it('still lists every webhook of the organization in Settings', async () => {
        const { webhooks } = build();
        expect((await webhooks.list('org_1')).map((w) => w.id)).toEqual(['by_key_a', 'by_key_b', 'from_settings']);
    });
});
