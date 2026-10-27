import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InvoiceStatus, MessageStatus, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { OrganizationSettingsService } from '../organization-settings/organization-settings.service';
import { LoyaltyService } from '../loyalty/loyalty.service';
import { InvoiceService } from '../invoice/invoice.service';
import { MessagingMediaStorage } from '../messaging/media/messaging-media.storage';
import { ensureManualChannel } from '../channel/ensure-manual-channel';
import { countryCodeOf, normalizePhone, phoneLookupVariants } from '../common/phone.util';
import { formatMoney } from '../commerce/order-vars';
import { billPdfFilename, buildBillDocument } from '../invoice/render/build-bill-document';
import { loadBillContext } from '../invoice/render/build-loader';
import { renderDocumentPdf } from '../invoice/render/document-pdf';
import { PosReceiptService, billLinks } from './pos-receipt.service';
import { PosStaffService } from './pos-staff.service';
import { BillDocument, BillSendPlan, PosWhatsAppService, WhatsAppBillSetup, refusalReason } from './pos-whatsapp.service';
import { BillValues, hasBillDocument } from './pos-bill-template';
import { billToken, maskPhone, readBillToken } from './pos-bill-link';
import { SendBillInput } from './pos-requests.schema';
import { readPosMeta } from './pos-order-meta';

export type BillChannel = 'whatsapp';
export type BillDeliveryStatus = 'sending' | 'sent' | 'delivered' | 'read' | 'not_sent' | 'failed';

export interface BillDelivery {
    channel: BillChannel;
    status: BillDeliveryStatus;
    to: string | null;
    reason: string | null;
}

export interface BillView {
    billUrl: string;
    delivery: BillDelivery[];
}

/** One try at sending a bill, kept on the order in `metadata.pos.bill`. */
export interface BillAttempt {
    id: string;
    channel: BillChannel;
    /** E.164, or the number as stored when it isn't a valid one. */
    to: string | null;
    at: string;
    staffId: string | null;
    userId: string;
    /** The send's idempotency key: the same number again within the minute is this attempt. Null when nothing was sent. */
    key: string | null;
    messageId: string | null;
    /** Set when it never became a message, with why. */
    status?: 'not_sent' | 'failed';
    reason?: string;
}

/** A number a bill goes to: E.164 when valid, and as given. */
export type BillPhone = { e164: string | null; raw: string };

export const BILL_FAILED = "Couldn't send the bill on WhatsApp. Try again.";
export const NOT_ON_WHATSAPP = "This number isn't on WhatsApp.";
export const AUTO_SEND_OFF = "Bills aren't sent automatically. Bill not sent.";
export const BILL_PDF_FAILED = "Couldn't make the bill PDF. Bill not sent.";
/** Meta: the number is not on WhatsApp, or cannot receive this message. */
const UNDELIVERABLE = '131026';
/** A send still not a message after this long never will be: the work behind it was lost. */
const SEND_LOST_MS = 2 * 60_000;

export function readBillAttempts(metadata: Prisma.JsonValue | null | undefined): BillAttempt[] {
    const pos = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? (metadata as Record<string, any>).pos : null;
    const bill = pos && typeof pos === 'object' ? pos.bill : null;
    return Array.isArray(bill) ? bill.filter((a): a is BillAttempt => !!a && typeof a === 'object' && typeof a.id === 'string') : [];
}

/** Where an attempt stands now, from the message it became. */
export function deliveryOf(attempt: BillAttempt, message: { status: MessageStatus; errorCode: string | null } | null, now = Date.now()): BillDelivery {
    const of = (status: BillDeliveryStatus, reason: string | null = null): BillDelivery => ({ channel: attempt.channel, status, to: attempt.to, reason });
    if (attempt.status) return of(attempt.status, attempt.reason ?? BILL_FAILED);
    if (!message) return now - Date.parse(attempt.at) < SEND_LOST_MS ? of('sending') : of('failed', BILL_FAILED);
    switch (message.status) {
        case MessageStatus.QUEUED:
            return of('sending');
        case MessageStatus.SENT:
            return of('sent');
        case MessageStatus.DELIVERED:
            return of('delivered');
        case MessageStatus.READ:
        case MessageStatus.PLAYED:
            return of('read');
        default:
            return of('failed', message.errorCode === UNDELIVERABLE ? NOT_ON_WHATSAPP : BILL_FAILED);
    }
}

