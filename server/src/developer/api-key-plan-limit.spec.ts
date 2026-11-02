import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ThrottlerException, ThrottlerStorageService } from '@nestjs/throttler';
import { BillingPlan } from '@prisma/client';

import { ApiKeyGuard, publicApiLimit } from './api-key.guard';
import { PublicApiController } from './public-api.controller';

describe('ApiKeyGuard plan limits', () => {
    let storage: ThrottlerStorageService;
    beforeEach(() => {
        storage = new ThrottlerStorageService();
    });
    afterEach(() => storage.onApplicationShutdown());

    function build(plan: BillingPlan) {
        const keys = { authenticate: jest.fn(() => Promise.resolve({ keyId: 'key_1', organizationId: 'org_1', scopes: ['contacts:read', 'templates:read'], plan })) };
        const guard = new ApiKeyGuard(keys as never, new Reflector(), storage);
        const headers: Record<string, string> = {};
        const call = (name: string) =>
            guard.canActivate({
                getClass: () => PublicApiController,
                getHandler: (): unknown => Reflect.get(PublicApiController.prototype, name),
                switchToHttp: () => ({
                    getRequest: () => ({ headers: { authorization: 'Bearer ck_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } }),
                    getResponse: () => ({ header: (name: string, value: string) => (headers[name] = value) }),
                }),
            } as unknown as ExecutionContext);
        return { call, headers };
    }
    const many = async (n: number, run: () => Promise<boolean>) => {
        for (let i = 0; i < n; i++) await run();
    };

    it('holds a key on Starter, Growth or Pro to 600 calls a minute on each endpoint', async () => {
        const { call, headers } = build(BillingPlan.GROWTH);
        await many(600, () => call('contacts'));
        expect(headers['X-RateLimit-Limit']).toBe('600');
        expect(headers['X-RateLimit-Remaining']).toBe('0');
        await expect(call('contacts')).rejects.toBeInstanceOf(ThrottlerException);
        expect(Number(headers['Retry-After'])).toBeGreaterThan(0);
        // Another endpoint has its own count.
        await expect(call('templates')).resolves.toBe(true);
    });

    it('lets the controller\'s throttle allow 2,000 a minute for a key, and 600 by address without one', () => {
        const withHeaders = (headers: Record<string, string>) => ({ switchToHttp: () => ({ getRequest: () => ({ headers }) }) }) as unknown as ExecutionContext;
        expect(publicApiLimit(withHeaders({ authorization: 'Bearer ck_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }))).toBe(2_000);
        expect(publicApiLimit(withHeaders({ 'x-api-key': 'ck_live_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }))).toBe(2_000);
        expect(publicApiLimit(withHeaders({}))).toBe(600);
    });

    it('leaves a key on Scale or Enterprise to the controller\'s 2,000 a minute', async () => {
        for (const plan of [BillingPlan.SCALE, BillingPlan.ADVANCE]) {
            const { call, headers } = build(plan);
            await many(700, () => call('contacts'));
            expect(headers['X-RateLimit-Limit']).toBeUndefined();
        }
    });
});
