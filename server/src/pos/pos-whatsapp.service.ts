import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChannelContact, ChannelPlatform, ChannelStatus, ConsentType, MessageTemplate, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ConsentService } from '../messaging/consent.service';
import { MessagingSendService, SendOutcome } from '../messaging/send/messaging-send.service';
import { SendRefusal } from '../messaging/outbound';
import { renderTemplate, sendComponents } from '../campaigns/templates/template-components';
import { billLinkPrefix } from '../campaigns/templates/template-starters';
import { BillValues, billTemplateValues, isBillTemplate } from './pos-bill-template';

export type BillTemplateState = 'approved' | 'pending' | 'missing';

export interface WhatsAppBillSetup {
    connected: boolean;
    template: BillTemplateState;
    templateName: string | null;
}

/** Why a bill cannot go out on WhatsApp, in the cashier's words. */
export const BILL_NOT_SENT = {
    notConnected: "WhatsApp isn't connected. Bill not sent.",
    templateMissing: "The WhatsApp bill template isn't set up yet. Bill not sent.",
    templatePending: "The WhatsApp bill template is waiting for Meta's approval. Bill not sent.",
    invalidNumber: "This phone number isn't valid. Bill not sent.",
    optedOut: 'This customer opted out of WhatsApp messages. Bill not sent.',
    blocked: 'This customer is blocked on WhatsApp. Bill not sent.',
} as const;

/** Ready to send: the number's channel and the approved bill template. */
export type BillSendPlan = { ok: true; channelId: string; template: MessageTemplate } | { ok: false; reason: string };

/** Meta's statuses for a template submitted and not yet decided. */
const IN_REVIEW = ['PENDING', 'IN_APPEAL'];

const REFUSALS: Partial<Record<SendRefusal, string>> = {
    channel_unavailable: BILL_NOT_SENT.notConnected,
    contact_blocked: BILL_NOT_SENT.blocked,
    opted_out: BILL_NOT_SENT.optedOut,
};

/** A refusal from the send service, as the reason the bill was not sent. */
export const refusalReason = (code: SendRefusal): string | null => REFUSALS[code] ?? null;

/**
 * The till on WhatsApp: the bill sent as the org's bill template (a utility
 * message the customer asked for by giving their number, so it needs no
 * marketing opt-in, though an opt-out or a block still stops it), and the
 * marketing opt-in a customer gives at the counter.
 */
@Injectable()
export class PosWhatsAppService {
    private readonly linkPrefix: string;

    constructor(
        private readonly prisma: PrismaService,
        private readonly consent: ConsentService,
        private readonly sender: MessagingSendService,
        config: ConfigService,
    ) {
        this.linkPrefix = billLinkPrefix(config.get<string>('frontendUrl') ?? '');
    }

    /** What the till shows about sending bills: whether a number is connected and the template is approved. */
    async setup(orgId: string): Promise<WhatsAppBillSetup> {
        const channel = await this.channelOf(orgId);
        const found = channel ? await this.billTemplate(orgId, channel.externalStoreId) : null;
        return {
            connected: !!channel && isLive(channel),
            template: found?.state ?? 'missing',
            templateName: found?.template?.name ?? null,
        };
    }

    /** Whether a bill can go to this number now, and what with: the checks before anything is written. */
    async plan(orgId: string, e164: string | null): Promise<BillSendPlan> {
        const channel = await this.channelOf(orgId);
        if (!channel || !isLive(channel)) return { ok: false, reason: BILL_NOT_SENT.notConnected };
        const found = await this.billTemplate(orgId, channel.externalStoreId);
        if (found.state === 'pending') return { ok: false, reason: BILL_NOT_SENT.templatePending };
        if (found.state !== 'approved' || !found.template) return { ok: false, reason: BILL_NOT_SENT.templateMissing };
        if (!e164) return { ok: false, reason: BILL_NOT_SENT.invalidNumber };
        const refusal = contactRefusal(await this.findContact(this.prisma, channel.id, e164.replace(/^\+/, '')));
        if (refusal) return { ok: false, reason: refusal };
        return { ok: true, channelId: channel.id, template: found.template };
    }

