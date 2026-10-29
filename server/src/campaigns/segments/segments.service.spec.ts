import { ConflictException } from '@nestjs/common';
import { SegmentsService } from './segments.service';

describe('deleting a segment', () => {
    function setup(using: Array<{ name: string }>) {
        const prisma = {
            segment: { findFirst: jest.fn(async () => ({ id: 'seg_1', organizationId: 'org_1' })), delete: jest.fn() },
            broadcast: { findMany: jest.fn(async (_args: any) => using) },
        };
        return { prisma, service: new SegmentsService(prisma as any, {} as any) };
    }

    it('is refused while an unsent broadcast includes or leaves it out', async () => {
        const { service, prisma } = setup([{ name: 'Diwali' }]);
        await expect(service.remove('org_1', 'seg_1')).rejects.toThrow(ConflictException);
        await expect(service.remove('org_1', 'seg_1')).rejects.toThrow('The broadcast “Diwali” uses this segment and has not been sent yet.');
        const where = prisma.broadcast.findMany.mock.calls[0][0].where;
        // One already sending has its recipients; only drafts and scheduled ones still read the segment.
        expect(where.status).toEqual({ in: ['DRAFT', 'SCHEDULED'] });
        expect(where.OR).toEqual([
            { audience: { path: ['segmentIds'], array_contains: ['seg_1'] } },
            { audience: { path: ['exclude', 'segmentIds'], array_contains: ['seg_1'] } },
        ]);
        expect(prisma.segment.delete).not.toHaveBeenCalled();
    });

    it('goes ahead when nothing waiting to send uses it', async () => {
        const { service, prisma } = setup([]);
        await expect(service.remove('org_1', 'seg_1')).resolves.toEqual({ deleted: true });
        expect(prisma.segment.delete).toHaveBeenCalledWith({ where: { id: 'seg_1' } });
    });
});
