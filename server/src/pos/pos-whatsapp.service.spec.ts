import { ConsentType } from '@prisma/client';
import { BILL_NOT_SENT, PosWhatsAppService, refusalReason } from './pos-whatsapp.service';
import { templateStarters } from '../campaigns/templates/template-starters';
import { toMetaComponents } from '../campaigns/templates/template-components';
import { CollaboVariant, packSlot } from '../campaigns/templates/pack/template-pack';

/**
 * The till on WhatsApp: the bill goes out in the org's approved bill template
 * — a utility message, so no marketing opt-in is needed or recorded — unless
 * the number is not connected, the template is not approved, or the customer
 * opted out or is blocked; and the offers opt-in a customer ticks is recorded
 * as consent.
 */

const ORG = 'org_1';
const APP = 'https://app.example.com';
const E164 = '+919800000001';
const starter = templateStarters(APP).find((s) => s.key === 'store_bill')!;
const BILL_TEMPLATE = {
    id: 'tpl_bill', organizationId: ORG, channelId: 'ch_wa', wabaId: 'waba_1', name: 'store_bill', language: 'en', category: 'UTILITY', status: 'APPROVED',
    parameterFormat: 'NAMED', components: toMetaComponents({ ...starter.draft, language: 'en' }),
};
const VALUES = { firstName: 'Asha', storeName: 'Acme', billNumber: 'INV-1', billTotal: '₹1,050.00', billDate: '26 Oct 2026' };
/** Collabo's recommended bill template (template-pack.ts), as the pack saves it. */
const PACK_BILL = {
    id: 'tpl_pack', name: 'collabo_store_bill_v1', packSlot: 'store_bill', packVersion: 1, packSource: 'collabo', updatedAt: new Date('2026-10-20T10:00:00Z'),
    components: toMetaComponents({ ...(packSlot(`${APP}/`, 'store_bill')!.variants[0] as CollaboVariant).draft, name: 'collabo_store_bill_v1', language: 'en', category: 'UTILITY' }),
};
const LIVE = { id: 'ch_wa', status: 'CONNECTED', isEnabled: true, externalStoreId: 'waba_1' };

function build(over: { channel?: unknown; contact?: Record<string, unknown> | null; templates?: unknown[] } = {}) {
    const contact = over.contact === undefined ? null : over.contact;
    const prisma: any = {
        channel: { findFirst: jest.fn().mockResolvedValue(over.channel === undefined ? LIVE : over.channel) },
        messageTemplate: { findMany: jest.fn().mockResolvedValue(over.templates ?? [BILL_TEMPLATE]) },
        channelContact: {
            findFirst: jest.fn().mockResolvedValue(contact),
            create: jest.fn(async ({ data }: any) => ({ id: 'cc_new', optInAt: null, optedOutAt: null, blockedAt: null, ...data })),
            update: jest.fn(async ({ where, data }: any) => ({ ...contact, id: where.id, ...data })),
        },
        conversation: { updateMany: jest.fn() },
    };
    prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
    const consent = { record: jest.fn() };
    const sender = { send: jest.fn().mockResolvedValue({ ok: true, messageId: 'msg_1' }), conversationFor: jest.fn().mockResolvedValue('conv_1') };
    const service = new PosWhatsAppService(prisma, consent as any, sender as any, { get: (k: string) => (k === 'frontendUrl' ? `${APP}/` : undefined) } as any);
    return { service, prisma, consent, sender };
}

describe('PosWhatsAppService.setup', () => {
    it('a connected number with the approved bill template', async () => {
        const { service, prisma } = build();
        expect(await service.setup(ORG)).toEqual({ connected: true, template: 'approved', templateName: 'store_bill' });
        expect(prisma.messageTemplate.findMany.mock.calls[0][0].where).toMatchObject({ organizationId: ORG, wabaId: 'waba_1', category: 'UTILITY' });
    });

    it('knows a renamed copy by its View bill link, and calls one in review pending', async () => {
        const { service } = build({ templates: [{ ...BILL_TEMPLATE, name: 'counter_receipt', status: 'PENDING' }] });
        expect(await service.setup(ORG)).toEqual({ connected: true, template: 'pending', templateName: 'counter_receipt' });
    });

    it.each([
        ['a link to another address', { components: toMetaComponents({ ...templateStarters('https://elsewhere.example').find((s) => s.key === 'store_bill')!.draft, language: 'en' }) }],
        ['a value the till cannot fill', {
            components: toMetaComponents({
                ...starter.draft,
                language: 'en',
                body: { text: 'Hi {{first_name}}, your {{points}} points and bill are ready.', examples: { first_name: 'A', points: '10' } },
            }),
        }],
        ['a template Meta filed under marketing', { category: 'MARKETING' }],
    ])('no bill template: %s', async (_label, change) => {
        const { service } = build({ templates: [{ ...BILL_TEMPLATE, ...change }] });
        expect(await service.setup(ORG)).toEqual({ connected: true, template: 'missing', templateName: null });
    });

    it('no number connected', async () => {
        expect(await build({ channel: null }).service.setup(ORG)).toEqual({ connected: false, template: 'missing', templateName: null });
        expect((await build({ channel: { ...LIVE, status: 'ERROR' } }).service.setup(ORG)).connected).toBe(false);
    });
});

