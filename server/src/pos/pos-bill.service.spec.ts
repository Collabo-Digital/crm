import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { InvoiceStatus, MessageStatus } from '@prisma/client';
import { AUTO_SEND_OFF, BILL_FAILED, BILL_PDF_FAILED, BillAttempt, NOT_ON_WHATSAPP, PosBillService, deliveryOf, readBillAttempts } from './pos-bill.service';
import { BILL_NOT_SENT } from './pos-whatsapp.service';
import { billLinkKey, billToken } from './pos-bill-link';
import { renderBillPdf } from './pos-bill-pdf';
import { toMetaComponents } from '../campaigns/templates/template-components';
import { CollaboVariant, packSlot } from '../campaigns/templates/pack/template-pack';

// The PDF engine is an ES module Jest cannot load; pos-bill-pdf.spec.ts renders real bills.
jest.mock('./pos-bill-pdf', () => ({ ...jest.requireActual('./pos-bill-pdf'), renderBillPdf: jest.fn() }));

/**
 * The bill after a sale: every way it is not sent, how its message's status
 * reads, the PDF a template with a document header carries, sending it again
 * (a walk-in gets the number's customer, a double tap sends once), and the
 * public link. The order's attempt list is kept in memory here; its SQL was
 * run against Postgres.
 */

const ORG = 'org_1';
const USER = 'u_device';
const ORDER = 'cmh3x8k2p40000qz7w1rbt9e4d';
const SECRET = 'e'.repeat(32);
const E164 = '+919800000001';
const flush = async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

const attempt = (over: Partial<BillAttempt> = {}): BillAttempt => ({
    id: 'a1', channel: 'whatsapp', to: E164, at: new Date().toISOString(), staffId: null, userId: USER, key: 'pos-bill:o:919800000001:1', messageId: null, ...over,
});

function build(opts: { customer?: Record<string, unknown> | null; plan?: unknown; sent?: unknown; messages?: unknown[] } = {}) {
    const attempts = new Map<string, BillAttempt[]>();
    const orderRow = () => ({
        id: ORDER,
        organizationId: ORG,
        customerId: (opts.customer as any)?.id ?? null,
        customer: opts.customer ?? null,
        metadata: { pos: { storeId: 'wh_mg', roundOff: 0.4, clientSaleId: 'x', bill: attempts.get(ORDER) ?? [] } },
    });
    const tx: any = {
        $queryRaw: jest.fn(),
        order: { findUniqueOrThrow: jest.fn(async () => ({ customerId: null })), update: jest.fn() },
        customer: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({ id: 'cust_new' }) },
        channel: { findFirst: jest.fn().mockResolvedValue({ id: 'ch_manual' }) },
        orderTimelineEvent: { create: jest.fn() },
    };
    const prisma: any = {
        order: {
            findFirst: jest.fn(async ({ where }: any) => (where.id === ORDER && (!where.organizationId || where.organizationId === ORG) ? orderRow() : null)),
            findFirstOrThrow: jest.fn(async () => ({
                name: '#M1042', createdAt: new Date('2026-10-26T06:30:00Z'), totalPrice: 1049.6, currency: 'INR',
                metadata: { pos: { roundOff: 0.4 } }, customer: { firstName: 'Asha' }, invoices: [{ invoiceNumber: 'INV-26-27/000042' }],
            })),
        },
        organization: { findUnique: jest.fn().mockResolvedValue({ name: 'Acme Pvt Ltd' }) },
        message: { findMany: jest.fn().mockResolvedValue(opts.messages ?? []) },
        invoice: { findFirst: jest.fn().mockResolvedValue(null) },
        $transaction: jest.fn(async (fn: any) => fn(tx)),
    };
    const whatsapp = {
        setup: jest.fn().mockResolvedValue({ connected: true, template: 'approved', templateName: 'store_bill' }),
        plan: jest.fn().mockResolvedValue(opts.plan ?? { ok: true, channelId: 'ch_wa', template: { name: 'store_bill' } }),
        sendBill: jest.fn().mockResolvedValue(opts.sent ?? { ok: true, messageId: 'msg_1' }),
    };
    const receipts = {
        receipt: jest.fn().mockResolvedValue({ order: { id: ORDER, name: '#M1042' }, customer: { name: 'Asha', phone: '+919800000210', gstin: null }, totals: { payable: 1050 } }),
    };
    const staff = { staffFromToken: jest.fn(async (_o: string, _u: string, token: string) => (token === 'good' ? { id: 'st_ravi' } : null)) };
    const loyalty = { recomputeForCustomer: jest.fn().mockResolvedValue(null) };
    const invoices = { pdf: jest.fn().mockResolvedValue({ buffer: Buffer.from('%PDF-invoice'), filename: 'INV-26-27-000042.pdf', invoiceNumber: 'INV-26-27/000042' }) };
    const media = { save: jest.fn(async (orgId: string, buffer: Buffer) => ({ storageKey: `${orgId}/saved.pdf`, size: buffer.length })) };
    const config = { get: (k: string) => ({ encryptionKey: SECRET, 'jwt.accessSecret': 'jwt', frontendUrl: 'https://app.example.com' })[k] };
    const service = new PosBillService(
        prisma,
        whatsapp as any,
        receipts as any,
        staff as any,
        { getStoreProfileSettings: jest.fn().mockResolvedValue({ storeName: 'Acme Store' }) } as any,
        loyalty as any,
        invoices as any,
        media as any,
        config as any,
    );
    jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
    const append = jest.spyOn(service as any, 'append').mockImplementation(async (orderId: any, a: any) => {
        const list = attempts.get(orderId) ?? [];
        if (a.key && list.some((x) => x.key === a.key)) return false;
        attempts.set(orderId, [...list, a]);
        return true;
    });
    const settle = jest.spyOn(service as any, 'settle').mockImplementation(async (orderId: any, id: any, patch: any) => {
        attempts.set(orderId, (attempts.get(orderId) ?? []).map((a) => (a.id === id ? { ...a, ...patch } : a)));
    });
    const latest = () => attempts.get(ORDER)?.at(-1);
    return { service, prisma, tx, whatsapp, receipts, staff, loyalty, invoices, media, append, settle, attempts, latest };
}

