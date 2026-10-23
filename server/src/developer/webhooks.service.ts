import { createHmac, randomBytes } from 'node:crypto';
import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AutomationEvent, ChannelContact, Prisma } from '@prisma/client';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { EncryptionService } from '../channel/encryption.service';
import { CommerceEventsService } from '../commerce/commerce-events.service';
import type { StoreEventKind } from '../commerce/order-vars';
import { contactName } from '../messaging/contact-name';
import { guardedRequest } from '../automation/engine/http-request';

export const WEBHOOK_QUEUE = 'webhooks';
/** About two hours of retries: 30 s, 1, 2, 4, 8, 16, 32 and 64 minutes. */
export const WEBHOOK_ATTEMPTS = 8;
/** An endpoint failing this many deliveries in a row is switched off. */
const MAX_CONSECUTIVE_FAILURES = 20;

export const WEBHOOK_EVENTS = [
    'message.received',
    'contact.tag_added',
    'order.created',
    'order.paid',
    'order.fulfilled',
    'order.delivered',
    'order.cancelled',
    'payment.received',
    'website.signup',
    'ad.referral',
] as const;

const isUniqueViolation = (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
const MESSAGE_EVENTS = ['whatsapp.message', 'whatsapp.cart', 'instagram.message', 'facebook.message'];

/** `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`, keyed by the endpoint's secret. */
export function webhookSignature(secret: string, body: string, t: number): string {
    return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
}

/**
 * Outgoing webhooks: Collabo posts JSON to the merchant's URLs when things
 * happen, signed so they can trust it (Collabo-Signature), retried with
 * backoff, logged per delivery, and switched off after 20 failures in a row.
 * A source event is sent to an endpoint once, however often it is replayed.
 */
@Injectable()
export class WebhooksService implements OnModuleInit {
    private readonly logger = new Logger(WebhooksService.name);
    private readonly allowPrivate: boolean;

    constructor(
        private readonly prisma: PrismaService,
        private readonly encryption: EncryptionService,
        private readonly commerceEvents: CommerceEventsService,
        @InjectQueue(WEBHOOK_QUEUE) private readonly queue: Queue<{ deliveryId: string }>,
        config: ConfigService,
    ) {
        this.allowPrivate = config.get<string>('AUTOMATION_HTTP_ALLOW_PRIVATE') === 'true';
    }

    onModuleInit() {
        this.commerceEvents.onOrder((orderId, kinds) => this.fromOrder(orderId, kinds));
        this.commerceEvents.onPayment((linkId) => this.fromPayment(linkId));
    }

    // ─── Endpoints ─────────────────────────────────────────────────────

    async list(orgId: string) {
        const rows = await this.prisma.webhookEndpoint.findMany({ where: { organizationId: orgId }, orderBy: { createdAt: 'desc' } });
        return rows.map((r) => this.view(r));
    }

    async create(orgId: string, input: { url: string; events: string[]; description?: string; createdById?: string | null; apiKeyId?: string | null }) {
        const url = this.checkUrl(input.url);
        const events = this.checkEvents(input.events);
        const secret = `whsec_${randomBytes(24).toString('base64url')}`;
        const row = await this.prisma.webhookEndpoint.create({
            data: {
                organizationId: orgId,
                url,
                events,
                description: input.description?.trim() || null,
                secret: this.encryption.encrypt(secret),
                createdById: input.createdById ?? null,
                apiKeyId: input.apiKeyId ?? null,
            },
        });
        return { ...this.view(row), secret };
    }

    async update(orgId: string, id: string, input: { url?: string; events?: string[]; description?: string | null; enabled?: boolean }) {
        const row = await this.endpoint(orgId, id);
        const updated = await this.prisma.webhookEndpoint.update({
            where: { id: row.id },
            data: {
                ...(input.url !== undefined ? { url: this.checkUrl(input.url) } : {}),
                ...(input.events !== undefined ? { events: this.checkEvents(input.events) } : {}),
                ...(input.description !== undefined ? { description: input.description?.trim() || null } : {}),
                // Switching it back on clears the failure count and the reason.
                ...(input.enabled !== undefined ? { enabled: input.enabled, ...(input.enabled ? { consecutiveFailures: 0, disabledReason: null } : {}) } : {}),
            },
        });
        return this.view(updated);
    }

    async rotateSecret(orgId: string, id: string) {
        const row = await this.endpoint(orgId, id);
        const secret = `whsec_${randomBytes(24).toString('base64url')}`;
        await this.prisma.webhookEndpoint.update({ where: { id: row.id }, data: { secret: this.encryption.encrypt(secret) } });
        return { secret };
    }

    async remove(orgId: string, id: string, apiKeyId?: string) {
        const done = await this.prisma.webhookEndpoint.deleteMany({ where: { id, organizationId: orgId, ...(apiKeyId ? { apiKeyId } : {}) } });
        if (!done.count) throw new NotFoundException('Webhook not found');
    }

    async deliveries(orgId: string, id: string) {
        await this.endpoint(orgId, id);
        return this.prisma.webhookDelivery.findMany({
            where: { endpointId: id },
            orderBy: { createdAt: 'desc' },
            take: 50,
            select: { id: true, event: true, status: true, attempts: true, responseStatus: true, error: true, createdAt: true, deliveredAt: true },
        });
    }

    /** A `ping` to one endpoint, to check the receiving side. */
    async test(orgId: string, id: string) {
        const row = await this.endpoint(orgId, id);
        const delivery = await this.prisma.webhookDelivery.create({
            data: { endpointId: row.id, organizationId: orgId, event: 'ping', sourceId: `ping:${randomBytes(8).toString('hex')}`, payload: { message: 'Hello from Collabo.' } },
        });
        await this.queue.add('deliver', { deliveryId: delivery.id }, { jobId: delivery.id, attempts: 1 });
        return { deliveryId: delivery.id };
    }

    // ─── Events ────────────────────────────────────────────────────────

    /** Queue one delivery per subscribed endpoint; a source already sent to an endpoint is skipped. */
    async emit(orgId: string, event: string, sourceId: string, data: Record<string, unknown>): Promise<number> {
        const endpoints = await this.prisma.webhookEndpoint.findMany({ where: { organizationId: orgId, enabled: true, events: { has: event } }, select: { id: true } });
        let queued = 0;
        for (const e of endpoints) {
            try {
                const delivery = await this.prisma.webhookDelivery.create({
                    data: { endpointId: e.id, organizationId: orgId, event, sourceId, payload: data as Prisma.InputJsonValue },
                    select: { id: true },
                });
                await this.queue.add('deliver', { deliveryId: delivery.id }, {
                    jobId: delivery.id,
                    attempts: WEBHOOK_ATTEMPTS,
                    backoff: { type: 'exponential', delay: 30_000 },
                    removeOnComplete: 1000,
                    removeOnFail: { count: 1000 },
                });
                queued++;
            } catch (err) {
                if (!isUniqueViolation(err)) this.logger.warn(`Webhook ${event} for ${e.id} not queued: ${err instanceof Error ? err.message : err}`);
            }
        }
        return queued;
    }

    /** From the automation event log: messages, tags, website sign-ups and ad chats. Never throws. */
    async fromAutomationEvent(event: AutomationEvent): Promise<void> {
        try {
            const kind = MESSAGE_EVENTS.includes(event.eventType) ? 'message.received'
                : event.eventType === 'crm.contact.tag_added' ? 'contact.tag_added'
                    : event.eventType === 'crm.website.signup' ? 'website.signup'
                        : event.eventType === 'crm.ad.referral' ? 'ad.referral'
                            : null;
            if (!kind) return;
            const any = await this.prisma.webhookEndpoint.count({ where: { organizationId: event.organizationId, enabled: true, events: { has: kind } } });
            if (!any) return;
            const contact = event.contactId ? await this.prisma.channelContact.findUnique({ where: { id: event.contactId } }) : null;
            const raw = ((event.payload ?? {}) as { raw?: Record<string, unknown> }).raw ?? {};
            const vars = (raw.vars ?? {}) as Record<string, string>;
            let data: Record<string, unknown>;
            if (kind === 'message.received') {
                const message = event.messageId
                    ? await this.prisma.message.findUnique({ where: { id: event.messageId }, select: { id: true, conversationId: true, kind: true, text: true, createdAt: true } })
                    : null;
                data = {
                    message: message ? { id: message.id, conversation_id: message.conversationId, kind: message.kind.toLowerCase(), text: message.text, received_at: message.createdAt } : { text: event.text ?? null },
                    contact: contact ? this.contactView(contact) : null,
                };
            } else if (kind === 'contact.tag_added') {
                data = { tag: (raw.tag as string | undefined) ?? event.text, contact: contact ? this.contactView(contact) : null };
            } else if (kind === 'website.signup') {
                data = { name: vars['signup.name'] || null, page: vars['signup.page'] || null, contact: contact ? this.contactView(contact) : null };
            } else {
                data = { ad: { id: vars['ad.id'], headline: vars['ad.headline'] || null, body: vars['ad.body'] || null, url: vars['ad.url'] || null }, contact: contact ? this.contactView(contact) : null };
            }
            await this.emit(event.organizationId, kind, `event:${event.id}`, data);
        } catch (err) {
            this.logger.warn(`Webhooks for event ${event.id} not queued: ${err instanceof Error ? err.message : err}`);
        }
    }

    private async fromOrder(orderId: string, kinds: StoreEventKind[]): Promise<void> {
        const order = await this.prisma.order.findUnique({
            where: { id: orderId },
            include: { customer: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } }, lineItems: { select: { title: true, variantTitle: true, quantity: true, price: true, sku: true } } },
        });
        if (!order) return;
        const data = {
            order: {
                id: order.id,
                name: order.name,
                financial_status: order.financialStatus.toLowerCase(),
                fulfillment_status: order.fulfillmentStatus.toLowerCase(),
                total: order.totalPrice.toString(),
                currency: order.currency,
                payment_gateways: order.paymentGateways,
                created_at: order.externalCreatedAt ?? order.createdAt,
                customer: order.customer
                    ? { id: order.customer.id, name: [order.customer.firstName, order.customer.lastName].filter(Boolean).join(' ') || null, email: order.customer.email, phone: order.customer.phone }
                    : null,
                items: order.lineItems.map((l) => ({ title: l.title, variant: l.variantTitle, sku: l.sku, quantity: l.quantity, price: l.price.toString() })),
            },
        };
        for (const kind of kinds) {
            if (['created', 'paid', 'fulfilled', 'delivered', 'cancelled'].includes(kind)) await this.emit(order.organizationId, `order.${kind}`, `order:${order.id}:${kind}`, data);
        }
    }

    private async fromPayment(linkId: string): Promise<void> {
        const link = await this.prisma.paymentLink.findUnique({ where: { id: linkId } });
        if (!link || link.status !== 'PAID') return;
        await this.emit(link.organizationId, 'payment.received', `payment:${link.id}`, {
            payment: {
                id: link.id,
                provider: link.provider.toLowerCase(),
                amount: link.amount.toString(),
                currency: link.currency,
                description: link.description,
                method: link.paymentMethod,
                gateway_payment_id: link.paymentId,
                order_id: link.orderId,
                paid_at: link.paidAt,
            },
        });
    }

    // ─── Delivery ──────────────────────────────────────────────────────

    /** One attempt. Throws on failure so the queue retries; the last failed attempt marks it failed. */
    async deliver(deliveryId: string, attempt: number, lastAttempt: boolean): Promise<void> {
        const delivery = await this.prisma.webhookDelivery.findUnique({ where: { id: deliveryId }, include: { endpoint: true } });
        if (!delivery || delivery.status === 'SENT') return;
        const endpoint = delivery.endpoint;
        if (!endpoint.enabled) {
            await this.prisma.webhookDelivery.update({ where: { id: deliveryId }, data: { status: 'FAILED', error: 'The webhook is switched off.' } });
            return;
        }
        const body = JSON.stringify({ id: delivery.id, event: delivery.event, created_at: delivery.createdAt.toISOString(), data: delivery.payload });
        const t = Math.floor(Date.now() / 1000);
        let status: number | null = null;
        let error: string | null = null;
        try {
            const res = await guardedRequest({
                method: 'POST',
                url: endpoint.url,
                body,
                allowPrivate: this.allowPrivate,
                timeoutMs: 10_000,
                maxBytes: 64 * 1024,
                headers: {
                    'user-agent': 'Collabo-Webhooks/1.0',
                    'collabo-event': delivery.event,
                    'collabo-delivery': delivery.id,
                    'collabo-signature': webhookSignature(this.encryption.decrypt(endpoint.secret), body, t),
                },
            });
            status = res.status;
            if (res.status < 200 || res.status >= 300) error = `The endpoint answered ${res.status}.`;
        } catch (err) {
            error = err instanceof Error ? err.message : String(err);
        }

        if (!error) {
            await this.prisma.$transaction([
                this.prisma.webhookDelivery.update({ where: { id: deliveryId }, data: { status: 'SENT', attempts: attempt, responseStatus: status, error: null, deliveredAt: new Date() } }),
                this.prisma.webhookEndpoint.update({ where: { id: endpoint.id }, data: { consecutiveFailures: 0, lastDeliveryAt: new Date() } }),
            ]);
            return;
        }
        await this.prisma.webhookDelivery.update({ where: { id: deliveryId }, data: { attempts: attempt, responseStatus: status, error: error.slice(0, 500), ...(lastAttempt ? { status: 'FAILED' } : {}) } });
        if (lastAttempt) {
            const failed = await this.prisma.webhookEndpoint.update({ where: { id: endpoint.id }, data: { consecutiveFailures: { increment: 1 } } });
            if (failed.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES && failed.enabled) {
                await this.prisma.webhookEndpoint.update({ where: { id: endpoint.id }, data: { enabled: false, disabledReason: `Switched off after ${MAX_CONSECUTIVE_FAILURES} failed deliveries in a row. Fix the endpoint, then switch it back on.` } });
            }
            return;
        }
        throw new Error(error);
    }

    // ─── Helpers ───────────────────────────────────────────────────────

    contactView(c: ChannelContact) {
        return { id: c.id, platform: c.platform.toLowerCase(), name: contactName(c), phone: c.phone, username: c.username, tags: c.tags, customer_id: c.customerId, opted_in: !!c.optInAt && !c.optedOutAt };
    }

    private view(r: { id: string; url: string; description: string | null; events: string[]; enabled: boolean; apiKeyId: string | null; consecutiveFailures: number; disabledReason: string | null; lastDeliveryAt: Date | null; createdAt: Date }) {
        return {
            id: r.id,
            url: r.url,
            description: r.description,
            events: r.events,
            enabled: r.enabled,
            createdByApi: !!r.apiKeyId,
            consecutiveFailures: r.consecutiveFailures,
            disabledReason: r.disabledReason,
            lastDeliveryAt: r.lastDeliveryAt,
            createdAt: r.createdAt,
        };
    }

    private async endpoint(orgId: string, id: string) {
        const row = await this.prisma.webhookEndpoint.findFirst({ where: { id, organizationId: orgId } });
        if (!row) throw new NotFoundException('Webhook not found');
        return row;
    }

    /** https only (http to a local address when private calls are allowed, for testing); private addresses are refused again at delivery. */
    private checkUrl(input: string): string {
        let url: URL;
        try {
            url = new URL(input.trim());
        } catch {
            throw new BadRequestException('Enter the full URL, starting with https://.');
        }
        if (url.protocol !== 'https:' && !(this.allowPrivate && url.protocol === 'http:')) throw new BadRequestException('Webhook URLs must use https://.');
        if (url.username || url.password) throw new BadRequestException('Put credentials in your endpoint’s own check of the signature, not in the URL.');
        return url.toString();
    }

    private checkEvents(events: string[]): string[] {
        const list = [...new Set(events)];
        if (!list.length || list.some((e) => !(WEBHOOK_EVENTS as readonly string[]).includes(e))) {
            throw new BadRequestException(`Choose events from: ${WEBHOOK_EVENTS.join(', ')}.`);
        }
        return list;
    }
}
