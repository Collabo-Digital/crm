import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AutomationStatus, ChannelContact, ChannelPlatform, ChannelStatus, ConsentType, InvoiceStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { countryCodeOf, normalizePhone } from '../common/phone.util';
import { ConsentService } from '../messaging/consent.service';
import { MessagingSendService } from '../messaging/send/messaging-send.service';
import { OutboundPayload } from '../messaging/outbound';
import { StoreActionsService } from '../commerce/store-actions.service';
import { orderVars } from '../commerce/order-vars';
import { ParamValue, renderTemplate, sendComponents, templateParams } from '../campaigns/templates/template-components';
import { interpolate } from '../automation/engine/flow';
import { parseRunContext, variablesFor } from '../automation/engine/run-context';

export interface WhatsAppReach {
    canSend: boolean;
    reason: string | null;
}

type BillCustomer = { id: string; phone: string | null; defaultAddress: Prisma.JsonValue | null };
type StepLike = { type?: string; config?: Record<string, unknown>; branches?: Record<string, StepLike[]> };

const NO_NUMBER = 'No WhatsApp number is connected.';
const NO_CONSENT = "This customer hasn't agreed to WhatsApp messages.";
const NO_TEMPLATE = 'Set up a WhatsApp invoice template first.';

/**
 * The bill on WhatsApp: whether this customer can be sent it, their opt-in
 * when they give it at the counter, and sending the GST invoice the way the
 * automations' "Send the invoice" step does — an approved template with a
 * document header carrying the invoice PDF.
 */
@Injectable()
export class PosWhatsAppService {
    private readonly logger = new Logger(PosWhatsAppService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly consent: ConsentService,
        private readonly sender: MessagingSendService,
        private readonly store: StoreActionsService,
    ) { }

    async reach(orgId: string, customer: BillCustomer | null): Promise<WhatsAppReach> {
        const found = await this.contactOf(orgId, customer);
        if (typeof found === 'string') return { canSend: false, reason: found };
        const refusal = this.consentRefusal(found.contact);
        return refusal ? { canSend: false, reason: refusal } : { canSend: true, reason: null };
    }

    /**
     * Records the customer's WhatsApp opt-in, given at the counter, on their
     * contact for the org's number — found or created as starting a chat does.
     * An earlier opt-out stands: only the customer can undo that, by writing in.
     */
    async optIn(orgId: string, userId: string, customer: BillCustomer & { firstName: string | null; lastName: string | null }, orderId: string): Promise<void> {
        const channel = await this.channelOf(orgId);
        const digits = this.digitsOf(customer);
        if (!channel || !digits) return;
        const name = [customer.firstName, customer.lastName].filter(Boolean).join(' ') || null;
        await this.prisma.$transaction(async (tx) => {
            let contact = await tx.channelContact.findFirst({
                where: { channelId: channel.id, OR: [{ waId: digits }, { externalId: digits }, { previousExternalIds: { has: digits } }] },
            });
            if (!contact) {
                contact = await tx.channelContact.create({
                    data: {
                        organizationId: orgId,
                        channelId: channel.id,
                        platform: ChannelPlatform.WHATSAPP,
                        externalId: digits,
                        waId: digits,
                        phone: `+${digits}`,
                        displayName: name,
                        customerId: customer.id,
                    },
                });
            } else if (!contact.customerId) {
                contact = await tx.channelContact.update({ where: { id: contact.id }, data: { customerId: customer.id } });
                await tx.conversation.updateMany({ where: { contactId: contact.id, customerId: null }, data: { customerId: customer.id } });
            }
            if (!contact.optedOutAt && !contact.optInAt) {
                await this.consent.record(tx, contact, ConsentType.OPT_IN, 'pos', { orderId, note: 'Agreed at the counter' }, userId);
            }
        });
    }

