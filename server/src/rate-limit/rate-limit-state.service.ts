import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChannelPlatform, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { BreakerOpenEvent, RateLimiterService, ScopeState } from './rate-limiter.service';
import { RateLimitScope } from './rate-limit.types';

/**
 * Makes limiter state visible to people.
 *
 *  - On every breaker opening, writes `rateLimitedUntil` / `rateLimitReason`
 *    on the affected channel row, so the channels page can say "rate limited
 *    until 14:32". Best-effort: a failed write is logged, never thrown.
 *  - `describe(channel)` lists the wallets a channel draws from with their
 *    live numbers, for `GET /channels/:id/rate-limit`.
 */
@Injectable()
export class RateLimitStateService implements OnModuleInit {
  private readonly logger = new Logger(RateLimitStateService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly limiter: RateLimiterService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    this.limiter.onBreakerOpen((e) => {
      void this.persistBreaker(e).catch((err) =>
        this.logger.warn(`could not persist breaker state: ${String(err)}`),
      );
    });
  }

  /** The wallets one channel spends from, broad to specific. */
  scopesFor(channel: {
    platform: ChannelPlatform;
    externalStoreUrl: string | null;
    credentials: Prisma.JsonValue | null;
  }): RateLimitScope[] {
    const creds = (channel.credentials ?? {}) as Record<string, unknown>;
    const appId = this.config.get<string>('meta.appId') ?? '';
    switch (channel.platform) {
      case ChannelPlatform.SHOPIFY: {
        const shop = shopDomainOf(channel.externalStoreUrl, creds);
        return shop ? [{ platform: 'shopify', kind: 'bucket', id: shop }] : [];
      }
      case ChannelPlatform.WHATSAPP: {
        const out: RateLimitScope[] = [];
        if (appId) out.push({ platform: 'meta', kind: 'app', id: appId });
        if (typeof creds.wabaId === 'string') out.push({ platform: 'meta', kind: 'buc', id: creds.wabaId });
        if (typeof creds.phoneNumberId === 'string') {
          out.push({ platform: 'meta', kind: 'phone', id: creds.phoneNumberId });
        }
        return out;
      }
      case ChannelPlatform.INSTAGRAM:
      case ChannelPlatform.FACEBOOK: {
        const out: RateLimitScope[] = [];
        if (appId) out.push({ platform: 'meta', kind: 'app', id: appId });
        if (typeof creds.pageId === 'string') out.push({ platform: 'meta', kind: 'page', id: creds.pageId });
        return out;
      }
      default:
        return [];
    }
  }

  async describe(channel: {
    id: string;
    platform: ChannelPlatform;
    externalStoreUrl: string | null;
    credentials: Prisma.JsonValue | null;
    rateLimitedUntil: Date | null;
    rateLimitReason: string | null;
  }): Promise<{
    channelId: string;
    platform: ChannelPlatform;
    mode: string;
    rateLimit: { limitedUntil: string | null; reason: string | null; active: boolean };
    scopes: ScopeState[];
  }> {
    const scopes = this.scopesFor(channel);
    const states = await Promise.all(scopes.map((s) => this.limiter.getState(s)));
    return {
      channelId: channel.id,
      platform: channel.platform,
      mode: this.limiter.mode(),
      rateLimit: describeRateLimit(channel.rateLimitedUntil, channel.rateLimitReason),
      scopes: states,
    };
  }

  private async persistBreaker(e: BreakerOpenEvent): Promise<void> {
    const ids = e.channelId ? [e.channelId] : await this.channelIdsFor(e.scope);
    if (ids.length === 0) return;
    await this.prisma.channel.updateMany({
      where: { id: { in: ids } },
      data: { rateLimitedUntil: new Date(e.untilMs), rateLimitReason: e.reason },
    });
  }

  /** Which channel rows a scope belongs to, when the caller did not say. */
  private async channelIdsFor(scope: RateLimitScope): Promise<string[]> {
    if (scope.platform === 'shopify') {
      const rows = await this.prisma.channel.findMany({
        where: {
          platform: ChannelPlatform.SHOPIFY,
          externalStoreUrl: { contains: scope.id },
        },
        select: { id: true },
      });
      return rows.map((r) => r.id);
    }
    // App-level limits belong to every merchant; do not stamp anyone.
    if (scope.kind === 'app') return [];
    const field =
      scope.kind === 'phone' ? 'phoneNumberId' : scope.kind === 'buc' ? 'wabaId' : scope.kind === 'page' ? 'pageId' : null;
    if (!field) return [];
    const rows = await this.prisma.channel.findMany({
      where: { credentials: { path: [field], equals: scope.id } },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }
}

export function describeRateLimit(
  until: Date | null | undefined,
  reason: string | null | undefined,
): { limitedUntil: string | null; reason: string | null; active: boolean } {
  const active = !!until && until.getTime() > Date.now();
  return {
    limitedUntil: until ? until.toISOString() : null,
    reason: active ? (reason ?? null) : null,
    active,
  };
}

function shopDomainOf(url: string | null, creds: Record<string, unknown>): string | null {
  if (typeof creds.shopDomain === 'string' && creds.shopDomain) return creds.shopDomain;
  if (!url) return null;
  return url.replace(/^https?:\/\//, '').replace(/\/.*$/, '') || null;
}