/** "26 Oct 2026", as invoices date themselves. */
const billDate = (d: Date) => d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });

/**
 * The bill after a sale: sent on WhatsApp by itself when the customer gave a
 * number (as a PDF when the bill template has a document header), sent again
 * from the till, its delivery followed from the message it became, and shown
 * to the customer behind its public link. Nothing here may fail or hold up a
 * sale: the send runs after the response, and every try is kept on the order
 * with who made it.
 */
@Injectable()
export class PosBillService {
    private readonly logger = new Logger(PosBillService.name);
    private readonly linkKey: Buffer;
    private readonly linkPrefix: string;

    constructor(
        private readonly prisma: PrismaService,
        private readonly whatsapp: PosWhatsAppService,
        private readonly receipts: PosReceiptService,
        private readonly staff: PosStaffService,
        private readonly orgSettings: OrganizationSettingsService,
        private readonly loyalty: LoyaltyService,
        private readonly invoices: InvoiceService,
        private readonly media: MessagingMediaStorage,
        config: ConfigService,
    ) {
        const links = billLinks(config);
        this.linkKey = links.key;
        this.linkPrefix = links.prefix;
    }

    billUrl(orderId: string): string {
        return `${this.linkPrefix}${billToken(this.linkKey, orderId)}`;
    }

    async setup(orgId: string): Promise<{ whatsapp: WhatsAppBillSetup }> {
        return { whatsapp: await this.whatsapp.setup(orgId) };
    }

    /** Each channel's latest attempt, as it stands now. */
    async delivery(orgId: string, metadata: Prisma.JsonValue | null): Promise<BillDelivery[]> {
        const latest = new Map<BillChannel, BillAttempt>();
        for (const a of readBillAttempts(metadata)) latest.set(a.channel, a);
        const attempts = [...latest.values()];
        const ids = attempts.flatMap((a) => (a.messageId ? [a.messageId] : []));
        // Sent, but its message id not written back yet: found by its key.
        const keys = attempts.flatMap((a) => (!a.messageId && !a.status && a.key ? [a.key] : []));
        const messages = ids.length || keys.length
            ? await this.prisma.message.findMany({
                where: { organizationId: orgId, OR: [{ id: { in: ids } }, { idempotencyKey: { in: keys } }] },
                select: { id: true, idempotencyKey: true, status: true, errorCode: true },
            })
            : [];
        return attempts.map((a) =>
            deliveryOf(a, messages.find((m) => (a.messageId ? m.id === a.messageId : !!a.key && m.idempotencyKey === a.key)) ?? null),
        );
    }

    async view(orgId: string, orderId: string): Promise<BillView> {
        const order = await this.prisma.order.findFirst({
            where: { id: orderId, organizationId: orgId, deletedAt: null, posSale: true },
            select: { id: true, metadata: true },
        });
        if (!order) throw new NotFoundException('That bill was not found.');
        return { billUrl: this.billUrl(order.id), delivery: await this.delivery(orgId, order.metadata) };
    }

    /** After a sale with a number: the bill sent to it, unless the store sends bills only when asked. */
    async afterSale(
        orgId: string,
        userId: string,
        sale: { orderId: string; staffId: string | null; phone: BillPhone; customerId: string | null; name: string | null; autoSend: boolean },
    ): Promise<void> {
        if (!sale.autoSend) {
            await this.append(sale.orderId, this.attempt(userId, sale.staffId, sale.phone, null, { status: 'not_sent', reason: AUTO_SEND_OFF }));
            return;
        }
        await this.start(orgId, userId, sale.orderId, sale.staffId, sale.phone, sale.customerId, sale.name);
    }