    /** Sends the bill's GST invoice PDF on WhatsApp, or a 400 saying why it can't. */
    async sendInvoice(orgId: string, userId: string, orderId: string): Promise<{ sent: true }> {
        const order = await this.prisma.order.findFirst({
            where: { id: orderId, organizationId: orgId, deletedAt: null },
            include: {
                customer: { select: { id: true, phone: true, defaultAddress: true } },
                lineItems: { select: { title: true, quantity: true } },
                fulfillments: { select: { trackingNumber: true, trackingUrl: true, trackingCompany: true } },
            },
        });
        if (!order) throw new NotFoundException('That bill was not found.');

        const found = await this.contactOf(orgId, order.customer);
        if (typeof found === 'string') throw new BadRequestException(found);
        const refusal = this.consentRefusal(found.contact);
        if (refusal || !found.contact) throw new BadRequestException(refusal ?? NO_CONSENT);

        // A bill without a GST invoice has no document to send: the template's
        // header must carry one, and a receipt is not a tax invoice.
        const hasInvoice = await this.prisma.invoice.findFirst({
            where: { orderId, organizationId: orgId, status: { notIn: [InvoiceStatus.CANCELLED, InvoiceStatus.CREDIT_NOTE] } },
            select: { id: true },
        });
        if (!hasInvoice) throw new BadRequestException('This bill has no GST invoice to send.');

        const setup = await this.invoiceTemplate(orgId, found.channelId);
        if (!setup) throw new BadRequestException(NO_TEMPLATE);
        const doc = await this.store.invoiceDocument(orgId, orderId);
        if (!doc) throw new BadRequestException('This bill has no GST invoice to send.');

        const contact = await this.prisma.channelContact.findUniqueOrThrow({
            where: { id: found.contact.id },
            include: { customer: { select: { firstName: true, lastName: true, ordersCount: true, tags: true } } },
        });
        const vars = variablesFor({
            contact: {
                name: contact.displayName,
                username: contact.username,
                phone: contact.phone,
                tags: contact.tags,
                attributes: (contact.attributes as Record<string, unknown>) ?? {},
                optedIn: !!contact.optInAt,
                optedOut: !!contact.optedOutAt,
            },
            customer: contact.customer,
            conversation: null,
            context: parseRunContext({ vars: { ...orderVars({ ...order, totalPrice: order.totalPrice.toString() }), ...doc.vars } }),
        });

        const format = setup.template.parameterFormat === 'NAMED' ? 'NAMED' : 'POSITIONAL';
        const components = setup.template.components as Record<string, unknown>[];
        const values: Record<string, ParamValue> = {};
        for (const p of templateParams(components, format)) {
            if (p.component === 'header' && p.kind !== 'text') {
                // Replaced with the uploaded file's id at delivery.
                values.header = { mediaId: 'pending-upload' };
                continue;
            }
            const value = interpolate(setup.templateValues[p.key] ?? '', vars).trim();
            if (!value) throw new BadRequestException(`The invoice template's “${p.name}” has no value for this customer.`);
            values[p.key] = value;
        }
        const payload: OutboundPayload = {
            type: 'template',
            name: setup.template.name,
            language: setup.template.language,
            category: setup.template.category,
            components: sendComponents(components, format, values),
            previewText: renderTemplate(components, values).body,
            headerMedia: { storageKey: doc.storageKey, mime: 'application/pdf', kind: 'document', filename: doc.filename },
        };
        const outcome = await this.sender.send({
            organizationId: orgId,
            conversationId: await this.sender.conversationFor(contact.id),
            payload,
            origin: 'agent',
            actorUserId: userId,
            // A double tap sends once; pressing again a minute later sends again.
            idempotencyKey: `pos-invoice:${doc.invoiceId}:${Math.floor(Date.now() / 60_000)}`,
        });
        if (!outcome.ok) throw new BadRequestException(outcome.message);
        return { sent: true };
    }

    /** The org's WhatsApp number, as starting a chat picks it. */
    private channelOf(orgId: string) {
        return this.prisma.channel.findFirst({
            where: { organizationId: orgId, platform: ChannelPlatform.WHATSAPP, status: { not: ChannelStatus.DISCONNECTED } },
            orderBy: { createdAt: 'asc' },
            select: { id: true },
        });
    }