    /**
     * Sends the bill to the number: its contact on the org's number found or
     * made as starting a chat does, and linked to the customer when given —
     * with no consent recorded, the bill being no marketing.
     */
    async sendBill(
        orgId: string,
        userId: string,
        plan: Extract<BillSendPlan, { ok: true }>,
        bill: { e164: string; customerId: string | null; name: string | null; values: BillValues; token: string; idempotencyKey: string },
    ): Promise<SendOutcome> {
        const contact = await this.contactFor(orgId, plan.channelId, bill.e164, bill.customerId, bill.name);
        // Checked again on the contact itself: it may have opted out since.
        const refusal = contactRefusal(contact);
        if (refusal) return { ok: false, code: contact.optedOutAt ? 'opted_out' : 'contact_blocked', message: refusal };

        const t = plan.template;
        const format = t.parameterFormat === 'NAMED' ? 'NAMED' : 'POSITIONAL';
        const components = t.components as Record<string, unknown>[];
        const values = billTemplateValues(t, bill.values, bill.token);
        return this.sender.send({
            organizationId: orgId,
            conversationId: await this.sender.conversationFor(contact.id),
            payload: {
                type: 'template',
                name: t.name,
                language: t.language,
                category: t.category,
                components: sendComponents(components, format, values),
                previewText: renderTemplate(components, values).body,
            },
            origin: 'system',
            actorUserId: userId,
            idempotencyKey: bill.idempotencyKey,
        });
    }

    /**
     * Records the customer's WhatsApp marketing opt-in, given at the counter,
     * on their contact for the org's number. An earlier opt-out stands: only
     * the customer can undo that, by writing in.
     */
    async optIn(orgId: string, userId: string, buyer: { customerId: string; e164: string; name: string | null }, orderId: string): Promise<void> {
        const channel = await this.channelOf(orgId);
        if (!channel) return;
        await this.prisma.$transaction(async (tx) => {
            const contact = await this.contactFor(orgId, channel.id, buyer.e164, buyer.customerId, buyer.name, tx);
            if (!contact.optedOutAt && !contact.optInAt) {
                await this.consent.record(tx, contact, ConsentType.OPT_IN, 'pos', { orderId, note: 'Agreed at the counter' }, userId);
            }
        });
    }

    /** The org's WhatsApp number, as starting a chat picks it. */
    private channelOf(orgId: string) {
        return this.prisma.channel.findFirst({
            where: { organizationId: orgId, platform: ChannelPlatform.WHATSAPP, status: { not: ChannelStatus.DISCONNECTED } },
            orderBy: { createdAt: 'asc' },
            select: { id: true, status: true, isEnabled: true, externalStoreId: true },
        });
    }

    /** The bill template on the number's account: an approved one, else one still in review. */
    private async billTemplate(orgId: string, wabaId: string | null): Promise<{ state: BillTemplateState; template: MessageTemplate | null }> {
        const rows = wabaId
            ? await this.prisma.messageTemplate.findMany({
                where: { organizationId: orgId, wabaId, category: 'UTILITY', status: { in: ['APPROVED', ...IN_REVIEW] } },
                orderBy: { updatedAt: 'desc' },
                take: 100,
            })
            : [];
        const bills = rows.filter((t) => isBillTemplate(t, this.linkPrefix));
        const approved = bills.find((t) => t.status === 'APPROVED');
        if (approved) return { state: 'approved', template: approved };
        return bills.length ? { state: 'pending', template: bills[0] } : { state: 'missing', template: null };
    }

    private findContact(db: Prisma.TransactionClient, channelId: string, digits: string) {
        return db.channelContact.findFirst({
            where: { channelId, OR: [{ waId: digits }, { externalId: digits }, { previousExternalIds: { has: digits } }] },
        });
    }

    /** The number's contact, made if new; a customer is linked to it when it has none. */
    private async contactFor(
        orgId: string,
        channelId: string,
        e164: string,
        customerId: string | null,
        name: string | null,
        db: Prisma.TransactionClient = this.prisma,
    ): Promise<ChannelContact> {
        const digits = e164.replace(/^\+/, '');
        let contact = await this.findContact(db, channelId, digits);
        if (!contact) {
            try {
                return await db.channelContact.create({
                    data: { organizationId: orgId, channelId, platform: ChannelPlatform.WHATSAPP, externalId: digits, waId: digits, phone: `+${digits}`, displayName: name, customerId },
                });
            } catch (err) {
                // Another send made it a moment ago. Inside a transaction the error stands.
                if (db !== this.prisma || !(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
                contact = await this.findContact(db, channelId, digits);
                if (!contact) throw err;
            }
        }
        if (customerId && !contact.customerId) {
            contact = await db.channelContact.update({ where: { id: contact.id }, data: { customerId } });
            await db.conversation.updateMany({ where: { contactId: contact.id, customerId: null }, data: { customerId } });
        }
        return contact;
    }
}

const isLive = (c: { status: ChannelStatus; isEnabled: boolean }) => c.status === ChannelStatus.CONNECTED && c.isEnabled;

function contactRefusal(contact: Pick<ChannelContact, 'optedOutAt' | 'blockedAt'> | null): string | null {
    if (contact?.optedOutAt) return BILL_NOT_SENT.optedOut;
    if (contact?.blockedAt) return BILL_NOT_SENT.blocked;
    return null;
}
