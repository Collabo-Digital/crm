import {
    Injectable,
    Logger,
    OnModuleInit,
    ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import Razorpay from 'razorpay';

import { RazorpayApiError, RazorpayPaymentLink } from '../payments/razorpay-merchant.client';

interface RazorpayCustomer {
    id: string;
    name: string;
    email: string;
}

interface RazorpaySubscription {
    id: string;
    status: string;
    current_end: number | null;
    current_start: number | null;
    plan_id: string;
    /** card, emandate or upi. Add-ons can only be added to card subscriptions. */
    payment_method?: string | null;
    customer_email?: string | null;
    customer_contact?: string | null;
}

export interface RazorpayAddon {
    id: string;
    subscription_id: string;
    invoice_id: string | null;
    item: { name: string; description: string | null; amount: number; currency: string };
}

const SDK_TIMEOUT_MS = 5_000;

/**
 * Thin wrapper around the Razorpay Node SDK.
 *
 * - Reads RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET / RAZORPAY_WEBHOOK_SECRET from env.
 * - If keys are missing, the service still boots but every method throws 503 —
 *   the rest of the app runs fine without payment.
 * - All SDK calls are wrapped in a 5s timeout so a slow Razorpay can't cascade
 *   into slow user-facing requests.
 */
@Injectable()
export class RazorpayService implements OnModuleInit {
    private readonly logger = new Logger(RazorpayService.name);
    private client: Razorpay | null = null;
    private webhookSecret: string | null = null;

    constructor(private readonly config: ConfigService) { }

    onModuleInit() {
        const keyId = this.config.get<string>('RAZORPAY_KEY_ID');
        const keySecret = this.config.get<string>('RAZORPAY_KEY_SECRET');
        this.webhookSecret =
            this.config.get<string>('RAZORPAY_WEBHOOK_SECRET') ?? null;

        if (!keyId || !keySecret) {
            this.logger.warn(
                'Razorpay credentials missing — /billing endpoints will return 503',
            );
            return;
        }

        this.client = new Razorpay({ key_id: keyId, key_secret: keySecret });
        this.logger.log('Razorpay SDK initialized');
    }

    private requireClient(): Razorpay {
        if (!this.client) {
            throw new ServiceUnavailableException('Billing not configured');
        }
        return this.client;
    }

    /** Wraps an SDK call with a 5s timeout. */
    private withTimeout<T>(operation: string, p: Promise<T>): Promise<T> {
        return Promise.race([
            p,
            new Promise<never>((_, reject) =>
                setTimeout(
                    () =>
                        reject(
                            new ServiceUnavailableException(
                                `Razorpay ${operation} timed out`,
                            ),
                        ),
                    SDK_TIMEOUT_MS,
                ),
            ),
        ]);
    }

    async createCustomer(input: {
        name: string;
        email: string;
    }): Promise<RazorpayCustomer> {
        const client = this.requireClient();
        return this.withTimeout(
            'createCustomer',
            client.customers.create({
                name: input.name,
                email: input.email,
                fail_existing: 0,
            }) as unknown as Promise<RazorpayCustomer>,
        );
    }

    async createSubscription(input: {
        planId: string;
        totalCount?: number;
        notes?: Record<string, string>;
        /** Pre-fills the email field in Razorpay's hosted checkout modal. */
        notifyEmail?: string;
        notifyPhone?: string;
    }): Promise<RazorpaySubscription> {
        const client = this.requireClient();
        const notifyInfo: Record<string, string> = {};
        if (input.notifyEmail) notifyInfo.notify_email = input.notifyEmail;
        if (input.notifyPhone) notifyInfo.notify_phone = input.notifyPhone;

        return this.withTimeout(
            'createSubscription',
            client.subscriptions.create({
                plan_id: input.planId,
                customer_notify: 1,
                // 120 monthly cycles ≈ 10 years — subscriptions end via cancel,
                // not expiry, so this is effectively "no end".
                total_count: input.totalCount ?? 120,
                notes: input.notes,
                ...(Object.keys(notifyInfo).length > 0
                    ? { notify_info: notifyInfo }
                    : {}),
            } as Parameters<typeof client.subscriptions.create>[0]) as unknown as Promise<RazorpaySubscription>,
        );
    }

    async fetchSubscription(id: string): Promise<RazorpaySubscription> {
        return this.rest('GET', `/v1/subscriptions/${encodeURIComponent(id)}`);
    }

    /** One charge on the subscription's next invoice. Razorpay takes these only on card subscriptions. */
    addAddon(subscriptionId: string, item: { name: string; amount: number; currency: string; description: string }): Promise<RazorpayAddon> {
        return this.rest('POST', `/v1/subscriptions/${encodeURIComponent(subscriptionId)}/addons`, { item, quantity: 1 });
    }

    /** Every add-on created since `from` (unix seconds), across subscriptions. */
    async addonsSince(from: number): Promise<RazorpayAddon[]> {
        const all: RazorpayAddon[] = [];
        for (let skip = 0; skip < 1000; skip += 100) {
            const page = await this.rest<{ items: RazorpayAddon[] }>('GET', `/v1/addons?from=${from}&count=100&skip=${skip}`);
            all.push(...page.items);
            if (page.items.length < 100) break;
        }
        return all;
    }

    /** A payment link Razorpay emails (and texts, with a phone number) to the customer, with reminders. */
    createPaymentLink(input: {
        amount: number;
        currency: string;
        description: string;
        reference_id: string;
        customer: { name?: string; email?: string; contact?: string };
        notes: Record<string, string>;
    }): Promise<RazorpayPaymentLink> {
        return this.rest('POST', '/v1/payment_links', {
            ...input,
            accept_partial: false,
            notify: { email: !!input.customer.email, sms: !!input.customer.contact },
            reminder_enable: true,
        });
    }

    async paymentLinkByReference(referenceId: string): Promise<RazorpayPaymentLink | null> {
        const found = await this.rest<{ payment_links: RazorpayPaymentLink[] }>('GET', `/v1/payment_links?reference_id=${encodeURIComponent(referenceId)}`);
        return found.payment_links[0] ?? null;
    }

    paymentLink(id: string): Promise<RazorpayPaymentLink> {
        return this.rest('GET', `/v1/payment_links/${encodeURIComponent(id)}`);
    }

    /**
     * Razorpay's REST API with Collabo's keys. Used for the calls usage billing
     * makes, so tests can point RAZORPAY_API_BASE at a stand-in: the SDK's host is fixed.
     */
    private async rest<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
        const keyId = this.config.get<string>('RAZORPAY_KEY_ID');
        const keySecret = this.config.get<string>('RAZORPAY_KEY_SECRET');
        if (!keyId || !keySecret) throw new ServiceUnavailableException('Billing not configured');
        const base = this.config.get<string>('billing.razorpayApiBase') ?? 'https://api.razorpay.com';
        let res: Response;
        try {
            res = await fetch(`${base}${path}`, {
                method,
                headers: {
                    authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`,
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

    async cancelSubscription(id: string): Promise<void> {
        const client = this.requireClient();
        await this.withTimeout(
            'cancelSubscription',
            client.subscriptions.cancel(id, false) as unknown as Promise<unknown>,
        );
    }

    /** Constant-time HMAC-SHA256 verification for webhook payloads. */
    verifyWebhookSignature(rawBody: Buffer, signature: string): boolean {
        if (!this.webhookSecret) {
            this.logger.error('RAZORPAY_WEBHOOK_SECRET not set');
            return false;
        }

        const expected = createHmac('sha256', this.webhookSecret)
            .update(rawBody)
            .digest('hex');

        const sigBuf = Buffer.from(signature, 'utf8');
        const expBuf = Buffer.from(expected, 'utf8');

        if (sigBuf.length !== expBuf.length) return false;
        return timingSafeEqual(sigBuf, expBuf);
    }

    /** Returns the public key id, for the client to mount Checkout.js. */
    getKeyId(): string | null {
        return this.config.get<string>('RAZORPAY_KEY_ID') ?? null;
    }

    /** True iff RAZORPAY_KEY_ID/SECRET are configured. */
    isConfigured(): boolean {
        return this.client !== null;
    }
}
