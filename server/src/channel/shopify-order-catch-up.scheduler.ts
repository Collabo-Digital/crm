import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChannelPlatform, ChannelStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { CheckoutService } from '../commerce/checkout.service';
import { ShopifySyncService } from './shopify-sync.service';
import { FIRST_SIGHTING_EVENT_WINDOW_MS, isWithinWindow } from './shopify-payload-age.util';
import { isTransientWebhookError } from './webhook-retry.util';

/** How long before the last run each run starts reading, to cover webhooks Shopify was still retrying. */
const OVERLAP_MS = 2 * 60 * 60 * 1000;
/** How far back a store's first run reads. */
const FIRST_RUN_MS = 24 * 60 * 60 * 1000;
/** Longest gap between ticks, whatever the interval; see onModuleInit. */
const MAX_TICK_MS = 5 * 60 * 1000;
/** Outlives any run, and frees a store whose server died part-way through. */
const LOCK_SECONDS = 30 * 60;

type CatchUpChannel = { id: string; organizationId: string; connectedAt: Date | null; orderCatchUpAt: Date | null };

/**
 * Recovers Shopify orders whose webhook was never processed. Shopify stops
 * retrying a delivery after a while and can lose one outright; such an order
 * got no confirmation or GST invoice, and its open checkout sent a cart
 * reminder to a buyer who had paid.
 *
 * Every SHOPIFY_RECONCILE_MINUTES each connected store's orders updated since
 * its last catch-up (less OVERLAP_MS) are read and passed through the orders
 * webhook's own path: the checkout is completed and the order written with
 * its store events. Events fire only for orders created in the last 24 hours,
 * as on a live webhook's first sighting; older ones are saved silently. An
 * order's events are raised once whichever path sees it first, because
 * upsertOrder raises them only on a change and each is unique per order.
 */
@Injectable()
export class ShopifyOrderCatchUpScheduler implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(ShopifyOrderCatchUpScheduler.name);
    private timer: NodeJS.Timeout | null = null;
    private running = false;
    private intervalMs = 60 * 60 * 1000;

    constructor(
        private readonly prisma: PrismaService,
        private readonly redis: RedisService,
        private readonly sync: ShopifySyncService,
        private readonly checkouts: CheckoutService,
        private readonly config: ConfigService,
    ) { }

    onModuleInit() {
        this.intervalMs = (this.config.get<number>('shopify.reconcileMinutes') ?? 30) * 60_000;
        // A store is due once its interval has passed since its last run, and
        // ticks come at least every MAX_TICK_MS: on a plain interval timer each
        // restart (every deploy) would push the next run back a whole hour.
        this.timer = setInterval(() => void this.tick(), Math.min(this.intervalMs, MAX_TICK_MS));
    }

    onModuleDestroy() {
        if (this.timer) clearInterval(this.timer);
    }

    async tick(): Promise<void> {
        if (this.running) return;
        this.running = true;
        try {
            const due = await this.prisma.channel.findMany({
                where: { platform: ChannelPlatform.SHOPIFY, status: ChannelStatus.CONNECTED, isEnabled: true, ...this.dueWhere() },
                select: { id: true },
            });
            for (const { id } of due) {
                // Another server is catching this store up.
                const lock = `shopify:order-catch-up:${id}`;
                if (!(await this.redis.acquireLock(lock, LOCK_SECONDS))) continue;
                try {
                    // Read again behind the lock: another server may have finished it since.
                    const channel = await this.prisma.channel.findFirst({
                        where: { id, ...this.dueWhere() },
                        select: { id: true, organizationId: true, connectedAt: true, orderCatchUpAt: true },
                    });
                    if (channel) await this.catchUp(channel);
                } catch (err) {
                    this.logger.warn(`Orders for Shopify channel ${id} could not be caught up; the next run tries again: ${err instanceof Error ? err.message : err}`);
                } finally {
                    await this.redis.del(lock).catch(() => undefined);
                }
            }
        } catch (err) {
            this.logger.error(`Catching up Shopify orders failed: ${err instanceof Error ? err.stack : err}`);
        } finally {
            this.running = false;
        }
    }

    private dueWhere() {
        return { OR: [{ orderCatchUpAt: null }, { orderCatchUpAt: { lte: new Date(Date.now() - this.intervalMs) } }] };
    }

    private async catchUp(channel: CatchUpChannel): Promise<void> {
        const startedAt = new Date();
        // Orders from before the store was connected are the backfill's to
        // import, silently; reading them here would message their buyers.
        const since = new Date(Math.max(
            channel.orderCatchUpAt ? channel.orderCatchUpAt.getTime() - OVERLAP_MS : startedAt.getTime() - FIRST_RUN_MS,
            channel.connectedAt?.getTime() ?? 0,
        ));
        let recovered = 0;
        let failed = 0;
        for await (const orders of this.sync.ordersUpdatedSince(channel.id, since)) {
            const stored = await this.prisma.order.findMany({
                where: { channelId: channel.id, externalId: { in: orders.map((o) => String(o.id)) } },
                select: { externalId: true, externalUpdatedAt: true },
            });
            const storedAt = new Map(stored.map((o) => [o.externalId, o.externalUpdatedAt]));
            for (const order of orders) {
                try {
                    await this.checkouts.markCompleted(channel, order);
                    // Already stored at this state or a later one: its webhook was processed.
                    const have = storedAt.get(String(order.id));
                    if (have && Date.parse(order.updated_at) <= have.getTime()) continue;
                    await this.sync.upsertOrder(channel.id, channel.organizationId, order, {
                        live: isWithinWindow(order.created_at, FIRST_SIGHTING_EVENT_WINDOW_MS),
                    });
                    recovered++;
                } catch (err) {
                    // As on the webhook: a brief outage ends this store's run so
                    // the next one reads these orders again, while an order this
                    // code cannot handle is skipped rather than holding the rest back.
                    if (isTransientWebhookError(err)) throw err;
                    failed++;
                    this.logger.warn(`Shopify order ${order.id} on channel ${channel.id} could not be recovered: ${err instanceof Error ? err.message : err}`);
                }
            }
        }
        await this.prisma.channel.update({ where: { id: channel.id }, data: { orderCatchUpAt: startedAt } });
        if (recovered || failed) {
            this.logger.log(`Shopify channel ${channel.id}: recovered ${recovered} order change(s) no webhook had delivered; ${failed} could not be recovered.`);
        }
    }
}