const sale = (over: Record<string, unknown> = {}) => ({
    orderId: ORDER, staffId: 'st_ravi', phone: { e164: E164, raw: E164 }, customerId: 'cust_1', name: 'Asha', autoSend: true, ...over,
});

/** Collabo's bill template as Meta holds it: version 2 with the PDF in a document header, version 1 with the link only. */
const PACK_DRAFT = (packSlot('https://app.example.com', 'store_bill')!.variants[0] as CollaboVariant).draft;
const billTemplate = (name: string, header: boolean) => ({
    id: `tpl_${name}`, name, language: 'en', category: 'UTILITY', status: 'APPROVED', parameterFormat: 'NAMED',
    components: toMetaComponents({ ...PACK_DRAFT, ...(header ? {} : { header: undefined }), name, language: 'en', category: 'UTILITY' }, '4::handle'),
});
const WITH_PDF = billTemplate('collabo_store_bill_v2', true);
const LINK_ONLY = billTemplate('collabo_store_bill_v1', false);

describe('how an attempt reads', () => {
    it.each([
        [MessageStatus.QUEUED, 'sending', null],
        [MessageStatus.SENT, 'sent', null],
        [MessageStatus.DELIVERED, 'delivered', null],
        [MessageStatus.READ, 'read', null],
        [MessageStatus.PLAYED, 'read', null],
    ])('a %s message is %s', (status, expected, reason) => {
        expect(deliveryOf(attempt(), { status, errorCode: null })).toEqual({ channel: 'whatsapp', status: expected, to: E164, reason });
    });

    it('Meta’s 131026 says the number is not on WhatsApp; any other failure says to try again', () => {
        expect(deliveryOf(attempt(), { status: MessageStatus.FAILED, errorCode: '131026' })).toMatchObject({ status: 'failed', reason: NOT_ON_WHATSAPP });
        expect(deliveryOf(attempt(), { status: MessageStatus.FAILED, errorCode: '131049' })).toMatchObject({ status: 'failed', reason: BILL_FAILED });
        expect(deliveryOf(attempt(), { status: MessageStatus.FAILED, errorCode: null })).toMatchObject({ status: 'failed', reason: BILL_FAILED });
    });

    it('an attempt that never became a message keeps its reason', () => {
        expect(deliveryOf(attempt({ status: 'not_sent', reason: BILL_NOT_SENT.templatePending, key: null }), null)).toEqual({
            channel: 'whatsapp', status: 'not_sent', to: E164, reason: BILL_NOT_SENT.templatePending,
        });
    });

    it('is sending until its message exists, and failed if it never does', () => {
        const at = Date.parse('2026-10-26T10:00:00Z');
        const a = attempt({ at: new Date(at).toISOString() });
        expect(deliveryOf(a, null, at + 30_000).status).toBe('sending');
        expect(deliveryOf(a, null, at + 5 * 60_000)).toMatchObject({ status: 'failed', reason: BILL_FAILED });
    });

    it('reads only well-formed attempts off the order', () => {
        const kept = attempt();
        expect(readBillAttempts({ pos: { bill: [kept, null, 'x', { channel: 'whatsapp' }] } } as any)).toEqual([kept]);
        expect(readBillAttempts(null)).toEqual([]);
        expect(readBillAttempts({ pos: { roundOff: 0 } })).toEqual([]);
    });
});

