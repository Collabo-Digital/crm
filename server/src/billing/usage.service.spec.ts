import { UserRole } from '@prisma/client';

import { seatOf } from './seats';
import { UsageService } from './usage.service';

describe('seatOf', () => {
    const agent = (grants: unknown) => seatOf(UserRole.AGENT, grants === undefined ? null : { grants });

    it('makes an agent who only packs, picks, receives, dispatches or sells at the till an ops seat', () => {
        expect(agent(['section.products', 'inventory.view', 'inventory.pack'])).toBe('ops');
        expect(agent(['section.products', 'inventory.view', 'inventory.receive', 'inventory.pick', 'inventory.dispatch', 'inventory.labels'])).toBe('ops');
        // The till's own key, compared as it is stored.
        expect(agent(['pos.sell'])).toBe('ops');
    });

    it('gives a full seat to an agent with anything more, or with no grants (every section)', () => {
        expect(agent(['section.products', 'inventory.pack', 'section.chat'])).toBe('full');
        expect(agent(['inventory.adjust'])).toBe('full');
        expect(agent([])).toBe('full');
        expect(agent(undefined)).toBe('full');
        expect(seatOf(UserRole.AGENT, { grants: 'inventory.pack' })).toBe('full');
    });

    it('counts owners, admins and managers as full seats whatever they hold, and leaves the outside roles free', () => {
        for (const role of [UserRole.OWNER, UserRole.ADMIN, UserRole.MANAGER]) expect(seatOf(role, { grants: ['inventory.pack'] })).toBe('full');
        for (const role of [UserRole.VIEWER, UserRole.VENDOR, UserRole.INFLUENCER]) expect(seatOf(role, null)).toBe('free');
    });
});

describe('UsageService.usage', () => {
    it('counts the month, the seats by kind, Store locations, live WhatsApp numbers and the org\'s own Instagram accounts', async () => {
        const prisma = {
            usageMonth: { findUnique: jest.fn(() => Promise.resolve({ conversations: 2_345 })) },
            whatsAppCall: { findMany: jest.fn(() => Promise.resolve([{ durationSeconds: 61 }, { durationSeconds: 30 }])) },
            organizationMember: {
                findMany: jest.fn(() => Promise.resolve([
                    { role: UserRole.OWNER, permissions: null },
                    { role: UserRole.AGENT, permissions: { grants: ['section.chat'] } },
                    { role: UserRole.AGENT, permissions: { grants: ['section.products', 'inventory.view', 'inventory.pack'] } },
                    { role: UserRole.AGENT, permissions: { grants: ['pos.sell'] } },
                ])),
            },
            warehouse: { count: jest.fn(() => Promise.resolve(3)) },
            channel: { count: jest.fn((args: { where: { platform: string } }) => Promise.resolve(args.where.platform === 'WHATSAPP' ? 2 : 1)) },
        };
        const usage = await new UsageService(prisma as never).usage('org_1', '2026-10');

        expect(usage).toEqual({ conversations: 2_345, callingMinutes: 3, members: 2, opsSeats: 2, storeLocations: 3, whatsappNumbers: 2, instagramAccounts: 1 });
        expect(prisma.organizationMember.findMany).toHaveBeenCalledWith({
            where: { organizationId: 'org_1', isActive: true, role: { in: ['OWNER', 'ADMIN', 'MANAGER', 'AGENT'] } },
            select: { role: true, permissions: true },
        });
        expect(prisma.warehouse.count).toHaveBeenCalledWith({ where: { organizationId: 'org_1', isActive: true, kind: 'STORE' } });
        expect(prisma.channel.count).toHaveBeenCalledWith({ where: { organizationId: 'org_1', platform: 'WHATSAPP', isEnabled: true, status: { not: 'DISCONNECTED' } } });
        expect(prisma.channel.count).toHaveBeenCalledWith({ where: { organizationId: 'org_1', platform: 'INSTAGRAM', ownerUserId: null, isEnabled: true, status: { not: 'DISCONNECTED' } } });
    });
});
