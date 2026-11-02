import { ForbiddenException } from '@nestjs/common';
import { ChannelPlatform, UserRole } from '@prisma/client';
import { InboxContactsService } from './inbox-contacts.service';
import { InboxViewer } from './inbox-visibility';

type Where = { id?: string | { in: string[] } };

const riya = { id: 'cust_riya', firstName: 'Riya', lastName: 'K', email: 'riya@example.com', phone: '+919800000001', ordersCount: 2 };
const sheena = { id: 'cust_sheena', firstName: 'Sheena', lastName: 'Nelson', email: 'sheena@example.com', phone: '+16505551234', ordersCount: 4 };

/** One WhatsApp chat whose number belongs to Riya, in a store that also has Sheena. */
function build(linkedTo: string | null = null) {
    const contact = {
        id: 'wa1', organizationId: 'org1', channelId: 'ch_wa', platform: ChannelPlatform.WHATSAPP, externalId: '919800000001',
        waId: '919800000001', phone: '+919800000001', isGroup: false, customerId: linkedTo, displayName: 'Riya',
        addressBookName: null, username: null, tags: [], attributes: null, ownerUserId: null, ownerTeamId: null,
        optInAt: null, optedOutAt: null, blockedAt: null, createdAt: new Date(0), lastInboundMessageAt: null,
    };
    const customers = [riya, sheena];
    const byId = (where: Where) => {
        const id = where.id;
        return customers.filter((c) => (typeof id === 'string' ? c.id === id : id ? id.in.includes(c.id) : true));
    };
    const prisma = {
        channel: { findFirst: jest.fn(() => Promise.resolve({ id: 'ch_wa' })) },
        channelContact: {
            findFirst: jest.fn(() => Promise.resolve({ ...contact })),
            findMany: jest.fn(() => Promise.resolve([])),
            update: jest.fn(({ data }: { data: object }) => Promise.resolve({ ...contact, ...data })),
        },
        conversation: {
            findMany: jest.fn(() => Promise.resolve([])),
            updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
        },
        customer: {
            findFirst: jest.fn(({ where }: { where: Where }) => Promise.resolve(byId(where)[0] ?? null)),
            findMany: jest.fn(({ where }: { where: Where }) => Promise.resolve(byId(where))),
            findUnique: jest.fn(() => Promise.resolve(null)),
        },
        consentEvent: { findMany: jest.fn(() => Promise.resolve([])) },
        adReferral: { findFirst: jest.fn(() => Promise.resolve(null)) },
        // The customers sharing the chat's number.
        $queryRaw: jest.fn(() => Promise.resolve([{ id: riya.id }])),
        $transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(prisma)),
    };
    const automationEvents = { recordTagsAdded: jest.fn(() => Promise.resolve([])) };
    const service = new InboxContactsService(
        prisma as never, {} as never, { publish: jest.fn() } as never, {} as never,
        automationEvents as never, { event: jest.fn() } as never, {} as never, {} as never,
    );
    return { service, prisma };
}

const viewer = (role: UserRole, grants: string[]): InboxViewer => ({ userId: 'u1', role, grants, teamIds: [] });
/** The launch's least-trusted member: an agent given the Chat section only. */
const chatOnly = viewer(UserRole.AGENT, ['section.chat', 'chat.view_unassigned']);

describe('InboxContactsService — store customers for members without the Customers section', () => {
    it('refuses a chat-only agent a search of the customer list', async () => {
        const { service, prisma } = build();

        await expect(service.customerCandidates('org1', chatOnly, 'wa1', 's')).rejects.toBeInstanceOf(ForbiddenException);
        expect(prisma.customer.findMany).not.toHaveBeenCalled();
    });

    it("still shows a chat-only agent the customers who share the chat's number", async () => {
        const { service } = build();

        const { results } = await service.customerCandidates('org1', chatOnly, 'wa1', undefined);

        expect(results.map((c) => c.id)).toEqual([riya.id]);
    });

    it.each([
        ['an agent with Customers', viewer(UserRole.AGENT, ['section.chat', 'section.customers'])],
        ['an agent with Orders', viewer(UserRole.AGENT, ['section.chat', 'section.orders'])],
        ['an agent who joined before section access', viewer(UserRole.AGENT, [])],
        ['a manager', viewer(UserRole.MANAGER, [])],
    ])('lets %s search the customer list', async (_label, member) => {
        const { service, prisma } = build();

        await expect(service.customerCandidates('org1', member, 'wa1', 'she')).resolves.toMatchObject({ results: expect.any(Array) as unknown[] });
        expect(prisma.customer.findMany).toHaveBeenCalled();
    });

    it('refuses a chat-only agent linking the chat to a customer with another number', async () => {
        const { service, prisma } = build();

        await expect(service.update('org1', chatOnly, 'wa1', { customerId: sheena.id })).rejects.toBeInstanceOf(ForbiddenException);
        await expect(service.linkToCustomer('org1', chatOnly, sheena.id, 'wa1')).rejects.toBeInstanceOf(ForbiddenException);
        expect(prisma.channelContact.update).not.toHaveBeenCalled();
    });

    it('refuses a chat-only agent swapping a linked customer for another', async () => {
        const { service, prisma } = build(riya.id);

        await expect(service.update('org1', chatOnly, 'wa1', { customerId: sheena.id })).rejects.toBeInstanceOf(ForbiddenException);
        expect(prisma.channelContact.update).not.toHaveBeenCalled();
    });

    it("lets a chat-only agent link the customer with the chat's number, and unlink", async () => {
        const { service, prisma } = build();

        await service.update('org1', chatOnly, 'wa1', { customerId: riya.id });
        await service.linkToCustomer('org1', chatOnly, riya.id, 'wa1');
        await service.update('org1', chatOnly, 'wa1', { customerId: null });

        const linked = prisma.channelContact.update.mock.calls.map(([args]) => (args as { data: { customerId: string | null } }).data.customerId);
        expect(linked).toEqual([riya.id, riya.id, null]);
    });

    it('lets a member with Customers link any customer', async () => {
        const { service, prisma } = build();

        await service.update('org1', viewer(UserRole.AGENT, ['section.chat', 'section.customers']), 'wa1', { customerId: sheena.id });

        expect(prisma.channelContact.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ customerId: sheena.id }) as object }));
    });

    it('refuses a chat-only agent starting a chat on a store customer', async () => {
        const { service, prisma } = build();

        await expect(service.startChat('org1', chatOnly, { phone: '+16505551234', customerId: sheena.id })).rejects.toBeInstanceOf(ForbiddenException);
        expect(prisma.customer.findFirst).not.toHaveBeenCalled();
    });
});
