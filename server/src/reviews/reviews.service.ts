import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, ProductReviewStatus, ReviewProvider } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { contactName } from '../messaging/contact-name';
import { JudgemeApiError, JudgemeClient, ReviewerNameFormat } from './judgeme.client';
import { parseRating, reviewText } from './review-rating';

export interface ReviewAccountView {
    connected: boolean;
    provider: 'JUDGEME';
    shopDomain: string | null;
    shopName: string | null;
    /** Whether Judge.me publishes new reviews without approval; null when unknown. */
    autopublish: boolean | null;
    connectedAt: Date | null;
}

export interface PublishInput {
    orgId: string;
    orderId: string;
    contactId: string;
    conversationId: string | null;
    runId: string;
    /** The rating as the customer gave it ("4 - Good", "⭐⭐⭐⭐"). */
    rating: string;
    text: string;
    products: 'first' | 'each';
    nameFormat: ReviewerNameFormat;
    contactName: string;
}

export interface PublishedReview {
    id: string;
    productTitle: string | null;
    status: ProductReviewStatus;
    reason: string | null;
}

const PAGE_SIZE = 25;
const MYSHOPIFY = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

/** Keeps "https://Acme.myshopify.com/admin" as "acme.myshopify.com". */
export function shopDomainOf(input: string): string {
    return input.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
}

/** The Shopify product id as Judge.me's number: "7001" or "gid://shopify/Product/7001". */
function productNumber(externalId: string | null): number | undefined {
    const digits = externalId ? /(\d+)$/.exec(externalId)?.[1] : undefined;
    return digits ? Number(digits) : undefined;
}

/**
 * Reviews collected on WhatsApp, published to the merchant's own Judge.me.
 * Every rating is published, high or low; Judge.me's own moderation decides
 * what shows on the store. A review Judge.me cannot take (no words, no email,
 * no Judge.me) is kept in Collabo with the reason.
 */