describe('PosWhatsAppService.plan — why a bill is not sent', () => {
    it.each([
        ['no number connected', { channel: null }, E164, BILL_NOT_SENT.notConnected],
        ['a number switched off', { channel: { ...LIVE, isEnabled: false } }, E164, BILL_NOT_SENT.notConnected],
        ['no bill template', { templates: [] }, E164, BILL_NOT_SENT.templateMissing],
        ['the template in review', { templates: [{ ...BILL_TEMPLATE, status: 'PENDING' }] }, E164, BILL_NOT_SENT.templatePending],
        ['an invalid number', {}, null, BILL_NOT_SENT.invalidNumber],
        ['an opted-out customer', { contact: { id: 'cc_1', optedOutAt: new Date(), blockedAt: null } }, E164, BILL_NOT_SENT.optedOut],
        ['a blocked customer', { contact: { id: 'cc_1', optedOutAt: null, blockedAt: new Date() } }, E164, BILL_NOT_SENT.blocked],
    ])('%s', async (_label, over, e164, reason) => {
        const { service } = build(over as any);
        expect(await service.plan(ORG, e164)).toEqual({ ok: false, reason });
    });

    it('a customer with no marketing opt-in can be sent the bill', async () => {
        const { service, prisma } = build({ contact: { id: 'cc_1', optInAt: null, optedOutAt: null, blockedAt: null } });
        expect(await service.plan(ORG, E164)).toEqual({ ok: true, channelId: 'ch_wa', template: BILL_TEMPLATE });
        expect(prisma.channelContact.findFirst.mock.calls[0][0].where.OR[0]).toEqual({ waId: '919800000001' });
    });

    it('prefers the approved template over one still in review', async () => {
        const { service } = build({ templates: [{ ...BILL_TEMPLATE, id: 'tpl_new', status: 'PENDING' }, BILL_TEMPLATE] });
        expect(await service.plan(ORG, E164)).toMatchObject({ ok: true, template: { id: 'tpl_bill' } });
    });

    it("prefers Collabo's approved recommended bill template over a merchant's copy", async () => {
        const pack = { ...BILL_TEMPLATE, ...PACK_BILL };
        const { service } = build({ templates: [{ ...BILL_TEMPLATE, id: 'tpl_copy', updatedAt: new Date('2026-10-26T12:00:00Z') }, pack] });
        expect(await service.plan(ORG, E164)).toMatchObject({ ok: true, template: { id: 'tpl_pack', name: 'collabo_store_bill_v1' } });
    });

    it("sends with the merchant's approved copy while the recommended one is in review, and reports a recommended one in review", async () => {
        const pending = { ...BILL_TEMPLATE, ...PACK_BILL, status: 'PENDING' };
        expect(await build({ templates: [pending, BILL_TEMPLATE] }).service.plan(ORG, E164)).toMatchObject({ ok: true, template: { id: 'tpl_bill' } });
        expect(await build({ templates: [pending] }).service.setup(ORG)).toEqual({ connected: true, template: 'pending', templateName: 'collabo_store_bill_v1' });
    });

    it('takes the newest approved version of the recommended bill template', async () => {
        const v1 = { ...BILL_TEMPLATE, ...PACK_BILL };
        const v2 = { ...BILL_TEMPLATE, ...PACK_BILL, id: 'tpl_pack_2', name: 'collabo_store_bill_v2', packVersion: 2 };
        expect(await build({ templates: [v1, v2] }).service.setup(ORG)).toEqual({ connected: true, template: 'approved', templateName: 'collabo_store_bill_v2' });
    });

    it('maps the send service’s refusals to the same reasons', () => {
        expect(refusalReason('channel_unavailable')).toBe(BILL_NOT_SENT.notConnected);
        expect(refusalReason('opted_out')).toBe(BILL_NOT_SENT.optedOut);
        expect(refusalReason('contact_blocked')).toBe(BILL_NOT_SENT.blocked);
        expect(refusalReason('invalid_payload')).toBeNull();
    });
});