    private digitsOf(customer: BillCustomer): string | null {
        return normalizePhone(customer.phone, countryCodeOf(customer.defaultAddress) ?? 'IN')?.replace(/^\+/, '') ?? null;
    }

    /** The customer's contact on the org's number (null when they have none yet), or why there can be none. */
    private async contactOf(orgId: string, customer: BillCustomer | null): Promise<{ channelId: string; contact: ChannelContact | null } | string> {
        if (!customer) return "Add the customer's phone number to send the bill on WhatsApp.";
        if (!customer.phone) return 'This customer has no phone number.';
        const digits = this.digitsOf(customer);
        if (!digits) return "This customer's phone number isn't a valid number.";
        const channel = await this.channelOf(orgId);
        if (!channel) return NO_NUMBER;
        const contact =
            (await this.prisma.channelContact.findFirst({
                where: { channelId: channel.id, OR: [{ waId: digits }, { externalId: digits }, { previousExternalIds: { has: digits } }] },
            })) ?? (await this.prisma.channelContact.findFirst({ where: { channelId: channel.id, customerId: customer.id } }));
        return { channelId: channel.id, contact };
    }

    private consentRefusal(contact: ChannelContact | null): string | null {
        if (contact?.optedOutAt) return 'This customer opted out of WhatsApp messages.';
        if (contact?.blockedAt) return 'This customer is blocked on WhatsApp.';
        if (!contact?.optInAt) return NO_CONSENT;
        return null;
    }

    /**
     * The template to send an invoice with: the one the org's invoice
     * automation uses, with its values; else an approved template whose only
     * parameter is a document header.
     */
    private async invoiceTemplate(orgId: string, channelId: string) {
        const usable = (t: { status: string; channelId: string; components: Prisma.JsonValue } | null) =>
            !!t &&
            t.status === 'APPROVED' &&
            t.channelId === channelId &&
            ((t.components ?? []) as Array<{ type?: string; format?: string }>).some(
                (c) => String(c.type).toUpperCase() === 'HEADER' && String(c.format).toUpperCase() === 'DOCUMENT',
            );

        const automations = await this.prisma.automation.findMany({
            where: { organizationId: orgId, status: { in: [AutomationStatus.ACTIVE, AutomationStatus.PAUSED] }, archivedAt: null, publishedVersionId: { not: null } },
            orderBy: { updatedAt: 'desc' },
            select: { publishedVersion: { select: { definition: true } } },
            take: 50,
        });
        for (const a of automations) {
            const step = findStep(((a.publishedVersion?.definition as { steps?: StepLike[] } | null)?.steps) ?? [], 'send_invoice');
            const templateId = typeof step?.config?.templateId === 'string' ? step.config.templateId : null;
            if (!templateId) continue;
            const template = await this.prisma.messageTemplate.findFirst({ where: { id: templateId, organizationId: orgId } });
            if (template && usable(template)) {
                return { template, templateValues: (step!.config!.templateValues as Record<string, string>) ?? {} };
            }
        }

        const candidates = await this.prisma.messageTemplate.findMany({
            where: { organizationId: orgId, channelId, status: 'APPROVED' },
            orderBy: { updatedAt: 'desc' },
            take: 100,
        });
        for (const template of candidates) {
            if (!usable(template)) continue;
            const format = template.parameterFormat === 'NAMED' ? 'NAMED' : 'POSITIONAL';
            const params = templateParams(template.components as Record<string, unknown>[], format);
            if (params.every((p) => p.component === 'header')) return { template, templateValues: {} as Record<string, string> };
        }
        return null;
    }
}

function findStep(steps: StepLike[], type: string): StepLike | null {
    for (const s of steps) {
        if (s.type === type) return s;
        for (const branch of Object.values(s.branches ?? {})) {
            const found = findStep(branch, type);
            if (found) return found;
        }
    }
    return null;
}
