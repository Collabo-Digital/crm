import { HttpException } from '@nestjs/common';
import { ConsentType } from '@prisma/client';
import { GrowthService } from './growth.service';

const CONSENT = 'I agree to receive offers from Chai Point on WhatsApp.';

function setup(contact: { optedOutAt: Date | null } = { optedOutAt: null }, signupsLastHour = 0) {
    const widget = {
        id: 'w_1',
        key: 'key_1234567890',
        enabled: true,
        organizationId: 'org_1',
        allowedDomains: ['shop.example.com'],
        settings: { popup: { enabled: true, consentText: CONSENT } },
        channel: { id: 'ch_1', organizationId: 'org_1', platform: 'WHATSAPP', status: 'CONNECTED' },
    };
    const resolved = { id: 'c_1', organizationId: 'org_1', externalId: '919800000000', customerId: null, tags: [], ...contact };
    const tx = {
        consentEvent: { findFirst: jest.fn(async () => null) },
        channelContact: { update: jest.fn() },
        siteWidget: { update: jest.fn() },
    };
    const prisma = {
        siteWidget: { findUnique: jest.fn(async () => widget) },
        consentEvent: { count: jest.fn(async () => signupsLastHour) },
        automationEvent: { create: jest.fn(async () => ({ id: 'ev_1' })) },
        $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    };
    const consent = { record: jest.fn() };
    const identity = { resolve: jest.fn(async () => resolved), linkCustomerByPhone: jest.fn(async () => null) };
    const automationEvents = { recordTagsAdded: jest.fn(async () => []) };
    const jobs = { event: jest.fn() };
    const service = new GrowthService(prisma as any, identity as any, consent as any, automationEvents as any, jobs as any, { get: () => undefined } as any);
    return { service, consent, jobs, prisma };
}

const form = { phone: '+919800000000', consent: 'yes', consentText: 'I agree to anything', page: 'https://shop.example.com/' };

describe('website pop-up sign-ups', () => {
    it('record the pop-up’s own consent wording, not text the request brings', async () => {
        const { service, consent, jobs } = setup();
        await service.signup('key_1234567890', form, 'https://shop.example.com');
        expect(consent.record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 'c_1' }), ConsentType.OPT_IN, 'widget', expect.objectContaining({ consentText: CONSENT }));
        expect(jobs.event).toHaveBeenCalledWith('ev_1');
    });

    it('do not opt back in someone who opted out, or start automations for them', async () => {
        const { service, consent, jobs } = setup({ optedOutAt: new Date('2026-09-01') });
        await expect(service.signup('key_1234567890', form, 'https://shop.example.com')).resolves.toEqual({ ok: true });
        expect(consent.record).not.toHaveBeenCalled();
        expect(jobs.event).not.toHaveBeenCalled();
    });

    it('are refused past the hourly limit for the store', async () => {
        const { service, consent } = setup({ optedOutAt: null }, 200);
        await expect(service.signup('key_1234567890', form, 'https://shop.example.com')).rejects.toThrow(HttpException);
        expect(consent.record).not.toHaveBeenCalled();
    });
});
