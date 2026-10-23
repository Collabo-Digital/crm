import { BadRequestException, ConflictException, ServiceUnavailableException, Controller, Post, Get, Patch, Delete, Body, Param, Query, Res, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response, Request } from 'express';
import { ChannelPlatform, ChannelStatus, SyncStatus, UserRole } from '@prisma/client';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue, type JobType } from 'bullmq';
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
import { WhatsAppAccountService } from './whatsapp-account.service';
import { MetaPagesOAuthService } from './meta-pages-oauth.service';
import { MetaPagesCallbackDto } from './dto/meta-pages-callback.dto';
import { WhatsAppCallbackDto } from './dto/whatsapp-callback.dto';
import { classifyMetaCallbackError } from './channel-connection.util';
import { ShopifyPixelService } from './shopify-pixel.service';
import { RateLimitStateService } from '../rate-limit/rate-limit-state.service';
import { Priority } from '../rate-limit/rate-limit.types';

/** Queue states in which a sync job is still going to run, or is running. */
const PENDING_JOB_STATES: JobType[] = ['active', 'waiting', 'delayed', 'prioritized', 'paused'];

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
    private readonly whatsappAccount: WhatsAppAccountService,
    private readonly metaPages: MetaPagesOAuthService,
    private readonly config: ConfigService,
    private readonly rateLimitState: RateLimitStateService,
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

      // Auto-trigger initial sync after successful connection. Bulk
      // priority: it is a backfill nobody is waiting on click-by-click.
      try {
        await this.syncQueue.add('sync', {
          channelId: result.channelId,
          organizationId: result.organizationId,
          entityTypes: ['locations', 'products', 'orders', 'customers', 'inventory'],
          priority: Priority.BULK,
        } satisfies SyncJobData, {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: { count: 100 },
          removeOnFail: { count: 50 },
          priority: Priority.BULK,
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

    // Auto-trigger initial sync after successful connection (bulk priority).
    try {
      await this.syncQueue.add('sync', {
        channelId: result.channelId,
        organizationId: user.orgId!,
        entityTypes: ['locations', 'products', 'orders', 'customers', 'inventory'],
        priority: Priority.BULK,
      } satisfies SyncJobData, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 50 },
        priority: Priority.BULK,
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
  async whatsappCallback(@CurrentUser() user: JwtPayload, @Body() dto: WhatsAppCallbackDto) {
    return this.whatsappOAuth.handleSignupCallback(dto.code, dto.state, user.orgId!, user.sub, {
      phoneNumberId: dto.phoneNumberId,
      wabaId: dto.wabaId,
      isOnBizApp: dto.isOnBizApp,
      businessId: dto.businessId,
    });
  }

  // POST /channels/messenger/install — config id + CSRF state for the Facebook
  // Login for Business popup that shares Pages and their Instagram accounts.
  @Post('messenger/install')
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  async installMessenger(@CurrentUser() user: JwtPayload) {
    return this.metaPages.getConnectConfig(user.orgId!, user.sub);
  }

  // POST /channels/messenger/callback — the popup's code; connects every Page
  // granted, plus the Instagram account linked to each.
  @Post('messenger/callback')
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  async messengerCallback(@CurrentUser() user: JwtPayload, @Body() dto: MetaPagesCallbackDto) {
    return this.metaPages.handleCallback(dto.code, dto.state, user.orgId!, user.sub);
  }

  // POST /channels/:id/whatsapp/retry-setup — re-run webhook subscription and
  // number registration after a partial setup failure.
  @Post(':id/whatsapp/retry-setup')
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  async whatsappRetrySetup(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.whatsappOAuth.retrySetup(id, user.orgId!);
  }

  // POST /channels/:id/whatsapp/refresh-health — re-read quality rating,
  // messaging limit and display-name status from Meta.
  @Post(':id/whatsapp/refresh-health')
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.MANAGER)
  async whatsappRefreshHealth(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    await this.channelService.findOne(id, user.orgId!, { userId: user.sub, role: user.role });
    return this.whatsappAccount.refreshHealth(id);
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

  // GET /channels/:id/rate-limit — live outbound rate-limit state for the
  // wallets this channel spends from (bucket balance, in-flight counts,
  // breaker, today's counters). Diagnostic; nothing in the UI depends on it.
  @Get(':id/rate-limit')
  @AllowInfluencer()
  async rateLimit(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    // Same visibility rule as findOne: a channel the viewer may not see 404s.
    await this.channelService.findOne(id, user.orgId!, {
      userId: user.sub,
      role: user.role,
    });
    const channel = await this.prisma.channel.findUniqueOrThrow({
      where: { id },
      select: {
        id: true,
        platform: true,
        externalStoreUrl: true,
        credentials: true,
        rateLimitedUntil: true,
        rateLimitReason: true,
      },
    });
    return this.rateLimitState.describe(channel);
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
  // The channel is claimed (syncStatus → IN_PROGRESS) HERE, before the job is
  // queued, not later by the worker. Two reasons:
  //
  //   * Truth. The row used to keep its old status until a worker picked the
  //     job up, so the API answered "Synced" for a channel with a sync queued.
  //     Clients poll only while IN_PROGRESS, so they never started polling and
  //     the page showed stale state until a reload.
  //   * Exclusion. Two triggers in that window both passed the IN_PROGRESS
  //     check and both enqueued. Two runs resolve the SAME SyncLog row and
  //     both write `cursor` into it, so they overwrite each other's
  //     checkpoint. The claim is a compare-and-set, so only one caller wins.
  //
  // IN_PROGRESS therefore means "queued or running". `runSync` and the
  // worker's `onFailed` handler always end a run with COMPLETED / FAILED, so
  // the claim is released by the same code that released it before.
  //
  // A lost claim still means one of two very different things:
  //
  //   * a sync really is queued or running → refuse (409).
  //   * a previous attempt died before its `finally` → the row is pinned and
  //     the UI button is disabled for ever. Take the claim over and queue.
  //
  // `isSyncLive` is what separates them.
  @Post(':id/sync')
  async triggerSync(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: TriggerSyncDto,
  ) {
    const orgId = user.orgId!;
    const existing = await this.prisma.channel.findFirst({
      where: { id, organizationId: orgId },
      select: { syncStatus: true, platform: true },
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
    // MANUAL channels have no pull and never enter IN_PROGRESS (`runSync` marks
    // them COMPLETED at once), so there is nothing to claim.
    //
    // `restoreTo` is what the row goes back to if the job cannot be queued.
    let restoreTo: SyncStatus | null = null;

    if (existing.platform === ChannelPlatform.SHOPIFY) {
      const claim = await this.prisma.channel.updateMany({
        where: { id, organizationId: orgId, syncStatus: { not: SyncStatus.IN_PROGRESS } },
        data: { syncStatus: SyncStatus.IN_PROGRESS },
      });

      if (claim.count === 1) {
        // `existing` was read before the claim and may be a beat stale; never
        // "restore" a row to IN_PROGRESS.
        restoreTo =
          existing.syncStatus === SyncStatus.IN_PROGRESS
            ? SyncStatus.IDLE
            : existing.syncStatus;
      } else if (await this.isSyncLive(id)) {
        throw new ConflictException(
          'A sync is already in progress for this channel. Wait for it to finish before starting another.',
        );
      } else {
        this.logger.warn(
          `Channel ${id} was pinned to IN_PROGRESS with no live sync — taking it over and queueing a fresh job.`,
        );
        restoreTo = SyncStatus.IDLE;
      }
    }

    let job: Awaited<ReturnType<Queue['add']>>;
    try {
      // Add job to BullMQ queue — returns immediately. A person pressed the
      // button, so this run is INTERACTIVE: it is picked before any queued
      // backfill and may spend deeper into the shop's rate-limit bucket.
      job = await this.syncQueue.add('sync', {
        channelId: id,
        organizationId: orgId,
        entityTypes: dto.entityTypes,
        priority: Priority.INTERACTIVE,
      } satisfies SyncJobData, {
        attempts: 3,                          // Retry up to 3 times
        backoff: { type: 'exponential', delay: 5000 },  // 5s, 10s, 20s
        removeOnComplete: { count: 100 },     // Keep last 100 completed jobs
        removeOnFail: { count: 50 },          // Keep last 50 failed jobs
        priority: Priority.INTERACTIVE,
      });
    } catch (error) {
      // Nothing will ever run, so nothing would ever release the claim.
      if (restoreTo) {
        await this.prisma.channel
          .updateMany({
            where: { id, syncStatus: SyncStatus.IN_PROGRESS },
            data: { syncStatus: restoreTo },
          })
          .catch((restoreError) =>
            this.logger.error(
              `Could not release the sync claim on channel ${id} after a failed enqueue`,
              restoreError,
            ),
          );
      }
      this.logger.error(`Failed to enqueue sync for channel ${id}`, error);
      throw new ServiceUnavailableException(
        'The sync queue is unavailable right now. Try again in a few minutes.',
      );
    }

    return {
      message: 'Sync started',
      jobId: job.id,
      channelId: id,
      entityTypes: dto.entityTypes,
    };
  }

  /**
   * Is a sync for this channel queued or running right now?
   *
   * The queue is the first authority: a job that is waiting, active, or
   * delayed between retries WILL write the channel's final status. The recent
   * IN_PROGRESS sync log is kept as a second signal for a run whose job is no
   * longer visible in the queue but is still inside the resume window.
   */
  private async isSyncLive(channelId: string): Promise<boolean> {
    const jobs = await this.syncQueue.getJobs(PENDING_JOB_STATES);
    const queued = jobs.some((job) => {
      const data = job?.data as SyncJobData | undefined;
      return data?.channelId === channelId && data.type !== 'setup';
    });
    if (queued) return true;

    const latestLog = await this.prisma.syncLog.findFirst({
      where: { channelId, status: SyncStatus.IN_PROGRESS },
      orderBy: { startedAt: 'desc' },
      select: { startedAt: true },
    });
    return (
      !!latestLog &&
      latestLog.startedAt.getTime() > Date.now() - SYNC_RESUME_MAX_AGE_MS
    );
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