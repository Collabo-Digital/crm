import { BadRequestException, ConflictException, Controller, Post, Get, Patch, Delete, Body, Param, Query, Res, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response, Request } from 'express';
import { ChannelPlatform, ChannelStatus, SyncStatus, UserRole } from '@prisma/client';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { SYNC_QUEUE, SyncJobData } from './sync.queue';
import { SYNC_RESUME_MAX_AGE_MS } from './shopify-sync.service';

import type { JwtPayload } from '../auth/interfaces/jwt-payload.interface';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { Roles, ORG_MANAGERS, CHANNEL_MANAGERS } from '../auth/decorators/roles.decorator';
import { AllowInfluencer } from '../auth/decorators/allow-influencer.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { ChannelService } from './channel.service';
import { ShopifyOAuthService } from './shopify-oauth.service';
import { ConnectShopifyDto } from './dto/connect-shopify.dto';
import { ConnectInstagramDto } from './dto/connect-instagram.dto';
import { CompleteInstagramDto } from './dto/complete-instagram.dto';
import { WhatsAppInstallDto } from './dto/whatsapp-install.dto';
import { ManualConnectShopifyDto } from './dto/manual-connect-shopify.dto';
import { UpdateChannelDto } from './dto/update-channel.dto';
import { TriggerSyncDto } from './dto/trigger-sync.dto';
import { UpdateSyncSettingsDto } from './dto/update-sync-settings.dto';
import { InstagramOAuthService } from './instagram-oauth.service';
import { WhatsAppOAuthService } from './whatsapp-oauth.service';
import { WhatsAppCallbackDto } from './dto/whatsapp-callback.dto';
import { classifyMetaCallbackError } from './channel-connection.util';
import { ShopifyPixelService } from './shopify-pixel.service';

@Controller('channels')
export class ChannelController {
  private readonly logger = new Logger(ChannelController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly channelService: ChannelService,
    private readonly shopifyOAuth: ShopifyOAuthService,
    private readonly shopifyPixel: ShopifyPixelService,
    private readonly instagramOAuth: InstagramOAuthService,
    private readonly whatsappOAuth: WhatsAppOAuthService,
    private readonly config: ConfigService,
    @InjectQueue(SYNC_QUEUE) private readonly syncQueue: Queue,
  ) { }

  // POST /channels/shopify/install — start public-app OAuth (shop domain only)
  @Post('shopify/install')
  async installShopify(
    @CurrentUser() user: JwtPayload,
    @Body() dto: ConnectShopifyDto,
  ) {
    const authUrl = await this.shopifyOAuth.getInstallUrl(
      user.orgId!,
      user.sub,
      dto.shopDomain,
      dto.apiKey,
      dto.apiSecret,
    );
    return { authUrl };
  }