describe('PosBillService.afterSale — the bill after a sale', () => {
    it('keeps the attempt with who rang it up, answers sending at once, and sends in the background', async () => {
        const { service, whatsapp, latest, prisma } = build();
        await service.afterSale(ORG, USER, sale());
        expect(latest()).toMatchObject({ channel: 'whatsapp', to: E164, staffId: 'st_ravi', userId: USER, messageId: null, key: expect.stringMatching(new RegExp(`^pos-bill:${ORDER}:919800000001:\\d+$`)) });
        expect((await service.view(ORG, ORDER)).delivery).toEqual([{ channel: 'whatsapp', status: 'sending', to: E164, reason: null }]);

        await flush();
        expect(whatsapp.sendBill).toHaveBeenCalledWith(ORG, USER, expect.objectContaining({ ok: true }), {
            orderId: ORDER,
            e164: E164,
            customerId: 'cust_1',
            name: 'Asha',
            values: { firstName: 'Asha', storeName: 'Acme Store', billNumber: 'INV-26-27/000042', billTotal: '₹1,050.00', billDate: '26 Oct 2026' },
            token: billToken(billLinkKey(SECRET), ORDER),
            idempotencyKey: latest()!.key,
            document: null,
        });
        expect(latest()!.messageId).toBe('msg_1');
        prisma.message.findMany.mockResolvedValueOnce([{ id: 'msg_1', idempotencyKey: latest()!.key, status: MessageStatus.DELIVERED, errorCode: null }]);
        expect((await service.view(ORG, ORDER)).delivery).toEqual([{ channel: 'whatsapp', status: 'delivered', to: E164, reason: null }]);
    });

    it.each(Object.values(BILL_NOT_SENT))('not sent: %s', async (reason) => {
        const { service, whatsapp, latest } = build({ plan: { ok: false, reason } });
        await service.afterSale(ORG, USER, sale());
        await flush();
        expect(latest()).toMatchObject({ status: 'not_sent', reason, key: null });
        expect(whatsapp.sendBill).not.toHaveBeenCalled();
        expect((await service.view(ORG, ORDER)).delivery).toEqual([{ channel: 'whatsapp', status: 'not_sent', to: E164, reason }]);
    });

    it('an invalid number on file is shown as it was saved', async () => {
        const { service, latest } = build({ plan: { ok: false, reason: BILL_NOT_SENT.invalidNumber } });
        await service.afterSale(ORG, USER, sale({ phone: { e164: null, raw: '98765 4321' } }));
        expect(latest()).toMatchObject({ to: '98765 4321', status: 'not_sent', reason: BILL_NOT_SENT.invalidNumber });
    });

    it('with bills sent only when asked, says so and sends nothing', async () => {
        const { service, whatsapp, latest } = build();
        await service.afterSale(ORG, USER, sale({ autoSend: false }));
        await flush();
        expect(latest()).toMatchObject({ status: 'not_sent', reason: AUTO_SEND_OFF });
        expect(whatsapp.plan).not.toHaveBeenCalled();
    });

    it('a refusal at send time is kept as the reason', async () => {
        const { service, latest } = build({ sent: { ok: false, code: 'opted_out', message: 'x' } });
        await service.afterSale(ORG, USER, sale());
        await flush();
        expect(latest()).toMatchObject({ status: 'not_sent', reason: BILL_NOT_SENT.optedOut });
    });

    it('a send that throws is a failure to try again, never an error for the sale', async () => {
        const { service, whatsapp, latest } = build();
        whatsapp.sendBill.mockRejectedValueOnce(new Error('redis down'));
        await expect(service.afterSale(ORG, USER, sale())).resolves.toBeUndefined();
        await flush();
        expect(latest()).toMatchObject({ status: 'failed', reason: BILL_FAILED });
    });

    it('greets a walk-in with no name as "there"', async () => {
        const { service, whatsapp, prisma } = build();
        prisma.order.findFirstOrThrow.mockResolvedValueOnce({ name: '#M1043', createdAt: new Date('2026-10-26T06:30:00Z'), totalPrice: 99.99, currency: 'INR', metadata: {}, customer: null, invoices: [] });
        await service.afterSale(ORG, USER, sale({ customerId: null, name: null }));
        await flush();
        expect(whatsapp.sendBill.mock.calls[0][3].values).toMatchObject({ firstName: 'there', billNumber: '#M1043', billTotal: '₹99.99' });
    });
});

