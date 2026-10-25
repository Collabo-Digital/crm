import { BadRequestException } from '@nestjs/common';
import { AutomationStatus, ConsentType } from '@prisma/client';
import { PosWhatsAppService } from './pos-whatsapp.service';

/**
 * Sending the bill on WhatsApp: only to a customer who agreed, only from a
 * connected number, and as the invoice automation sends it — an approved
 * template whose document header carries the invoice PDF.
 */

const ORG = 'org_1';
const CUSTOMER = { id: 'cust_1', phone: '98000 00001', defaultAddress: null };
const DOC_TEMPLATE = {
    id: 'tpl_invoice', organizationId: ORG, channelId: 'ch_wa', name: 'invoice_copy', language: 'en', category: 'UTILITY', status: 'APPROVED',
    parameterFormat: 'POSITIONAL',
    components: [
        { type: 'HEADER', format: 'DOCUMENT' },
        { type: 'BODY', text: 'Hi {{1}}, your invoice {{2}} is attached.', example: { body_text: [['Asha', 'INV-1']] } },
    ],
};

function build(over: { channel?: unknown; contact?: Record<string, unknown> | null; invoice?: unknown; automations?: unknown[]; templates?: unknown[] } = {}) {
    const contact = over.contact === undefined ? { id: 'cc_1', optInAt: new Date(), optedOutAt: null, blockedAt: null } : over.contact;
    const prisma: any = {
        channel: { findFirst: jest.fn().mockResolvedValue(over.channel === undefined ? { id: 'ch_wa' } : over.channel) },
        channelContact: {
            findFirst: jest.fn().mockResolvedValue(contact),
            findUniqueOrThrow: jest.fn().mockResolvedValue({
                id: 'cc_1', displayName: 'Asha', username: null, phone: '+919800000001', tags: [], attributes: {}, optInAt: new Date(), optedOutAt: null,
                customer: { firstName: 'Asha', lastName: 'Menon', ordersCount: 3, tags: [] },
            }),
        },
        order: {
            findFirst: jest.fn().mockResolvedValue({
                id: 'order_1', name: '#M1001', totalPrice: 1995, currency: 'INR', financialStatus: 'PAID', fulfillmentStatus: 'UNFULFILLED',
                paymentGateways: [], lineItems: [{ title: 'Linen shirt', quantity: 2 }], fulfillments: [], customer: CUSTOMER,
            }),
        },
        invoice: { findFirst: jest.fn().mockResolvedValue(over.invoice === undefined ? { id: 'inv_1' } : over.invoice) },
        automation: {
            findMany: jest.fn().mockResolvedValue(
                over.automations ?? [
                    {
                        publishedVersion: {
                            definition: {
                                steps: [
                                    { id: 't', type: 'trigger', config: {} },
                                    { id: 'c', type: 'condition', config: {}, branches: { yes: [{ id: 's', type: 'send_invoice', config: { templateId: 'tpl_invoice', templateValues: { 'body.1': '{{first_name}}', 'body.2': '{{invoice.number}}' } } }], no: [] } },
                                ],
                            },
                        },
                    },
                ],
            ),
        },
        messageTemplate: {
            findFirst: jest.fn().mockResolvedValue(DOC_TEMPLATE),
            findMany: jest.fn().mockResolvedValue(over.templates ?? []),
        },
    };
    const consent = { record: jest.fn() };
    const sender = { send: jest.fn().mockResolvedValue({ ok: true, messageId: 'm1' }), conversationFor: jest.fn().mockResolvedValue('conv_1') };
    const store = {
        invoiceDocument: jest.fn().mockResolvedValue({ invoiceId: 'inv_1', storageKey: `${ORG}/inv.pdf`, filename: 'INV-1.pdf', vars: { 'invoice.number': 'INV-26-27/000001' } }),
    };
    const service = new PosWhatsAppService(prisma, consent as any, sender as any, store as any);
    return { service, prisma, consent, sender, store };
}

describe('PosWhatsAppService.reach', () => {
    it.each([
        ['a walk-in', null, {}, "Add the customer's phone number to send the bill on WhatsApp."],
        ['no phone', { ...CUSTOMER, phone: null }, {}, 'This customer has no phone number.'],
        ['no connected number', CUSTOMER, { channel: null }, 'No WhatsApp number is connected.'],
        ['no opt-in', CUSTOMER, { contact: { id: 'cc_1', optInAt: null, optedOutAt: null, blockedAt: null } }, "This customer hasn't agreed to WhatsApp messages."],
        ['no contact yet', CUSTOMER, { contact: null }, "This customer hasn't agreed to WhatsApp messages."],
        ['opted out', CUSTOMER, { contact: { id: 'cc_1', optInAt: new Date(), optedOutAt: new Date(), blockedAt: null } }, 'This customer opted out of WhatsApp messages.'],
    ])('cannot send: %s', async (_label, customer, over, reason) => {
        const { service } = build(over as any);
        expect(await service.reach(ORG, customer as any)).toEqual({ canSend: false, reason });
    });

    it('can send to an opted-in customer on a connected number', async () => {
        const { service, prisma } = build();
        expect(await service.reach(ORG, CUSTOMER)).toEqual({ canSend: true, reason: null });
        // Looked up by the number as WhatsApp writes it.
        expect(prisma.channelContact.findFirst.mock.calls[0][0].where.OR[0]).toEqual({ waId: '919800000001' });
    });
});

