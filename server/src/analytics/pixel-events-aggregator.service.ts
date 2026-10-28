import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { rememberProductId } from './product-image-match.util';

interface PixelDay {
    channelId: string;
    organizationId: string;
    date: string;
    viewersByProduct: Map<string, Set<string>>;
    addToCartsByProduct: Map<string, number>;
    /** Shopify product id per title, kept so the Analytics page can show its image. */
    productIdByTitle: Map<string, string>;
    viewsByPage: Map<string, { title: string | null; views: number }>;
    visitors: Set<string>;
    pageviews: number;
    addToCartVisitors: Set<string>;
    checkoutStartedVisitors: Set<string>;
    checkoutCompletedVisitors: Set<string>;
}

/**
 * Rolls Web Pixel events (RawAnalyticsEvent rows with visitorId set) into
 * AnalyticsSnapshot. The pixel is the SOLE source for productViews and the
 * pixel* top-level counts; it never touches addToCarts / checkouts (webhook-
 * owned) or orders/revenue (Order-table-owned) — one source per metric.
 */
@Injectable()
export class PixelEventsAggregator {
    private readonly logger = new Logger(PixelEventsAggregator.name);

    constructor(private readonly prisma: PrismaService) { }

    @Cron(CronExpression.EVERY_HOUR)
    async runHourly(): Promise<void> {
        await this.rollup(new Date(Date.now() - 60 * 60 * 1000));
    }

    /** The Refresh button names its own workspace; only the hourly cron runs across every workspace. */
    async rollupRecentDay(organizationId: string): Promise<void> {
        await this.rollup(new Date(Date.now() - 24 * 60 * 60 * 1000), organizationId);
    }

    async rollup(since: Date, organizationId?: string): Promise<void> {
        const events = await this.prisma.rawAnalyticsEvent.findMany({
            where: {
                ...(organizationId && { organizationId }),
                occurredAt: { gte: since },
                visitorId: { not: null },
                eventName: {
                    in: [
                        'page_viewed', 'product_viewed', 'product_added_to_cart',
                        'checkout_started', 'checkout_completed',
                    ],
                },
            },
            orderBy: { occurredAt: 'asc' },
            select: {
                organizationId: true,
                channelId: true,
                occurredAt: true,
                eventName: true,
                visitorId: true,
                payload: true,
            },
        });
        if (events.length === 0) return;

        const buckets = new Map<string, PixelDay>();
        for (const evt of events) {
            const date = evt.occurredAt.toISOString().slice(0, 10);
            const key = `${evt.channelId}:${date}`;
            const slot = buckets.get(key) ?? {
                channelId: evt.channelId,
                organizationId: evt.organizationId,
                date,
                viewersByProduct: new Map(),
                addToCartsByProduct: new Map(),
                productIdByTitle: new Map(),
                viewsByPage: new Map(),
                visitors: new Set(),
                pageviews: 0,
                addToCartVisitors: new Set(),
                checkoutStartedVisitors: new Set(),
                checkoutCompletedVisitors: new Set(),
            };
            const visitor = evt.visitorId!;
            slot.visitors.add(visitor);

            switch (evt.eventName) {
                case 'page_viewed': {
                    slot.pageviews += 1;
                    const p = evt.payload as { pagePath?: string; pageTitle?: string } | null;
                    if (p?.pagePath) {
                        const entry = slot.viewsByPage.get(p.pagePath)
                            ?? { title: p.pageTitle ?? null, views: 0 };
                        entry.views += 1;
                        if (!entry.title && p.pageTitle) entry.title = p.pageTitle;
                        slot.viewsByPage.set(p.pagePath, entry);
                    }
                    break;
                }
                case 'product_viewed': {
                    const p = evt.payload as { productTitle?: string; productId?: unknown } | null;
                    const title = p?.productTitle;
                    if (title) {
                        const viewers = slot.viewersByProduct.get(title) ?? new Set<string>();
                        viewers.add(visitor);
                        slot.viewersByProduct.set(title, viewers);
                        rememberProductId(slot.productIdByTitle, title, p?.productId);
                    }
                    break;
                }
                case 'product_added_to_cart': {
                    slot.addToCartVisitors.add(visitor);
                    const p = evt.payload as { productTitle?: string; productId?: unknown } | null;
                    const title = p?.productTitle;
                    if (title) {
                        rememberProductId(slot.productIdByTitle, title, p?.productId);
                        slot.addToCartsByProduct.set(
                            title,
                            (slot.addToCartsByProduct.get(title) ?? 0) + 1,
                        );
                    }
                    break;
                }
                case 'checkout_started':
                    slot.checkoutStartedVisitors.add(visitor);
                    break;
                case 'checkout_completed':
                    slot.checkoutCompletedVisitors.add(visitor);
                    break;
            }
            buckets.set(key, slot);
        }

        for (const bucket of buckets.values()) {
            await this.upsertSnapshot(bucket);
        }
        this.logger.log(
            `[pixel-agg] Rolled up ${events.length} pixel events into ${buckets.size} snapshot row(s)`,
        );
    }

