import { ChannelPlatform, UserRole } from '@prisma/client';
import { InboxContactsService } from './inbox-contacts.service';
import { InboxViewer } from './inbox-visibility';

type Row = Record<string, unknown>;

/** Just enough of a Prisma where clause for these queries: equality, not, in, OR and a conversation `some`. */
function match(row: Row, where: Row, db: { conversations: Row[] }): boolean {
    return Object.entries(where).every(([key, cond]) => {
        if (key === 'OR') return (cond as Row[]).some((w) => match(row, w, db));
        if (key === 'conversations') {
            return db.conversations.some((v) => v.contactId === row.id && match(v, (cond as { some: Row }).some, db));
        }
        if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
            if ('not' in cond) return row[key] !== (cond as { not: unknown }).not;
            if ('in' in cond) return (cond as { in: unknown[] }).in.includes(row[key]);
        }
        return row[key] === cond;
    });
}

const contact = (id: string, fields: Row) => ({
    id, organizationId: 'org1', channelId: 'ch_wa', platform: ChannelPlatform.WHATSAPP, externalId: id, isGroup: false,
    customerId: null, displayName: null, addressBookName: null, username: null, phone: null, waId: null,
    optInAt: null, optedOutAt: null, tags: [], attributes: null, ownerUserId: null, ownerTeamId: null, createdAt: new Date(0),
    ...fields,
});
const conversation = (id: string, contactId: string, fields: Row = {}) => ({
    id, contactId, customerId: null, assignedUserId: null, teamId: null, lastMessageAt: null, lastMessagePreview: null, ...fields,
});

function build(seed: { contacts: Row[]; conversations: Row[]; customers?: Row[] }) {
    const db = { contacts: seed.contacts, conversations: seed.conversations, customers: seed.customers ?? [] };
    const where = (rows: Row[]) => (args: { where: Row }) => rows.filter((r) => match(r, args.where, db));
    const updateMany = (rows: Row[]) => async (args: { where: Row; data: Row }) => {
        const hit = where(rows)(args);
        hit.forEach((r) => Object.assign(r, args.data));
        return { count: hit.length };
    };
    const prisma = {
        channelContact: {
            findFirst: async (args: { where: Row }) => where(db.contacts)(args)[0] ?? null,
            findMany: async (args: { where: Row }) =>
                where(db.contacts)(args).map((c) => ({
                    ...c,
                    channel: { name: c.platform === ChannelPlatform.WHATSAPP ? 'Acme WhatsApp' : '@acme' },
                    conversations: db.conversations.filter((v) => v.contactId === c.id),
                })),
            update: async (args: { where: { id: string }; data: Row }) => Object.assign(db.contacts.find((c) => c.id === args.where.id)!, args.data),
            updateMany: updateMany(db.contacts),
        },
        conversation: { findMany: async (args: { where: Row }) => where(db.conversations)(args), updateMany: updateMany(db.conversations) },
        customer: {
            findFirst: async (args: { where: Row }) => where(db.customers)(args)[0] ?? null,
            findUnique: async (args: { where: { id: string } }) => {
                const c = db.customers.find((r) => r.id === args.where.id);
                return c ? { totalSpent: 0, ordersCount: 0, tags: [], orders: [], ...c } : null;
            },
            findMany: async () => [],
            create: jest.fn(async (args: { data: Row }) => {
                const row = { id: `cust_new${db.customers.length}`, deletedAt: null, ...args.data };
                db.customers.push(row);
                return row;
            }),
        },
        channel: { findFirst: async () => ({ id: 'ch_manual' }) },
        consentEvent: { findMany: async () => [] },
        adReferral: { findFirst: async () => null },
        user: { findUnique: async () => null },
        inboxTeam: { findUnique: async () => null },
        // Customers sharing a phone number: none unless a test says so.
        $queryRaw: jest.fn().mockResolvedValue([]),
        $transaction: async (fn: (tx: unknown) => unknown) => fn(prisma),
    };
    const events = { publish: jest.fn() };
    const service = new InboxContactsService(prisma as never, {} as never, events as never, {} as never, {} as never, {} as never, {} as never, {} as never);
    return { service, db, prisma, events };
}

const owner: InboxViewer = { userId: 'u_owner', role: UserRole.OWNER, grants: [], teamIds: [] };
const agent: InboxViewer = { userId: 'u_agent', role: UserRole.AGENT, grants: ['section.chat'], teamIds: [] };
const viewerRole: InboxViewer = { userId: 'u_view', role: UserRole.VIEWER, grants: ['chat.view_all'], teamIds: [] };

