import { randomBytes } from 'node:crypto';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PaymentProvider } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EncryptionService } from '../channel/encryption.service';
import { TEMPLATE_PACK_QUEUE, TemplatePackJobData, queuePackEnsureIfPresent } from '../campaigns/templates/pack/template-pack.queue';
import { RazorpayKeys, RazorpayMerchantClient } from './razorpay-merchant.client';

/** The Razorpay webhook events this app needs, to enable on the merchant's webhook. */
export const RAZORPAY_WEBHOOK_EVENTS = ['payment_link.paid', 'payment_link.partially_paid', 'payment_link.expired', 'payment_link.cancelled'];

interface Secrets {
    keySecret: string;
    webhookSecret: string;
}

export interface PaymentAccountView {
    connected: boolean;
    provider: 'RAZORPAY';
    keyId: string | null;
    livemode: boolean;
    /** The path segment of the webhook URL, shown to managers to set up in Razorpay. */
    webhookToken: string | null;
    webhookEvents: string[];
    lastWebhookAt: Date | null;
    connectedAt: Date | null;
}

/**
 * The organization's own Razorpay account. Payment links are created with
 * these keys, so customers pay the merchant directly. The key secret never
 * leaves the server; the webhook secret is shown on connect and on rotate,
 * because the merchant pastes it into Razorpay's webhook form.
 */
@Injectable()
export class PaymentAccountsService {
    private readonly logger = new Logger(PaymentAccountsService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly encryption: EncryptionService,
        private readonly razorpay: RazorpayMerchantClient,
        @InjectQueue(TEMPLATE_PACK_QUEUE) private readonly packQueue: Queue<TemplatePackJobData>,
    ) { }

    async view(orgId: string): Promise<PaymentAccountView> {
        const found = await this.prisma.paymentAccount.findUnique({ where: { organizationId_provider: { organizationId: orgId, provider: PaymentProvider.RAZORPAY } } });
        const account = found?.credentials && !found.disconnectedAt ? found : null;
        return {
            connected: !!account,
            provider: 'RAZORPAY',
            keyId: account?.keyId ?? null,
            livemode: account?.livemode ?? false,
            webhookToken: account?.webhookToken ?? null,
            webhookEvents: RAZORPAY_WEBHOOK_EVENTS,
            lastWebhookAt: account?.lastWebhookAt ?? null,
            connectedAt: account?.createdAt ?? null,
        };
    }

    async connect(orgId: string, userId: string, input: { keyId: string; keySecret: string }): Promise<PaymentAccountView & { webhookSecret: string }> {
        const keyId = input.keyId.trim();
        const keySecret = input.keySecret.trim();
        if (!/^rzp_(live|test)_[A-Za-z0-9]+$/.test(keyId)) throw new BadRequestException('A Razorpay key id starts with rzp_live_ or rzp_test_.');
        if (!(await this.razorpay.keysWork({ keyId, keySecret }))) {
            throw new BadRequestException('Razorpay did not accept this key id and secret. Copy them again from Razorpay → Account & Settings → API keys.');
        }
        const existing = await this.prisma.paymentAccount.findUnique({ where: { organizationId_provider: { organizationId: orgId, provider: PaymentProvider.RAZORPAY } } });
        // New keys on a connected account keep the webhook already set up in Razorpay working.
        const webhookSecret = existing?.credentials ? this.secrets(existing.credentials).webhookSecret : randomBytes(24).toString('base64url');
        const credentials = this.encryption.encrypt(JSON.stringify({ keySecret, webhookSecret } satisfies Secrets));
        const data = { keyId, credentials, livemode: keyId.startsWith('rzp_live_'), connectedById: userId, disconnectedAt: null };
        if (existing) {
            await this.prisma.paymentAccount.update({ where: { id: existing.id }, data });
        } else {
            await this.prisma.paymentAccount.create({
                data: { ...data, organizationId: orgId, provider: PaymentProvider.RAZORPAY, webhookToken: randomBytes(24).toString('base64url') },
            });
        }
        // Adds the payment templates to the recommended WhatsApp templates, where the
        // organization has them. Not awaited.
        void queuePackEnsureIfPresent(this.prisma, this.packQueue, orgId, 'razorpay').catch((err) =>
            this.logger.error(`Could not queue the payment WhatsApp templates for ${orgId}: ${err instanceof Error ? err.message : err}`),
        );
        return { ...(await this.view(orgId)), webhookSecret };
    }

    /** A new webhook secret, for when the old one may have leaked. The merchant updates Razorpay to match. */
    async rotateWebhookSecret(orgId: string): Promise<{ webhookSecret: string }> {
        const account = await this.require(orgId);
        const webhookSecret = randomBytes(24).toString('base64url');
        const { keySecret } = this.secrets(account.credentials!);
        await this.prisma.paymentAccount.update({
            where: { id: account.id },
            data: { credentials: this.encryption.encrypt(JSON.stringify({ keySecret, webhookSecret } satisfies Secrets)) },
        });
        return { webhookSecret };
    }

    /**
     * Clears the keys. Links already sent stay payable in Razorpay, but their
     * payments are no longer seen here; the links keep their history.
     */
    async disconnect(orgId: string): Promise<void> {
        const done = await this.prisma.paymentAccount.updateMany({
            where: { organizationId: orgId, provider: PaymentProvider.RAZORPAY, disconnectedAt: null },
            data: { credentials: null, disconnectedAt: new Date() },
        });
        if (!done.count) throw new NotFoundException('No Razorpay account is connected.');
    }

    async require(orgId: string) {
        const account = await this.prisma.paymentAccount.findUnique({ where: { organizationId_provider: { organizationId: orgId, provider: PaymentProvider.RAZORPAY } } });
        if (!account?.credentials || account.disconnectedAt) {
            throw new BadRequestException('Connect your Razorpay account in Settings → Orders → Payments to send payment links.');
        }
        return account as typeof account & { credentials: string };
    }

    keys(account: { keyId: string; credentials: string | null }): RazorpayKeys {
        return { keyId: account.keyId, keySecret: this.secrets(account.credentials!).keySecret };
    }

    /** Null once disconnected: its webhooks are then refused. */
    webhookSecret(account: { credentials: string | null; disconnectedAt: Date | null }): string | null {
        return account.credentials && !account.disconnectedAt ? this.secrets(account.credentials).webhookSecret : null;
    }

    private secrets(cipher: string): Secrets {
        return JSON.parse(this.encryption.decrypt(cipher)) as Secrets;
    }
}
