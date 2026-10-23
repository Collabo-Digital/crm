import { createHash, randomBytes } from 'node:crypto';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** What a key may do. A key gets the ones chosen when it was made. */
export const API_SCOPES = ['messages:send', 'contacts:read', 'contacts:write', 'templates:read', 'webhooks:manage'] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export interface ApiCaller {
    keyId: string;
    organizationId: string;
    scopes: string[];
}

const hashOf = (key: string) => createHash('sha256').update(key).digest('hex');

/**
 * Keys for the public API: `ck_live_` and 32 random characters, shown once.
 * Only the SHA-256 is stored, so a leaked database does not leak keys.
 */
@Injectable()
export class ApiKeysService {
    constructor(private readonly prisma: PrismaService) { }

    async list(orgId: string) {
        return this.prisma.apiKey.findMany({
            where: { organizationId: orgId, revokedAt: null },
            orderBy: { createdAt: 'desc' },
            select: { id: true, name: true, prefix: true, scopes: true, lastUsedAt: true, createdAt: true },
        });
    }

    async create(orgId: string, userId: string, input: { name: string; scopes: string[] }) {
        const scopes = [...new Set(input.scopes)];
        if (!scopes.length || scopes.some((s) => !(API_SCOPES as readonly string[]).includes(s))) {
            throw new BadRequestException(`Choose what the key may do: ${API_SCOPES.join(', ')}.`);
        }
        const key = `ck_live_${randomBytes(24).toString('base64url')}`;
        const row = await this.prisma.apiKey.create({
            data: { organizationId: orgId, name: input.name.trim(), prefix: key.slice(0, 12), hash: hashOf(key), scopes, createdById: userId },
            select: { id: true, name: true, prefix: true, scopes: true, lastUsedAt: true, createdAt: true },
        });
        return { ...row, key };
    }

    /** Revoked keys stop working at once; webhooks they made stop with them. */
    async revoke(orgId: string, id: string) {
        const done = await this.prisma.apiKey.updateMany({ where: { id, organizationId: orgId, revokedAt: null }, data: { revokedAt: new Date() } });
        if (!done.count) throw new NotFoundException('API key not found');
        await this.prisma.webhookEndpoint.updateMany({ where: { organizationId: orgId, apiKeyId: id, enabled: true }, data: { enabled: false, disabledReason: 'The API key that made it was revoked.' } });
    }

    /** The organization and scopes behind a key, or null. Marks it used at most once a minute. */
    async authenticate(raw: string): Promise<ApiCaller | null> {
        if (!/^ck_live_[\w-]{20,64}$/.test(raw)) return null;
        const key = await this.prisma.apiKey.findUnique({ where: { hash: hashOf(raw) }, select: { id: true, organizationId: true, scopes: true, revokedAt: true } });
        if (!key || key.revokedAt) return null;
        await this.prisma.apiKey.updateMany({
            where: { id: key.id, OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: new Date(Date.now() - 60_000) } }] },
            data: { lastUsedAt: new Date() },
        });
        return { keyId: key.id, organizationId: key.organizationId, scopes: key.scopes };
    }
}