describe('InboxContactsService — the same person on several chats', () => {
    function riya() {
        return build({
            contacts: [
                contact('wa1', { customerId: 'cust1', phone: '+919800000001', displayName: 'Riya' }),
                contact('wa2', { customerId: 'cust1', phone: '+919800000002', optInAt: new Date('2026-10-01') }),
                contact('ig1', { customerId: 'cust1', platform: ChannelPlatform.INSTAGRAM, channelId: 'ch_ig', username: 'riya.k' }),
                contact('wa9', { customerId: 'cust9', phone: '+919800000009' }),
            ],
            conversations: [
                conversation('v1', 'wa1', { customerId: 'cust1', assignedUserId: 'u_agent', lastMessageAt: new Date('2026-10-20') }),
                conversation('v2', 'wa2', { customerId: 'cust1', assignedUserId: 'u_other', lastMessageAt: new Date('2026-10-22'), lastMessagePreview: 'Is my order out?' }),
                conversation('v3', 'ig1', { customerId: 'cust1', assignedUserId: 'u_agent', lastMessageAt: new Date('2026-10-21'), lastMessagePreview: 'Love the kurta' }),
                conversation('v9', 'wa9', { customerId: 'cust9', lastMessageAt: new Date('2026-10-23') }),
            ],
            customers: [{ id: 'cust1', organizationId: 'org1', deletedAt: null, firstName: 'Riya' }, { id: 'cust9', organizationId: 'org1', deletedAt: null }],
        });
    }

    it('lists the customer\'s other chats, latest first, and nobody else\'s', async () => {
        const { service } = riya();
        const view = await service.get('org1', owner, 'wa1');
        expect(view.otherChats.map((c) => c.contactId)).toEqual(['wa2', 'ig1']);
        expect(view.otherChats[0]).toMatchObject({
            platform: ChannelPlatform.WHATSAPP, phone: '+919800000002', conversationId: 'v2', lastMessagePreview: 'Is my order out?', optedIn: true,
        });
        expect(view.otherChats[1]).toMatchObject({ platform: ChannelPlatform.INSTAGRAM, username: 'riya.k', name: '@riya.k', optedIn: false });
    });

    it('leaves out the chats an agent cannot open', async () => {
        const { service } = riya();
        const view = await service.get('org1', agent, 'wa1');
        expect(view.otherChats.map((c) => c.contactId)).toEqual(['ig1']);
    });

    it('shows no other chats for a contact without a customer', async () => {
        const { service } = build({ contacts: [contact('wa1', {})], conversations: [conversation('v1', 'wa1')] });
        expect((await service.get('org1', owner, 'wa1')).otherChats).toEqual([]);
    });

    it('links a chat to the customer the other chat already has, with its conversation', async () => {
        const { service, db, events } = build({
            contacts: [contact('wa1', { customerId: 'cust1' }), contact('ig1', { platform: ChannelPlatform.INSTAGRAM, username: 'riya.k' })],
            conversations: [conversation('v1', 'wa1', { customerId: 'cust1' }), conversation('v3', 'ig1')],
            customers: [{ id: 'cust1', organizationId: 'org1', deletedAt: null }],
        });
        const view = await service.samePerson('org1', owner, 'ig1', 'wa1');
        expect(db.contacts.map((c) => c.customerId)).toEqual(['cust1', 'cust1']);
        expect(db.conversations.map((v) => v.customerId)).toEqual(['cust1', 'cust1']);
        expect(view.customer?.id).toBe('cust1');
        expect(view.otherChats.map((c) => c.contactId)).toEqual(['wa1']);
        expect(events.publish).toHaveBeenCalledWith('org1', { type: 'conversation.updated', conversationId: 'v3' });
    });

    it('makes one customer from the chat that says more when neither has one', async () => {
        const { service, db, prisma } = build({
            contacts: [
                contact('ig1', { platform: ChannelPlatform.INSTAGRAM, username: 'riya.k' }),
                contact('wa1', { phone: '+919800000001', waId: '919800000001', displayName: 'Riya Kapoor Shah' }),
            ],
            conversations: [conversation('v3', 'ig1'), conversation('v1', 'wa1')],
        });
        await service.samePerson('org1', owner, 'ig1', 'wa1');
        expect(prisma.customer.create).toHaveBeenCalledTimes(1);
        expect(prisma.customer.create.mock.calls[0][0].data).toMatchObject({
            organizationId: 'org1', channelId: 'ch_manual', firstName: 'Riya', lastName: 'Kapoor Shah', phone: '+919800000001',
            externalId: expect.stringMatching(/^manual_/),
        });
        const made = db.customers[0].id;
        expect(db.contacts.map((c) => c.customerId)).toEqual([made, made]);
        expect(db.conversations.map((v) => v.customerId)).toEqual([made, made]);
    });

    it('names the customer from the profile when the number has no name', async () => {
        const { service, prisma } = build({
            contacts: [contact('wa1', { phone: '+919800000001' }), contact('ig1', { platform: ChannelPlatform.INSTAGRAM, username: 'riya.k' })],
            conversations: [conversation('v1', 'wa1'), conversation('v3', 'ig1')],
        });
        await service.samePerson('org1', owner, 'wa1', 'ig1');
        expect(prisma.customer.create.mock.calls[0][0].data).toMatchObject({ firstName: 'riya.k', lastName: null, phone: '+919800000001' });
    });

    it('uses the one store customer with the WhatsApp number instead of making another', async () => {
        const { service, db, prisma } = build({
            contacts: [contact('wa1', { phone: '+919800000001' }), contact('wa2', { phone: '+919800000002', displayName: 'Riya' })],
            conversations: [conversation('v1', 'wa1'), conversation('v2', 'wa2')],
            customers: [{ id: 'cust_shop', organizationId: 'org1', deletedAt: null, phone: '98000 00002' }],
        });
        prisma.$queryRaw.mockResolvedValueOnce([{ id: 'cust_shop' }]);
        await service.samePerson('org1', owner, 'wa1', 'wa2');
        expect(prisma.customer.create).not.toHaveBeenCalled();
        expect(db.contacts.map((c) => c.customerId)).toEqual(['cust_shop', 'cust_shop']);
    });

    it('refuses two chats on two different customers and changes nothing', async () => {
        const { service, db } = riya();
        await expect(service.samePerson('org1', owner, 'wa1', 'wa9')).rejects.toThrow('two different store customers');
        expect(db.contacts.map((c) => c.customerId)).toEqual(['cust1', 'cust1', 'cust1', 'cust9']);
        expect(db.conversations.map((v) => v.customerId)).toEqual(['cust1', 'cust1', 'cust1', 'cust9']);
    });

    it('follows the edit rules: no viewers, and only chats the member can open', async () => {
        const { service } = riya();
        await expect(service.samePerson('org1', viewerRole, 'wa1', 'wa9')).rejects.toThrow('Viewers cannot');
        await expect(service.samePerson('org1', agent, 'wa1', 'wa2')).rejects.toThrow('Contact not found');
        await expect(service.samePerson('org1', owner, 'wa1', 'wa1')).rejects.toThrow('Choose another chat');
    });
});

