import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata, UnauthorizedException, createParamDecorator } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ApiCaller, ApiKeysService, ApiScope } from './api-keys.service';

const SCOPES_KEY = 'api-scopes';
/** The scope a public API route needs. */
export const RequireApiScope = (scope: ApiScope) => SetMetadata(SCOPES_KEY, scope);

type WithCaller = Request & { apiCaller?: ApiCaller };

/** The calling key's organization and scopes, set by ApiKeyGuard. */
export const Caller = createParamDecorator((_: unknown, ctx: ExecutionContext): ApiCaller => (ctx.switchToHttp().getRequest<WithCaller>()).apiCaller!);

/**
 * /public/v1: `Authorization: Bearer ck_live_…` (or `X-Api-Key`). Routes are
 * also @Public(), so the session guards stand aside; this is the only check.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
    constructor(
        private readonly keys: ApiKeysService,
        private readonly reflector: Reflector,
    ) { }

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const req = context.switchToHttp().getRequest<WithCaller>();
        const header = req.headers.authorization;
        const raw = (typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : (req.headers['x-api-key'] as string | undefined))?.trim();
        const caller = raw ? await this.keys.authenticate(raw) : null;
        if (!caller) throw new UnauthorizedException('Send a valid API key as “Authorization: Bearer ck_live_…”.');
        const scope = this.reflector.get<ApiScope | undefined>(SCOPES_KEY, context.getHandler());
        if (scope && !caller.scopes.includes(scope)) throw new ForbiddenException(`This API key does not have the ${scope} scope.`);
        req.apiCaller = caller;
        return true;
    }
}
