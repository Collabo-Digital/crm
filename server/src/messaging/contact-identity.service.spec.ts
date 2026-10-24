import { ChannelContact } from '@prisma/client';
import { ContactIdentityService } from './contact-identity.service';

const contact = { id: 'ct1', organizationId: 'org1', customerId: null, waId: '919800000000' } as ChannelContact;

describe('ContactIdentityService.linkCustomerByPhone', () => {
    it('does not scan the customers again for a number that just matched nobody', async () => {
        const service = new ContactIdentityService();
        const tx = { $queryRaw: jest.fn().mockResolvedValue([]), channelContact: { update: jest.fn() }, conversation: { updateMany: jest.fn() } };
        const t0 = Date.UTC(2026, 9, 25, 10, 0, 0);

        expect(await service.linkCustomerByPhone(tx as never, contact, t0)).toBeNull();
        expect(await service.linkCustomerByPhone(tx as never, contact, t0 + 60_000)).toBeNull();
        expect(tx.$queryRaw).toHaveBeenCalledTimes(1);

        // A customer added since is found on a message after the pause.
        tx.$queryRaw.mockResolvedValueOnce([{ id: 'cust1' }]);
        expect(await service.linkCustomerByPhone(tx as never, contact, t0 + 11 * 60_000)).toBe('cust1');
        expect(tx.channelContact.update).toHaveBeenCalledWith({ where: { id: 'ct1' }, data: { customerId: 'cust1' } });
    });
});
