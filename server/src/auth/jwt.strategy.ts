import { Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { JwtPayload, SessionPayload } from './interfaces/jwt-payload.interface';
import { extractGrants } from './permissions';
import { ACTIVE_MEMBERSHIP } from './active-membership';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
    constructor(
        config: ConfigService,
        private readonly redis: RedisService,
        private readonly prisma: PrismaService,
    ) {
        super({
            jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
            ignoreExpiration: false,
            secretOrKey: config.get<string>('jwt.accessSecret')!,
        });
    }

    async validate(payload: JwtPayload): Promise<SessionPayload> {
        // The signature only proves we issued this token. The session lookup
        // proves it has not been logged out or revoked since — without it an
        // access token kept working after logout, password reset and admin
        // force-logout until it expired.
        //
        // Fails closed, but a Redis outage is a 503, not a 401: the client
        // treats 401 as "refresh, then sign out", which would log every user
        // out on a Redis blip.
        //
        // A support session also lasts only while the admin session it was
        // started from does, so revoking the admin ends it on the next request
        // rather than when its access token expires. Sessions started before
        // that origin was recorded carry none, as at refresh.
        let active: boolean;
        try {
            active = !!payload.sid && (await this.redis.isAuthSessionActive(payload.sid, payload.sub));
            if (active && payload.impersonatedBy && payload.impersonatorSid) {
                active = await this.redis.isAuthSessionActive(payload.impersonatorSid, payload.impersonatedBy);
            }
        } catch {
            throw new ServiceUnavailableException('Authentication is temporarily unavailable');
        }
        if (!active) throw new UnauthorizedException('Session expired');

        // Try Redis cache first (sub-millisecond) — but ONLY when it holds the
        // org this token was minted for.
        //
        // The session cache is keyed by userId alone and `switchOrg` overwrites
        // that single entry for the whole user. Returning it unconditionally
        // meant a second tab switching workspace silently re-pointed THIS
        // request's orgId, role and vendorScope: a user who is VIEWER in org A
        // and ADMIN in org B would act as an admin in the tab still showing A,
        // with no error and the correct org name on screen.
        //
        // On a mismatch we fall through to the DB path below, which resolves
        // the membership for `payload.orgId` and re-caches. Tokens minted
        // before any org exists (onboarding) carry no orgId and still use the
        // fast path.
        // Privilege flags come from the signed token, never the shared cache.
        // The cache is keyed by userId alone, so the session written by
        // `startImpersonation` was also served to the target user's OWN token:
        // it carried `impersonatedBy`, passed SuperAdminGuard and let them call
        // `stop-impersonating` to receive the super admin's tokens.
        const flags = {
            sid: payload.sid,
            isSuperAdmin: payload.isSuperAdmin === true,
            impersonatedBy: payload.impersonatedBy,
            impersonatorSid: payload.impersonatorSid,
        };

        try {
            const cached = await this.redis.getSession<SessionPayload>(payload.sub);
            if (cached && (!payload.orgId || cached.orgId === payload.orgId)) {
                return { ...cached, ...flags };
            }
        } catch {
            // Redis down — fall through to DB
        }

        // Cache miss — load from DB. The revision is read first, so what is
        // loaded is cached only if no role change or removal evicted the
        // session meanwhile (see RedisService.setSession).
        let revision: string | null = null;
        try {
            revision = await this.redis.sessionRevision(payload.sub);
        } catch {
            // Redis down — answer from the DB without caching
        }
        const user = await this.prisma.user.findFirst({
            where: { id: payload.sub, deletedAt: null },
            include: {
                memberships: {
                    where: ACTIVE_MEMBERSHIP,
                    include: { organization: true },
                },
            },
        });

        if (!user) throw new UnauthorizedException('User not found');

        // Honour the org the token was minted for (login/switchOrg set
        // payload.orgId) — otherwise a cache miss silently snaps a multi-org
        // user back to their first org (and its role). A token naming an org
        // the user is no longer an active member of is rejected: falling back
        // to another membership ran the request in a different tenant while
        // the UI still showed the old one. Only tokens minted before any org
        // existed (onboarding) carry no orgId and take the first membership.
        const membership = payload.orgId
            ? user.memberships.find((m) => m.organizationId === payload.orgId)
            : user.memberships[0];
        if (payload.orgId && !membership) {
            throw new UnauthorizedException('You no longer have access to this workspace');
        }
        const session: SessionPayload = {
            sub: user.id,
            email: user.email,
            orgId: membership?.organizationId,
            role: membership?.role,
            vendorScope: membership?.vendorScope ?? undefined,
            permissions: extractGrants(membership?.permissions),
            emailVerified: user.emailVerified,
            memberships: user.memberships.map((m) => ({
                orgId: m.organizationId,
                role: m.role,
                vendorScope: m.vendorScope ?? undefined,
                permissions: extractGrants(m.permissions),
            })),
        };

        // Cache for subsequent requests (ignore errors)
        if (revision !== null) {
            this.redis.setSession(user.id, session as unknown as Record<string, unknown>, revision).catch(() => {});
        }

        return { ...session, ...flags };
    }
}