describe('PosBillService — the bill’s PDF', () => {
    const render = renderBillPdf as jest.Mock;
    const pdfPlan = (linkOnly: unknown = LINK_ONLY) => ({ ok: true, channelId: 'ch_wa', template: WITH_PDF, linkOnly });
    beforeEach(() => render.mockReset().mockResolvedValue(Buffer.from('%PDF-1.3 bill')));

    it('a template with a document header goes with the bill’s PDF, made from its receipt and kept in the org’s chat media', async () => {
        const { service, whatsapp, receipts, media, invoices, latest } = build({ plan: pdfPlan() });
        await service.afterSale(ORG, USER, sale());
        await flush();
        expect(receipts.receipt).toHaveBeenCalledWith(ORG, ORDER);
        expect(render).toHaveBeenCalledWith(await receipts.receipt.mock.results[0].value);
        expect(media.save).toHaveBeenCalledWith(ORG, Buffer.from('%PDF-1.3 bill'), 'application/pdf');
        expect(invoices.pdf).not.toHaveBeenCalled();
        const [, , plan, bill] = whatsapp.sendBill.mock.calls[0];
        expect(plan.template).toBe(WITH_PDF);
        expect(bill).toMatchObject({ orderId: ORDER, document: { storageKey: `${ORG}/saved.pdf`, filename: 'Bill-M1042.pdf' } });
        expect(latest()).toMatchObject({ messageId: 'msg_1' });
        expect(latest()!.status).toBeUndefined();
    });

    it('a sale with a GST invoice carries the invoice’s own PDF instead', async () => {
        const { service, whatsapp, prisma, invoices } = build({ plan: pdfPlan() });
        prisma.invoice.findFirst.mockResolvedValueOnce({ id: 'inv_42' });
        await service.afterSale(ORG, USER, sale());
        await flush();
        expect(prisma.invoice.findFirst.mock.calls[0][0]).toMatchObject({
            where: { orderId: ORDER, organizationId: ORG, status: { notIn: [InvoiceStatus.CANCELLED, InvoiceStatus.CREDIT_NOTE] } },
            orderBy: { createdAt: 'desc' },
        });
        expect(invoices.pdf).toHaveBeenCalledWith('inv_42', ORG);
        expect(render).not.toHaveBeenCalled();
        expect(whatsapp.sendBill.mock.calls[0][3].document).toEqual({ storageKey: `${ORG}/saved.pdf`, filename: 'INV-26-27-000042.pdf' });
    });

    it('a template without a document header goes without a PDF, as before', async () => {
        const { service, whatsapp, prisma, media } = build({ plan: { ok: true, channelId: 'ch_wa', template: LINK_ONLY, linkOnly: null } });
        await service.afterSale(ORG, USER, sale());
        await flush();
        expect(prisma.invoice.findFirst).not.toHaveBeenCalled();
        expect(render).not.toHaveBeenCalled();
        expect(media.save).not.toHaveBeenCalled();
        const [, , plan, bill] = whatsapp.sendBill.mock.calls[0];
        expect(plan.template).toBe(LINK_ONLY);
        expect(bill).toMatchObject({ orderId: ORDER, document: null });
    });

    it('when the PDF can’t be made, the approved bill template without one goes instead', async () => {
        render.mockRejectedValueOnce(new Error('layout failed'));
        const { service, whatsapp, media, latest } = build({ plan: pdfPlan() });
        await service.afterSale(ORG, USER, sale());
        await flush();
        expect(media.save).not.toHaveBeenCalled();
        const [, , plan, bill] = whatsapp.sendBill.mock.calls[0];
        expect(plan).toMatchObject({ ok: true, channelId: 'ch_wa', template: LINK_ONLY, linkOnly: null });
        expect(bill.document).toBeNull();
        expect(latest()).toMatchObject({ messageId: 'msg_1' });
    });

    it('a PDF that can’t be kept counts as one that can’t be made', async () => {
        const { service, whatsapp, media } = build({ plan: pdfPlan() });
        media.save.mockRejectedValueOnce(new Error('disk full'));
        await service.afterSale(ORG, USER, sale());
        await flush();
        expect(whatsapp.sendBill.mock.calls[0][2].template).toBe(LINK_ONLY);
        expect(whatsapp.sendBill.mock.calls[0][3].document).toBeNull();
    });

    it('with no bill template without the PDF to fall back to, the bill is not sent, and the till says why', async () => {
        render.mockRejectedValueOnce(new Error('layout failed'));
        const { service, whatsapp, latest } = build({ plan: pdfPlan(null) });
        await service.afterSale(ORG, USER, sale());
        await flush();
        expect(whatsapp.sendBill).not.toHaveBeenCalled();
        expect(latest()).toMatchObject({ status: 'not_sent', reason: BILL_PDF_FAILED });
        expect(BILL_PDF_FAILED).toBe("Couldn't make the bill PDF. Bill not sent.");
        expect((await service.view(ORG, ORDER)).delivery).toEqual([{ channel: 'whatsapp', status: 'not_sent', to: E164, reason: BILL_PDF_FAILED }]);
    });

    it('sending again from the till makes the PDF again and carries it', async () => {
        const { service, whatsapp, media } = build({ plan: pdfPlan(), customer: { id: 'cust_1', phone: '+919800000001', defaultAddress: null, firstName: 'Asha', lastName: null } });
        await service.sendAgain(ORG, USER, ORDER, { channel: 'whatsapp' });
        await flush();
        expect(media.save).toHaveBeenCalledTimes(1);
        expect(whatsapp.sendBill.mock.calls[0][3]).toMatchObject({ orderId: ORDER, e164: E164, document: { storageKey: `${ORG}/saved.pdf`, filename: 'Bill-M1042.pdf' } });
    });
});

