import { createHash } from 'node:crypto';
import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata, UnauthorizedException, createParamDecorator } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectThrottlerStorage, ThrottlerException, ThrottlerStorage } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { planFeatures } from '../billing/pricing';
import { ApiCaller, ApiKeysService, ApiScope } from './api-keys.service';

const SCOPES_KEY = 'api-scopes';
/** The scope a public API route needs. */
export const RequireApiScope = (scope: ApiScope) => SetMetadata(SCOPES_KEY, scope);

type WithCaller = Request & { apiCaller?: ApiCaller };

/**
 * Calls each key may make to each endpoint in a minute, on the plan with the
 * most (Scale and Enterprise). The controller's throttle, which runs before
 * the key is checked, allows this; ApiKeyGuard holds other plans to theirs.
 */
export const PUBLIC_API_CEILING = 2_000;
const MINUTE_MS = 60_000;
/** Calls without a key, counted by address. */
const WITHOUT_KEY = 600;

/** The controller throttle's limit: the ceiling for a presented key, 600 by address without one. */
export const publicApiLimit = (context: ExecutionContext): number =>
    presentedKey(context.switchToHttp().getRequest<Request>()) ? PUBLIC_API_CEILING : WITHOUT_KEY;

/** The calling key's organization and scopes, set by ApiKeyGuard. */
export const Caller = createParamDecorator((_: unknown, ctx: ExecutionContext): ApiCaller => (ctx.switchToHttp().getRequest<WithCaller>()).apiCaller!);

const presentedKey = (req: Request): string | undefined => {
    const header = req.headers.authorization;
    return (typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : (req.headers['x-api-key'] as string | undefined))?.trim();
};

/**
 * Rate limit bucket for /public/v1: the key presented, so integrations that
 * share an address (Zapier, Make, a hosting provider) do not share a limit.
 * The throttler runs before ApiKeyGuard, so the key is not verified yet.
 */
export const apiKeyTracker = (req: Record<string, any>): string => {
    const raw = presentedKey(req as Request);
    return raw ? `api-key:${createHash('sha256').update(raw).digest('hex')}` : (req.ip as string);
};

/**
 * /public/v1: `Authorization: Bearer ck_live_…` (or `X-Api-Key`). Routes are
 * also @Public(), so the session guards stand aside; this is the only check.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
    constructor(
        private readonly keys: ApiKeysService,
        private readonly reflector: Reflector,
        @InjectThrottlerStorage() private readonly storage: ThrottlerStorage,
    ) { }

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const req = context.switchToHttp().getRequest<WithCaller>();
        const raw = presentedKey(req);
        const caller = raw ? await this.keys.authenticate(raw) : null;
        if (!caller) throw new UnauthorizedException('Send a valid API key as “Authorization: Bearer ck_live_…”.');
        const scope = this.reflector.get<ApiScope | undefined>(SCOPES_KEY, context.getHandler());
        if (scope && !caller.scopes.includes(scope)) throw new ForbiddenException(`This API key does not have the ${scope} scope.`);
        req.apiCaller = caller;
        await this.holdToPlan(context, caller);
        return true;
    }

    /** The key's plan limit on this endpoint (planFeatures), counted and answered like the throttle's. */
    private async holdToPlan(context: ExecutionContext, caller: ApiCaller): Promise<void> {
        const limit = planFeatures(caller.plan).apiRequestsPerMinute;
        if (limit >= PUBLIC_API_CEILING) return;
        const key = `public-api-plan:${caller.keyId}:${context.getClass().name}:${context.getHandler().name}`;
        const hit = await this.storage.increment(key, MINUTE_MS, limit, MINUTE_MS, 'plan');
        const res = context.switchToHttp().getResponse<Response>();
        res.header('X-RateLimit-Limit', String(limit));
        res.header('X-RateLimit-Remaining', String(Math.max(0, limit - hit.totalHits)));
        res.header('X-RateLimit-Reset', String(hit.timeToExpire));
        if (hit.isBlocked) {
            res.header('Retry-After', String(hit.timeToBlockExpire));
            throw new ThrottlerException();
        }
    }
}