describe('PosWhatsAppService.sendBill', () => {
    const plan = { ok: true as const, channelId: 'ch_wa', template: BILL_TEMPLATE as any };
    const bill = { e164: E164, customerId: 'cust_1', name: 'Asha Menon', values: VALUES, token: 'ord1.sig', idempotencyKey: 'pos-bill:o:919800000001:1' };

    it('makes the contact for the number, linked to the customer, with no consent recorded', async () => {
        const { service, prisma, consent } = build();
        await service.sendBill(ORG, 'u_1', plan, bill);
        expect(prisma.channelContact.create.mock.calls[0][0].data).toMatchObject({ channelId: 'ch_wa', externalId: '919800000001', waId: '919800000001', phone: E164, customerId: 'cust_1', displayName: 'Asha Menon' });
        expect(prisma.channelContact.create.mock.calls[0][0].data).not.toHaveProperty('optInAt');
        expect(consent.record).not.toHaveBeenCalled();
    });

    it('links a contact the number already has to the customer, as starting a chat does', async () => {
        const { service, prisma } = build({ contact: { id: 'cc_1', customerId: null, optInAt: null, optedOutAt: null, blockedAt: null } });
        await service.sendBill(ORG, 'u_1', plan, bill);
        expect(prisma.channelContact.update).toHaveBeenCalledWith({ where: { id: 'cc_1' }, data: { customerId: 'cust_1' } });
        expect(prisma.conversation.updateMany).toHaveBeenCalledWith({ where: { contactId: 'cc_1', customerId: null }, data: { customerId: 'cust_1' } });
    });

    it('sends the bill template with the bill’s values and its link on the button', async () => {
        const { service, sender } = build();
        expect(await service.sendBill(ORG, 'u_1', plan, bill)).toEqual({ ok: true, messageId: 'msg_1' });
        const sent = sender.send.mock.calls[0][0];
        expect(sent).toMatchObject({ organizationId: ORG, conversationId: 'conv_1', origin: 'system', actorUserId: 'u_1', idempotencyKey: bill.idempotencyKey });
        expect(sent.payload).toMatchObject({ type: 'template', name: 'store_bill', language: 'en', category: 'UTILITY' });
        expect(sent.payload.previewText).toBe('Hi Asha, thank you for shopping at Acme. Your bill INV-1 for ₹1,050.00 dated 26 Oct 2026 is ready.');
        expect(sent.payload.components).toContainEqual({ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: 'ord1.sig' }] });
    });

    it('does not send to a contact that opted out since the till checked', async () => {
        const { service, sender } = build({ contact: { id: 'cc_1', customerId: 'cust_1', optedOutAt: new Date(), blockedAt: null } });
        expect(await service.sendBill(ORG, 'u_1', plan, bill)).toEqual({ ok: false, code: 'opted_out', message: BILL_NOT_SENT.optedOut });
        expect(sender.send).not.toHaveBeenCalled();
    });
});

describe('PosWhatsAppService.optIn — the offers tick', () => {
    it('records the marketing opt-in with source pos on the number’s contact', async () => {
        const { service, prisma, consent } = build();
        await service.optIn(ORG, 'u_1', { customerId: 'cust_1', e164: E164, name: 'Asha' }, 'order_1');
        expect(prisma.channelContact.create.mock.calls[0][0].data).toMatchObject({ waId: '919800000001', customerId: 'cust_1' });
        expect(consent.record).toHaveBeenCalledWith(prisma, expect.objectContaining({ id: 'cc_new' }), ConsentType.OPT_IN, 'pos', expect.objectContaining({ orderId: 'order_1' }), 'u_1');
    });

    it('leaves an earlier opt-out standing', async () => {
        const { service, consent } = build({ contact: { id: 'cc_1', customerId: 'cust_1', optInAt: null, optedOutAt: new Date() } });
        await service.optIn(ORG, 'u_1', { customerId: 'cust_1', e164: E164, name: null }, 'order_1');
        expect(consent.record).not.toHaveBeenCalled();
    });
});