    /**
     * The bill sent again: to the number given, else the customer's. A walk-in
     * bill sent to a number gets that number's customer; a bill with a
     * customer goes to the new number and leaves the customer as they are.
     */
    async sendAgain(orgId: string, userId: string, orderId: string, input: SendBillInput): Promise<BillView> {
        let staffId: string | null = null;
        if (input.staffToken) {
            const staff = await this.staff.staffFromToken(orgId, userId, input.staffToken);
            if (!staff) throw new ForbiddenException('The till has locked. Unlock it with your staff PIN again.');
            staffId = staff.id;
        }
        const order = await this.prisma.order.findFirst({
            where: { id: orderId, organizationId: orgId, deletedAt: null, posSale: true },
            select: { id: true, customer: { select: { id: true, phone: true, defaultAddress: true, firstName: true, lastName: true } } },
        });
        if (!order) throw new NotFoundException('That bill was not found.');
        const customer = order.customer;
        const name = customer ? [customer.firstName, customer.lastName].filter(Boolean).join(' ') || null : null;
        const own = customer?.phone ? normalizePhone(customer.phone, countryCodeOf(customer.defaultAddress) ?? 'IN') : null;

        let phone: BillPhone;
        let linkTo: string | null;
        if (input.phone) {
            const e164 = normalizePhone(input.phone, 'IN');
            if (!e164) throw new BadRequestException('Enter a valid phone number for the customer.');
            phone = { e164, raw: input.phone };
            linkTo = customer ? (own === e164 ? customer.id : null) : await this.attachCustomer(orgId, userId, orderId, e164);
        } else {
            if (!customer?.phone) throw new BadRequestException("Add the customer's mobile number to send the bill.");
            phone = { e164: own, raw: customer.phone };
            linkTo = customer.id;
        }
        await this.start(orgId, userId, orderId, staffId, phone, linkTo, name);
        return this.view(orgId, orderId);
    }

    /** The bill behind a public link: its receipt, with the customer's number masked whatever the receipt shows. */
    async publicBill(token: string) {
        const orderId = readBillToken(this.linkKey, token);
        const order = orderId
            ? await this.prisma.order.findFirst({ where: { id: orderId, posSale: true, deletedAt: null }, select: { organizationId: true } })
            : null;
        if (!orderId || !order) throw new NotFoundException("This bill link isn't valid.");
        const receipt = await this.receipts.receipt(order.organizationId, orderId);
        const customer = receipt.customer;
        const masked = customer ? maskPhone(customer.phone) : null;
        return { ...receipt, customer: customer ? { ...customer, phone: masked, phoneShown: customer.phoneShown && masked } : null };
    }

    /** Checks what can be checked now, keeps the attempt, and sends after the response. */
    private async start(orgId: string, userId: string, orderId: string, staffId: string | null, phone: BillPhone, customerId: string | null, name: string | null) {
        const plan = await this.whatsapp.plan(orgId, phone.e164);
        if (!plan.ok) {
            await this.append(orderId, this.attempt(userId, staffId, phone, null, { status: 'not_sent', reason: plan.reason }));
            return;
        }
        // A double tap, or the till's send and a tap within the minute, sends once.
        const key = `pos-bill:${orderId}:${phone.e164!.replace(/^\+/, '')}:${Math.floor(Date.now() / 60_000)}`;
        const attempt = this.attempt(userId, staffId, phone, key);
        if (!(await this.append(orderId, attempt))) return;
        void this.deliver(orgId, userId, orderId, attempt, plan, customerId, name);
    }

