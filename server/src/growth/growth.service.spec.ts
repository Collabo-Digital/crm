import { HttpException } from '@nestjs/common';
import { ConsentType } from '@prisma/client';
import RedisMock from 'ioredis-mock';
import { RedisService } from '../redis/redis.service';
import { GrowthService } from './growth.service';

const CONSENT = 'I agree to receive offers from Chai Point on WhatsApp.';
const HOUR = 3600_000;
const VISITOR_IP = '203.0.113.7';

/** RedisService over ioredis-mock, which runs the real commands and Lua. */
function realRedis() {
    const redis = new RedisService({ get: () => 'redis://localhost:6379' } as never);
    const client = new RedisMock();
    (redis as unknown as { client: unknown }).client = client;
    return { redis, client };
}
beforeEach(() => realRedis().client.flushall());

function setup(contact: { optedOutAt: Date | null; waId?: string | null } = { optedOutAt: null }, signupsLastHour = 0, confirmOnWhatsApp = false) {
    const widget = {
        id: 'w_1',
        key: 'key_1234567890',
        enabled: true,
        organizationId: 'org_1',
        allowedDomains: ['shop.example.com'],
        settings: { popup: { enabled: true, consentText: CONSENT, confirmOnWhatsApp } },
        channel: { id: 'ch_1', organizationId: 'org_1', platform: 'WHATSAPP', status: 'CONNECTED', credentials: { displayPhoneNumber: '+91 80 4718 0000' } },
    };
    const resolved = { id: 'c_1', organizationId: 'org_1', channelId: 'ch_1', externalId: '919800000000', waId: '919800000000', customerId: null, tags: [], ...contact };
    const saved: Array<{ code: string }> = [];
    const tx = {
        consentEvent: { findFirst: jest.fn(async () => null) },
        channelContact: { update: jest.fn(), findUniqueOrThrow: jest.fn(async () => resolved) },
        siteWidget: { update: jest.fn() },
        widgetSignup: { updateMany: jest.fn(async () => ({ count: 1 })) },
    };
    const prisma = {
        siteWidget: { findUnique: jest.fn(async () => widget) },
        consentEvent: { count: jest.fn(async () => signupsLastHour) },
        widgetSignup: {
            count: jest.fn(async () => signupsLastHour + saved.length),
            create: jest.fn(async ({ data }: { data: { code: string } }) => {
                saved.push(data);
                return { code: data.code };
            }),
            findUnique: jest.fn(async (): Promise<unknown> => null),
        },
        conversation: { findUnique: jest.fn(async () => ({ contactId: 'c_1' })) },
        automationEvent: { create: jest.fn(async () => ({ id: 'ev_1' })) },
        $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    };
    const consent = { record: jest.fn() };
    const identity = { resolve: jest.fn(async () => resolved), linkCustomerByPhone: jest.fn(async () => null) };
    const automationEvents = { recordTagsAdded: jest.fn(async () => ['ev_tag']) };
    const jobs = { event: jest.fn() };
    const service = new GrowthService(prisma as any, identity as any, consent as any, automationEvents as any, jobs as any, realRedis().redis, { get: () => undefined } as any);
    return { service, consent, jobs, prisma, identity, tx, saved };
}

const form = { phone: '+919800000000', consent: 'yes', consentText: 'I agree to anything', page: 'https://shop.example.com/' };

describe('website pop-up sign-ups without confirming on WhatsApp', () => {
    it('record the pop-up’s own consent wording, not text the request brings', async () => {
        const { service, consent, jobs } = setup();
        await service.signup('key_1234567890', form, 'https://shop.example.com', VISITOR_IP);
        expect(consent.record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 'c_1' }), ConsentType.OPT_IN, 'widget', expect.objectContaining({ consentText: CONSENT }));
        expect(jobs.event).toHaveBeenCalledWith('ev_1');
    });

    it('do not opt back in someone who opted out, or start automations for them', async () => {
        const { service, consent, jobs } = setup({ optedOutAt: new Date('2026-09-01') });
        await expect(service.signup('key_1234567890', form, 'https://shop.example.com', VISITOR_IP)).resolves.toEqual({ ok: true });
        expect(consent.record).not.toHaveBeenCalled();
        expect(jobs.event).not.toHaveBeenCalled();
    });

    it('are refused past the hourly limit for the store', async () => {
        const { service, consent } = setup({ optedOutAt: null }, 200);
        await expect(service.signup('key_1234567890', form, 'https://shop.example.com', VISITOR_IP)).rejects.toThrow(HttpException);
        expect(consent.record).not.toHaveBeenCalled();
    });
});