describe('PosWhatsAppService.optIn', () => {
    it('creates the contact for the number and records the opt-in with source pos', async () => {
        const { service, prisma, consent } = build();
        const created = { id: 'cc_new', organizationId: ORG, customerId: 'cust_1', optInAt: null, optedOutAt: null };
        const tx = { channelContact: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue(created) } };
        prisma.$transaction = jest.fn(async (fn: any) => fn(tx));
        await service.optIn(ORG, 'u_1', { ...CUSTOMER, firstName: 'Asha', lastName: null }, 'order_1');
        expect(tx.channelContact.create.mock.calls[0][0].data).toMatchObject({ channelId: 'ch_wa', waId: '919800000001', phone: '+919800000001', customerId: 'cust_1' });
        expect(consent.record).toHaveBeenCalledWith(tx, created, ConsentType.OPT_IN, 'pos', expect.objectContaining({ orderId: 'order_1' }), 'u_1');
    });

    it('leaves an earlier opt-out standing', async () => {
        const { service, prisma, consent } = build();
        const tx = { channelContact: { findFirst: jest.fn().mockResolvedValue({ id: 'cc_1', customerId: 'cust_1', optInAt: null, optedOutAt: new Date() }) } };
        prisma.$transaction = jest.fn(async (fn: any) => fn(tx));
        await service.optIn(ORG, 'u_1', { ...CUSTOMER, firstName: null, lastName: null }, 'order_1');
        expect(consent.record).not.toHaveBeenCalled();
    });
});

describe('PosWhatsAppService.sendInvoice', () => {
    it('sends the invoice PDF in the template the invoice automation uses, with its values filled in', async () => {
        const { service, sender, store } = build();
        expect(await service.sendInvoice(ORG, 'u_1', 'order_1')).toEqual({ sent: true });
        expect(store.invoiceDocument).toHaveBeenCalledWith(ORG, 'order_1');
        const sent = sender.send.mock.calls[0][0];
        expect(sent).toMatchObject({ organizationId: ORG, conversationId: 'conv_1', origin: 'agent', actorUserId: 'u_1' });
        expect(sent.payload).toMatchObject({
            type: 'template',
            name: 'invoice_copy',
            headerMedia: { storageKey: `${ORG}/inv.pdf`, mime: 'application/pdf', kind: 'document', filename: 'INV-1.pdf' },
            previewText: 'Hi Asha, your invoice INV-26-27/000001 is attached.',
        });
    });

    it('without an invoice automation, takes an approved template that needs nothing but the document', async () => {
        const plain = { ...DOC_TEMPLATE, id: 'tpl_plain', components: [{ type: 'HEADER', format: 'DOCUMENT' }, { type: 'BODY', text: 'Your invoice is attached.' }] };
        const { service, sender } = build({ automations: [], templates: [DOC_TEMPLATE, plain] });
        await service.sendInvoice(ORG, 'u_1', 'order_1');
        expect(sender.send.mock.calls[0][0].payload.name).toBe('invoice_copy');
        expect(sender.send.mock.calls[0][0].payload.previewText).toBe('Your invoice is attached.');
    });

    it.each([
        [{ contact: { id: 'cc_1', optInAt: null, optedOutAt: null, blockedAt: null } }, "This customer hasn't agreed to WhatsApp messages."],
        [{ channel: null }, 'No WhatsApp number is connected.'],
        [{ automations: [], templates: [] }, 'Set up a WhatsApp invoice template first.'],
        [{ invoice: null }, 'This bill has no GST invoice to send.'],
    ])('refuses with the reason: %o', async (over, reason) => {
        const { service, sender } = build(over as any);
        await expect(service.sendInvoice(ORG, 'u_1', 'order_1')).rejects.toThrow(new BadRequestException(reason));
        expect(sender.send).not.toHaveBeenCalled();
    });

    it('ignores an invoice automation whose template has no document header', async () => {
        const { service, prisma } = build({ templates: [] });
        prisma.messageTemplate.findFirst.mockResolvedValue({ ...DOC_TEMPLATE, components: [{ type: 'HEADER', format: 'IMAGE' }] });
        await expect(service.sendInvoice(ORG, 'u_1', 'order_1')).rejects.toThrow('Set up a WhatsApp invoice template first.');
        expect(prisma.automation.findMany.mock.calls[0][0].where.status.in).toEqual([AutomationStatus.ACTIVE, AutomationStatus.PAUSED]);
    });

    it("passes on WhatsApp's refusal in its own words", async () => {
        const { service, sender } = build();
        sender.send.mockResolvedValueOnce({ ok: false, code: 'CONSENT', message: 'This person opted out of marketing messages.' });
        await expect(service.sendInvoice(ORG, 'u_1', 'order_1')).rejects.toThrow('This person opted out of marketing messages.');
    });
});
