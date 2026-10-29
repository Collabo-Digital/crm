import { ChannelPlatform } from '@prisma/client';
import { CustomerService } from './customer.service';

describe('CustomerService.findOne — chats', () => {
  it("lists every number and profile linked to the customer, latest message first", async () => {
    const at = (day: number) => new Date(`2026-10-${day}T10:00:00Z`);
    const contact = (id: string, platform: ChannelPlatform, fields: Record<string, unknown>, conversation: { id: string; lastMessageAt: Date | null } | null) => ({
      id, platform, displayName: null, addressBookName: null, username: null, phone: null, externalId: id,
      channel: { name: platform === ChannelPlatform.WHATSAPP ? 'Acme WhatsApp' : '@acme' },
      conversations: conversation ? [conversation] : [],
      ...fields,
    });
    const prisma = {
      customer: { findFirst: jest.fn().mockResolvedValue({ id: 'cust1', addresses: [], defaultAddress: { address1: 'MG Road', city: 'Pune' } }) },
      order: { findFirst: jest.fn() },
      channelContact: {
        findMany: jest.fn().mockResolvedValue([
          contact('wa1', ChannelPlatform.WHATSAPP, { phone: '+919800000001', displayName: 'Riya' }, { id: 'v1', lastMessageAt: at(20) }),
          contact('wa2', ChannelPlatform.WHATSAPP, { phone: '+919800000002' }, null),
          contact('ig1', ChannelPlatform.INSTAGRAM, { username: 'riya.k' }, { id: 'v3', lastMessageAt: at(22) }),
        ]),
      },
    };
    const service = new CustomerService(prisma as any, {} as any);

    const customer = await service.findOne('cust1', 'org1');

    expect(prisma.channelContact.findMany.mock.calls[0][0].where).toEqual({ customerId: 'cust1', organizationId: 'org1' });
    expect(customer.chats).toEqual([
      { contactId: 'ig1', platform: ChannelPlatform.INSTAGRAM, channel: { name: '@acme' }, name: '@riya.k', phone: null, username: 'riya.k', conversationId: 'v3', lastMessageAt: at(22) },
      { contactId: 'wa1', platform: ChannelPlatform.WHATSAPP, channel: { name: 'Acme WhatsApp' }, name: 'Riya', phone: '+919800000001', username: null, conversationId: 'v1', lastMessageAt: at(20) },
      { contactId: 'wa2', platform: ChannelPlatform.WHATSAPP, channel: { name: 'Acme WhatsApp' }, name: '+919800000002', phone: '+919800000002', username: null, conversationId: null, lastMessageAt: null },
    ]);
  });
});