  // GET /channels/shopify/app — target for the Shopify app's application_url.
  // Shopify sends the merchant's browser here right after an install-link
  // install and whenever they click the app inside their Shopify admin
  // (?hmac&host&shop&timestamp). We simply land them on the CRM channels page
  // with the shop pre-filled so connecting is one click. No state is changed
  // here, so HMAC verification is unnecessary — but the shop param is
  // format-validated before being embedded in our own redirect.
  @Public()
  @Get('shopify/app')
  shopifyAppEntry(@Query('shop') shop: string | undefined, @Res() res: Response) {
    const frontendUrl = this.config.get<string>('frontendUrl');
    const validShop =
      typeof shop === 'string' && /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)
        ? shop
        : null;
    return res.redirect(
      validShop
        ? `${frontendUrl}/settings/channels?install_shop=${validShop}`
        : `${frontendUrl}/settings/channels`,
    );
  }

  // GET /channels/shopify/callback — Shopify redirects here after the merchant
  // approves (or cancels) the install. The merchant's browser is sitting on
  // this URL, so EVERY outcome must end in a redirect back to the frontend —
  // never a JSON error page.
  @Public()
  @Get('shopify/callback')
  async shopifyCallback(
    @Query() query: { code?: string; hmac: string; shop: string; state: string; timestamp: string },
    @Res() res: Response,
  ) {
    const frontendUrl = this.config.get<string>('frontendUrl');
    try {
      const result = await this.shopifyOAuth.handleCallback(query);

      // Webhook registration + pixel activation run on the queue, NOT here.
      //
      // Between them they are ~20 sequential Shopify mutations, each able to
      // back off on a 429. Awaiting them left the merchant's browser parked
      // on this URL long enough to hit the edge proxy's timeout, so a store
      // that had connected fine rendered an error page instead of the
      // redirect. The channel row is already committed by handleCallback.
      await this.enqueueChannelSetup(result.channelId, result.organizationId);

      // Auto-trigger initial sync after successful connection
      try {
        await this.syncQueue.add('sync', {
          channelId: result.channelId,
          organizationId: result.organizationId,
          entityTypes: ['locations', 'products', 'orders', 'customers', 'inventory'],
        } satisfies SyncJobData, {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: { count: 100 },
          removeOnFail: { count: 50 },
        });
      } catch {
        // Non-fatal: sync can be triggered manually later
      }

      return res.redirect(result.redirectUrl);
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      // Match precisely — a bare 'state' also matches identifiers inside
      // Prisma code frames (e.g. "stateData"), mislabeling DB errors.
      const reason =
        message.includes('state parameter') ? 'invalid_state'
          : message.includes('cancelled') ? 'cancelled'
            : message.includes('another organization') ? 'shop_taken'
              : message.includes('HMAC') ? 'invalid_hmac'
                : 'connect_failed';
      this.logger.warn(`Shopify OAuth callback failed (${reason}): ${message}`);
      return res.redirect(`${frontendUrl}/settings/channels?error=shopify_connect_failed&reason=${reason}`);
    }
  }

  // POST /channels/shopify/manual-connect — connect using manually created custom app credentials
  @Post('shopify/manual-connect')
  async manualConnectShopify(
    @CurrentUser() user: JwtPayload,
    @Body() dto: ManualConnectShopifyDto,
  ) {
    const result = await this.shopifyOAuth.manualConnect(user.orgId!, dto.shopDomain, dto.apiKey, dto.apiSecret, dto.accessToken);

    // Auto-trigger initial sync after successful connection
    try {
      await this.syncQueue.add('sync', {
        channelId: result.channelId,
        organizationId: user.orgId!,
        entityTypes: ['locations', 'products', 'orders', 'customers', 'inventory'],
      } satisfies SyncJobData, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 50 },
      });
    } catch {
      // Non-fatal: sync can be triggered manually later
    }

    // Queued, not awaited: the client aborts this request at 30s, and ~20
    // sequential webhook mutations routinely take longer. That timeout was
    // surfacing as "Failed to connect Shopify store." for a store that had
    // in fact connected - after which the retry hit "A Shopify store is
    // already connected. Disconnect it first."
    await this.enqueueChannelSetup(result.channelId, user.orgId!);

    return result;
  }

  // POST /channels/instagram/install — start Meta OAuth flow.
  //
  // OWNER/ADMIN across every connect route: linking a channel hands a third
  // party ongoing access to the org's data and, for WhatsApp, the ability to
  // message its customers. Matches the role check ChannelService.disconnect
  // has always applied — connecting was simply never gated.
  @Post('instagram/install')
  @Roles(...CHANNEL_MANAGERS)
  @AllowInfluencer()
  async installInstagram(
    @CurrentUser() user: JwtPayload,
    @Body() dto: ConnectInstagramDto,
  ) {
    const authUrl = await this.instagramOAuth.getInstallUrl(
      user.orgId!,
      user.sub,
      dto.reconnectChannelId,
    );
    return { authUrl };
  }

  // GET /channels/instagram/callback — Meta redirects here after OAuth.
  //
  // The merchant's browser is sitting on this URL, so EVERY outcome has to end
  // in a redirect back to the frontend carrying a reason slug — never a JSON
  // error page, which is what an uncaught throw here used to render. Same
  // contract as shopifyCallback above.
  @Public()
  @Get('instagram/callback')
  async instagramCallback(
    @Query()
    query: {
      code?: string;
      state?: string;
      error?: string;
      error_reason?: string;
      error_description?: string;
    },
    @Res() res: Response,
  ) {
    const frontendUrl = this.config.get<string>('frontendUrl');
    try {
      const { redirectUrl } = await this.instagramOAuth.handleCallback(query);
      return res.redirect(redirectUrl);
    } catch (error) {
      const reason = classifyMetaCallbackError(query, error);
      this.logger.warn(
        `Instagram OAuth callback failed (${reason}): ${error instanceof Error ? error.message : ''}`,
      );
      return res.redirect(
        `${frontendUrl}/settings/channels?error=instagram_connect_failed&reason=${reason}`,
      );
    }
  }

  // GET /channels/instagram/pending/:id — the accounts one login granted, for
  // the picker. Tokens are stripped server-side; this returns display fields
  // only.
  @Get('instagram/pending/:id')
  @Roles(...CHANNEL_MANAGERS)
  @AllowInfluencer()
  async instagramPending(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.instagramOAuth.listPending(id, user.orgId!);
  }

  // POST /channels/instagram/complete — connect the account the merchant picked.
  @Post('instagram/complete')
  @Roles(...CHANNEL_MANAGERS)
  @AllowInfluencer()
  async completeInstagram(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CompleteInstagramDto,
  ) {
    return this.instagramOAuth.completePending(
      dto.pendingId,
      dto.igUserId,
      user.orgId!,
      user.sub,
    );
  }

  // POST /channels/whatsapp/install — returns configId + state for the Meta JS SDK
  // (Embedded Signup runs in a popup launched by the frontend, not a browser redirect)
  @Post('whatsapp/install')
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  async installWhatsApp(
    @CurrentUser() user: JwtPayload,
    @Body() dto: WhatsAppInstallDto,
  ) {
    return this.whatsappOAuth.getSignupConfig(
      user.orgId!,
      user.sub,
      dto.reconnectChannelId,
    );
  }

  // POST /channels/whatsapp/callback — frontend forwards the code returned by FB.login
  @Post('whatsapp/callback')
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  async whatsappCallback(@Body() dto: WhatsAppCallbackDto) {
    return this.whatsappOAuth.handleSignupCallback(dto.code, dto.state);
  }

  // GET /channels — list org's channels.
  //
  // Open to influencers: this is how they reach their own Instagram connection.
  // The list is scoped by role inside the service, so an influencer receives
  // only the channels they personally connected.
  @Get()
  @AllowInfluencer()
  findAll(@CurrentUser() user: JwtPayload) {
    return this.channelService.findAllForOrg(user.orgId!, {
      userId: user.sub,
      role: user.role,
    });
  }

  // GET /channels/:id — get channel details + sync logs
  @Get(':id')
  @AllowInfluencer()
  findOne(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.channelService.findOne(id, user.orgId!, {
      userId: user.sub,
      role: user.role,
    });
  }

  // PATCH /channels/:id — update name or toggle
  @Patch(':id')
  @Roles(...CHANNEL_MANAGERS)
  @AllowInfluencer()
  update(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateChannelDto,
  ) {
    return this.channelService.update(id, user.orgId!, user.sub, dto);
  }

  // DELETE /channels/:id — disconnect
  @Delete(':id')
  @Roles(...CHANNEL_MANAGERS)
  @AllowInfluencer()
  disconnect(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.channelService.disconnect(id, user.orgId!, user.sub);
  }

  // POST /channels/:id/sync — trigger manual sync
  //
  // IN_PROGRESS means one of two very different things, and this endpoint has
  // to tell them apart:
  //
  //   * a sync really is running  → starting a second one is harmful. Both
  //     runs resolve the SAME SyncLog row and both write `cursor` into it, so
  //     they overwrite each other's checkpoint. Refuse.
  //   * a previous attempt died before its `finally` (e.g. credential
  //     resolution threw before `runSync` entered its try/finally) → the row
  //     is pinned and the UI button is disabled for ever. Reset and queue.
  //
  // The age of the channel's most recent sync log is what separates them.
  // This used to reset unconditionally, which fixed the second case by
  // permanently enabling the first.
  @Post(':id/sync')
  async triggerSync(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: TriggerSyncDto,
  ) {
    const existing = await this.prisma.channel.findFirst({
      where: { id, organizationId: user.orgId! },
      select: { syncStatus: true, status: true, platform: true, name: true },
    });
    if (!existing) {
      throw new BadRequestException(`Channel ${id} not found`);
    }
    // Sync semantics by platform:
    //   SHOPIFY → pull from Shopify + bulk-push local unsynced items.
    //   MANUAL  → no pull source; runSync short-circuits the pull and just
    //             runs the bulk-push (products + orders + drafts). Useful
    //             when the user has auto-sync OFF and wants to push their
    //             CRM-side items to Shopify on demand.
    //   Anything else (INSTAGRAM, WHATSAPP) has no push or pull semantics
    //   for this sync queue — reject so the UI doesn't expose the affordance.
    if (
      existing.platform !== ChannelPlatform.SHOPIFY &&
      existing.platform !== ChannelPlatform.MANUAL
    ) {
      throw new BadRequestException(
        `Sync is not available for ${existing.platform} channels.`,
      );
    }
    if (existing.syncStatus === SyncStatus.IN_PROGRESS) {
      const latestLog = await this.prisma.syncLog.findFirst({
        where: { channelId: id, status: SyncStatus.IN_PROGRESS },
        orderBy: { startedAt: 'desc' },
        select: { startedAt: true },
      });
      const live =
        !!latestLog &&
        latestLog.startedAt.getTime() > Date.now() - SYNC_RESUME_MAX_AGE_MS;

      if (live) {
        throw new ConflictException(
          'A sync is already in progress for this channel. Wait for it to finish before starting another.',
        );
      }

      this.logger.warn(
        `Channel ${id} was pinned to IN_PROGRESS with no live sync log — resetting to IDLE before queueing a fresh job.`,
      );
      await this.prisma.channel.update({
        where: { id },
        data: {
          syncStatus: SyncStatus.IDLE,
          status: ChannelStatus.CONNECTED,
        },
      });
    }

    // Add job to BullMQ queue — returns immediately
    const job = await this.syncQueue.add('sync', {
      channelId: id,
      organizationId: user.orgId!,
      entityTypes: dto.entityTypes,
    } satisfies SyncJobData, {
      attempts: 3,                          // Retry up to 3 times
      backoff: { type: 'exponential', delay: 5000 },  // 5s, 10s, 20s
      removeOnComplete: { count: 100 },     // Keep last 100 completed jobs
      removeOnFail: { count: 50 },          // Keep last 50 failed jobs
    });

    return {
      message: 'Sync started',
      jobId: job.id,
      channelId: id,
      entityTypes: dto.entityTypes,
    };
  }

  /**
   * Queue post-connect store setup (webhooks + web pixel).
   *
   * Never throws: a channel with no webhooks still syncs on demand, so a
   * Redis hiccup must not turn a successful connect into a failed one.
   */
  private async enqueueChannelSetup(
    channelId: string,
    organizationId: string,
  ): Promise<void> {
    try {
      await this.syncQueue.add(
        'setup',
        { type: 'setup', channelId, organizationId } satisfies SyncJobData,
        {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: { count: 100 },
          removeOnFail: { count: 50 },
        },
      );
    } catch (error) {
      this.logger.error(
        `Could not queue setup for channel ${channelId} - webhooks are NOT registered. ` +
        `Re-run POST /channels/${channelId}/register-webhooks once Redis is healthy.`,
        error instanceof Error ? error.stack : error,
      );
    }
  }

  // GET /channels/:id/sync-settings — per-entity toggles, per-entity sync
  // state, and how many local records a push would send right now.
  @Get(':id/sync-settings')
  getSyncSettings(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.channelService.getSyncSettings(id, user.orgId!);
  }

  // PATCH /channels/:id/sync-settings — set which entities sync, per direction.
  //
  // ORG_MANAGERS: this decides what crosses the line into a merchant's live
  // Shopify store. NOTE the guard-order trap documented in roles.decorator.ts —
  // RolesGuard runs BEFORE VendorAccessGuard, so omitting VENDOR closes this
  // route to vendors, which is intended here.
  @Patch(':id/sync-settings')
  @Roles(...ORG_MANAGERS)
  updateSyncSettings(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateSyncSettingsDto,
  ) {
    return this.channelService.updateSyncSettings(id, user.orgId!, dto);
  }

  // GET /channels/:id/sync-logs — list sync history
  @Get(':id/sync-logs')
  getSyncLogs(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.channelService.getSyncLogs(id, user.orgId!);
  }

  @Post(':id/activate-pixel')
  async activatePixel(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const channel = await this.prisma.channel.findFirst({
      where: { id, organizationId: user.orgId!, platform: ChannelPlatform.SHOPIFY },
      select: { id: true },
    });
    if (!channel) throw new BadRequestException('Shopify channel not found');
    return this.shopifyPixel.activatePixel(id);
  }

  // POST /channels/:id/register-webhooks — re-run webhook registration for
  // an already-connected Shopify channel. Used when we add a new topic to
  // `WEBHOOK_TOPICS` (e.g. analytics cart/checkout events) — existing
  // channels need to re-register against Shopify or they'll silently miss
  // the new topics. Idempotent on Shopify's side: already-registered
  // topics return a "topic already registered" error which we swallow.
  @Post(':id/register-webhooks')
  async reRegisterWebhooks(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    const channel = await this.prisma.channel.findFirst({
      where: {
        id,
        organizationId: user.orgId!,
        platform: ChannelPlatform.SHOPIFY,
      },
      select: { id: true },
    });
    if (!channel) {
      throw new BadRequestException(`Shopify channel ${id} not found`);
    }
    await this.shopifyOAuth.registerWebhooks(channel.id);
    return { ok: true };
  }
}