describe('PosBillService.sendAgain', () => {
    it('a walk-in bill sent to a number gets that number’s customer, made if new, and counted', async () => {
        const { service, tx, whatsapp, loyalty } = build();
        const view = await service.sendAgain(ORG, USER, ORDER, { channel: 'whatsapp', phone: '98000 00001' });
        expect(tx.$queryRaw).toHaveBeenCalled();
        expect(tx.customer.findFirst.mock.calls[0][0].where.phone.in).toEqual(expect.arrayContaining([E164, '9800000001']));
        expect(tx.customer.create.mock.calls[0][0].data).toMatchObject({ organizationId: ORG, channelId: 'ch_manual', phone: E164 });
        expect(tx.order.update).toHaveBeenCalledWith({ where: { id: ORDER }, data: { customerId: 'cust_new' } });
        expect(tx.orderTimelineEvent.create).toHaveBeenCalled();
        expect(loyalty.recomputeForCustomer).toHaveBeenCalledWith('cust_new', ORG);
        expect(view.delivery).toEqual([{ channel: 'whatsapp', status: 'sending', to: E164, reason: null }]);
        await flush();
        expect(whatsapp.sendBill.mock.calls[0][3]).toMatchObject({ e164: E164, customerId: 'cust_new' });
    });

    it('a walk-in bill uses the customer already on file for the number', async () => {
        const { service, tx } = build();
        tx.customer.findFirst.mockResolvedValueOnce({ id: 'cust_known' });
        await service.sendAgain(ORG, USER, ORDER, { channel: 'whatsapp', phone: E164 });
        expect(tx.customer.create).not.toHaveBeenCalled();
        expect(tx.order.update).toHaveBeenCalledWith({ where: { id: ORDER }, data: { customerId: 'cust_known' } });
    });

    it('a tap that lost the race keeps the customer the first one attached', async () => {
        const { service, tx, loyalty } = build();
        tx.order.findUniqueOrThrow.mockResolvedValueOnce({ customerId: 'cust_first' });
        await service.sendAgain(ORG, USER, ORDER, { channel: 'whatsapp', phone: E164 });
        expect(tx.order.update).not.toHaveBeenCalled();
        expect(loyalty.recomputeForCustomer).not.toHaveBeenCalled();
    });

    it('a bill with a customer goes to a new number without changing the customer or linking the number to them', async () => {
        const { service, prisma, tx, whatsapp } = build({ customer: { id: 'cust_1', phone: '+919800000009', defaultAddress: null, firstName: 'Asha', lastName: null } });
        await service.sendAgain(ORG, USER, ORDER, { channel: 'whatsapp', phone: E164 });
        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(tx.order.update).not.toHaveBeenCalled();
        await flush();
        expect(whatsapp.sendBill.mock.calls[0][3]).toMatchObject({ e164: E164, customerId: null, name: 'Asha' });
    });

    it('with no number, goes to the customer’s own, linked to them', async () => {
        const { service, whatsapp } = build({ customer: { id: 'cust_1', phone: '98000 00009', defaultAddress: null, firstName: 'Asha', lastName: 'Menon' } });
        await service.sendAgain(ORG, USER, ORDER, { channel: 'whatsapp' });
        await flush();
        expect(whatsapp.sendBill.mock.calls[0][3]).toMatchObject({ e164: '+919800000009', customerId: 'cust_1', name: 'Asha Menon' });
    });

    it('a double tap within the minute sends once', async () => {
        const { service, whatsapp, attempts } = build();
        await service.sendAgain(ORG, USER, ORDER, { channel: 'whatsapp', phone: E164 });
        await service.sendAgain(ORG, USER, ORDER, { channel: 'whatsapp', phone: E164 });
        await flush();
        expect(attempts.get(ORDER)).toHaveLength(1);
        expect(whatsapp.sendBill).toHaveBeenCalledTimes(1);
    });

    it('records the staff member whose PIN unlocked the till, and refuses a stale one', async () => {
        const { service, latest } = build();
        await service.sendAgain(ORG, USER, ORDER, { channel: 'whatsapp', phone: E164, staffToken: 'good' });
        expect(latest()).toMatchObject({ staffId: 'st_ravi', userId: USER });
        await expect(service.sendAgain(ORG, USER, ORDER, { channel: 'whatsapp', phone: E164, staffToken: 'stale' })).rejects.toBeInstanceOf(ForbiddenException);
    });

    it.each([
        [{ channel: 'whatsapp' as const }, new BadRequestException("Add the customer's mobile number to send the bill.")],
        [{ channel: 'whatsapp' as const, phone: '12345' }, new BadRequestException('Enter a valid phone number for the customer.')],
    ])('refuses %o', async (body, error) => {
        await expect(build().service.sendAgain(ORG, USER, ORDER, body)).rejects.toThrow(error);
    });

    it('only for a point-of-sale bill of this org', async () => {
        await expect(build().service.sendAgain('org_other', USER, ORDER, { channel: 'whatsapp', phone: E164 })).rejects.toBeInstanceOf(NotFoundException);
    });
});