    /** The send itself; its outcome goes back on the attempt. */
    private async deliver(
        orgId: string,
        userId: string,
        orderId: string,
        attempt: BillAttempt,
        plan: Extract<BillSendPlan, { ok: true }>,
        customerId: string | null,
        name: string | null,
    ): Promise<void> {
        try {
            const ready = await this.withDocument(orgId, orderId, plan);
            if (!ready) {
                await this.settle(orderId, attempt.id, { status: 'not_sent', reason: BILL_PDF_FAILED });
                return;
            }
            const outcome = await this.whatsapp.sendBill(orgId, userId, ready.plan, {
                orderId,
                e164: attempt.to!,
                customerId,
                name,
                values: await this.values(orgId, orderId),
                token: billToken(this.linkKey, orderId),
                idempotencyKey: attempt.key!,
                document: ready.document,
            });
            await this.settle(
                orderId,
                attempt.id,
                outcome.ok
                    ? { messageId: outcome.messageId }
                    : { status: refusalReason(outcome.code) ? 'not_sent' : 'failed', reason: refusalReason(outcome.code) ?? BILL_FAILED },
            );
            if (!outcome.ok) this.logger.log(`Bill for order ${orderId} not sent on WhatsApp: ${outcome.message}`);
        } catch (err) {
            this.logger.warn(`Bill for order ${orderId} not sent on WhatsApp: ${err instanceof Error ? err.message : err}`);
            await this.settle(orderId, attempt.id, { status: 'failed', reason: BILL_FAILED }).catch((e) =>
                this.logger.warn(`Bill attempt ${attempt.id} on order ${orderId} not updated: ${e instanceof Error ? e.message : e}`),
            );
        }
    }

    /**
     * What the bill goes with: a template with a document header takes the
     * bill's PDF, made now. When the PDF can't be made, the approved bill
     * template without one goes instead; with none, nothing goes (null).
     */
    private async withDocument(
        orgId: string,
        orderId: string,
        plan: Extract<BillSendPlan, { ok: true }>,
    ): Promise<{ plan: Extract<BillSendPlan, { ok: true }>; document: BillDocument | null } | null> {
        if (!hasBillDocument(plan.template)) return { plan, document: null };
        try {
            return { plan, document: await this.document(orgId, orderId) };
        } catch (err) {
            this.logger.warn(`Bill PDF for order ${orderId} not made: ${err instanceof Error ? err.message : err}`);
            return plan.linkOnly ? { plan: { ...plan, template: plan.linkOnly, linkOnly: null }, document: null } : null;
        }
    }

    /**
     * The bill's PDF in the organization's chat media: the sale's GST invoice
     * when it has one, as the statutory document, else the bill itself, A4
     * like the invoice.
     */
    private async document(orgId: string, orderId: string): Promise<BillDocument> {
        const invoice = await this.prisma.invoice.findFirst({
            where: { orderId, organizationId: orgId, status: { notIn: [InvoiceStatus.CANCELLED, InvoiceStatus.CREDIT_NOTE] } },
            orderBy: { createdAt: 'desc' },
            select: { id: true },
        });
        let pdf: { buffer: Buffer; filename: string };
        if (invoice) pdf = await this.invoices.pdf(invoice.id, orgId);
        else {
            const [receipt, context] = await Promise.all([this.receipts.receipt(orgId, orderId), loadBillContext(this.prisma, orgId)]);
            pdf = { buffer: await renderDocumentPdf(buildBillDocument(receipt, context)), filename: billPdfFilename(receipt.order.name) };
        }
        const { storageKey } = await this.media.save(orgId, pdf.buffer, 'application/pdf');
        return { storageKey, filename: pdf.filename };
    }

    private attempt(userId: string, staffId: string | null, phone: BillPhone, key: string | null, outcome: Pick<BillAttempt, 'status' | 'reason'> = {}): BillAttempt {
        return { id: randomUUID(), channel: 'whatsapp', to: phone.e164 ?? phone.raw, at: new Date().toISOString(), staffId, userId, key, messageId: null, ...outcome };
    }

    /** Adds the attempt to the order; false when one with its key is there already. */
    private async append(orderId: string, attempt: BillAttempt): Promise<boolean> {
        const attempts = Prisma.sql`coalesce("metadata"->'pos'->'bill', '[]'::jsonb)`;
        const count = await this.prisma.$executeRaw`
            UPDATE "orders"
            SET "metadata" = jsonb_set(
                coalesce("metadata", '{}'::jsonb),
                '{pos}',
                coalesce("metadata"->'pos', '{}'::jsonb) || jsonb_build_object('bill', ${attempts} || jsonb_build_array(${JSON.stringify(attempt)}::jsonb))
            )
            WHERE "id" = ${orderId}
            ${attempt.key ? Prisma.sql`AND NOT ${attempts} @> ${JSON.stringify([{ key: attempt.key }])}::jsonb` : Prisma.empty}
        `;
        return count > 0;
    }

