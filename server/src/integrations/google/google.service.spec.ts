import { GoogleService } from './google.service';

describe('GoogleService reading new rows', () => {
    function service(seenRows: number | null, sheet: string[][]) {
        const prisma = {
            googleSheet: {
                findUnique: jest.fn(async () => ({ id: 's1', organizationId: 'o', spreadsheetId: 'sp', tab: 'Leads', seenRows })),
                update: jest.fn(async () => ({})),
                updateMany: jest.fn(async () => ({ count: 1 })),
            },
        };
        // 'Leads'!A3:ZZ → the rows from the 3rd on; 'Leads'!A1:ZZ1 → the header.
        const values = jest.fn(async (_token: string, _id: string, range: string) => {
            const [, from, to] = /!A(\d+):ZZ(\d+)?$/.exec(range)!;
            return sheet.slice(Number(from) - 1, to ? Number(to) : undefined);
        });
        const redis = { get: jest.fn(async () => 'token') };
        const s = new GoogleService(prisma as never, {} as never, redis as never, { values } as never, {} as never);
        return { s, prisma, values };
    }
    const header = ['Name', 'Phone'];

    it('returns rows after the last one seen, and leaves the position to the caller', async () => {
        const { s, prisma } = service(2, [header, ['Asha', '+91 98000 00001'], ['Ravi', '+91 98000 00002'], [], ['Meera', '+91 98000 00003']]);
        const fresh = await s.newRows('s1');
        expect(fresh.rows).toEqual([
            { number: 3, cells: ['Ravi', '+91 98000 00002'] },
            { number: 5, cells: ['Meera', '+91 98000 00003'] },
        ]);
        expect(fresh.end).toBe(5);
        expect(fresh.columns.map((c) => c.key)).toEqual(['name', 'phone']);
        expect(prisma.googleSheet.update).toHaveBeenCalledWith({ where: { id: 's1' }, data: expect.not.objectContaining({ seenRows: expect.anything() }) });
    });

    it('notes the end of a sheet read for the first time, and starts nothing', async () => {
        const { s, prisma } = service(null, [header, ['Asha', '1']]);
        await expect(s.newRows('s1')).resolves.toEqual({ columns: [], rows: [], end: 2 });
        expect(prisma.googleSheet.update).toHaveBeenCalledWith({ where: { id: 's1' }, data: expect.objectContaining({ seenRows: 2 }) });
    });

    it('moves back to the end when rows were deleted, so the next new row is read', async () => {
        // Five rows were seen; two were deleted since.
        const { s, prisma } = service(5, [header, ['Asha', '1'], ['Ravi', '2']]);
        await expect(s.newRows('s1')).resolves.toEqual({ columns: [], rows: [], end: 3 });
        expect(prisma.googleSheet.update).toHaveBeenCalledWith({ where: { id: 's1' }, data: expect.objectContaining({ seenRows: 3 }) });
    });

    it('moves the position forward only', async () => {
        const { s, prisma } = service(2, []);
        await s.markRead('s1', 4);
        expect(prisma.googleSheet.updateMany).toHaveBeenCalledWith({ where: { id: 's1', seenRows: { lt: 4 } }, data: { seenRows: 4 } });
    });
});