@Injectable()
export class ReviewsService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly judgeme: JudgemeClient,
    ) { }

    // ─── The Judge.me connection ─────────────────────────────────────────

    async account(orgId: string): Promise<ReviewAccountView> {
        const account = await this.active(orgId);
        return {
            connected: !!account,
            provider: 'JUDGEME',
            shopDomain: account?.shopDomain ?? null,
            shopName: account?.shopName ?? null,
            autopublish: account?.autopublish ?? null,
            connectedAt: account?.updatedAt ?? null,
        };
    }

    async connect(orgId: string, userId: string, input: { shopDomain: string; apiToken: string }): Promise<ReviewAccountView> {
        const shopDomain = shopDomainOf(input.shopDomain);
        const apiToken = input.apiToken.trim();
        if (!MYSHOPIFY.test(shopDomain)) throw new BadRequestException('Use the shop’s myshopify.com address, like your-store.myshopify.com.');
        let shopName: string | null;
        try {
            shopName = (await this.judgeme.shopInfo(shopDomain, apiToken)).shop?.name ?? null;
        } catch (err) {
            if (err instanceof JudgemeApiError && err.status >= 400 && err.status < 500) {
                throw new BadRequestException('Judge.me did not accept this API token for that shop. Copy the private API token from Judge.me → Settings → Integrations → View API tokens.');
            }
            throw new BadRequestException(err instanceof Error ? err.message : 'Judge.me could not be reached.');
        }
        // Only shown to the merchant; connecting does not depend on it.
        const autopublish = await this.judgeme.autopublish(shopDomain, apiToken).catch(() => null);
        // The key proves the shop is the merchant's; it is not kept, since publishing needs none.
        const data = { shopDomain, shopName, autopublish, connectedById: userId, disconnectedAt: null };
        await this.prisma.reviewAccount.upsert({
            where: { organizationId_provider: { organizationId: orgId, provider: ReviewProvider.JUDGEME } },
            create: { organizationId: orgId, provider: ReviewProvider.JUDGEME, ...data },
            update: data,
        });
        return this.account(orgId);
    }

    async disconnect(orgId: string): Promise<void> {
        const done = await this.prisma.reviewAccount.updateMany({
            where: { organizationId: orgId, provider: ReviewProvider.JUDGEME, disconnectedAt: null },
            data: { disconnectedAt: new Date() },
        });
        if (!done.count) throw new NotFoundException('Judge.me is not connected.');
    }

    // ─── Publishing ──────────────────────────────────────────────────────

    /** One review per product (the order's first, or each), published to Judge.me when it can take it. */
    async publish(input: PublishInput): Promise<{ rating: number; reviews: PublishedReview[] }> {
        const rating = parseRating(input.rating);
        if (rating === null) throw new BadRequestException(`No rating from 1 to 5 in “${input.rating.slice(0, 60)}”.`);
        const order = await this.prisma.order.findFirst({
            where: { id: input.orderId, organizationId: input.orgId },
            select: {
                shippingAddress: true,
                customer: { select: { firstName: true, lastName: true, email: true } },
                lineItems: { select: { externalProductId: true, title: true }, orderBy: { createdAt: 'asc' } },
            },
        });
        if (!order) throw new NotFoundException('The order for this review was not found.');

        const seen = new Set<string>();
        const lines = order.lineItems.filter((l) => l.externalProductId && !seen.has(l.externalProductId) && seen.add(l.externalProductId));
        // An order of custom items only is reviewed as the shop.
        const products: Array<{ externalId: string | null; title: string | null }> = lines.length
            ? (input.products === 'each' ? lines : lines.slice(0, 1)).map((l) => ({ externalId: l.externalProductId, title: l.title }))
            : [{ externalId: null, title: null }];

        const ship = (order.shippingAddress ?? {}) as Record<string, string | undefined>;
        const name =
            [order.customer?.firstName, order.customer?.lastName].filter(Boolean).join(' ').trim() ||
            (ship.name ?? [ship.first_name ?? ship.firstName, ship.last_name ?? ship.lastName].filter(Boolean).join(' ')).trim() ||
            input.contactName ||
            'WhatsApp customer';
        const email = order.customer?.email?.trim() || null;
        const body = reviewText(input.text);
        const account = await this.active(input.orgId);

        const reviews: PublishedReview[] = [];
        for (const product of products) {
            const already = await this.prisma.productReview.findFirst({
                where: { organizationId: input.orgId, orderId: input.orderId, productExternalId: product.externalId, status: ProductReviewStatus.POSTED },
                select: { id: true },
            });
            let status: ProductReviewStatus = ProductReviewStatus.SAVED;
            let reason: string | null = null;
            if (already) reason = 'Already published for this order.';
            else if (!body) reason = 'Rating only: no review text.';
            else if (!email) reason = 'The order has no email address, which Judge.me needs.';
            else if (!account) reason = 'Judge.me is not connected.';
            else {
                try {
                    await this.judgeme.createReview({
                        shop_domain: account.shopDomain,
                        platform: 'shopify',
                        ...(productNumber(product.externalId) !== undefined ? { id: productNumber(product.externalId) } : {}),
                        name,
                        email,
                        rating,
                        body,
                        reviewer_name_format: input.nameFormat,
                    });
                    status = ProductReviewStatus.POSTED;
                } catch (err) {
                    status = ProductReviewStatus.FAILED;
                    reason = (err instanceof Error ? err.message : String(err)).slice(0, 500);
                }
            }
            const row = await this.prisma.productReview.create({
                data: {
                    organizationId: input.orgId,
                    orderId: input.orderId,
                    conversationId: input.conversationId,
                    contactId: input.contactId,
                    automationRunId: input.runId,
                    productExternalId: product.externalId,
                    productTitle: product.title,
                    rating,
                    body,
                    reviewerName: name.slice(0, 200),
                    reviewerEmail: email,
                    provider: status === ProductReviewStatus.SAVED ? null : ReviewProvider.JUDGEME,
                    status,
                    reason,
                    postedAt: status === ProductReviewStatus.POSTED ? new Date() : null,
                },
                select: { id: true },
            });
            reviews.push({ id: row.id, productTitle: product.title, status, reason });
        }
        return { rating, reviews };
    }

    /** The chat note for what happened to a customer's review. */
    noteFor(rating: number, body: string, reviews: PublishedReview[]): string {
        const words = reviewText(body);
        const lines = reviews.map((r) => {
            const what = `${rating}★ review of ${r.productTitle ?? 'the shop'}`;
            if (r.status === ProductReviewStatus.POSTED) return `${what}, published to Judge.me.`;
            if (r.status === ProductReviewStatus.FAILED) return `${what}, not published: ${r.reason}`;
            return `${what}, kept in Collabo: ${r.reason}`;
        });
        return [...lines, ...(words ? [`“${words}”`] : [])].join('\n').slice(0, 2000);
    }

    // ─── Campaigns → Reviews ─────────────────────────────────────────────

    async list(orgId: string, q: { rating?: number; status?: ProductReviewStatus; page?: number }) {
        const where: Prisma.ProductReviewWhereInput = {
            organizationId: orgId,
            ...(q.rating ? { rating: q.rating } : {}),
            ...(q.status ? { status: q.status } : {}),
        };
        const page = Math.max(1, q.page ?? 1);
        const [rows, total, byRating, published] = await Promise.all([
            this.prisma.productReview.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                skip: (page - 1) * PAGE_SIZE,
                take: PAGE_SIZE,
                include: {
                    order: { select: { id: true, name: true } },
                    contact: { select: { displayName: true, addressBookName: true, username: true, phone: true, externalId: true } },
                },
            }),
            this.prisma.productReview.count({ where }),
            this.prisma.productReview.groupBy({ by: ['rating'], where: { organizationId: orgId }, _count: { _all: true } }),
            this.prisma.productReview.count({ where: { organizationId: orgId, status: ProductReviewStatus.POSTED } }),
        ]);
        const counts = Object.fromEntries([1, 2, 3, 4, 5].map((r) => [r, byRating.find((g) => g.rating === r)?._count._all ?? 0])) as Record<number, number>;
        const count = Object.values(counts).reduce((a, b) => a + b, 0);
        const sum = Object.entries(counts).reduce((a, [r, n]) => a + Number(r) * n, 0);
        return {
            reviews: rows.map((r) => ({
                id: r.id,
                rating: r.rating,
                body: r.body,
                productTitle: r.productTitle,
                reviewerName: r.reviewerName,
                contactName: r.contact ? contactName(r.contact) : r.reviewerName,
                order: r.order,
                conversationId: r.conversationId,
                status: r.status,
                reason: r.reason,
                createdAt: r.createdAt,
                postedAt: r.postedAt,
            })),
            total,
            page,
            pageSize: PAGE_SIZE,
            stats: { count, average: count ? Math.round((sum / count) * 10) / 10 : null, byRating: counts, published },
        };
    }

    private async active(orgId: string) {
        const account = await this.prisma.reviewAccount.findUnique({ where: { organizationId_provider: { organizationId: orgId, provider: ReviewProvider.JUDGEME } } });
        return account && !account.disconnectedAt ? account : null;
    }
}