describe('PosBillService — the public bill', () => {
    it('the link is the app’s /b/ page with a signed token', () => {
        const { service } = build();
        expect(service.billUrl(ORDER)).toBe(`https://app.example.com/b/${billToken(billLinkKey(SECRET), ORDER)}`);
    });

    it('shows the receipt with the customer’s number masked', async () => {
        const { service, receipts } = build();
        const bill = await service.publicBill(billToken(billLinkKey(SECRET), ORDER));
        expect(receipts.receipt).toHaveBeenCalledWith(ORG, ORDER);
        expect(bill.customer).toEqual({ name: 'Asha', phone: '+91 98••• ••210', gstin: null });
        expect(JSON.stringify(bill)).not.toContain('9800000210');
    });

    it.each([
        ['a tampered token', `${ORDER}.${'A'.repeat(22)}`],
        ['a token signed with another key', billToken(billLinkKey('x'.repeat(32)), ORDER)],
        ['a bill that is gone', billToken(billLinkKey(SECRET), 'cmh3x8k2p40000qz7w1rbt9zzz')],
    ])('%s is a 404 in a sentence', async (_label, token) => {
        const { service, receipts } = build();
        await expect(service.publicBill(token)).rejects.toThrow(new NotFoundException("This bill link isn't valid."));
        expect(receipts.receipt).not.toHaveBeenCalled();
    });
});
