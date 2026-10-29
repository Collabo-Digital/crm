import { Logger } from '@nestjs/common';
import { WhatsAppGroupsService } from './whatsapp-groups.service';

describe('WhatsAppGroupsService: telling open inboxes a group changed', () => {
    it('handles a database error itself instead of leaving the promise rejected, which would stop the process', async () => {
        const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        const prisma = { conversation: { findFirst: jest.fn().mockRejectedValue(new Error('Timed out fetching a new connection')) } };
        const service = new WhatsAppGroupsService(prisma as any, {} as any, {} as any, {} as any, { publish: jest.fn() } as any);
        try {
            (service as any).publish({ id: 'g1', contactId: 'c1', organizationId: 'org1' });
            await new Promise((resolve) => setImmediate(resolve));
            expect(warn).toHaveBeenCalledWith(expect.stringContaining('Timed out fetching a new connection'));
        } finally {
            warn.mockRestore();
        }
    });
});
