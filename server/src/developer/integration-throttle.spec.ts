import { Controller, INestApplication, Param, Post } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { Throttle, ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import { hookTracker } from '../automation/automation-hooks.controller';
import { UserThrottlerGuard } from '../auth/user-throttler.guard';
import { apiKeyTracker } from './api-key.guard';

@Controller()
class Probe {
    @Post('key')
    @Throttle({ default: { ttl: 60_000, limit: 2, getTracker: apiKeyTracker } })
    key() {
        return 'ok';
    }

    @Post('hook/:token')
    @Throttle({ default: { ttl: 60_000, limit: 2, getTracker: hookTracker } })
    hook(@Param('token') token: string) {
        return token;
    }
}

describe('integration rate limits', () => {
    let app: INestApplication;

    beforeEach(async () => {
        const module = await Test.createTestingModule({
            imports: [ThrottlerModule.forRoot({ throttlers: [{ ttl: 60_000, limit: 60 }] })],
            controllers: [Probe],
            providers: [{ provide: APP_GUARD, useClass: UserThrottlerGuard }],
        }).compile();
        app = module.createNestApplication();
        await app.init();
    });

    afterEach(() => app.close());

    const statuses = async (n: number, send: () => request.Test) => {
        const out: number[] = [];
        for (let i = 0; i < n; i++) out.push((await send()).status);
        return out;
    };

    it('counts each API key on its own, though the calls come from one address', async () => {
        const post = (key: string) => () => request(app.getHttpServer()).post('/key').set('Authorization', `Bearer ${key}`);
        expect(await statuses(3, post('ck_live_a'))).toEqual([201, 201, 429]);
        expect(await statuses(1, post('ck_live_b'))).toEqual([201]);
        expect(await statuses(1, () => request(app.getHttpServer()).post('/key').set('X-Api-Key', 'ck_live_c'))).toEqual([201]);
    });

    it('counts calls without a key by address', async () => {
        expect(await statuses(3, () => request(app.getHttpServer()).post('/key'))).toEqual([201, 201, 429]);
    });

    it('counts each automation hook URL on its own', async () => {
        expect(await statuses(3, () => request(app.getHttpServer()).post('/hook/aaa'))).toEqual([201, 201, 429]);
        expect(await statuses(1, () => request(app.getHttpServer()).post('/hook/bbb'))).toEqual([201]);
    });
});