    /** Merges what became of an attempt into it. */
    private async settle(orderId: string, attemptId: string, patch: Partial<BillAttempt>): Promise<void> {
        await this.prisma.$executeRaw`
            UPDATE "orders"
            SET "metadata" = jsonb_set("metadata", '{pos,bill}', (
                SELECT coalesce(jsonb_agg(CASE WHEN e->>'id' = ${attemptId} THEN e || ${JSON.stringify(patch)}::jsonb ELSE e END ORDER BY i), '[]'::jsonb)
                FROM jsonb_array_elements("metadata"->'pos'->'bill') WITH ORDINALITY AS t(e, i)
            ))
            WHERE "id" = ${orderId} AND jsonb_typeof("metadata"->'pos'->'bill') = 'array'
        `;
    }

    /** What the bill template says: who it is for, the store, and the bill's number, amount and date. */
    private async values(orgId: string, orderId: string): Promise<BillValues> {
        const [order, profile, org] = await Promise.all([
            this.prisma.order.findFirstOrThrow({
                where: { id: orderId, organizationId: orgId },
                select: {
                    name: true,
                    createdAt: true,
                    totalPrice: true,
                    currency: true,
                    metadata: true,
                    customer: { select: { firstName: true } },
                    invoices: {
                        where: { status: { notIn: [InvoiceStatus.CANCELLED, InvoiceStatus.CREDIT_NOTE] } },
                        orderBy: { createdAt: 'desc' },
                        select: { invoiceNumber: true },
                        take: 1,
                    },
                },
            }),
            this.orgSettings.getStoreProfileSettings(orgId),
            this.prisma.organization.findUnique({ where: { id: orgId }, select: { name: true } }),
        ]);
        const payable = Number(order.totalPrice) + (readPosMeta(order.metadata)?.roundOff ?? 0);
        return {
            // Meta refuses an empty value; "Hi there" reads as the bill to a walk-in should.
            firstName: order.customer?.firstName?.trim() || 'there',
            storeName: profile.storeName.trim() || org?.name || 'our store',
            billNumber: order.invoices[0]?.invoiceNumber ?? order.name,
            billTotal: formatMoney(Math.round(payable * 100) / 100, order.currency || 'INR'),
            billDate: billDate(order.createdAt),
        };
    }

    /** The customer with this number — found, or made — put on a walk-in bill; the one already there if a tap beat this one. */
    private async attachCustomer(orgId: string, userId: string, orderId: string, e164: string): Promise<string> {
        const { customerId, attached } = await this.prisma.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT "id" FROM "orders" WHERE "id" = ${orderId} AND "organization_id" = ${orgId} FOR UPDATE`;
            const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { customerId: true } });
            if (order.customerId) return { customerId: order.customerId, attached: false };
            const found = await tx.customer.findFirst({
                where: { organizationId: orgId, deletedAt: null, phone: { in: phoneLookupVariants(e164) } },
                orderBy: [{ ordersCount: 'desc' }, { updatedAt: 'desc' }],
                select: { id: true },
            });
            const customer =
                found ??
                (await tx.customer.create({
                    data: { organizationId: orgId, channelId: (await ensureManualChannel(tx, orgId)).id, externalId: `manual_${randomUUID()}`, phone: e164 },
                    select: { id: true },
                }));
            await tx.order.update({ where: { id: orderId }, data: { customerId: customer.id } });
            await tx.orderTimelineEvent.create({
                data: { orderId, actorId: userId, action: 'customer', message: `Customer ${e164} added at the point of sale to send the bill` },
            });
            return { customerId: customer.id, attached: true };
        });
        // The bill now counts towards the customer's orders and spend, as at a sale.
        if (attached) {
            await this.loyalty.recomputeForCustomer(customerId, orgId).catch((err) =>
                this.logger.warn(`Loyalty recompute failed after adding a customer to order ${orderId}: ${err}`),
            );
        }
        return customerId;
    }
}
