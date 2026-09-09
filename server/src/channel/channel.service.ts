import {
  BadRequestException,
  Injectable,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ChannelPlatform, ChannelStatus, SyncStatus, UserRole, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ShopifyOAuthService } from './shopify-oauth.service';
import { InstagramOAuthService } from './instagram-oauth.service';
import { UpdateChannelDto } from './dto/update-channel.dto';
import { UpdateSyncSettingsDto } from './dto/update-sync-settings.dto';
import {
  describeAccount,
  deriveConnectionState,
  readTokenExpiry,
} from './channel-connection.util';
import {
  PULL_ENTITY_TYPES,
  PUSH_ENTITY_TYPES,
} from './shopify-sync.service';

/**
 * Who is looking. Carried explicitly rather than read from a request-scoped
 * context so every read states whose view it is returning.
 */
export interface ChannelViewer {
  userId: string;
  role: UserRole | undefined;
}

@Injectable()
export class ChannelService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly shopifyOAuth: ShopifyOAuthService,
    private readonly instagramOAuth: InstagramOAuthService,
  ) { }

  /**
   * Project a channel row for the API: derived connection state and a
   * non-secret account summary in, `credentials` out.
   *
   * The strip is the point — `credentials` holds encrypted tokens, and the only
   * safe way to expose an account is to whitelist display fields out of it,
   * which is what `describeAccount` does.
   */
  private toListItem(channel: {
    id: string;
    name: string;
    platform: ChannelPlatform;
    status: ChannelStatus;
    isEnabled: boolean;
    credentials: Prisma.JsonValue;
    metadata: Prisma.JsonValue;
    externalStoreId: string | null;
    externalStoreUrl: string | null;
    connectedAt: Date | null;
    lastError: string | null;
    lastSyncedAt: Date | null;
    syncStatus: SyncStatus;
    createdAt: Date;
    updatedAt: Date;
  }) {
    const { credentials, metadata, ...rest } = channel;
    const tokenExpiresAt = readTokenExpiry(credentials);
    const meta = (metadata ?? null) as Record<string, unknown> | null;
    const disconnectedAt =
      typeof meta?.disconnectedAt === 'string' ? meta.disconnectedAt : null;

    return {
      ...rest,
      connectionState: deriveConnectionState(
        { status: channel.status, tokenExpiresAt },
        new Date(),
      ),
      account: describeAccount(channel.platform, credentials, metadata),
      tokenExpiresAt,
      disconnectedAt,
    };
  }

  /** The columns `toListItem` needs. */
  private static readonly LIST_SELECT = {
    id: true,
    name: true,
    platform: true,
    status: true,
    isEnabled: true,
    credentials: true,
    metadata: true,
    externalStoreId: true,
    externalStoreUrl: true,
    connectedAt: true,
    lastError: true,
    lastSyncedAt: true,
    syncStatus: true,
    ownerUserId: true,
    createdAt: true,
    updatedAt: true,
  } as const;

  /**
   * Which channels this viewer may see.
   *
   * An influencer is an outside party who happens to hold a membership: they
   * get their OWN connections and nothing else — not the organization's Shopify
   * store, not its WhatsApp number, not another influencer's Instagram. Every
   * other role sees the whole organization.
   *
   * Returned as a `where` fragment rather than filtering in memory so the
   * restriction is part of the query and cannot be forgotten by a later caller
   * that reuses the rows.
   */
  private visibilityScope(viewer: ChannelViewer): Prisma.ChannelWhereInput {
    if (viewer.role === UserRole.INFLUENCER) {
      return { ownerUserId: viewer.userId };
    }
    return {};
  }

  /**
   * May this viewer act on this specific channel?
   *
   * Two ways to qualify: acting for the organization (OWNER/ADMIN), or owning
   * the row. That is what lets an influencer manage their own Instagram while
   * leaving everyone else's alone, without a second permission system.
   */
  private async assertCanManageChannel(
    channel: { id: string; ownerUserId: string | null },
    orgId: string,
    userId: string,
  ): Promise<void> {
    if (channel.ownerUserId && channel.ownerUserId === userId) return;
    await this.requireOrgRole(orgId, userId, [UserRole.OWNER, UserRole.ADMIN]);
  }

  async findAllForOrg(orgId: string, viewer: ChannelViewer) {
    // Auto-heal MANUAL channels stuck in ERROR / SYNCING / IN_PROGRESS state.
    // MANUAL channels have no remote to sync with, so any non-CONNECTED state
    // is stale (left over from misrouted sync jobs). Without this the UI
    // shows a red "Error" badge that the user can't clear because the Sync
    // button is correctly hidden for MANUAL channels.
    await this.prisma.channel.updateMany({
      where: {
        organizationId: orgId,
        platform: ChannelPlatform.MANUAL,
        OR: [
          { status: { not: ChannelStatus.CONNECTED } },
          { syncStatus: { not: SyncStatus.IDLE } },
        ],
      },
      data: {
        status: ChannelStatus.CONNECTED,
        syncStatus: SyncStatus.IDLE,
      },
    });

    const channels = await this.prisma.channel.findMany({
      where: { organizationId: orgId, ...this.visibilityScope(viewer) },
      orderBy: { createdAt: 'desc' },
      select: ChannelService.LIST_SELECT,
    });

    return channels.map((channel) => this.toListItem(channel));
  }

  async findOne(channelId: string, orgId: string, viewer: ChannelViewer) {
    const channel = await this.prisma.channel.findFirst({
      // Scoped, so an influencer probing another member's channel id gets the
      // same 404 as a channel that does not exist, never a leak of its name.
      where: { id: channelId, organizationId: orgId, ...this.visibilityScope(viewer) },
      include: {
        syncLogs: {
          orderBy: { createdAt: 'desc' },
          take: 10,
          select: {
            id: true,
            status: true,
            entityType: true,
            recordsProcessed: true,
            recordsFailed: true,
            totalEstimated: true,
            errorMessage: true,
            startedAt: true,
            completedAt: true,
          },
        },
      },
    });
    if (!channel) throw new NotFoundException('Channel not found');

    // Don't expose credentials in the response — but do report whether the
    // grant inside them still covers what the app needs, and who the connected
    // account is. Additive fields; no existing property changes shape.
    const { credentials, syncLogs } = channel;
    return {
      ...this.toListItem(channel),
      // findOne is the Manage dialog's source, which shows the raw metadata
      // block; the list projection drops it down to `disconnectedAt`.
      metadata: channel.metadata,
      syncLogs,
      scopeStatus:
        channel.platform === ChannelPlatform.SHOPIFY
          ? this.shopifyOAuth.describeScopeStatus(credentials)
          : { known: true, missing: [], reconnectRequired: false },
    };
  }

  // ─── PER-ENTITY SYNC SETTINGS ───
  //
  // The enforcement side already lives in ShopifySyncService.enabledEntities;
  // this is the read/write API behind it. Both sides share one rule:
  // **enabled unless a row says otherwise**. That keeps channels which predate
  // the toggles -- and any entity a merchant has never touched -- behaving
  // exactly as they do today with no rows seeded for them.

  /**
   * How many local records the PUSH direction would send RIGHT NOW.
   *
   * Surfaced next to the push toggles because `bulkPushUnsyncedOrders` sends
   * EVERY manual order never marked SYNCED -- potentially a long backlog -- and
   * each becomes a real order in the merchant's Shopify admin via
   * `orderCreate`. A Shopify order cannot be un-created, so the number has to
   * be visible BEFORE the merchant ticks the box, not discovered afterwards.
   *
   * Drafts are deliberately absent: they do not carry the
   * `metadata.shopifySync` marker, so any count here would be invented rather
   * than derived.
   */
  private async pendingPushCounts(orgId: string) {
    const manual = await this.prisma.channel.findFirst({
      where: { organizationId: orgId, platform: ChannelPlatform.MANUAL },
      select: { id: true },
    });
    if (!manual) return { orders: 0, products: 0 };

    // Raw SQL, not a Prisma JSON filter, and deliberately so.
    //
    // `NOT: { metadata: { path: [...], equals: 'SYNCED' } }` compiles to
    // NOT (metadata #>> '{shopifySync,status}' = 'SYNCED'). For a row whose
    // metadata is NULL — or which simply has no shopifySync key — the inner
    // comparison is NULL, NOT NULL is NULL, and the row is EXCLUDED. Those
    // are precisely the never-pushed records this count exists to warn about,
    // so the filter would report 0 for the most dangerous case. `coalesce`
    // collapses both to the empty string and compares cleanly.
    //
    // Mirrors ShopifyPushService.isAlreadySynced: only the exact string
    // 'SYNCED' counts as done, so a FAILED or absent marker is still pending.
    const countPending = async (table: 'orders' | 'products') => {
      const rows = await this.prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT count(*) AS count
        FROM ${Prisma.raw(`"${table}"`)} t
        WHERE t.organization_id = ${orgId}
          AND t.channel_id = ${manual.id}
          AND t.deleted_at IS NULL
          AND coalesce(t.metadata->'shopifySync'->>'status', '') <> 'SYNCED'
      `;
      return Number(rows[0]?.count ?? 0);
    };

    const [orders, products] = await Promise.all([
      countPending('orders'),
      countPending('products'),
    ]);
    return { orders, products };
  }

  async getSyncSettings(channelId: string, orgId: string) {
    const channel = await this.prisma.channel.findFirst({
      where: { id: channelId, organizationId: orgId },
      select: { id: true, platform: true },
    });
    if (!channel) throw new NotFoundException('Channel not found');

    const rows = await this.prisma.channelSyncState.findMany({
      where: { channelId },
      select: {
        direction: true,
        entityType: true,
        enabled: true,
        watermark: true,
        backfillDone: true,
      },
    });

    const describe = (direction: 'pull' | 'push', entityType: string) => {
      const row = rows.find(
        (r) => r.direction === direction && r.entityType === entityType,
      );
      return {
        entityType,
        // Absent row => enabled. Only an explicit `false` turns something off.
        enabled: row?.enabled ?? true,
        backfillDone: row?.backfillDone ?? false,
        watermark: row?.watermark ?? null,
      };
    };

    return {
      channelId: channel.id,
      platform: channel.platform,
      pull: PULL_ENTITY_TYPES.map((e) => describe('pull', e)),
      push: PUSH_ENTITY_TYPES.map((e) => describe('push', e)),
      pendingPush: await this.pendingPushCounts(orgId),
    };
  }

  async updateSyncSettings(
    channelId: string,
    orgId: string,
    dto: UpdateSyncSettingsDto,
  ) {
    const channel = await this.prisma.channel.findFirst({
      where: { id: channelId, organizationId: orgId },
      select: { id: true },
    });
    if (!channel) throw new NotFoundException('Channel not found');
    if (dto.pull.length === 0 && dto.push.length === 0) {
      throw new BadRequestException(
        'Select at least one thing to sync, or disconnect the channel instead.',
      );
    }

    // A row is written for EVERY entity in both directions, not just the
    // enabled ones, so the stored state is self-describing rather than
    // something you have to diff against a hard-coded list to interpret.
    const writes = [
      ...PULL_ENTITY_TYPES.map((entityType) => ({
        direction: 'pull',
        entityType,
        enabled: dto.pull.includes(entityType),
      })),
      ...PUSH_ENTITY_TYPES.map((entityType) => ({
        direction: 'push',
        entityType,
        enabled: dto.push.includes(entityType),
      })),
    ];

    await this.prisma.$transaction(
      writes.map((w) =>
        this.prisma.channelSyncState.upsert({
          where: {
            channelId_direction_entityType: {
              channelId,
              direction: w.direction,
              entityType: w.entityType,
            },
          },
          create: { channelId, ...w },
          // ONLY the toggle. `watermark` and `backfillDone` are the sync's own
          // bookkeeping and must survive a settings change -- otherwise turning
          // an entity off and on again would force a full re-backfill.
          update: { enabled: w.enabled },
        }),
      ),
    );

    return this.getSyncSettings(channelId, orgId);
  }

  async update(channelId: string, orgId: string, userId: string, dto: UpdateChannelDto) {
    const channel = await this.prisma.channel.findFirst({
      where: { id: channelId, organizationId: orgId },
    });
    if (!channel) throw new NotFoundException('Channel not found');
    // Load first, THEN authorize: whether you may edit this row depends on
    // whether you own it, which cannot be known before reading it.
    await this.assertCanManageChannel(channel, orgId, userId);

    return this.prisma.channel.update({
      where: { id: channelId },
      data: dto,
    });
  }

  /**
   * Disconnect a channel: revoke what we can remotely, then clear the grant.
   *
   * ALWAYS a state flip, never a delete. `Order.channelId` is non-nullable and
   * nine relations cascade from this row, so deleting a channel would take the
   * merchant's orders, products and message logs with it. A disconnected row is
   * the account's history.
   *
   * This used to run only for SHOPIFY: every other platform fell out of the
   * `if` and returned undefined, leaving live Meta tokens in the row while the
   * UI reported success.
   */
  async disconnect(channelId: string, orgId: string, userId: string) {
    const channel = await this.prisma.channel.findFirst({
      where: { id: channelId, organizationId: orgId },
    });
    if (!channel) throw new NotFoundException('Channel not found');
    // An influencer may disconnect their OWN account and nobody else's.
    await this.assertCanManageChannel(channel, orgId, userId);

    if (channel.platform === ChannelPlatform.MANUAL) {
      // Not a connection: it is the org's own in-store book, lazily created and
      // referenced by every offline order.
      throw new BadRequestException(
        'The manual channel is built in and cannot be disconnected.',
      );
    }

    if (channel.status === ChannelStatus.DISCONNECTED) {
      // Idempotent: a double-click, or two tabs, must not 500.
      return { message: 'Channel already disconnected' };
    }

    // Remote cleanup is best-effort throughout — the grant may already be dead
    // on the provider's side, and that must not block us from clearing it here.
    if (channel.credentials) {
      try {
        if (channel.platform === ChannelPlatform.SHOPIFY) {
          await this.shopifyOAuth.unregisterWebhooks(channelId);
        } else if (channel.platform === ChannelPlatform.INSTAGRAM) {
          await this.instagramOAuth.revokeWebhookSubscription(channel);
        }
        // WhatsApp subscribes nothing at connect time, so there is nothing to
        // revoke; the token simply stops being used.
      } catch {
        // Ignored by design.
      }
    }

    const existingMeta =
      channel.metadata && typeof channel.metadata === 'object'
        ? (channel.metadata as Record<string, unknown>)
        : {};

    await this.prisma.channel.update({
      where: { id: channelId },
      data: {
        status: ChannelStatus.DISCONNECTED,
        syncStatus: SyncStatus.IDLE,
        credentials: Prisma.JsonNull,
        lastError: null,
        // Release the account claim: (platform, external_store_id) is globally
        // unique, so keeping the ids here would block every other organization
        // — and this one — from ever connecting this account again.
        externalStoreId: null,
        externalStoreUrl: null,
        metadata: {
          ...existingMeta,
          // Remember which account this row was, so reconnecting the same one
          // revives this row (with its orders and logs) instead of opening a
          // second one, and so the UI can still name a disconnected account.
          externalAccountId: channel.externalStoreId,
          lastAccount: describeAccount(
            channel.platform,
            channel.credentials,
            channel.metadata,
          ),
          disconnectedAt: new Date().toISOString(),
        } as Prisma.InputJsonValue,
      },
    });

    return { message: 'Channel disconnected' };
  }

  async getSyncLogs(channelId: string, orgId: string) {
    const channel = await this.prisma.channel.findFirst({
      where: { id: channelId, organizationId: orgId },
    });
    if (!channel) throw new NotFoundException('Channel not found');

    return this.prisma.syncLog.findMany({
      where: { channelId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  private async requireOrgRole(orgId: string, userId: string, roles: UserRole[]) {
    const membership = await this.prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId: orgId, userId } },
    });
    if (!membership || !membership.isActive || !roles.includes(membership.role)) {
      throw new ForbiddenException('Insufficient permissions');
    }
  }
}