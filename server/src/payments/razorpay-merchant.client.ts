import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface RazorpayKeys {
    keyId: string;
    keySecret: string;
}

/** The fields of a Razorpay Payment Link this app reads. */
export interface RazorpayPaymentLink {
    id: string;
    short_url: string;
    status: 'created' | 'partially_paid' | 'paid' | 'expired' | 'cancelled';
    amount: number;
    amount_paid: number;
    currency: string;
    reference_id: string | null;
    payments?: Array<{ payment_id: string; amount: number; method: string; status: string }> | null;
}

export interface CreatePaymentLinkInput {
    /** In paise. */
    amount: number;
    currency: string;
    reference_id: string;
    description: string;
    customer: { name?: string; contact?: string; email?: string };
    /** Unix seconds. */
    expire_by: number;
    notes: Record<string, string>;
}

export class RazorpayApiError extends Error {
    constructor(readonly status: number, message: string) {
        super(message);
    }
}

/**
 * The merchant's own Razorpay account, called with the keys they connected.
 * Payment Links API: POST/GET /v1/payment_links, POST /v1/payment_links/:id/cancel,
 * HTTP Basic auth with the key id and secret.
 */
@Injectable()
export class RazorpayMerchantClient {
    private readonly base: string;

    constructor(config: ConfigService) {
        this.base = config.get<string>('payments.razorpayApiBase') ?? 'https://api.razorpay.com';
    }

    /** True when Razorpay accepts the keys; a 401 means they are wrong. */
    async keysWork(keys: RazorpayKeys): Promise<boolean> {
        try {
            await this.call(keys, 'GET', '/v1/payment_links?count=1');
            return true;
        } catch (err) {
            if (err instanceof RazorpayApiError && err.status === 401) return false;
            throw err;
        }
    }

    create(keys: RazorpayKeys, input: CreatePaymentLinkInput): Promise<RazorpayPaymentLink> {
        return this.call(keys, 'POST', '/v1/payment_links', {
            ...input,
            accept_partial: false,
            // We send the link in chat; Razorpay's own SMS and email would be a second copy.
            notify: { sms: false, email: false },
            reminder_enable: false,
        });
    }

    fetch(keys: RazorpayKeys, id: string): Promise<RazorpayPaymentLink> {
        return this.call(keys, 'GET', `/v1/payment_links/${encodeURIComponent(id)}`);
    }

    cancel(keys: RazorpayKeys, id: string): Promise<RazorpayPaymentLink> {
        return this.call(keys, 'POST', `/v1/payment_links/${encodeURIComponent(id)}/cancel`);
    }

    private async call<T>(keys: RazorpayKeys, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
        let res: Response;
        try {
            res = await fetch(`${this.base}${path}`, {
                method,
                headers: {
                    authorization: `Basic ${Buffer.from(`${keys.keyId}:${keys.keySecret}`).toString('base64')}`,
                    ...(body ? { 'content-type': 'application/json' } : {}),
                },
                body: body ? JSON.stringify(body) : undefined,
                signal: AbortSignal.timeout(15_000),
            });
        } catch (err) {
            throw new RazorpayApiError(0, `Razorpay could not be reached: ${err instanceof Error ? err.message : err}`);
        }
        const json = (await res.json().catch(() => null)) as { error?: { description?: string } } | null;
        if (!res.ok) throw new RazorpayApiError(res.status, json?.error?.description ?? `Razorpay answered ${res.status}`);
        return json as T;
    }
}