describe('website pop-up sign-ups confirmed on WhatsApp', () => {
    const pendingRow = (over: Record<string, unknown> = {}) => ({
        id: 'ws_1',
        organizationId: 'org_1',
        widgetId: 'w_1',
        phone: '919800000000',
        name: 'Asha',
        page: 'https://shop.example.com/',
        consentText: CONSENT,
        code: 'K7Q2MX',
        expiresAt: new Date(Date.now() + HOUR),
        confirmedAt: null,
        widget: { id: 'w_1', settings: { popup: { enabled: true, tag: 'website-signup', confirmOnWhatsApp: true } } },
        ...over,
    });
    const confirmation = 'Hi! Please confirm my sign-up. Code: K7Q2MX';

    it('save only a pending sign-up, and answer with a wa.me link carrying its code', async () => {
        const { service, prisma, consent, identity, jobs } = setup({ optedOutAt: null }, 0, true);
        const res = await service.signup('key_1234567890', form, 'https://shop.example.com', VISITOR_IP);
        const saved = (prisma.widgetSignup.create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
        expect(saved).toMatchObject({ organizationId: 'org_1', widgetId: 'w_1', phone: '919800000000', consentText: CONSENT, page: form.page });
        expect(saved.code).toMatch(/^[2-9A-HJ-NP-Z]{6}$/);
        expect((saved.expiresAt as Date).getTime() - Date.now()).toBeGreaterThan(23 * HOUR);
        expect(res).toEqual({ ok: true, code: saved.code, confirmUrl: `https://wa.me/918047180000?text=${encodeURIComponent(`Hi! Please confirm my sign-up. Code: ${saved.code}`)}` });
        expect(identity.resolve).not.toHaveBeenCalled();
        expect(consent.record).not.toHaveBeenCalled();
        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(prisma.automationEvent.create).not.toHaveBeenCalled();
        expect(jobs.event).not.toHaveBeenCalled();
    });

    it('count pending sign-ups towards the store’s hourly limit', async () => {
        const { service, prisma } = setup({ optedOutAt: null }, 1000, true);
        await expect(service.signup('key_1234567890', form, 'https://shop.example.com', VISITOR_IP)).rejects.toThrow(HttpException);
        expect(prisma.widgetSignup.create).not.toHaveBeenCalled();
    });

    it('opt in whoever sends the code, once, with the sign-up’s evidence, and start its automations', async () => {
        const { service, prisma, consent, tx, jobs } = setup({ optedOutAt: null, waId: '919811122233' });
        prisma.widgetSignup.findUnique.mockResolvedValue(pendingRow());
        await service.confirmSignup('org_1', 'conv_1', 'wamid.CONFIRM1', confirmation);
        expect(prisma.widgetSignup.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { organizationId_code: { organizationId: 'org_1', code: 'K7Q2MX' } } }));
        expect(tx.widgetSignup.updateMany).toHaveBeenCalledWith({ where: { id: 'ws_1', confirmedAt: null }, data: { confirmedAt: expect.any(Date) } });
        expect(consent.record).toHaveBeenCalledTimes(1);
        expect(consent.record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 'c_1' }), ConsentType.OPT_IN, 'widget', {
            page: 'https://shop.example.com/',
            consentText: CONSENT,
            widgetId: 'w_1',
            code: 'K7Q2MX',
            wamid: 'wamid.CONFIRM1',
            typedPhone: '919800000000',
        });
        expect(tx.channelContact.update).toHaveBeenCalledWith({ where: { id: 'c_1' }, data: { tags: ['website-signup'] } });
        expect(prisma.automationEvent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ eventType: 'crm.website.signup', contactId: 'c_1', channelId: 'ch_1' }) }));
        expect(jobs.event.mock.calls.map((c) => c[0])).toEqual(['ev_tag', 'ev_1']);
    });

    it('leave the typed number out of the evidence when it is the sender’s', async () => {
        const { service, prisma, consent } = setup({ optedOutAt: null });
        prisma.widgetSignup.findUnique.mockResolvedValue(pendingRow());
        await service.confirmSignup('org_1', 'conv_1', 'wamid.CONFIRM1', confirmation);
        expect((consent.record.mock.calls[0] as unknown[])[4]).not.toHaveProperty('typedPhone');
    });

    it('opt back in someone who had opted out: they asked in their own message', async () => {
        const { service, prisma, consent, jobs } = setup({ optedOutAt: new Date('2026-09-01') });
        prisma.widgetSignup.findUnique.mockResolvedValue(pendingRow());
        await service.confirmSignup('org_1', 'conv_1', 'wamid.CONFIRM1', confirmation);
        expect(consent.record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 'c_1' }), ConsentType.OPT_IN, 'widget', expect.anything());
        expect(jobs.event).toHaveBeenCalled();
    });

    it('do nothing for an expired or already used code', async () => {
        for (const row of [pendingRow({ expiresAt: new Date(Date.now() - 1000) }), pendingRow({ confirmedAt: new Date() })]) {
            const { service, prisma, consent, jobs } = setup();
            prisma.widgetSignup.findUnique.mockResolvedValue(row);
            await service.confirmSignup('org_1', 'conv_1', 'wamid.CONFIRM2', confirmation);
            expect(prisma.$transaction).not.toHaveBeenCalled();
            expect(consent.record).not.toHaveBeenCalled();
            expect(jobs.event).not.toHaveBeenCalled();
        }
    });

    it('confirm once when the same code arrives twice at the same time', async () => {
        const { service, prisma, consent, tx, jobs } = setup();
        prisma.widgetSignup.findUnique.mockResolvedValue(pendingRow());
        tx.widgetSignup.updateMany.mockResolvedValue({ count: 0 });
        await service.confirmSignup('org_1', 'conv_1', 'wamid.CONFIRM3', confirmation);
        expect(consent.record).not.toHaveBeenCalled();
        expect(jobs.event).not.toHaveBeenCalled();
    });

    it('keep the once-a-day rule: a second sign-up the same day only uses up its code', async () => {
        const { service, prisma, consent, tx, jobs } = setup();
        prisma.widgetSignup.findUnique.mockResolvedValue(pendingRow());
        tx.consentEvent.findFirst.mockResolvedValue({ id: 'ce_1' } as never);
        await service.confirmSignup('org_1', 'conv_1', 'wamid.CONFIRM4', confirmation);
        expect(tx.widgetSignup.updateMany).toHaveBeenCalled();
        expect(consent.record).not.toHaveBeenCalled();
        expect(jobs.event).not.toHaveBeenCalled();
    });

    it('cost no database lookup for a message without a code', async () => {
        const { service, prisma } = setup();
        for (const text of ['Hi, is the linen shirt in stock?', 'My discount code: SAVE10', null]) {
            await service.confirmSignup('org_1', 'conv_1', 'wamid.X', text);
        }
        expect(prisma.widgetSignup.findUnique).not.toHaveBeenCalled();
        expect(prisma.conversation.findUnique).not.toHaveBeenCalled();
    });

    it('never break message ingest when confirming fails', async () => {
        const { service, prisma } = setup();
        prisma.widgetSignup.findUnique.mockRejectedValue(new Error('connection lost'));
        await expect(service.confirmSignup('org_1', 'conv_1', 'wamid.X', confirmation)).resolves.toBeUndefined();
    });
});

