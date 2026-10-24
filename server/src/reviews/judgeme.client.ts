import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type ReviewerNameFormat = '' | 'last_initial' | 'all_initials' | 'anonymous';

/** Judge.me's RequestCreateReview. */
export interface JudgemeReview {
    shop_domain: string;
    platform: 'shopify';
    /** The Shopify product id; without it the review is of the shop. */
    id?: number;
    name: string;
    email: string;
    rating: number;
    body: string;
    reviewer_name_format: ReviewerNameFormat;
}

export class JudgemeApiError extends Error {
    constructor(readonly status: number, message: string) {
        super(message);
    }
}

/**
 * Judge.me's REST API (https://judge.me/api/docs): the private API key in the
 * X-Api-Token header and the shop as shop_domain. Creating a review needs no
 * key: Judge.me takes it like a review from its web form and saves it in the
 * background, and not at all when the store has web reviews turned off.
 */
@Injectable()
export class JudgemeClient {
    private readonly base: string;

    constructor(config: ConfigService) {
        this.base = config.get<string>('reviews.judgemeApiBase') ?? 'https://api.judge.me/api/v1';
    }

    shopInfo(shopDomain: string, apiToken: string) {
        return this.call<{ shop?: { name?: string; domain?: string; platform?: string; plan?: string } }>('GET', '/shops/info', { shop_domain: shopDomain }, apiToken);
    }

    /** Whether Judge.me publishes new reviews without approval; null when it does not say. */
    async autopublish(shopDomain: string, apiToken: string): Promise<boolean | null> {
        const res = await this.call<{ settings?: Record<string, unknown> }>('GET', '/settings', { shop_domain: shopDomain, 'setting_keys[]': 'autopublish' }, apiToken);
        const value = res.settings?.autopublish;
        return value === true || value === 'true' ? true : value === false || value === 'false' ? false : null;
    }

    async createReview(review: JudgemeReview): Promise<void> {
        await this.call('POST', '/reviews', {}, null, review);
    }

    private async call<T>(method: 'GET' | 'POST', path: string, query: Record<string, string>, apiToken: string | null, body?: unknown): Promise<T> {
        const url = new URL(`${this.base}${path}`);
        for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
        let res: Response;
        try {
            res = await fetch(url, {
                method,
                headers: {
                    ...(apiToken ? { 'x-api-token': apiToken } : {}),
                    ...(body ? { 'content-type': 'application/json' } : {}),
                },
                body: body ? JSON.stringify(body) : undefined,
                signal: AbortSignal.timeout(15_000),
            });
        } catch (err) {
            throw new JudgemeApiError(0, `Judge.me could not be reached: ${err instanceof Error ? err.message : err}`);
        }
        const json = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
        if (!res.ok) throw new JudgemeApiError(res.status, json?.error ?? json?.message ?? `Judge.me answered ${res.status}`);
        return (json ?? {}) as T;
    }
}