    private async upsertSnapshot(bucket: PixelDay): Promise<void> {
        const date = new Date(`${bucket.date}T00:00:00.000Z`);
        const existing = await this.prisma.analyticsSnapshot.findUnique({
            where: {
                channelId_date_granularity: { channelId: bucket.channelId, date, granularity: 'DAILY' },
            },
        });
        const existingMetrics = (existing?.metrics as Record<string, unknown> | null) ?? {};

        const byProduct = new Map<
            string,
            { productId?: string; productViews: number; addToCarts: number; checkouts: number; orders: number }
        >();
        for (const row of (existingMetrics.byProduct as Array<{
            productTitle: string; productId?: string; productViews?: number; addToCarts?: number;
            checkouts?: number; orders?: number;
        }> | undefined) ?? []) {
            byProduct.set(row.productTitle, {
                productId: row.productId,
                productViews: row.productViews ?? 0,
                addToCarts: row.addToCarts ?? 0,
                checkouts: row.checkouts ?? 0,
                orders: row.orders ?? 0,
            });
        }
        for (const [title, viewers] of bucket.viewersByProduct) {
            const slot = byProduct.get(title) ?? { productViews: 0, addToCarts: 0, checkouts: 0, orders: 0 };
            slot.productViews = viewers.size;
            byProduct.set(title, slot);
        }
        // Pixel-counted add-to-carts per product. Webhooks may have already
        // written an addToCarts count for the same product — keep whichever
        // is larger so re-running the rollup never shrinks a count.
        for (const [title, count] of bucket.addToCartsByProduct) {
            const slot = byProduct.get(title) ?? { productViews: 0, addToCarts: 0, checkouts: 0, orders: 0 };
            slot.addToCarts = Math.max(slot.addToCarts, count);
            byProduct.set(title, slot);
        }
        for (const [title, id] of bucket.productIdByTitle) {
            const slot = byProduct.get(title);
            if (slot && !slot.productId) slot.productId = id;
        }

        const nextMetrics = {
            ...existingMetrics,
            byProduct: Array.from(byProduct.entries()).map(([productTitle, v]) => ({ productTitle, ...v })),
            byPage: Array.from(bucket.viewsByPage.entries()).map(([path, v]) => ({
                path,
                title: v.title,
                views: v.views,
            })),
            pixelSessions: bucket.visitors.size,
            pixelPageviews: bucket.pageviews,
            pixelAddToCartSessions: bucket.addToCartVisitors.size,
            pixelCheckoutStartedSessions: bucket.checkoutStartedVisitors.size,
            pixelCheckoutCompletedSessions: bucket.checkoutCompletedVisitors.size,
        };

        await this.prisma.analyticsSnapshot.upsert({
            where: {
                channelId_date_granularity: { channelId: bucket.channelId, date, granularity: 'DAILY' },
            },
            create: {
                organizationId: bucket.organizationId,
                channelId: bucket.channelId,
                date,
                granularity: 'DAILY',
                source: 'shopify_pixel',
                metrics: nextMetrics as Prisma.InputJsonValue,
            },
            update: {
                source: existing?.source ?? 'shopify_pixel',
                metrics: nextMetrics as Prisma.InputJsonValue,
            },
        });
    }
}