describe('InboxContactsService — chats linked from the customer page', () => {
    function shop() {
        return build({
            contacts: [contact('wa1', {}), contact('wa2', { customerId: 'cust2' }), contact('wa3', { customerId: 'cust1' })],
            conversations: [conversation('v1', 'wa1'), conversation('v2', 'wa2', { customerId: 'cust2' }), conversation('v3', 'wa3', { customerId: 'cust1' })],
            customers: [{ id: 'cust1', organizationId: 'org1', deletedAt: null }, { id: 'cust2', organizationId: 'org1', deletedAt: null }],
        });
    }

    it('links a chat and its conversation to the customer', async () => {
        const { service, db } = shop();
        expect(await service.linkToCustomer('org1', owner, 'cust1', 'wa1')).toEqual({ contactId: 'wa1', customerId: 'cust1' });
        expect(db.contacts[0].customerId).toBe('cust1');
        expect(db.conversations[0].customerId).toBe('cust1');
    });

    it('leaves a chat that belongs to another customer where it is', async () => {
        const { service, db } = shop();
        await expect(service.linkToCustomer('org1', owner, 'cust1', 'wa2')).rejects.toThrow('linked to another store customer');
        expect(db.contacts[1].customerId).toBe('cust2');
        await expect(service.linkToCustomer('org1', owner, 'nope', 'wa1')).rejects.toThrow('Customer not found');
    });

    it('unlinks only a chat of this customer, with its conversation', async () => {
        const { service, db } = shop();
        await expect(service.unlinkFromCustomer('org1', owner, 'cust1', 'wa2')).rejects.toThrow('not linked to this customer');
        expect(await service.unlinkFromCustomer('org1', owner, 'cust1', 'wa3')).toEqual({ contactId: 'wa3', customerId: null });
        expect(db.contacts[2].customerId).toBeNull();
        expect(db.conversations[2].customerId).toBeNull();
    });

    it('keeps viewers and agents to what they may edit', async () => {
        const { service } = shop();
        await expect(service.linkToCustomer('org1', viewerRole, 'cust1', 'wa1')).rejects.toThrow('Viewers cannot');
        await expect(service.unlinkFromCustomer('org1', agent, 'cust1', 'wa3')).rejects.toThrow('Contact not found');
    });
});
