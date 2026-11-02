import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ThrottlerException, ThrottlerStorageService } from '@nestjs/throttler';
import { BillingPlan } from '@prisma/client';

import { ApiKeyGuard } from './api-key.guard';
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
        const call = (handler: (...args: never[]) => unknown) =>
            guard.canActivate({
                getClass: () => PublicApiController,
                getHandler: () => handler,
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
        await many(600, () => call(PublicApiController.prototype.contacts));
        expect(headers['X-RateLimit-Limit']).toBe('600');
        expect(headers['X-RateLimit-Remaining']).toBe('0');
        await expect(call(PublicApiController.prototype.contacts)).rejects.toBeInstanceOf(ThrottlerException);
        expect(Number(headers['Retry-After'])).toBeGreaterThan(0);
        // Another endpoint has its own count.
        await expect(call(PublicApiController.prototype.templates)).resolves.toBe(true);
    });

    it('leaves a key on Scale or Enterprise to the controller\'s 2,000 a minute', async () => {
        for (const plan of [BillingPlan.SCALE, BillingPlan.ADVANCE]) {
            const { call, headers } = build(plan);
            await many(700, () => call(PublicApiController.prototype.contacts));
            expect(headers['X-RateLimit-Limit']).toBeUndefined();
        }
    });
});