/**
 * Scripts can post the pop-up's form with a forged Origin. Each address may
 * sign up only a few numbers an hour, so a few addresses cannot fill the
 * store's hourly limit and turn its real visitors away.
 */
describe('website pop-up sign-ups from one address', () => {
    const post = (service: GrowthService, ip: string, phone = '+919800000000') =>
        service.signup('key_1234567890', { ...form, phone }, 'https://shop.example.com', ip).then(
            () => 'ok',
            (e: HttpException) => e.getStatus(),
        );

    it('cannot fill the store’s limit and lock out a real visitor', async () => {
        const { service, saved } = setup({ optedOutAt: null }, 0, true);
        // Four addresses, each posting as often as the route’s throttle allows in an hour.
        for (const ip of ['198.51.100.1', '198.51.100.2', '198.51.100.3', '198.51.100.4']) {
            const answers: Array<string | number> = [];
            for (let i = 0; i < 60; i++) answers.push(await post(service, ip));
            expect(answers.filter((a) => a === 'ok')).toHaveLength(5);
            expect(answers.slice(5).every((a) => a === 429)).toBe(true);
        }
        expect(saved).toHaveLength(20);

        await expect(post(service, VISITOR_IP, '+919811122233')).resolves.toBe('ok');
    });

    it('holds a sign-up script to the limit when confirming is off, so it opts in only a few numbers', async () => {
        const { service, consent } = setup({ optedOutAt: null }, 0, false);
        const answers: Array<string | number> = [];
        for (let i = 0; i < 8; i++) answers.push(await post(service, '198.51.100.9', `+9198000000${10 + i}`));

        expect(answers).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 429, 429, 429]);
        expect(consent.record).toHaveBeenCalledTimes(5);
    });

    it('treats one IPv6 /64 as one address', async () => {
        const { service } = setup({ optedOutAt: null }, 0, true);
        for (let i = 1; i <= 5; i++) await expect(post(service, `2001:db8:1:2::${i}`)).resolves.toBe('ok');

        await expect(post(service, '2001:db8:1:2:ffff:ffff:ffff:ffff')).resolves.toBe(429);
        await expect(post(service, '2001:db8:1:3::1')).resolves.toBe('ok');
    });
});
